TASK=LIFE-P0-MEMORY-PIPELINE-AUDIT
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-life-experience
BASE_COMMIT=4a3b8ef
MODE=READ_ONLY

# Memory Pipeline V2 Phase 0 审计

审计范围是 `4a3b8ef` 生产基线及当前 worktree 中 Root 已加入的 Experience-aware 改动。当前 worktree 有并发未提交修改；因此凡是“改动前”行为均以 `git show 4a3b8ef:<file>` 复核，凡是“当前”行为均引用 worktree 行号。审计没有 git 写操作；生产 archive 只读打开；所有行为实验使用 `/tmp` 临时目录。

## 1. 当前 conversation 保存路径

实际公开入口不是 `chatTurn`，而是 `PetRuntime.startChatTurn()`；它由 `PetTurnManager.start()` 执行，并在普通文本路径调用 `PetRuntime.chat()`（`src/runtime/pet-runtime.js:702-737`，`src/runtime/pet-turn-manager.js:29-70`）。一条普通 owner 消息的路径是：

```text
startChatTurn
  -> PetTurnManager.start(run)
  -> PetRuntime.chat(ownerText, ..., {turnId})
  -> ConversationStore.appendMessage({role:'user', text:ownerText, turnId})
  -> SQLite raw_messages
  -> state.messages recent cache
  -> conversation-store.json
```

`chat()` 先在调用 Local Brain 前 append owner 消息（`src/runtime/pet-runtime.js:530-537`）。Brain 成功后，普通单气泡 assistant 以带 `turnId` 的 dialogue 写入；多气泡 assistant 逐条以 `kind='final'`、同一 `turnId` 写入（`src/runtime/pet-runtime.js:628-635`）。因此 Brain 失败时，owner 可能已经归档，而 assistant 不一定存在；`chat()` 的失败返回点是 `src/runtime/pet-runtime.js:549-550`。

`ConversationStore` 的路径和边界如下：

- 文件名常量为 `conversation-store.json` 与 `conversation-archive.db`，上限常量为 `CONVERSATION_MAX_MESSAGES=500`（`src/conversation/conversation-store.js:7-14`）。实例在 sandbox root 下组装两个路径（`src/conversation/conversation-store.js:342-345`）。
- 初始化时先读旧 JSON、规范化；创建 SQLite `raw_messages(sequence,id,role,payload)`；把仍在旧 JSON 的消息导入 archive，再按 sequence 从 SQLite 取最近 `maxMessages` 回填 `state.messages`（`src/conversation/conversation-store.js:356-405`）。
- append 的持久化顺序是先将保留原始 text 的 `raw` 插入 SQLite，再 push normalized message 到 `state.messages`，超过 500 时从头裁掉，最后原子写 JSON（`src/conversation/conversation-store.js:646-700`、`718-726`）。
- `state.messages` 是 normalized recent cache；`conversation-store.json` 是该 cache 的重启快照，不是完整 archive。`CONVERSATION_MAX_MESSAGES` 只裁 cache：normalize 时 `slice(-500)`（`src/conversation/conversation-store.js:311-315`），append 时 splice（`694-697`）。它不删除 `raw_messages`。
- archive 是可按 sequence 读取的原始消息源：`rawHistory()` / `rawHistoryAfterSequence()` 不走 recent UI 的 50 条限制（`src/conversation/conversation-store.js:426-452`）。普通 `list/history` 最多面向 UI 返回 50 条（`469-510`），recent visual resolver 可检查 cache 内最多 500 条（`478-490`）。

因此 archive 与 recent cache 的边界是“完整 raw append-only 证据”与“最多 500 条 normalized 工作/UI cache”。再往上还有两个更窄的模型上下文：当前 `RecentConversation` 配置窗口以及 `selectContextTurns()` 的字符预算（`src/runtime/pet-runtime.js:840-857`）。

## 2. `semanticHistory(48)` 的生成逻辑

