# DEVLOG — Experience-aware Memory Pipeline（Memory Pipeline v2）

水印：待用户 review；**未部署、未 push、未重启生产**。

```
TASK=LIFE-EXPERIENCE-AWARE-MEMORY-PIPELINE
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-life-experience
BRANCH=feat/life-experience-buffer
BASE_COMMIT=4a3b8ef（= 生产 Pet 当前 HEAD）
PRODUCTION_DEPLOYED=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_RESTARTED=NO
PUSHED=NO
```

命名说明：用户指出不要叫它 "50 turns"。本项目内部定名为
**Experience-aware Memory Pipeline**——核心不是窗口更大，而是
「知道什么值得留下 / 什么时候整理 / 什么时候形成长期记忆 / 什么时候进入梦境」。

配套文档：完整 Phase 0 审计见 `docs/AUDIT_MEMORY_PIPELINE_V2.md`。

---

## 1. Phase 0 审计结论

### 1.1 用户报告的故障：真实链路

用户原话是「我们家的猫猫叫黑莓，你要记住」，之后花花「不知道猫叫什么」。

Root 现场探针（`/tmp` 临时 PetMemory + MemoryGate，未触碰生产 DB）逐层推翻了所有表层假设：

| 假设 | 实测 | 判定 |
|---|---|---|
| 「检测不到显式请求」 | `userExplicitlyRequestsMemory('我们家的猫猫叫黑莓，你要记住')` → **true** | 推翻 |
| 「短语覆盖不足」 | `不要忘` / `以后叫` / `以后知道` 确实不命中 | 成立（次要） |
| 「兜底内容被写坏」 | 旧 fallback 产出 **`主人们家的猫猫叫黑莓…`**（`startsWith('我')`→`slice(1)`） | 成立（次要） |
| 「低分候选不兜底」 | `confidence-low` / `importance-low` 时确实不写 | 成立（代码级；真实触发与否 archive 不可复原） |
| **「无关键词的第二句被丢弃」** | `记住我们家的猫叫黑莓` 写入后，紧接着 `我们家的猫叫黑莓` → `gate skipped` | **主根因** |

**最终裁定（审计独立复核后一致）**：唯一主根因是
**显式记忆意图没有跨 turn 传播**。主人给一次指令，然后正常地谈论那件事；
第二句没有关键词，旧 Gate 只能当普通消息处理，模型 `model-skip` 时不写 PetMemory——
于是「刚刚被告知的那只猫」消失了。

次要因素三项：旧 Gate 的白名单（`importance-low/confidence-low/level-denied` 不兜底）、
旧 fallback 的正文污染（`主人们家的…`）、以及 `recall('猫')` 因单字不入索引而天生为空
（这不是「没有记忆」的证据）。

archive 只读交叉验证（82 条相关消息）：真实会话确有「先不知道、后重新告诉、随后能答出」
的现象，但 `raw_messages.payload` 不含 `memoryCandidate`/`confidence`/`importance` 字段，
因此**当年模型实际返回了什么候选，无法从 archive 复原**——这一点明确标注为「无法验证」，
没有用构造探针冒充真实模型输出。

### 1.2 Root 探针原始证据（保留）

```
A. userExplicitlyRequestsMemory('我们家的猫猫叫黑莓，你要记住') = true
B. 旧 fallback candidate = {"level":"user",
     "content":"主人们家的猫猫叫黑莓，你要记住",     <- 正文已被写坏
     "evidence":"我们家的猫猫叫黑莓，你要记住"}
C. gate(model-skip)      = written
D. gate(confidence-low)  = skipped  <- 不兜底
E. gate(importance-low)  = skipped  <- 不兜底

meow-memory 分词：
tokenize('猫叫什么') = ["猫叫","叫什","什么"]   -> recall('猫叫什么') 命中
tokenize('猫')       = []                       -> recall('猫') 永远为空（单字不入索引）
```

