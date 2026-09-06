# DEVLOG — Visual Memory Phase 1.1（Legacy Semantic Index + Recall Routing Fix）

Branch: `feat/visual-memory-phase1.1`
Base: `19b2c2cb932e128477f96c763e012474b4c3ecf5`（Visual Memory Phase 1，已部署生产）

## 背景：Android 真机长期视觉验收失败

生产部署后「你记得我之前给你发的那盆无花果吗」→「哪一张？」，「你还记得我之前
给你看的蜡笔小新吗」→「哪一张？」。只读诊断确认根因（详见
handoffs/vm-triage-android-ltv-deepseek-v4.md）：

- `ROOT_CAUSE=LEGACY_VISUAL_ROOTS_HAVE_NO_CONTENT_SEMANTIC_INDEX`：
  31 个历史图片 root 只索引了主人原话（user_text）；archive 里 15 条旧
  `visual_observation/visual_compare` 从未导入（visual_events=0）。
- 蜡笔小新等原话无内容词 → 索引零命中；无花果的「花果」bigram 被 stop 字「花」抑制。
- 单字通用词（给/发）造成 phantom tie → 并列分按 D-013 反问。
- 短追问（有很多无花果 / 那蜡笔小新呢）无时间词 → 不触发长期，掉到普通文字路径。

## 本轮交付

### A. Legacy safe observation 零模型导入（LUNA-01）

`src/vision/legacy-observation-importer.js`：只从 archive 的
`activityType=visual_observation/visual_compare` 导入，0 模型调用。映射保守：
单图 turn 直接映射；comparison turn 仅当 summary 明确关联 V0/V1/当前图片 且能
由 media_ref/visual_selected 顺序确定 visualId→attachment 才映射，否则 SKIP 绝不猜。
事件用 deterministic `event_id=legacy-<messageId>` 幂等去重；cursor 存 sync_state
（`legacy_observation_sequence`），restart-safe。

- 生产副本迁移：`LEGACY_OBSERVATIONS_TOTAL=15` / `MAPPED=10` / `SKIPPED_AMBIGUOUS=5`
- `VISUAL_EVENTS_IMPORTED=10`、`OBSERVATION_TERMS_IMPORTED=984`、`MODEL_CALLS=0`、幂等。
- 证据等级不变：user_text=raw，observation=inferred（权重 ×1）。

### B. keyword/scorer 修正（LUNA-02）

`src/vision/visual-keywords.js`：
- bigram stop 规则修正（D-017）：只有当 bigram 两侧都属 stop 才过滤；单侧 stop 的
  高信息 bigram（花果/无花/小新/蜡笔）保留。禁止硬编码具体词。
- 新增 `GENERIC_RECALL_TERMS` + `suppressGenericTerms` + `contentQueryTerms`：长期检索
  query 侧抑制「给/发/记/得/之/前/记得/之前/图片/那张/第一张」等 routing 套话
  （D-018）；Recent 的 overlapScore 语义不变。

`src/vision/long-term-visual-recall.js`：resolve 改用 `contentQueryTerms`。

生产副本 dry-run 结果：
- 无花果 Q → `matched`，top1=047fba61…，score=6；给/发 噪声 root 被压出 top（FIG_NOISE_CANDIDATES_DEMOTED=YES）。
- 蜡笔小新 Q → `matched`，winner=bb87fc0c…（shinchan 组，score=12，observation 词命中）；
  无关图全部 score=1，不再并列。

### C. 短追问 recall context（LUNA-03 + coordinator 接线）

`src/runtime/visual-recall-context.js`：ephemeral（RAM）`VisualRecallContext`，
TTL 30min / 最多 3 次，支持 topic_shift（那蜡笔小新呢 → 重写为完整长期问句）与
refine（有很多无花果 → 追加到上一 query）。

`pet-turn-orchestrator.js`：`runVisual` 增加 `followUp` 参数（用 gate 的 preResolve 结果）；
matched→clear、ambiguous→record、none(且 followUp)→clear；暴露
`recallContextActive/planFollowUp/clearVisualRecallContext`。