基线的 `restoreRecentConversation()` 硬编码调用 `semanticHistory(48)`（`git show 4a3b8ef:src/runtime/pet-runtime.js` 中 `restoreRecentConversation`，约 572-576 行；当前 worktree 调用已移至 `src/runtime/pet-runtime.js:937-948`）。`semanticHistory(limit)` 只从 recent cache 取 `limit` 条消息，先过滤 `kind='activity'` 和 `kind='media_ref'`（`src/conversation/conversation-store.js:521-524`）。被过滤的是 kind，不是 assistant role；dialogue、final 及缺省 kind 会保留。

对 `assistant + kind='final' + turnId`：同一个 `turnId` 第一次出现时放进 `projected`；后续 final 不新增 entry，而是把 text 以换行合并，截到 1200 字符，更新时间、id，并使用最后一个 reasoning（`src/conversation/conversation-store.js:525-542`）。所以多气泡在语义层合成一个 assistant message，但每个气泡在最初的 `limit` 消息窗口中都占一个 slot。

随后 `restoreRecentConversation()` 再按 `turnId` 把 user 与 assistant replies 聚合；无 turnId 的旧消息走 legacy 配对；只对同时有 user 和 reply 的 entry 调用 `RecentConversation.append()`（`src/runtime/pet-runtime.js:949-983`）。

精确上限：

```text
48 messages / (1 user + 1 assistant) = 最多 24 个完整 turn
48 messages / (1 user + 2 final bubbles) = 最多 16 个完整 turn
```

activity/media_ref 虽会被 semantic filter 丢弃，但已先占用 `listForRecentVisualRecall(48)` 的输入 slot，所以只会使完整 turn 更少。若窗口从中间切入，还可能得到没有 user 或没有 reply 的不完整 entry；它们不会 append 到 RecentConversation。

改动前，`RecentConversation` 默认只有 12 turns、上限 32（`git show 4a3b8ef:src/conversation/recent-conversation.js:5-35`），且 runtime 明确 `new RecentConversation({maxTurns:12})`（`git show 4a3b8ef:src/runtime/pet-runtime.js` 约 105-106 行）。所以旧链路即使 `semanticHistory(48)` 理论上得到 24 个 turn，最终 RAM 工作集也只剩 12 个。

当前 Root 改动把 restore 请求按配置动态计算为 `max(48, shortTermContextTurns*2+4)`，并受 500 message cap 约束（`src/runtime/pet-runtime.js:939-947`）；`RecentConversation` 与模型 context budget 同样使用 resolved `shortTermContextTurns`（`src/runtime/pet-runtime.js:166-179`、`840-857`），配置分辨率在 `src/memory/memory-pipeline-config.js:133-144`。当前 `config.json:46-54` 的配置值仍是 48 turns，因此实际 restore 请求是 `48*2+4=100` messages，给多气泡/边界留 4 条余量；不是旧的硬编码 48。注意当前 `src/conversation/recent-conversation.js:1-3` 的常量上限也是 48，故本 worktree 实际是 48-turn 上限，不是 50-turn 上限；若产品要求 50，配置解析和 RecentConversation 上限仍需一起改，单改 restore 无法实现 50。

## 3. 哪些消息进入 MemoryGate

当前 `PetRuntime.chat()` 只有在 Brain 返回成功后才进入 Gate（`src/runtime/pet-runtime.js:540-550`）。调用条件是（`src/runtime/pet-runtime.js:588-604`）：

```js
const gate = effectiveVisionImage
  ? { status: 'skipped', reason: 'vision-context' }
  : ownerText.trim()
    ? this.memoryGate.consider(
        ownerText,
        result.rawMemoryCandidate ?? result.memoryCandidate,
        { messageId: ownerMessage?.id, explicitFallback: ... },
      )
    : { status: 'skipped', reason: 'empty-message' }
```