---

## 2. 架构变更（保留既有接口，不重写 PetMemory）

```
Conversation Archive
        ↓
Experience Buffer         ← 新增：experience-buffer.sqlite / experience_events
        ↓
Consolidator（规则沉淀）   ← 新增：反复出现的经验 → raw PetMemory 事实行
        ↓
Reflection（既有引擎，未改 schema/阈值/lease）→ Derived Memory
```

保留不动：`Conversation Archive`、`PetMemory`（schema 未改）、`Dream`（生成逻辑未改）、
`MemoryGate`（校验权威未削弱），以及全部既有导出接口。

### 2.1 为什么需要 Consolidator 这一层

已验收的 Micro Reflection 有硬不变量：`PetMemory.rememberReflectionCandidate()` 要求
`sourceIds` 指向**已存在的 PetMemory 行**（否则 `PET_DERIVED_RAW_EVIDENCE_REQUIRED`）。
所以 buffer 行**不能**直接当 Reflection 的 `source_ids`。

方案：Consolidator 先把「反复出现的经验」经 `memory.remember(...)` 提升为 **raw 证据行**，
再由既有 Reflection 正常消费它们去合成更高层理解（如「黑莓喜欢柔软、高处休息」）。
这样 Reflection 的提示词、schema、阈值、lease 全部不变，同时满足
「Reflection 消费 Experience Buffer」的语义。

### 2.2 重复判定（踩过的真实坑）

「同一事实出现 ≥2 次」最初用**整句指纹**实现：`黑莓今天睡沙发` / `黑莓又睡沙发了` /
`黑莓还是睡沙发` 是三个不同字符串 → 计数永远是 1 → `repeated_behavior` **永远不可能触发**。

修正为**内容词包含度**：复用仓库既有中文分词器 `cjkTerms`（与 PetMemory 召回索引用同一套），
取 2-gram、剔除停用词与 `GENERIC_RECALL_TERMS`，按有向包含度比较。
实测标定（`EXPERIENCE_REPEAT_MIN_SIMILARITY = 0.4`）：

| 对照 | 相似度 | 判定 |
|---|---|---|
| `黑莓今天睡沙发` ↔ `黑莓又睡沙发了` | 0.60 | 同一行为 |
| `黑莓今天睡沙发` ↔ `黑莓还是睡沙发` | 0.60 | 同一行为 |
| `黑莓今天睡沙发` ↔ `黑莓在沙发上睡着了` | 0.40 | 同一行为 |
| `黑莓今天睡沙发` ↔ `今天天气不错` | 0.00 | 无关 |
| `黑莓今天睡沙发` ↔ `主人今天有点难过` | 0.00 | 无关 |
| `黑莓今天睡沙发` ↔ `花花今天吃了狗粮` | 0.00 | 无关 |

阈值落在实测分离带里；**宁可漏判也不误合并**（虚构的模式比漏掉的模式更糟）。

### 2.3 第二个设计缺陷：admission 的「先有鸡还是先有蛋」

buffer 初版规定「低 importance 的普通聊天不入库」。这直接杀死了重复检测：
**第一次**「黑莓今天睡沙发」被当闲聊丢掉，第二次就没有可比对的基线。

修正：低价值经验**入库但 importance 低**（0.2），
「低重要性」的含义是「Reflection 可以忽略它」，而不是「把证据扔掉」；
真正拦住一次性事件的是 Consolidator 的 `importance >= 2` 门槛。

---

## 3. 四个 Phase 的交付

### Phase 1 — Experience Buffer（`src/experience/experience-buffer.js`）

独立 SQLite（`experience-buffer.sqlite`），表 `experience_events`，**不进 PetMemory**：

```
id, created_at, source_type, conversation_id, message_id, actor_id,
content, importance_score, emotion_score, memory_candidate, processed, processed_at
```