`pet-runtime.js`（coordinator）：startChatTurn 与 chat() 增加 follow-up gate——
仅当 recall context active 且 preResolve 找到候选才进视觉路径，否则清 context 落回文字
（「那晚饭呢」不误触发；「花花你好」零视觉开销）。

## 明确不做 / deferred

- `ASSISTANT_HINT=DEFERRED`：legacy observation 导入 + scorer 修正后语义覆盖
  22/31 → 25/31，剩余 6 个无语义 root 主要是 comparison 第二张/空文本图（低价值），
  引入 assistant retrieval_hint 的误召回风险 > 收益，故本轮不实现。
- `LEGACY_LAZY_VLM_BOOTSTRAP=DEFERRED`（OPTION C，本轮禁止动态重扫 VLM）。
- 未做：批量 VLM / Vector DB / embedding / initiative / Dream 新功能 / 管理页面 /
  timestamp UI bug / Activity Trace 精简。

## 不变式（回归锁定）

- 原图重开：候选无论来自 owner_text/observation，最终回答仍必须
  `readAttachmentDataUrl → Local Brain Vision`。
- missing asset：诚实「无法重新确认」，不用旧 observation/hint 冒充。
- Recent Visual > Long-Term Visual；「刚才的面」仍走 Recent。
- Multi-Visual A→B→A PASS；comparison min unique=2 PASS；MAX_VISUAL_INSPECTIONS_PER_TURN=5 PASS。

## 验证（sandbox + 生产只读副本，生产数据零改动）

- `test/v0.4-legacy-observation-import.mjs`（A/B/C 零模型/幂等/保守映射）
- `test/v0.4-visual-keyword-scorer.mjs`（bigram 保留 + generic 抑制 + 无花果/蜡笔小新 top1）
- `test/v0.4-visual-recall-followup.mjs`（orchestrator 级 F/G/H + 生命周期）
- `test/v0.4-visual-recall-followup-runtime.mjs`（pet-runtime gate 端到端）
- `test/v0.4-visual-memory-acceptance-1.1.mjs`（生产副本迁移 + 无花果/蜡笔小新 dry-run）
- 回归全绿：Phase 1 全部 v0.4 测试、`npm run smoke`（含 client build/verify）、`npm run test:long-life`。

## Production Wiring Closure

`ff91c7c` 已实现并测试 `importLegacyObservations()`，但此前的
`PetRuntime.initialize()` 只执行 `syncVisualExperiences()`，没有进入 legacy
observation importer；原有 importer 测试直接调用函数，因此没有覆盖真实生产初始化路径。

本次只做最小 source wiring：在 ConversationStore 与 VisualExperienceStore
初始化、`syncVisualExperiences()` 完成之后，使用同一组 archive reader 和
`visualTermsFor(..., { boost })` 接入 `importLegacyObservations()`。初始化迁移仍为
zero-model-call，legacy observation 继续使用 `source_kind=observation`、
`evidence=inferred`、`boost=1`，并依赖既有 cursor、deterministic event id 与去重逻辑。

若 migration 整体出现异常，runtime 只通过安全 diagnostics logger 输出受限 error
code，不暴露 prompt、图片数据或模型内部内容；成功结果则明确记录 total、mapped、
各类 skipped 数量与 modelCalls，避免把失败伪装成完成或把 ambiguous skip 伪装成失败。

新增 `test/v0.4-visual-memory-runtime-init.mjs`，只通过
`new PetRuntime(...).initialize()` 验证：

- sync 在 legacy import 之前执行；
- 首次初始化导入 observation、重启不重复；
- 新 archive activity 只被增量导入；
- ambiguous comparison 被记录为 completed/skipped；
- importer 异常被记录为 failed，且不使 runtime 初始化崩溃。

## 状态

`FINAL_STATUS=READY_FOR_PRODUCTION_DEPLOYMENT`
`PRODUCTION_DATA_MODIFIED=NO` / `PRODUCTION_CHAT_CREATED=NO` / `PRODUCTION_DREAM_RUN=NO` /
`PRODUCTION_DEPLOYED=NO`（由后续 deployment closure 处理生产）。