也就是说：vision turn 无论是否带文字，都跳过 MemoryGate；空白消息跳过；只有非空、非 vision 的 owner text 才把模型候选送入 Gate。`rawMemoryCandidate` 优先于已验证的 `memoryCandidate`，因为 raw 候选还携带 `remember=false` 或具体拒绝原因所需的信息。解析器保留 raw object（`src/brain/memory-candidate.js:299-325`），Local Brain 原样返回（`src/brain/local-brain.js:270-285`）。assistant 输出、图片观察不作为该 Gate 写入的 owner evidence；belief 路径也明确跳过 vision（`src/runtime/pet-runtime.js:551-555`）。

当前 Gate 自己的三个提前 return 是：

1. `userOptedOutOfMemory` → `user-opt-out`；
2. `containsSensitiveMemoryText` → `memory-sensitive-reject`；
3. `containsNonAssertion` → `not-owner-assertion`。

代码证据为 `src/memory/memory-gate.js:35-47`；非 assertion 正则（问号、如果/假如/比如、他说/你说、是不是/是否等）在 `src/memory/current-belief.js:5-13`。这三个 return 发生在 candidate validation/fallback 之前。

## 4. 显式记忆为什么没有形成 durable memory

### 4.1 真实 archive 交叉验证

对 `/home/vitamin_c/.local/share/vc-ai-pet/sandbox/conversation-archive.db` 使用 `new DatabaseSync(path,{readOnly:true})` 查询，没有写入。真实输出：

```text
TABLES raw_messages,sqlite_sequence
MATCH_COUNT 82
CANDIDATE_FIELD_LIKE_COUNT 0
```

archive 中能确认真实对话曾出现过相关请求和失败/恢复现象，例如：

```text
sequence 3192 user      那这只猫叫什么呢，你还记得吗
sequence 3196 assistant 这只猫叫黑莓呀，之前洗澡时还带着它呢～
sequence 4801 assistant 花花不知道猫咪叫什么名字哦，花花只记得它好可爱！
sequence 4802 user      你忘记我们家的猫猫叫什么了吗
sequence 4806 user      我们家的猫猫叫黑莓哦你要记住
sequence 4807 assistant 汪！记住啦！黑莓是猫猫的名字！
sequence 4810 user      黑莓是谁哇
sequence 4811 assistant 汪！黑莓是猫猫的名字呀！花花记得很清楚！
```

这说明真实会话确有“先不知道、后重新告诉、随后能答出”的现象，但 `raw_messages.payload` 只有消息 JSON；没有 `rawMemoryCandidate`、`memoryCandidate`、importance 或 confidence 字段，故真实 Local Brain 当年到底返回了什么 candidate，不能从 archive 复原。特别是“低分候选导致不兜底”对真实会话的发生与否，结论是**无法验证**，不能把 Root 的构造 candidate 探针当作真实模型输出。

### 4.2 候选根因逐项裁定

#### a) 短语覆盖缺口：成立（旧实现），当前已修复；不是精确句的唯一解释

基线 `userExplicitlyRequestsMemory()` 只匹配 `记住|记下来|记一下|记着|记好`（`git show 4a3b8ef:src/brain/memory-candidate.js:72-80`），所以 `不要忘`、`以后叫`、`以后知道` 的实测结果为 false；精确句“我们家的猫猫叫黑莓，你要记住”含“记住”，实测为 true。当前 `EXPLICIT_MEMORY_PHRASES` 已加入这些短语（`src/brain/memory-candidate.js:72-82`），且当前 `/tmp` 输出为：

```text
我们家的猫猫叫黑莓，你要记住 -> explicit=true
猫叫黑莓，不要忘             -> explicit=true
以后叫它黑莓                 -> explicit=true
你以后知道猫叫黑莓           -> explicit=true
我们家的猫叫黑莓             -> explicit=false
```

最后一条不是 bug：它是无 directive 的普通 assertion，当前由 explicit controller 的 follow-up window 覆盖。

#### b) fallback 白名单：成立于基线；是代码级丢弃路径，但真实发生于 archive 无法验证

