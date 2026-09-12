# Memory Coverage Audit — 生产实据（只读）

```
TASK=LIFE-P6-MEMORY-COVERAGE-AUDIT
SOURCE=/home/vitamin_c/.local/share/vc-ai-pet/sandbox（只读打开）
EXECUTED_BY=Luna w-458d4e1f（Root 下达任务书）
PRODUCTION_DB_MODIFIED=NO（审计前后无新文件、无 WAL 变更、无 checkpoint）
LOCAL_BRAIN_TOUCHED=NO  PROCESS_RESTARTED=NO
```

用户的问题（原话要点）：「我跟他说过的话，他有时候会忘，小思考是不是有问题？还有梦境的频率好像
还是很低，小思考也不够多，是不是有一些对话被漏掉了？」以及用户自己的定性：

> 「没有从 raw archive 丢掉，但大量对话在进入 PetMemory 之前被过滤掉了，
> 因此对于小思考和梦境来说等价于"没经历过"。」

本审计用只读数据验证了这个定性，并给出了具体数字与两个新的确凿缺陷。

---

## 1. 结论先行

**主因是上游筛选，不是调度阈值保守。** 全量 157 个用户对话轮次里，
可确认经 MemoryGate 落库的用户 raw 记忆只有 **12 条（7.6%）**；
最近 48 小时 14 轮里只有 **1 条（7.1%）**。
PetMemory 的 204 条 raw 行中 **187 条 importance=1**，按既有代码不会进入
Reflection/Dream 的 source window，最终只有 **17 条**对两个内生活动可见。

因此「把小思考 30min→5min、梦境 15min→2min」只会让系统更勤快地处理这 17 条，
**不会让被丢掉的 145 个轮次重新出现**。

---

## 2. 主漏斗（全量 / 最近 48h）

| 指标 | 全量 | 最近 48h |
|---|---:|---:|
| USER_DIALOGUE_TURNS | 157 | 14 |
| RAW_ARCHIVE_USER_TURNS | 157 | 14 |
| PET_MEMORY_ACCEPTED_RAW（MemoryGate 落库） | 12 | 1 |
| **MEMORY_ACCEPT_RATE** | **7.6%** | **7.1%** |
| REFLECTION_ELIGIBLE_RAW（active+raw+importance≥2） | 17 | 1 |
| REFLECTION_RUNS | 10 | 1 |
| REFLECTION_DERIVED | 3 | 1 |
| DREAM_RUNS | 4 | **0** |
| DREAM_DERIVED | 7 | 0 |

raw archive 侧覆盖完好：452 行（user 157 / assistant 295），
`USER_DIALOGUE_TURNS == RAW_ARCHIVE_USER_TURNS`，**A 层没有丢**。

---

## 3. 定点样本：黑莓

### A — raw archive 里原话都在

含「黑莓」的行 34 条，其中 **user 原话 12 条**，跨越 09-07、09-08、09-10、09-11。
包括用户投诉时引用的那句原话：

```
2026-09-11 01:50:37  user  "我们家的猫猫叫黑莓哦你要记住"
2026-09-11 01:50:42  assistant "汪！记住啦！黑莓是猫猫的名字！…"   <- 回复说记住了
```

### B — PetMemory 里没有对应的 raw memory（0/12）

库里 4 个「黑莓」字符串命中，**没有一条能支持"黑莓是谁/长什么样"**：

| level | content | importance | 问题 |
|---|---|---:|---|
| lesson | 主人说：一定要记住哦 | 2 | 关键词里塞了「黑莓」，正文没有 |
| lesson | 主人说：对的你要努力地记住我说的话哦 | 2 | 同上 |
| project | 主人说：以后你要跟他好好玩 | 2 | 关键词里有「李黑莓」，正文只有"他" |
| lesson | 主人要求记住黑莓的长相、花色和面部细节（reflection derived） | 3 | **derived，无 raw 依据**，且缺具体花色 |

**这正是用户截图现象的机制**：花花嘴上说「记住啦」，数据库里没有任何一条能回答
「黑莓是谁」的 raw 记忆；后来问「黑莓长什么样子」时只能答「花花没有记住黑莓的样子」。

### C — 召回层也有问题（但比 B 次要）

只读模拟 `search`（未 bump hit_count）：

| query | 结果 |
|---|---|
| `猫猫叫什么名字` | top1 = 「主人说：一定要记住哦」(score 10.94) — **generic 关键词压过实际事实** |
| `黑莓` | top1 = 「一定要记住哦」；top2 = 那条无 raw 依据的 derived |
| `猫` | **无命中**（单字不入索引，meow-memory 行为） |

即：召回正确性依赖关键词，而关键词由模型自由生成、**可以与正文无关**，
于是「一定要记住哦」因为带了「黑莓」关键词而排在真正内容前面。

---