写入规则（四类必进）：`explicit_memory`（≥0.9）/ 宠物身份 `owner_chat`（≥0.8）/
`repeated_behavior`（≥0.8）/ `emotion_event`（≥0.8）；其余为普通经验，低 importance 入库。
生命周期 **14 天**（7–14 区间取上限）；`purgeExpired` 只删「过期**且已处理**」，
过期未处理的素材必须保留并计数（否则 Reflection 会丢素材）。
`record()` 同步、fail-closed、绝不抛异常；**绝不持久化图片/dataURL/附件路径/附件 id**。

### Phase 2 — Explicit Memory Queue（`src/memory/explicit-memory-queue.js` + controller + gate）

- 检测：`记住 / 记下来 / 记一下 / 记着 / 记好 / 不要忘 / 别忘了 / 以后叫 / 以后知道`
- metadata：`priority: HIGH` / `source: USER_EXPLICIT`
- 流程：`user request → Explicit Memory Queue → Memory Validation → PetMemory`
- **不绕过 MemoryGate**：opt-out / 敏感信息 / 非断言三个提前 return 保持不变，
  等价性查重与校验全保留
- `MemoryGate.consider()` 不再用「拒绝原因白名单」兜底：模型候选被拒时一律走显式兜底，
  于是 `importance-low` / `confidence-low` / `level-denied` 都不再悄悄丢弃主人的指令
- **新增 `ExplicitMemoryController`（跨 turn 意图）**：一次指令在 TTL（10 分钟）内覆盖
  随后的复述句（`我们家的猫叫黑莓` 没有关键词也能写入），
  靠词汇包含度阈值（0.5）约束不被无关句蹭到；opt-out 立即撤销窗口
- 修掉的三个真实缺陷：`主人们家的…` 正文污染（改为 `/^我(?!们)/` 才改写）、
  `别记`/`不用记` 退出识别回归（安全红线）、裸「记住」/「记住吧」/「我记住了」/「记住吗？」
  不再产生候选（新增 `hasSubstantiveClaim` 与回忆问句判定）

### Phase 3 — 短期上下文（`src/conversation/context-budget.js` + runtime）

用户要求「不要简单改数字」，因此：

- 配置化：`SHORT_TERM_CONTEXT_TURNS`，默认 **48**（不是 50），上限由 token budget 动态决定
- `RecentConversation` 默认 48、上限 48、旧 maxTurns 校验与错误码不变、旧逻辑全保留
- **优先级裁剪**：HIGH（用户明确事实 / 宠物信息 / 关系信息）→ MEDIUM（近期与重复行为）
  → LOW（闲聊寒暄）；预算不足时**先删 LOW**，而不是从最旧开始截断
- **最近 6 轮永不被裁**（宠物不能忘记刚刚说的话）；输出保持时间顺序；纯函数、绝不抛异常
- 恢复路径修正：旧 `semanticHistory(48)` 最多只能重建 **24 turns**（48 条消息 ≈ 24 轮），
  改为按配置 `turns × 2 + 4` 计算，48 turns 需要 100 条消息

### Phase 4 — Reflection 调度与 Dream 输入

- Reflection 触发 = 既有 raw 记忆条件 **或** 新增的四类经验信号：
  A 新 experience 数（默认 10）/ B 显式记忆 / C 重复行为 / D 情绪事件
- 完成一次 Reflection 后把已消费的 buffer 行 `processed = 1`；**未完成/失败绝不标记**
- Dream：**生成逻辑、schema、阈值一行未改**，只把近期经验作为
  **非证据上下文段**（`src/experience/experience-dream-context.js` + 既有
  `visualContextProvider` 包装）注入，并附带声明：可用于理解近期生活，
  **不能作为 `source_ids`**，也不能凭一次出现就写成长期记忆

---

## 4. 可配置项（`config.json` → `memoryPipeline`，环境变量优先）