基线 `EXPLICIT_FALLBACK_REASONS` 只有 `model-skip/content-invalid/evidence-invalid`，选择逻辑在 `git show 4a3b8ef:src/memory/memory-gate.js:10、27-31`；`importance-low`、`confidence-low`、`level-denied` 在 validator 中分别由 `src/brain/memory-candidate.js:276-281`（当前行号）拒绝，旧 Gate 随后在 `git show 4a3b8ef:src/memory/memory-gate.js:37-39` 直接 skipped。

旧逻辑的 `/tmp` 构造复现是：

```text
validate importance=1  -> importance-low; gate -> skipped
validate confidence=.5 -> confidence-low; gate -> skipped
validate level=soul    -> level-denied; gate -> skipped
validate remember=false -> model-skip; gate -> written
```

当前 Gate 已不再使用该白名单：失败 candidate 会在 `src/memory/memory-gate.js:45-53` 统一尝试 `explicitFallback` 或 `highPriorityMemoryCandidate`；当前每个独立 `/tmp` sandbox 的实际输出均为 `status=written, level=fact, explicit=true`，包括上述三种拒绝原因。因此 b 是基线缺陷、当前已修复；但“生产那次正是低分候选”仍**无法验证**。

#### c) directive 前缀剥离不足：成立于基线的内容污染；不是无写入主因，当前已修复

基线 `explicitMemoryStatement()` 只剥开头 directive，不剥句尾“你要记住”（`git show 4a3b8ef:src/brain/memory-candidate.js:86-92`）。基线 fallback 又用宽泛的 `evidence.startsWith('我')` + `slice(1)`（`git show 4a3b8ef:src/brain/memory-candidate.js:94-114`），会把“我们家的...”变成“主人们家的...”。Root 的实测输出也确认了这一点（`docs/DEVLOG_MEMORY_PIPELINE_V2.md:25-28`）。

但基线 Gate 最终把 candidate content 规范成 `主人说：${proposed.evidence}`（`git show 4a3b8ef:src/memory/memory-gate.js:32-35`），所以 c 主要污染内容，不能解释 candidate 为 model-skip 时为什么不落库。当前实现加入 leading/trailing directive、排除“我们”误判（`src/brain/memory-candidate.js:90-141、218-254`）。

#### d) level/content 语义与召回：不成立为“记不住”的根因

题设的 `fact + 主人明确要求记住：我们家的猫叫黑莓` 是当前 fallback 的保守内容形式，但基线对于“我们...”会因 `startsWith('我')` 判成 `user`，并且 Gate 实际写入的是 `主人说：${evidence}`；不能把题设中的 level 作为基线事实。

真实 `PetMemory` `/tmp` 实验写入 `fact / importance=3 / content=主人明确要求记住：我们家的猫叫黑莓`，输出为：

```text
recall('猫叫什么') -> 命中该行
recall('猫')       -> []
buildHistoricalRecallContext('猫叫什么').entries -> 命中，同一行 source=raw
prompt-builder 注入 -> system prompt 同时含“黑莓”、长期记忆行和 Historical Recall 行
```

对旧污染正文 `主人们家的猫猫叫黑莓，你要记住` 的同样实验，`recall('猫叫什么')` 和 Historical Context 也命中；`recall('猫')` 仍为空。原因是 `meow-memory` 的单字 query tokenize 为空；Root 已实测 `tokenize('猫')=[]`、`tokenize('猫叫什么')=["猫叫","叫什","什么"]`（`docs/DEVLOG_MEMORY_PIPELINE_V2.md:39-46`）。所以 d 的“任意猫问法都召回不了”不成立；仅“单字查询不命中”成立，但不是 durable write 根因。

### 4.3 Local Brain raw candidate 链路与三项待验证问题

Local Brain 并不要求模型返回 `remember=true` 才能把东西送到 Gate：`parseStructuredChatResponse()` 将 `parsed.memory` 保留为 `rawMemoryCandidate`，即使 validator 判为 model-skip（`src/brain/memory-candidate.js:299-325`）；`LocalBrain.reply()` 返回 raw 和 checked candidate（`src/brain/local-brain.js:270-285`）；runtime 以 raw 优先传给 Gate（`src/runtime/pet-runtime.js:588-603`）。当前 `/tmp` 伪造 `remember=false` 的输出是 `rawMemoryCandidate` 存在、`memoryCandidate=null`、Gate `written`，所以“model-skip 不能兜底”不成立。