## 4. 两个新确认的缺陷（有生产证据）

### BUG-1：视觉轮把显式记忆请求整个跳过 ★严重

`src/runtime/pet-runtime.js` 在有视觉上下文时把 gate 短路为
`{ status:'skipped', reason:'vision-context' }`，**gate 根本不执行**。

于是这两类真实轮次永不落库：

- `09-10 05:32` 「你看黑莓在凳子上」+ 图
- `09-10 05:35` 「**你要记住黑莓的样子哦，不要记错花纹了**，现在再仔细看看黑莓的图片」+ 视觉上下文
- `09-08 12:33` 「今天带黑莓去洗澡了」+ 图

**主人的显式记忆请求，只要那一轮带图，就一定不会被记住。**
用户抱怨的「黑莓长什么样子 → 没记住」直接由此产生。

### BUG-2：`不要记错` 被误判成"不要记住"

`src/brain/memory-candidate.js` 的 opt-out 正则匹配「不要**记**错」→
`userOptedOutOfMemory=true` → 整句被当作"主人要求不要记住"而丢弃。
`09-10 05:35` 那句原话同时命中 BUG-1 与 BUG-2。

### 已修（本 branch）

用户点名的另一个 bug —— 模型候选因 `confidence-low` / `importance-low` / `level-denied`
被拒时**不触发显式兜底**、导致「嘴上说记住、库里没有」——已在 commit `7d1a265` 修复：
`MemoryGate` 不再使用「拒绝原因白名单」，显式请求在模型候选被拒时一律走兜底。
已用真实 PetMemory 验证：用户描述的 `remember=true, confidence=0.65`
现在会写入并带 `priority=HIGH / source=USER_EXPLICIT`，且 `recall('猫叫什么')` 命中。

---

## 5. 系统性缺口（不是黑莓独例）

三条真实用户原话，raw 里都在、PetMemory 里都没有对应 raw 行，**且都带图**：

1. `2026-09-04 13:12` 「我打了好多好多牛肉丸」+ image/webp
2. `2026-09-04 13:44` 「这是爸爸做的手工挂饰」+ image/webp
3. `2026-09-04 16:09` 「对了这是我们养的新植物，家里的新成员」+ image/webp

**带图轮次集体缺失**，与 BUG-1 一致，说明这是系统性缺陷而非个例。

---

## 6. 现状 vs 用户目标的差距地图

### 生产现状（旧链路）

```
raw_messages（452：用户 157 轮，原话完整）
   -> MemoryGate / vision-context 分支          <- 只放行 12 条（7.6%）
   -> PetMemory raw（204，其中 importance>=2 只有 17）
   -> reflectionSourceRows / dreamSourceRows（active + raw + importance>=2）
   -> Reflection（10 次/3 derived） / Dream（4 次/7 derived）
```

低价值对话在这条链路里，对「内生活」等价于**没发生过**——用户判断正确。

### 本 worktree 修好后

```
raw user turn
  ├─ MemoryGate -> 少量 durable PetMemory raw（证据链不变）
  └─ ExperienceBuffer -> experience_events（含低 importance 的近期经历）
       ├─ Reflection / Dream context：能看到近期事件，但明确不是证据
       └─ Consolidator：重复/情绪/身份等稳定信号才提升为 PetMemory raw
             -> 既有 Reflection / Dream derived gate 不变
```

关键不变量得以保留：经验行**只作旁路 context**，不进入 `sourceRows` /
`availableSourceIds` / `source_ids`；任何 derived 记忆仍必须由真实 PetMemory raw 行
通过 `isRawEvidenceRow` 与 `derivedEvidence` 校验。**若把 `experience_events.id`
直接当 `source_ids`，就会破坏 raw/derived 边界——明确禁止。**

审计建议的最小接入点与本 worktree 的实现一致：
`pet-runtime` 的 `experienceAwareContextProvider` → 既有 `visualContext` 入口
→ `buildReflectionMessages`，Reflection 的 source 选择逻辑一行不改。

---

## 7. 待跟进（未在本轮修复）

1. **Dream 调度另有独立问题**：审计时 Dream checkpoint 之后已有 **4 条 pending raw**
   且最早一条已超 72h 年龄门槛（`dreamEligibility=true`），但最近 48h **没有 Dream log**。
   说明除了上游筛选，还存在调度运行/状态条件问题（sleeep 分支、未记录的 skip、
   进程运行状态）。**需要单独排查，不要与上游筛选混为一谈。**
2. **关键词与正文脱节**：模型给「一定要记住哦」塞了「黑莓」关键词，导致 generic
   句子在 `黑莓` 查询上排第一。建议在写入时校验 keywords 必须在正文/证据中出现，
   否则丢弃该关键词。
3. `recall('猫')` 单字无命中是 meow-memory 分词行为，不在本轮范围。