| 键 | 默认 | 环境变量 |
|---|---|---|
| `shortTermContextTurns` | 48 | `SHORT_TERM_CONTEXT_TURNS` |
| `shortTermContextChars` | 24000 | `SHORT_TERM_CONTEXT_CHARS` |
| `experienceBufferEnabled` | true | `EXPERIENCE_BUFFER_ENABLED` |
| `experienceBufferRetentionDays` | 14 | `EXPERIENCE_BUFFER_RETENTION_DAYS` |
| `reflectionOnExperience` | true | `REFLECTION_ON_EXPERIENCE` |
| `reflectionNewExperienceTrigger` | 10 | `REFLECTION_NEW_EXPERIENCE_TRIGGER` |
| `dreamRecentExperienceLimit` | 12 | `DREAM_RECENT_EXPERIENCE_LIMIT` |

非法值不抛异常：回落默认并写入 `diagnostics`（`…:invalid-env:fell-back-to-default`），
超范围则夹取（`clamped-min/max`）。

---

## 5. Migration 与 dry-run

`scripts/migrate-experience-buffer.mjs`（`npm run migrate:experience-buffer`）：

- **默认 DRY-RUN**：只读探查（`readOnly: true`，不产生 WAL/写事务），打印将创建什么
- `--apply` 才写；`CREATE TABLE IF NOT EXISTS` + 索引 + meta 表，单事务
- 建库后 `chmod 0600`
- **schema drift 拒绝执行**：表已存在但列集不符 → 打印缺失/多余列，exit 3，绝不「顺手修」
- 实测：空目录 dry-run（零写入）→ apply（schemaMatch=true, 0600）→ 再 dry-run（幂等 no-op）
  → 缺 sandbox（SANDBOX_MISSING）→ 漂移库（REFUSED, exit 3）

---

## 6. 测试结果（全部真实 exit code）

### 新增（`npm run test:experience-aware-memory`）

```
v0.4-experience-buffer                   exit=0
v0.4-context-budget                      exit=0
v0.4-explicit-memory-request             exit=0
v0.4-explicit-memory-controller          exit=0
v0.4-experience-consolidator             exit=0
v0.4-experience-dream-context            exit=0
v0.4-recent-conversation-50              exit=0
v0.4-experience-aware-memory-acceptance  exit=0
```

### 用户点名的 5 个验收用例（`test/v0.4-experience-aware-memory-acceptance.mjs`）

真实 `PetRuntime` + 临时 sandbox + stub Local Brain（不发模型调用、不碰生产数据）：

```
CASE_1_EXPLICIT_MEMORY_SURVIVES_20_TURNS=PASS   # 「记住我们家的猫叫黑莓」→ 20 轮闲聊 → recall 命中黑莓
CASE_2_REPEATED_BEHAVIOUR_CANDIDATE=PASS        # 三次「睡沙发」→ source_type=repeated_behavior
CASE_3_EXPLICIT_QUEUE_HIGH_PRIORITY=PASS        # 队列 entry priority=HIGH / source=USER_EXPLICIT
CASE_4_REFLECTION_CONSUMES_BUFFER=PASS          # Reflection 后 processed=1 且 pending 下降
CASE_5_DREAM_INPUT_INCLUDES_EXPERIENCE=PASS     # Dream 输入段含近期 experience
VC_AI_PET_V0_4_EXPERIENCE_AWARE_MEMORY_ACCEPTANCE=PASS
```

### 既有回归（全部 exit=0）

- core：`v0.2-core` `v0.2-memory-gate` `v0.3-recent-conversation` `v0.3-conversation-persistence`
  `v0.3-turn-orchestrator` `v0.3-dream` `v0.3-memory-truth` `v0.3-time-context`
  `v0.3-ui-presence` `v0.3-emotion-layer`