- **a) 真实 Local Brain 返回 remember=true 且 confidence<0.72：无法验证。** 生产 archive 没有 candidate 字段，当前代码只能证明 validator 会以 `confidence-low` 拒绝（`src/brain/memory-candidate.js:273-281`），不能证明真实模型曾输出该组合。
- **b) Schema 下限错配：错配成立；“模型习惯性输出 importance=1 并稳定触发”无法验证。** `PET_CHAT_RESPONSE_SCHEMA`/instruction 允许或要求 remember=false 时 importance=1（`src/brain/memory-candidate.js:21-38、61-68`），validator 对 remember=true 要求 importance>=2（`src/brain/memory-candidate.js:276-279`）。这制造了合法 JSON Schema 与应用校验不一致的风险，但 archive 没有足够样本统计模型输出，不能推出“习惯性/稳定”。在基线一旦真的输出 1，b 的白名单会丢弃；当前 Gate 已对该拒绝 fallback。
- **c) level-denied 同样丢弃显式请求：基线成立，当前不成立。** 基线 level 不在 `LEVELS` 时返回 `level-denied`（`git show 4a3b8ef:src/brain/memory-candidate.js:126-133`），旧 Gate 不在白名单内，故 skipped；当前 Gate 的统一 fallback 已用四个独立 `/tmp` case 复现为 written。真实生产是否走过此分支仍无法验证。

## 5. Reflection trigger、调度、lease/window

基线 raw Reflection eligibility 是：取 `reflectionWindow().last_dream_time` 作为 checkpoint；从 `reflectionSourceRows({after,before:now})` 取源；raw source 数 `>=2` 或最老 source 年龄 `>=1小时` 即 eligible（`src/runtime/pet-runtime.js:81-100`；常量 `src/runtime/pet-runtime.js:37-40`）。`last_dream_time` 虽沿用 meow-memory 字段名，但窗口 id 是 `vc-ai-pet:reflection-window`（`src/memory/pet-memory.js:35-37、274-280`）。

调度层 `maybeRunReflection()` 还要求：没有 chat/dream/reflection in-flight；非 force 时 state 属于 idle/rest/curious/sleepy/sleep；距上次成功 Reflection 至少 30 分钟；然后调用注入的 eligibility，满足才调用 ReflectionEngine（`src/dream/dream-scheduler.js:10-20、642-725`）。force 只绕过 state/eligibility，不绕过 busy 和 30 分钟 interval。

ReflectionEngine 每次最多取 `REFLECTION_BATCH_SIZE=4` 个 new raw source，最多生成 `REFLECTION_DERIVED_MAX_PER_BATCH=1` 条 derived，related 最多 4，lease 30 分钟（`src/dream/reflection-engine.js:8-16、280-309`）。它先读取 window、筛 source、`claimReflection(owner,boundary)`；只处理前 4 个，成功后 `finishReflection(processedBoundary)`，剩余 raw 留给下一轮；模型失败则以旧 checkpoint finish，释放 lease 且不前移 checkpoint（`src/dream/reflection-engine.js:331-367、354-368、438-469`）。PetMemory 的 claim/finish 都委托 meow-memory window，lease 参数固定 30 分钟（`src/memory/pet-memory.js:274-287`）。

Root 新增的 experience-aware 条件位于 `src/runtime/pet-runtime.js:118-163`，由 scheduler 注入到 `src/runtime/pet-runtime.js:317-324`：

- A：pending Experience Buffer 数 `>= config.reflectionNewExperienceTrigger`，当前 `config.json:46-54` 为 10；
- B：pending 中任意 `sourceType='explicit_memory'`；
- C：任意 `sourceType='repeated_behavior'`；
- D：任意 `sourceType='emotion_event'`。

A/B/C/D 任一成立就把 `eligible` 置 true，但仍受 scheduler 的 busy/state/30min interval 和 ReflectionEngine 的“必须有合格 PetMemory raw source”不变量约束。Root 还在 `tick()` 中先跑 Experience consolidation，再跑 Deep Dream/Reflection（`src/runtime/pet-runtime.js:384-417`）。

## 6. Dream 当前读取哪些 source rows

`PetMemory.dreamSourceRows()` 与 `reflectionSourceRows()` 当前都委托同一个 `#rawSourceRows()`（`src/memory/pet-memory.js:243-249、646-662`）。过滤条件是：

```text
status = active
source_session = vc-ai-pet
isRawEvidenceRow(row) = true
importance >= 2
created_at 为 finite
after < created_at <= before
```

`isRawEvidenceRow()` 进一步拒绝 dream/reflection session、assistant/model role 和未确认 provenance（`src/memory/derived-evidence.js:7-13`）。边界是严格 `>` lower、`<=` upper，按 created_at 升序。

Dream eligibility 是至少 8 个未处理 raw source，或最老未处理 raw source 已 72 小时（`src/runtime/pet-runtime.js:46-66`；scheduler 常量 `src/dream/dream-scheduler.js:5-8`）。Deep Dream 的 scheduler 还要求：非 force 必须 sleep，连续睡眠至少 15 分钟；夜间窗口 22:30–08:00，白天 nap 需 45 分钟；成功后 cooldown 30 分钟（`src/dream/dream-scheduler.js:22-27、524-628`）。当前 Root 的 `deepDreamEligibility()` 本身是 sourceCount>0，但它被 Deep Dream scheduler 的睡眠/冷却条件包住（`src/runtime/pet-runtime.js:68-79`）。

Dream 与 Reflection 的源集合在当前代码层面相同，差异主要是调度阈值、批量和 checkpoint 消费方式：Dream 每 batch 最多 24 new、related 24、每 batch 最多 3 derived；Reflection 每 pass 最多 4 new、related 4、最多 1 derived（`src/dream/dream-engine.js:8-17、419-465`；`src/dream/reflection-engine.js:8-16、354-360`）。两者都只允许 source_ids 指向已给出的 PetMemory 行，Dream/Reflection 产出的行不会成为 raw source。

Root 的 Experience Buffer 接入点是 runtime 创建 `experienceAwareContextProvider`，在其中组合既有 visual context 和 `recentExperienceContext()`，再传给 DreamEngine/ReflectionEngine（`src/runtime/pet-runtime.js:290-315`）。`src/experience/experience-dream-context.js:15-18、70-80` 明确将 Buffer 渲染为“非证据上下文”，禁止把它当 source_ids。故 Dream 的 source selection、schema、gate、写入逻辑未改变；改变的是 prompt 增加一段带声明的最近经历。严格说“Dream 生成逻辑不变”应理解为生成/验证/持久化不变，而不是输入上下文字节完全不变。

## A. 显式记忆故障最终裁定

对用户报告的“先说记住，再紧接着只陈述事实，后来花花说不知道”这一具体链路，唯一主根因是：**旧实现没有把显式记忆意图跨 turn 传播；第二句“我们家的猫叫黑莓”没有关键词，因此旧 Gate 只能按普通消息处理，若模型返回 model-skip 就没有显式 fallback，最终不写 PetMemory。** Root 的 `/tmp` 验收证据明确记录了该顺序和 `gate skipped`（`docs/DEVLOG_MEMORY_PIPELINE_V2.md:89-95` 中的设计目标及 Root 验收记录；当前实现的对应修复是 `src/memory/explicit-memory-controller.js:7-17、131-182` 与 `src/runtime/pet-runtime.js:557-603`）。

次要因素有三项：