- long-life：`v0.4-raw-history` `v0.4-derived-evidence` `v0.4-long-life` `v0.4-inner-life-ui`
- visual-memory 1.2：`v0.4-visual-keyword-scorer` `v0.4-visual-scorer-phase1.2`
  `v0.4-visual-activity-compact` `v0.4-visual-presentation-cleanup` `v0.4-visual-routing-phase1.2`
  `v0.4-contextual-visual-recall-followup` `v0.4-visual-memory-acceptance-1.2`
- visual-memory 1.1：`v0.4-visual-memory-runtime-init` `v0.4-legacy-observation-import`
  `v0.4-visual-recall-followup` `v0.4-visual-recall-followup-runtime` `v0.4-visual-memory-acceptance-1.1`
- mobile/持久化：`v0.4-mobile-composer-polish` `v0.4-mobile-submission-recovery`
  `v0.5-chat-start-idempotency` `v0.5-mobile-reload-recovery`
- 完整 `npm run smoke`：**exit=0**（含 client bundle 构建与校验）

---

## 7. 数据库变化 / migration

```
NEW_DB=/home/vitamin_c/.local/share/vc-ai-pet/sandbox/experience-buffer.sqlite   ← 尚未在生产创建
NEW_TABLE=experience_events (+ experience_buffer_meta, 4 个索引)
PET_MEMORY_SCHEMA_CHANGED=NO
CONVERSATION_ARCHIVE_SCHEMA_CHANGED=NO
PRODUCTION_DB_MODIFIED=NO
MIGRATION_REQUIRED_ON_DEPLOY=YES
  （启动时 experienceBuffer.initialize() 自动建表；
    也可先跑 npm run migrate:experience-buffer -- --sandbox <dir>（dry-run）再 --apply）
```

---

## 8. RISK_REPORT

| 风险 | 等级 | 说明与缓解 |
|---|---|---|
| `experience_events` 是新增表，生产首次启动自动创建 | LOW | `CREATE TABLE IF NOT EXISTS`；迁移脚本可先 dry-run 审阅；DB 权限 0600 |
| 优先级裁剪可能让模型看不到某些中段闲聊 | MEDIUM | 最近 6 轮与 HIGH 事实永不裁剪；默认预算（24k 字符）下 48 turns 实测全保留，只有超预算才裁剪；异常回落到不裁剪的旧行为 |
| 恢复窗口从 48 条消息升到约 100 条消息 | LOW | 只影响内存中的 `RecentConversation` 重建，不动 archive；旧 `maxTurns:12` 调用点仍兼容 |
| Consolidator 可能把无关事件误判为重复 | MEDIUM | 阈值 0.4 经 8 组真实对照标定（无关句 0.00）；仍需 ≥2 个不同 conversationId；写入前查重；**宁可漏判不误合并** |
| 重复计数在进程内维护，重启后从 1 重新开始 | MEDIUM | Consolidator 按需扫描**已持久化行**，重启后退化为「每轮重新看一遍」，不丢数据，只是升级慢一轮 |
| 显式意图窗口（10 分钟）内可能覆盖后续相关句 | LOW | 词汇包含度阈值约束；opt-out 立即撤销；窗口过期自动失效；写入内容为逐字原话，不生成幻觉事实 |
| Dream 输入新增经验段可能影响生成风格 | MEDIUM | 生成逻辑/schema/阈值未改；只增加带声明的非证据段；**建议部署后观察一轮 Dream 输出质量** |
| 生产尚未部署 | — | 本阶段按用户要求不部署、不重启、不 push，等 review |

---

## 9. 未决事项

1. `recall('猫')` 单字查询仍为空——这是 meow-memory 分词行为，**不在本次范围**；
   已记住的事实能通过「猫叫什么」这类自然问法召回。
2. archive 无法复原当年 Local Brain 的真实 candidate，因此「低分候选」对历史事故的
   实际触发比例**无法验证**（审计已明确标注，未用构造数据冒充）。
3. 重复计数器的持久化（跨重启保留 occurrence 基线）是已知次优项，建议后续单独跟进。