1. 旧 Gate 白名单对 `importance-low/confidence-low/level-denied` 不兜底（基线证据 `git show 4a3b8ef:src/memory/memory-gate.js:10、27-39`），但真实 archive 没有 candidate 字段，不能证明这次事故确由低分候选触发；
2. 旧 fallback 对“我们”误用 `slice(1)`、且不剥句尾 directive，造成 `主人们家的...` 内容污染（基线 `git show 4a3b8ef:src/brain/memory-candidate.js:86-114`；Root 实测 `docs/DEVLOG_MEMORY_PIPELINE_V2.md:25-28`）；
3. `recall('猫')` 的单字 query 天生无 token，不能作为“没有 durable memory”的判断依据（Root 分词实测 `docs/DEVLOG_MEMORY_PIPELINE_V2.md:41-46`；本审计 `/tmp` PetMemory 复现相同结果）。

当前修复后的真实 `/tmp` 输出证明：四个旧 Gate 拒绝原因都能写入 fallback；写入 `fact` 后 `recall('猫叫什么')` 命中，Historical Context 和 prompt-builder 注入均命中；只有 `recall('猫')` 为空。因此当前实现已消除上述“无关键词 follow-up + 不兜底”主链路，但生产 archive 无法证明历史 Local Brain 的具体 candidate。

## B. 升级影响面地图

### 必须新增

| 文件 | 作用 | 风险 |
|---|---|---|
| `src/experience/experience-buffer.js` | 14 天、SQLite `experience_events`、owner/pet/system 事件和 pending/processed 游标 | MEDIUM：新增持久化库、清理和并发边界，但不改旧 schema |
| `src/experience/experience-consolidator.js` | 跨至少 2 个 conversation、至少 2 次、时间跨度至少 1 天的重复经验规则沉淀 | HIGH：把事件提升为长期 raw 记忆，错误会污染 recall；当前阈值/写入在 `:117-137、185-219、243-299` |
| `src/experience/experience-dream-context.js` | 非证据 prompt 段和安全声明 | LOW：纯格式化，不产生 source_ids |
| `src/memory/explicit-memory-controller.js` | 显式 intent TTL 10 分钟、follow-up overlap 0.5 | MEDIUM：跨 turn 状态可能误关联，受 TTL/词法阈值约束 |
| `src/memory/explicit-memory-queue.js` | HIGH priority 显式入口的队列状态 | MEDIUM：队列与写入状态需防重复/丢失 |
| `src/memory/memory-pipeline-config.js` | 统一解析 context、retention、trigger 配置 | LOW：有 clamp/diagnostics，但配置错误会改变窗口 |
| `src/conversation/context-budget.js` | 48-turn/24k-char 工作上下文选择 | MEDIUM：优先级裁剪会改变模型看到的历史 |
| `scripts/migrate-experience-buffer.mjs` | archive 到 Experience Buffer 的增量 backfill | HIGH：迁移重复执行、时间边界和 provenance 需要审慎验收 |

### 必须修改

| 文件/函数 | 改动点 | 风险与理由 |
|---|---|---|
| `src/runtime/pet-runtime.js:118-163`、`:166-201`、`:384-417`、`:702-737`、`:937-983` | 统一配置；初始化 Buffer/Consolidator；chat 记录经历和显式 follow-up；tick 先 consolidation 再 scheduler；动态 restore | HIGH：runtime 是所有写入、上下文和后台任务的汇合点 |
| `src/memory/memory-gate.js:35-92` | 显式 fallback 不再只受旧白名单限制，并保留 opt-out/sensitive/non-assertion veto | HIGH：任何 Gate 改动都可能放宽长期记忆写入；必须维持 validation、duplicate 和 evidence 不变量 |
| `src/brain/memory-candidate.js:72-82、90-141、178-255` | 扩展 explicit phrases；安全剥离前后 directive；拒绝“我们”错误 slice；构造高优先级 candidate | HIGH：改变自然语言识别和 durable content，需回归敏感/否定/问句 |
| `src/conversation/recent-conversation.js:1-81` | 将短期窗口上限/默认值与 pipeline 配置对齐 | MEDIUM：直接改变 Local Brain 输入，且当前最大值仍为 48；若要 50 必须明确改上限 |
| `src/dsh/host-plugin.js:27-40` | 把 `rawConfig.memoryPipeline` 传给 runtime | MEDIUM：配置注入面变化，但旧配置保持默认兼容 |
| `config.json:46-54` | 声明 48 turns、24k chars、14 日 buffer、10 条 experience trigger 等默认部署值 | LOW：配置风险可由解析 clamp/diagnostics 降低 |
| `package.json:scripts` | 增加 experience-aware test/migration 命令 | LOW：只影响开发/运维入口 |

### 绝对不能动

- `PetMemory` schema、`pet-memory.db` 表结构及 `conversation-archive.db` 的 `raw_messages` schema：接口兼容要求明确禁止重写；只通过既有 `remember/rememberCandidate/rememberReflectionCandidate` 适配。
- Android/UI、网络、Local Brain 服务协议/调用边界、Tailscale：本任务是 memory pipeline，不应扩大到客户端、网络或模型服务变更；Local Brain 只读取现有 prompt/response contract。
- Dream/Reflection 的既有 source provenance、`isRawEvidenceRow`、derived `source_ids` 验证：它们是不变量，不可通过“把 buffer id 填进 source_ids”绕过。

### 让 Reflection 消费 Experience Buffer 的最小侵入方案

`PetMemory.rememberReflectionCandidate()` 要求 `source_ids` 非空且每个 id 最终能在 PetMemory 找到；`derivedEvidence()` 又要求至少一个已存在、confirmed、raw evidence row（`src/memory/pet-memory.js:336-390`，`src/memory/derived-evidence.js:38-49`）。因此 Experience Buffer 的 event id 不能直接作为 Reflection `source_ids`，否则违反既有不变量。

最小安全接入是两段式：

1. Buffer 只作为 `experienceAwareContextProvider` 的非证据上下文，并参与 eligibility；
2. 由规则沉淀器只把满足重复、跨 conversation、跨天条件且有 owner 原文证据的经验提升为普通 `source_session='vc-ai-pet'` 的 raw PetMemory 行，随后让既有 Reflection 读取这些真实 PetMemory row 并用它们的 id 作 source_ids。

Root 当前方案正是 `ExperienceConsolidator` 的这条路径：只扫描 owner rows（`src/experience/experience-consolidator.js:140-179`），稳定条件为至少 2 次、至少 2 个 conversation、至少 1 天（`:185-219`），写入时 provenance 标为 confirmed USER_STATEMENT（`:269-299`）。它是保持 schema、Reflection adapter 和 source-id 不变量的最小侵入方案，整体评价为**可接受但 HIGH 风险**：若 candidate 的 `evidence` 不是 owner 的逐字原文，或“重复行为”只是系统/视觉推断，却被标成 USER_STATEMENT，就会错误地把推断伪装成 raw 证据。落地前应保证该 provenance 只用于实际 owner statement；纯视觉/系统事件应保留非 raw provenance，或不要提升为 Reflection source。

## 未能确认的疑点

1. 生产 `conversation-archive.db` 没有模型 response metadata，无法确认真实 Local Brain 是否曾返回 `remember=true + confidence<0.72`、importance=1 或非法 level，也无法确认低分白名单路径是否就是某次历史事故的实际分支。
2. 当前 config/documentation 使用 48 turns；任务文字多次提到 50 turns。当前 `recent-conversation.js:1-3` 明确上限 48，是否要把产品目标定为 48 还是 50，需要 Root 做产品决策。
3. 当前 fallback 的 queue metadata `source=USER_EXPLICIT` 是 runtime/返回层 metadata；实际 PetMemory provenance 仍由 Gate/`rememberCandidate` 归一化。若后续审计或 UI 要按 source 精确区分显式请求，应先确认不改 schema 的 provenance 映射策略。
4. Root 的 consolidator 将重复 owner text 提升为 confirmed raw row 的语义边界需要测试覆盖；这决定“经验”是事实证据还是仅供 Reflection 的非证据上下文。
