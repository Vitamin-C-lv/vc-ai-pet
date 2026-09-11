# VC AI Pet — Project State

Status: FINAL_STATUS=HOUSEHOLD_IDENTITY_PHASE1B_1_CLI_HARDENING_COMPLETE

## 2026-09-11 — Household Identity Phase 1B.1 TTY CLI Lifecycle Hardening

基于 `ae160578d4ff2b3a003239daaa383ce0920b4210`，本轮只修复
`identity:create-person` 的真实 TTY hidden-password reader。`askHidden()` 现在在进入时
快照 `stdin.isRaw` 与 `stdin.readableFlowing`，退出时幂等地先移除 listener、恢复 raw
mode、仅在进入前不是 flowing 时 `pause()`，并只写一个换行；Enter、Ctrl+C、decoder/TTY
异常与 reject 都走同一恢复路径。输入使用 `StringDecoder('utf8')`，退格按 JS Unicode
code point 删除；没有增加 `--password`、环境变量密码或 pipe password 模式。

新增 `test/v0.6-identity-cli.mjs`，使用系统已有 `script` pseudo-TTY 在 5 秒边界内覆盖
no-TTY 拒绝、ASCII 创建、确认不一致无 DB 行、Ctrl+C 自然退出、密码不回显，以及首个
UTF-8 多字节序列跨写入分段后的创建与 `IdentityStore.verifyPassword()`。本轮未改
IdentityStore/schema/crypto、HTTP/runtime、Android/network，也未创建 production identity DB。

```text
BASE_COMMIT=ae160578d4ff2b3a003239daaa383ce0920b4210
IDENTITY_STORE_MODIFIED=NO
IDENTITY_SCHEMA_MODIFIED=NO
IDENTITY_CRYPTO_MODIFIED=NO
PRODUCTION_DB_MODIFIED=NO
DEPLOYED=NO
```

## 2026-09-11 — Household Identity Phase 1B Foundation

基于 production lineage `4a3b8ef91d6fa806616a4b29825405b8fe02d938` 新建
`feat/household-identity-phase1b`。本轮仅新增独立 `identity.sqlite` 的 Person Registry
基础：`schema_migrations`、`people`、`credentials`、`sessions`、`guest_devices`，以及
受控 `identity:create-person` CLI。没有默认账户，没有 production sandbox 写入；CLI 必须
显式给出 `--sandbox-root`，且只在 TTY 内无回显读取/确认密码。

密码使用 Node built-in `crypto.scrypt`（versioned `N=32768,r=8,p=1,keyLength=64`、32-byte
random salt、`timingSafeEqual`）；本机一次 scrypt 实测约 88 ms。人类账号创建在单个 SQLite
事务内完成 person 与 credential 写入，用户名规范化为小写并以 `lower(username)` partial
unique index 保证大小写无关唯一；人员只可 disable，不提供 public hard delete。Session 与
guest device 仅建 schema，尚未实现 HTTP auth、cookie、guest bootstrap 或 actor provenance。

临时 sandbox 测试确认 `identity.001` 两次初始化不重复、identity DB mode 为 `0600`、无默认
账号、scrypt verify/disabled rejection/safe DTO 均正确；`conversation-archive.db`、
`visual-experience.db`、`memory/pet-memory.db` fixture 未被改写。既有 smoke、chat-start
idempotency、visual-memory、client bundle 回归通过。未修改 Android、LAN/network、runtime、
conversation、visual、PetMemory、Dream；未 deploy/restart。

```text
BASE_COMMIT=4a3b8ef91d6fa806616a4b29825405b8fe02d938
BRANCH=feat/household-identity-phase1b
MIGRATION_ID=identity.001
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
NEXT_PHASE=1C_SESSION_AUTH_AND_ACTOR_CONTEXT
```

## 2026-09-09 — Visual Canonical Deduplication on Current Production Lineage

基于当前正式 lineage `819fb2ce33013c86ae2ccfb56bdad2dfa8d6e60a` 建立
`feat/visual-canonical-dedup-current`，仅 transplant 已审查的
`c1a4b1ea7673de51de62d26a7ef53a91a99d26c9` Visual Canonical Dedup 变更。本轮不重写
dedup 算法，不修改 Tailscale、Android endpoint、submissionId、Composer、Dream toggle、LAN
或 Local Brain。UI 冲突保留当前 production navigation/composer/recovery/header 行为，再叠加
occurrenceCount、lastOccurredAt、visual-gallery-occurrences 与 Gallery detail occurrence
rendering；backend 仅落在 Visual Experience、Visual Gallery、Visual Dream Context、Visual
Recall、Visual Working Session 与 Pet runtime/orchestrator integration。

```text
BASE_COMMIT=819fb2ce33013c86ae2ccfb56bdad2dfa8d6e60a
SOURCE_DEDUP_COMMIT=c1a4b1ea7673de51de62d26a7ef53a91a99d26c9
BRANCH=feat/visual-canonical-dedup-current
LINEAGE_STATUS=AHEAD_BEHIND_CHECK_REQUIRED
ANDROID_COMPANION_MODIFIED_BY_DEDUP=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
```

冲突处理只涉及 `PROJECT_STATE.md` 文档；代码冲突按 current production 版本保留并叠加
dedup additions。migration preview 继续只使用 sandbox/temp DB，保持
`MODEL_CALLS=0`、`PET_MEMORY_WRITES=0`、`DREAM_RUNS=0`。

## 2026-09-09 — Conservative Perceptual Dedup Gate After Real Production-Copy Review

基于 `38b60954d38e1cfa6f34779518b7139bb1cb2e0f` 收紧通用 visual fingerprint gate，禁止
针对 G05、attachment、owner text 或蜡笔小新做 special-case。默认阈值从 `4/4/0.02`
改为 `1/1/0.005`，仍保持 model-free、fail-closed 的 PERCEPTUAL matching。

真实 production-copy `41` roots 重新 preview：G05 candidate
`530979ae-e78f-43b6-9913-16ed3eb7cb88` 不再进入 duplicate group；G07 的
`pHash=0,dHash=1,aspect=0` near-duplicate 仍进入 group。新增 regression 覆盖
added-object gate `pHash=2,dHash=4,aspect≈0.0123` 的 NO-MERGE，以及高置信 near-duplicate
的 YES-MERGE。普通 resize fixture 在新 gate 下实测 `pHash=2,dHash=0,aspect=0`，因此保留
真实 FAIL 结果，不为让 fixture 通过而放宽阈值。

```text
SOURCE_COMMIT=38b60954d38e1cfa6f34779518b7139bb1cb2e0f
PREVIOUS_THRESHOLDS=4/4/0.02
NEW_THRESHOLDS=1/1/0.005
G05_FALSE_MERGE_REGRESSION=PASS
G05_GROUPED=NO
G07_HIGH_CONFIDENCE_DUPLICATE=PASS
G07_GROUPED=YES
RESIZED_DUPLICATE=FAIL
MODEL_CALLS=0
PET_MEMORY_WRITES=0
DREAM_RUNS=0
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
FINAL_STATUS=PERCEPTUAL_THRESHOLD_REVIEW_REQUIRED
```

## 2026-09-09 — Conservative Two-Gate Perceptual Matching

在不放宽 strict gate 的前提下，新增独立的 resize-safe gate：strict 为
`pHash<=1,dHash<=1,aspect<=0.005`，resize-safe 为
`pHash<=2,dHash<=1,aspect<=0.001`。匹配关系是 `strict OR resize-safe`。内部 reason
区分为 `PERCEPTUAL_STRICT` / `PERCEPTUAL_RESIZE_SAFE`，对外 occurrence 继续返回
`duplicateKind=PERCEPTUAL`，并提供 `perceptualGate=strict|resize-safe`，保持既有 API
contract。没有 G05、attachment、owner text 或动画 special-case。

dedup fixture 重新确认 exact、re-encode、metadata 与 ordinary resize 均通过；resize
实测 `pHash=2,dHash=0,aspect=0` 使用 `resize-safe` gate。G05 boundary
`2/4/~0.0126`、`2/2/0`、`2/1/>0.005` 与 `3/0/0` 均拒绝。新鲜 production-copy
包含 `41` roots：G05 不再分组，G07 的 `0/1/0` strict near-duplicate 保持分组。
唯一非 EXACT group 为 G07，contact sheet 人工复核未发现明显内容变化。

```text
BASE_COMMIT=819fb2ce33013c86ae2ccfb56bdad2dfa8d6e60a
SOURCE_COMMIT=096845609497daad1e93756d7f2825c85688b101
STRICT_GATE=1/1/0.005
RESIZE_SAFE_GATE=2/1/0.001
ROOTS_BEFORE=41
DUPLICATE_GROUPS=10
ROOTS_AFTER_CANONICAL_VIEW=26
EXACT_GROUPS=9
STRICT_PERCEPTUAL_GROUPS=1
RESIZE_SAFE_PERCEPTUAL_GROUPS=0
G05_GROUPED=NO
G07_GROUPED=YES
FALSE_MERGE_FOUND=NO
SECOND_APPLY_ALIASES_CREATED=0
SECOND_APPLY_OCCURRENCES_CREATED=0
SECOND_APPLY_NEW_ROOT=0
MODEL_CALLS=0
PET_MEMORY_WRITES=0
DREAM_RUNS=0
ANDROID_COMPANION_MODIFIED_BY_DEDUP=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
FINAL_STATUS=READY_FOR_VISUAL_DEDUP_PRODUCTION_MIGRATION_REVIEW
```

## 2026-09-08 — Final Idempotency TTL Alignment Fix

基于用户指定的 `dcb6c6095ef5eeeef76549135d2f46be465a9db0` 在独立 worktree
`fix/chat-start-idempotency` 上只做本轮 TTL 对齐。既有提交身份仍位于页面
生命周期之外的 host-lifetime `/api/pet/chat/start` 边界：前端每次显式发送生成独立
`submissionId`，服务端 host-RAM registry 记录 `submissionId -> turnId` 与
`message + attachmentId` fingerprint；同 ID 同 payload 返回同一 turn 且不会再次
调用 `runtime.startChatTurn`，同 ID 不同 payload 返回 409
`SUBMISSION_ID_CONFLICT`。registry 为最多 256 条、10 分钟 TTL 的 LRU/TTL 内存
结构，不进入 ConversationStore、PetMemory 或 Visual DB；既有 PetTurnManager
TTL 为 15 分钟且本轮不修改，故 server idempotency TTL 与前端 pending max age
均不超过后端 turn 生命周期。Pet Host 重启后的全局 exactly-once 不作保证。

mobile submission state 现在把 pending submission 的非敏感元数据写入
`localStorage`：保存 transport metadata + pending user message text，即 schema、
submissionId、message、attachmentId、stage、turnId、after、createdAt 与 hasImage；
不保存图片 base64、tokens、CoT 或 secrets。
`PRE_UPLOAD` 的图片仍只在 RAM，reload 后清除并提示重新选择；`UPLOADED` 复用
attachmentId；`START_IN_FLIGHT`/`START_ACCEPTANCE_UNKNOWN` 用同 submissionId 做
start reconciliation；`TURN_ACCEPTED` 直接复用同 turnId/after poll。完成或
`TURN_FAILED` 清除 pending；过期 pending 清除且不自动 start。accepted poll 保留
1s/2s/4s 最多三次 bounded same-turn retry，耗尽后显式继续等待仍只 resume 同一
turn。确认的 legacy 404/405 只给未带 submissionId 的旧客户端使用，ambiguous
start 不走 legacy fallback。

`test/v0.5-chat-start-idempotency.mjs` 覆盖 N–Q、AA、Z 的真实 LAN HTTP registry、409
conflict、distinct submission、LRU/TTL 与双客户端竞态；
`test/v0.5-mobile-reload-recovery.mjs` 覆盖 R–Z、AB 的 localStorage reload/restart
fixture、附件复用、同 turn/cursor、PRE_UPLOAD 重新选择、完成/失败清理与 stale
清理。既有 A–M、composer autosize/Plus/Send/IME/Emoji、navigation、Dream/Gallery、
Visual、diagnostics、turn orchestrator 与 client bundle 校验继续通过。

FINAL_STATUS=READY_FOR_GITHUB_FINAL_REVIEW
BASE_COMMIT=dcb6c6095ef5eeeef76549135d2f46be465a9db0
BRANCH=fix/chat-start-idempotency
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-chat-start-idempotency
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
SUBMISSION_ID_GENERATION=CRYPTO_RANDOM_UUID_WITH_SECURE_RANDOM_TIME_COUNTER_FALLBACK
SUBMISSION_ID_PERSISTED=LOCALSTORAGE_CONTENT_TRANSPORT_METADATA_PLUS_PENDING_USER_MESSAGE_TEXT
SUBMISSION_ID_REUSED_AFTER_RELOAD=YES
SERVER_IDEMPOTENCY_REGISTRY=HOST_RAM_SUBMISSION_ID_TO_TURN_ID_AND_FINGERPRINT
SERVER_IDEMPOTENCY_BOUNDED=MAX_ENTRIES_256_LRU
SERVER_IDEMPOTENCY_TTL=10_MINUTES
PET_TURN_MANAGER_TTL=15_MINUTES
PET_TURN_MANAGER_MODIFIED=NO
PENDING_SUBMISSION_MAX_AGE=10_MINUTES
IDEMPOTENCY_TTL=10_MINUTES
TTL_ALIGNMENT=PASS
STALE_TURN_REPLAY=NO
LOCALSTORAGE_CONTENT=transport metadata + pending user message text
LOCALSTORAGE_USER_MESSAGE_TEXT=YES
LOCALSTORAGE_IMAGE_BASE64=NO
NO_IMAGE_BASE64=YES
NO_TOKEN=YES
NO_COT=YES
NO_SECRET=YES
SAME_SUBMISSION_SAME_TURN=PASS
SAME_SUBMISSION_START_CALL_COUNT=1
SUBMISSION_PAYLOAD_CONFLICT=HTTP_409_SUBMISSION_ID_CONFLICT
DIFFERENT_SUBMISSION_SAME_PAYLOAD=DISTINCT_TURNS
START_IN_FLIGHT_RELOAD=IDEMPOTENT_RECONCILIATION
START_UNKNOWN_RELOAD=IDEMPOTENT_RECONCILIATION
TURN_ACCEPTED_RELOAD=SAME_TURN_AND_AFTER
UPLOADED_RELOAD=SAME_ATTACHMENT_ID_NO_UPLOAD
ATTACHMENT_REUPLOAD_AFTER_RELOAD=NO
PENDING_STORAGE_CLEARED_ON_COMPLETE=YES
PENDING_STORAGE_CLEARED_ON_FAIL=YES
STALE_PENDING_CLEARED=YES
LEGACY_FALLBACK_AMBIGUOUS_START_DUPLICATE=NO
CROSS_WEBVIEW_RELOAD_DUPLICATE_TURN=NO
CROSS_APP_RESTART_DUPLICATE_TURN=NO
CROSS_PET_HOST_RESTART_EXACTLY_ONCE=NOT_GUARANTEED
GLOBAL_EXACTLY_ONCE_CLAIMED=NO
CASE_A_TO_M=PASS
CASE_N_TO_Z=PASS
CASE_A_TO_Z=PASS
CASE_AA=PASS
CASE_AB=PASS
VISUAL_MEMORY_MODIFIED=NO
DREAM_MODIFIED=NO
PET_MEMORY_MODIFIED=NO
LOCAL_BRAIN_MODIFIED=NO
LAN_TOPOLOGY_MODIFIED=NO
ANDROID_NATIVE_MODIFIED=NO
PRODUCTION_DEPLOYED=NO

## 2026-09-08 — Composer Transport Ambiguity Final Fix

基于用户指定的 `cc8d743f5198e6e4359b1ca046cc80c198fe27b6` 继续在独立
worktree 修复 mobile composer transport recovery。本轮调查确认 `/api/pet/chat/start`
先完成 handler 校验，再调用 `runtime.startChatTurn`；`PetRuntime` 委托
`PetTurnManager.start`，而 `PetTurnManager` 会在异步 run 开始前先把 turn 放入内存
Map，随后 handler 才返回 202/turnId。因此 start 请求发出后的 response loss 不能
被推断为未创建 turn。现有 handler 没有可安全关联的 turn-list/reconciliation API，
本轮不猜测、不修改后端，而是让前端对未知 ownership fail closed。

submission state 现在明确区分 `PRE_UPLOAD`、`UPLOADED`、`PRE_START`、
`START_IN_FLIGHT`、`START_ACCEPTANCE_UNKNOWN`、`TURN_ACCEPTED`、
`TURN_COMPLETED` 与 `TURN_FAILED`。start 之前明确可证明的 validation/transport
unavailable/capacity rejection 才能安全回滚；generic 5xx、无 HTTP response、无效
start response 均保留 optimistic owner bubble，清空但不恢复为可发送 draft，保留
RAM 中的 uploaded attachment，禁止 automatic start/upload。accepted poll 的
transport error 只按 1s/2s/4s 最多三次 bounded same-turn retry，保存并复用同一
`turnId` 与 `after` cursor；耗尽后保持 paused，`继续等待` 仅调用同一 turn 的
explicit resume。`TURN_FAILED` 仍保留 owner bubble，不自动重复发送。

没有修改 ConversationStore semantics、Chat backend API、PetTurnManager、Visual
Memory、Dream、PetMemory、Local Brain、LAN topology 或 Android native，也没有
production deploy。

FINAL_STATUS=READY_FOR_GITHUB_REVIEW
BASE_COMMIT=cc8d743f5198e6e4359b1ca046cc80c198fe27b6
BRANCH=fix/composer-failure-recovery
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-composer-failure-recovery
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
AMBIGUOUS_START_ACCEPTANCE_HANDLED=PASS
START_IN_FLIGHT_STATE=PASS
START_UNKNOWN_AUTO_RESEND=NO
START_UNKNOWN_DRAFT_RESTORED=NO
ACCEPTED_POLL_BOUNDED_RETRY=PASS
ACCEPTED_POLL_RETRY_START_COUNT=0
EXPLICIT_RESUME_SAME_TURN=PASS
ATTACHMENT_UPLOAD_COUNT_ON_FAILURE_RETRY=1
ATTACHMENT_REUSED=YES
AUTOMATIC_DUPLICATE_TURN=NO
SERVER_TURN_FAILED_DUPLICATE=NO
CASES_A_TO_H=PASS
CASES_I_TO_M=PASS
PRODUCTION_DEPLOYED=NO

`test/v0.4-mobile-submission-recovery.mjs` 现在覆盖 A–M：包含 response lost
unknown、unknown ordinary submit no new start、accepted bounded retry same turn/
cursor、eventual completion、retry exhaustion 与 explicit resume；既有
autosize、Plus/Send、IME、Emoji、文字/图片路径继续通过。完整 smoke 等价 Node
子命令、客户端构建、`lib/client.js` 语法检查和 bundle 校验均已通过；真实
Android/生产验收不属于本轮边界。

## 2026-09-08 — Composer Failure Recovery Correctness Fix

基于用户指定的 `3d53660ea923bc7ba0cdd795dc30182b4f1fabc4` 建立独立
worktree。本轮只调整 mobile frontend submission state/recovery：明确
`PRE_UPLOAD`、`UPLOADED`、`TURN_ACCEPTED`、`TURN_COMPLETED` 与终态
`TURN_FAILED`；pre-accept 失败回滚 optimistic user bubble 并恢复草稿/图片；
已上传的 attachment 在 start 前显式重试时复用；已接收 turn 的网络失败保留
同一 `turnId` 并在重新连接时继续 poll。没有修改 ConversationStore semantics、
Chat backend API、PetTurnManager、Visual Memory、Dream、PetMemory、Local Brain、
LAN 或 Android native，也没有 production deploy。

FINAL_STATUS=READY_FOR_GITHUB_REVIEW
BASE_COMMIT=3d53660ea923bc7ba0cdd795dc30182b4f1fabc4
BRANCH=fix/composer-failure-recovery
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-composer-failure-recovery
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
PRE_ACCEPT_FAILURE_RECOVERY=PASS
OPTIMISTIC_BUBBLE_ROLLBACK=PASS
UPLOAD_RETRY_COUNT=1
ATTACHMENT_REUSED=YES
TURN_ACCEPTED_TRACKING=PASS
POLL_FAILURE_REUSES_TURN_ID=PASS
AUTOMATIC_DUPLICATE_TURN=NO
SERVER_TURN_FAILED_DUPLICATE=NO
TEXT_IMAGE_SUCCESS=PASS
AUTOSIZE_REGRESSION=PASS
PLUS_SEND_REGRESSION=PASS
IME_REGRESSION=PASS
EMOJI_REGRESSION=PASS
CHAT_BACKEND_MODIFIED=NO
PRODUCTION_DEPLOYED=NO

新增 `test/v0.4-mobile-submission-recovery.mjs` 覆盖 upload 前失败、已上传
start 前失败重试、accepted 后同 turn 恢复、server `TURN_FAILED`、optimistic
bubble 数量、图片上传次数与 attachment id 复用；既有
`test/v0.4-mobile-composer-polish.mjs` 的 autosize、Plus/Send、IME、Emoji
与文字/图片路径继续通过。客户端构建与 bundle 校验通过；真实 Android/生产
验收未运行。

## 2026-09-08 — Android UI Acceptance Small Fix: Composer + Chat Header

基于用户指定的 `5b968f6a86acb8d8211861871b4391f7562367c6` 建立独立
worktree。本次只调整移动端 Chat composer 的 Plus/Send 分离、textarea
autosize、emoji 插入辅助、现有图片选择器接线，以及 Chat sticky header/shell
的 CSS 特异性与布局；复用现有 upload、attachmentId、chat start/turn 和视觉
渲染链路。没有部署生产，也没有修改导航协议、Chat 后端、Visual Memory、Dream、
PetMemory、Local Brain、LAN 或 Android native shell。

FINAL_STATUS=READY_FOR_PRODUCTION_DEPLOYMENT
BASE_COMMIT=5b968f6a86acb8d8211861871b4391f7562367c6
BRANCH=feat/mobile-ui-composer-polish
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-mobile-ui-composer-polish
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE_STATUS=CLEAN_AFTER_COMMIT
TEXTAREA_AUTOGROW=PASS
TEXTAREA_AUTOSHRINK=PASS
TEXTAREA_RESET_AFTER_SEND=PASS
TEXTAREA_MAX_HEIGHT=132
PLUS_ALWAYS_VISIBLE=PASS
SEND_VISIBLE_EMPTY=PASS
SEND_VISIBLE_TEXT=PASS
SEND_VISIBLE_IMAGE=PASS
SEND_VISIBLE_TEXT_AND_IMAGE=PASS
TEXT_THEN_IMAGE=PASS
IMAGE_THEN_TEXT=PASS
TEXT_DRAFT_PRESERVED=PASS
ATTACHMENT_PRESERVED=PASS
SECOND_IMAGE_UPLOADER_CREATED=NO
CHAT_API_MODIFIED=NO
EMOJI_INSERT_AUTOSIZE=PASS
IME_GUARD=PASS
CHAT_HEADER_WHITE_FRAME_REMOVED=PASS
CHAT_HEADER_TITLE_CENTERED=PASS
CHAT_HEADER_STICKY=PASS
SAFE_AREA=PASS
NAVIGATION_REGRESSION=PASS
GALLERY_REGRESSION=PASS
DREAM_REGRESSION=PASS
VISUAL_PRESENTATION_REGRESSION=PASS
PET_MEMORY_MODIFIED=NO
VISUAL_DB_MODIFIED=NO
DREAM_LOGIC_MODIFIED=NO
LOCAL_BRAIN_MODIFIED=NO
LAN_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
ANDROID_MANUAL_ACCEPTANCE=NOT_RUN

纯 VM/假 DOM 的 `test/v0.4-mobile-composer-polish.mjs` 覆盖 A–M 行为；现有
mobile navigation、Dream/Gallery、Visual Presentation Cleanup、Visual Memory
1.2、Visual Memory 及 smoke 等价 Node 命令全部通过。浏览器 computed-style
探针也确认 `#chat-view` padding 为 `0px`、Chat header 使用页面暖色背景且无
shadow/radius、三列为 `44px 1fr 44px`、标题居中、composer 为 flex、隐藏 Send
仍预留固定槽位。真实 Android 设备/键盘接受测试仍留在部署前手工边界。

## 2026-09-07 — Mobile UI / Navigation Redesign

基于 contextual visual recall follow-up 的只读基线建立独立 worktree。本次只改
移动端 UI、逻辑导航、composer 接线和静态图标服务；Home 宠物卡、聊天消息/
thinking/visual activity/media_ref、Dream/Gallery 内容语义与已有图片发送链路
保持不变。没有部署生产服务，也没有修改 Android、数据库或 PetMemory。

FINAL_STATUS=READY_FOR_PRODUCTION_DEPLOYMENT
BASE_COMMIT=fdc3dcb42b694b076f635516822e84eaaae648ef
BRANCH=feat/mobile-ui-navigation-redesign
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-mobile-ui-navigation-redesign
LUNA_MAX_AGENTS_USED=5
DEEPSEEK_PRO_USED=NO
HOME_CORE_LAYOUT_PRESERVED=PASS
DREAM_ENTRY_ON_HOME=PASS
HOME_GALLERY_ENTRY_REMOVED=PASS
HOUSE_CONSTRUCTION_PLACEHOLDER=PASS
CHAT_HEADER_HOME_GALLERY=PASS
CHAT_OLD_BOTTOM_NAV_REMOVED=PASS
COMPOSER_MIC_NO_PERMISSION=PASS
COMPOSER_EMOJI_DRAWER=PASS
COMPOSER_PROVIDER_HOOK=PASS
COMPOSER_ADD_SEND_STATE=PASS
COMPOSER_EXISTING_TEXT_IMAGE_PATH=PASS
CHINESE_IME_COMPOSITION_GUARD=PASS
NAVIGATION_LOGICAL_STACK=PASS
NAVIGATION_HOME_FALLBACK=PASS
GALLERY_CHAT_CHILD_FLOW=PASS
STATIC_SVG_ASSETS=PASS
UI_NAVIGATION_FIXTURE=PASS
SMOKE_SCRIPT_BODY=PASS
VERIFY_CLIENT_STEPS=PASS
VISUAL_MEMORY_1_2=PASS
VISUAL_MEMORY=PASS
LONG_LIFE_AND_INNER_LIFE=PASS
DIFF_CHECK=PASS
PET_MEMORY_MODIFIED=NO
VISUAL_DB_SCHEMA_MODIFIED=NO
DREAM_LOGIC_MODIFIED=NO
LOCAL_BRAIN_MODIFIED=NO
CHAT_API_OR_PAYLOAD_MODIFIED=NO
LAN_API_OR_TOPOLOGY_MODIFIED=NO
LAN_STATIC_SVG_MIME_SUPPORT=YES
ANDROID_NATIVE_MODIFIED=NO
ANDROID_MANUAL_ACCEPTANCE=NOT_RUN
PRODUCTION_DEPLOYED=NO

本机没有 npm 可执行文件；因此 npm run smoke、npm run verify:client、
npm run test:visual-memory-1.2、npm run test:visual-memory 的脚本体分别以同一组
node 子命令执行并全部通过。客户端构建输出为 lib/client.js 62747 bytes，未产生
额外工作树改动。真实 Android 键盘与设备验收留在部署前手工边界。

## 2026-09-07 — Contextual Historical Visual Recall Follow-up Fix

基于 `5b4ad5685e95a6e3b7d8a790b1dff6c857796515` 建立独立 worktree，修复
视觉回忆语境中的自然追问、澄清回答和 subject correction 路由。本次复用既有
RAM-only `VisualRecallContext`，只增加 turn/session-scoped frame 字段；无新的
永久记忆、Visual DB 控制记录或第二套 Visual Memory。

```text
BASE_COMMIT=5b4ad5685e95a6e3b7d8a790b1dff6c857796515
BRANCH=feat/contextual-visual-recall-followup
CURRENT_MESSAGE_ONLY_INTENT_BEFORE=NO
CURRENT_RECENT_INTENT_BEFORE=NONE
CURRENT_ROUTE_BEFORE=ORDINARY_CHAT
WHY_NOT_TRIGGERED=message-only detector rejected 想想+subject; clarification no-candidate path cleared the existing frame
CONTEXTUAL_VISUAL_FRAME=REUSED_AND_EXTENDED_EPHEMERAL
REAL_FAILURE_REPRODUCED=YES
REAL_FAILURE_FIXED=YES
FIG_FOLLOWUP_RECALL=PASS
SUBJECT_CORRECTION=PASS
CLARIFICATION_CONTINUATION=PASS
FALSE_POSITIVE_DINNER=PASS
FALSE_POSITIVE_MATH=PASS
FALSE_POSITIVE_WEATHER=PASS
EXPLICIT_LONG_TERM_REGRESSION=PASS
LEGACY_RECALL_REGRESSION=PASS
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_REGRESSION=PASS
FIVE_INSPECTION_CAP=PASS
ORIGINAL_IMAGE_REOPEN=PASS
LOCAL_BRAIN_REINSPECTION=PASS
HISTORICAL_ATTACHMENT_VISIBLE_COUNT=1
FULL_OBSERVATION_VISIBLE=NO
VISUAL_FINAL_MAX_BUBBLES=2
PET_MEMORY_MODIFIED=NO
VISUAL_DB_SCHEMA_MODIFIED=NO
SCORER_MODIFIED=NO
DREAM_MODIFIED=NO
GALLERY_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
```

专门 fixture 为 `test/v0.4-contextual-visual-recall-followup.mjs`，并已接入
`npm run test:visual-memory-1.2`。澄清无候选时仍执行 Long-Term retrieval，
只有 subject correction/clarification retry 才允许无候选继续进入该链；普通 topic
shift 仍需候选预检，Recent Visual 继续优先。

## 2026-09-07 — Dream Insight Viewer + Visual Gallery

基于 Visual Presentation Cleanup 的 `5772fe1` 建立独立 UI/API 分支。本次只增加
Dream/Reflection 的安全持久化内容展示和 Visual Gallery 只读展示；不运行 Dream，
不触碰 production worktree，不改变 Visual DB schema、PetMemory 语义、视觉检索、
Local Brain、LAN wiring 或 Android。

```text
BASE_COMMIT=5772fe1e5f9d0a46449111aeff104c55160a24ad
BRANCH=feat/dream-gallery-ui
DREAM_INSIGHT_VIEWER=PASS
REFLECTION_DISTINCTION=PRESERVED
VISUAL_GALLERY_READ_ONLY=PASS
VISUAL_GALLERY_LEGACY_ROOTS=PRESERVED
VISUAL_GALLERY_ORIGINAL_BYTES_IN_LIST=NO
VISUAL_OBSERVATION_PROVENANCE=INFERRED
VISUAL_TERMS=BOUNDED_RETRIEVAL_CLUES_ONLY
VISUAL_DB_SCHEMA_CHANGED=NO
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_CHAT_CREATED=NO
PRODUCTION_DREAM_RUN=NO
PRODUCTION_DEPLOYED=NO
ANDROID_ACCEPTANCE=DEFERRED
```

## 2026-09-07 — Fixed LAN endpoint and WSL forwarding self-heal

本次是独立的 Windows LAN maintenance，不改变 Visual Memory、PetMemory、
Dream、Vision、retrieval、scorer、conversation 数据或 Pet runtime。

```
OFFICIAL_LAN_ENDPOINT=http://192.168.1.175:17870
OFFICIAL_LAN_PORT=17870
WINDOWS_FIXED_LAN_IP=192.168.1.175
IP_STABILITY_METHOD=ROUTER_DHCP_RESERVATION
WSL_FORWARDING=SELF_HEAL_CONNECTADDRESS
SELF_HEAL_SCRIPT=scripts/windows/vc-ai-pet-lan-forwarding-self-heal.ps1
PET_RUNTIME_MODIFIED=NO
VISUAL_MEMORY_MODIFIED=NO
PRODUCTION_DATA_MODIFIED=NO
```

当前 Windows 仍使用 DHCP；DHCP reservation 需要由路由器侧完成。本机
self-heal 在 Windows 不再拥有 .175 时 fail-closed，不会将新地址变成正式
endpoint。Android Companion fresh-install 默认同步为 192.168.1.175:17870，
已有 pet_host preference 保留。完整操作与测试边界见
[LAN_FORWARDING_SELF_HEAL.md](docs/LAN_FORWARDING_SELF_HEAL.md)。

## 2026-09-07 — Visual Memory Phase 1.2（Long-Term Retrieval Precision + Activity Trace Compact）

修复 Android 真机长期视觉复验再次失败：真实根因不是 observation term pollution，
而是 Recent resolver 的 generic boilerplate overlapScore 短路了长期 resolver。
另加中文 2-4 gram、owner exact phrase bonus、observation 归一化/封顶、semantic margin，
以及长期 recall UI 压缩（不再大段 dump observation、final 默认 1 bubble）。
详见 [Phase 1.2 工程日志](docs/DEVLOG_VISUAL_MEMORY_PHASE1_2.md)。

```text
BASE_COMMIT=bfe99edbcdd690465127715379aecdd2063d5eff
BRANCH=feat/visual-memory-phase1.2
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-vm-1.2
REAL_FAILURE_SELECTED_ATTACHMENT=2c910ee2-fc52-48eb-90b0-eb5456b7af35 (Tom&Jerry)
CORRECT_FIG_ATTACHMENT=047fba61-b59e-46f5-a36e-e10c9143d5c8
ROOT_CAUSE=RECENT_BOILERPLATE_OVERLAP_SHORT_CIRCUITS_LONG_TERM
OWNER_EXACT_PHRASE_BONUS=+50/phrase
CHINESE_2_4_GRAM=single=1/bigram=3/trigram=9/4gram=27
SINGLE_CHAR_WEIGHT=0.25 (owner) / 1 (observation)
OBSERVATION_SCORE_NORMALIZED=dedup+bounded
OBSERVATION_SCORE_CAP=ngram=12/single=2
SEMANTIC_MARGIN=abs floor 10 OR relative >=2x
FIG_TOP1=047fba61-b59e-46f5-a36e-e10c9143d5c8
FIG_TOP1_SCORE=50.5
FIG_TOP2_SCORE=1
FIG_MARGIN=49.5
FIG_RESOLUTION=matched
SHINCHAN_RECALL=matched (winner=bb87fc0c, score 11)
SHINCHAN_RELEVANT_AMBIGUITY=allowed for close related images
UNRELATED_IMAGE_WINNER=NO
OBSERVATION_ONLY_LEGACY_RECALL=PASS (蜡笔小新 via observation)
LONG_TERM_ACTIVITY_MAX_VISIBLE_STEPS=recall + image + short re-look + final
FULL_OBSERVATION_VISIBLE_TO_USER=NO
FULL_OBSERVATION_STILL_PERSISTED=YES (inferred event)
LONG_TERM_FINAL_BUBBLES=1 (max 2)
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_A_B_A=PASS
FIVE_INSPECTION_CAP=PASS
DEFERRED_TIMESTAMP_LEAK=PRESERVED
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_CHAT_CREATED=NO
PRODUCTION_DEPLOYED=NO
```

## 2026-09-06 — Visual Memory Phase 1.1（legacy semantic index + recall routing fix）

修复 Android 真机长期视觉验收失败：zero-model 导入 15 条旧 safe observation、
修正 bigram stop 规则与 generic recall term 抑制、增加短追问 ephemeral recall context。
详见 [Phase 1.1 工程日志](docs/DEVLOG_VISUAL_MEMORY_PHASE1_1.md)。

```text
BASE_COMMIT=19b2c2cb932e128477f96c763e012474b4c3ecf5
BRANCH=feat/visual-memory-phase1.1
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-vm-1.1
LEGACY_OBSERVATIONS_TOTAL=15
LEGACY_OBSERVATIONS_MAPPED=10
LEGACY_OBSERVATIONS_SKIPPED_AMBIGUOUS=5
PRODUCTION_RUNTIME_WIRING=PASS
PRODUCTION_PATH_RUNTIME_INIT_TEST=PASS
MODEL_CALLS_DURING_MIGRATION=0
MIGRATION_IDEMPOTENT=YES
SEMANTIC_COVERAGE_BEFORE=22/31
SEMANTIC_COVERAGE_AFTER=25/31
STOP_BIGRAM_RULE_FIXED=YES
GENERIC_RECALL_TERMS_SUPPRESSED=YES
FIG_QUERY_TOP1=047fba61-b59e-46f5-a36e-e10c9143d5c8
FIG_QUERY_RESOLUTION=matched
SHINCHAN_RESOLUTION=matched（winner=bb87fc0c，无关图全被压到 score=1）
FOLLOWUP_ROUTING=PASS（有很多无花果 / 那蜡笔小新呢 / 那晚饭呢不误触发）
ASSISTANT_HINT_IMPLEMENTED=NO（DEFERRED）
LEGACY_LAZY_VLM_BOOTSTRAP=DEFERRED
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_A_B_A=PASS
FIVE_INSPECTION_CAP=PASS
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_CHAT_CREATED=NO
PRODUCTION_DREAM_RUN=NO
PRODUCTION_DEPLOYED=NO
```

## 2026-09-06 — Visual Memory Phase 1

李花花拥有长期视觉经历：历史图片进 Visual Experience Index（zero-inference
backfill），长期回想找到候选后重新打开真正原图再回答；旧 observation 只辅助
retrieval；Dream/Reflection 只拿 bounded RAW/INFERRED visual context。
详见 [Visual Memory Phase 1 工程日志](docs/DEVLOG_VISUAL_MEMORY_PHASE1.md)
与 [Agent Handoff 协议](docs/AGENT_HANDOFF_PROTOCOL.md)。

```text
BASE_COMMIT=ce566c506a9d496ea5ee543b73f28232269c5c99
INTEGRATION_BRANCH=feat/visual-memory-phase1
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-visual-memory
AGENT_HANDOFF=/home/vitamin_c/projects/personal/vc-ai-pet-agent-share
VISUAL_DB=visual-experience.db
ZERO_INFERENCE_BACKFILL=PASS
LONG_TERM_VISUAL_RECALL=PASS
RECENT_VISUAL_PRIORITY=PRESERVED
ORIGINAL_IMAGE_REOPEN=PASS
OLD_CAPTION_AS_FINAL_EVIDENCE=NO
VISUAL_OBSERVATION_PROVENANCE=inferred
REPEATED_IMAGE_RAW_ROOT_DEDUP=PASS
DREAM_VISUAL_CONTEXT=BOUNDED_RAW_INFERRED
REFLECTION_VISUAL_CONTEXT=BOUNDED_RAW_INFERRED
OVER_500_MESSAGES_RECALL=PASS
RESTART_RECALL=PASS
MISSING_ASSET=HONEST
ASSISTANT_EVIDENCE_EXCLUDED=PASS
MULTI_VISUAL_REGRESSION=PASS
A_TO_B_TO_A=PASS
FIVE_INSPECTION_CAP=PASS
MODEL_CALLS_DURING_BACKFILL=0
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_DREAM_RUN=NO
DEFERRED_BUGS_PRESERVED=YES
PRODUCTION_DEPLOYED=NO
```

## 2026-09-05 — Long-term cognition phase 1

The delivered scope is durable raw conversation history, temporal owner
beliefs, source-backed direct belief answers, evidence-rooted weak Self
hypotheses, Dream/Reflection loop guards and a user-facing inner-life timeline.
See [phase design and acceptance](docs/LONG_TERM_COGNITION_PHASE1.md).

```text
BASELINE_BRANCH=feat/visual-working-session
BASELINE_HEAD=50789e0fd15854c2e45aa89a4fc1d07f45b7fb4c
BRANCH=feat/long-term-cognition
WORKTREE=/home/vitamin_c/projects/personal/vc-ai-pet-cognition
CURRENT_BELIEF=supported/contested/temporary/unknown
RAW_HISTORY=SQLITE_ARCHIVE_PLUS_BOUNDED_RECENT_CACHE
SELF=WEAK_INFERRED_HYPOTHESES_FROM_DISTINCT_RAW_ROOTS
DERIVED_SELF_REINFORCEMENT=GUARDED
DREAM_UI=PLAY_TOP_ENTRY_AND_PAGINATED_TIMELINE
REFLECTION_UI=SMALL_THOUGHTS_IN_SAME_TIMELINE
EXISTING_TEST_PROGRAMS=25_PASS_AFTER_INTENTIONAL_CONTRACT_UPDATES
LONG_LIFE_TEST_PROGRAMS=4_PASS
REAL_LOCAL_BRAIN_CHANGE_AND_RECALL=PASS_IN_TEMP_SANDBOX
CLIENT_BUILD_AND_VERIFY=PASS
NARROW_SCREEN_RENDER_QA=UNVERIFIED_CHROMIUM_NAVIGATION_TIMEOUT
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_DREAM_RUN=NO
PRODUCTION_HOST_RESTARTED=NO
ANDROID_NATIVE_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
GOMOKU=DEFERRED
INITIATIVE_AND_BACKGROUND_NOTIFICATIONS=DEFERRED
ARCHIVE_WIDE_VISUAL_EXPERIENCE_RETRIEVAL=DEFERRED
```

Runtime audit found **two** DSH Host processes opening the production Pet DB.
The LAN Host predates the latest source modifications, so its loaded code is
not verified equal to source. This branch was tested independently and has not
been activated in that production Host. No reset, force push, or replacement
of the original checkout was used. Older acceptance sections below are
historical snapshots, not a current service-status assertion.

Additional fixes: old 500-message deletion became a bounded cache plus durable
archive; new MemoryGate writes retain actual evidence instead of model
paraphrases; questions/assistant quotations cannot become facts; historical
and current-Self reads retain provenance; out-of-order cognition completion
does not overwrite newer owner evidence; zero-sized history reads return empty.

The explicit product adjustment is staged delivery, plus a narrow evidence
answer renderer because live Local Brain testing showed correct retrieval did
not guarantee a correct final answer. No claims are made of universal semantic
contradiction resolution, retroactive restoration of deleted data, full Self
revision or Android device acceptance.

## Historical baseline

```text
DSH_VERSION=0.1.1-rc.2
REPO_PATH=/home/vitamin_c/projects/personal/vc-ai-pet
GITHUB_REPO=https://github.com/Vitamin-C-lv/vc-ai-pet
GITHUB_VISIBILITY=PUBLIC
DSH_PLUGIN_INSTALL_PATH=/home/vitamin_c/.dsh/profiles/web/node_modules/vc-ai-pet
PET_SANDBOX=/home/vitamin_c/.local/share/vc-ai-pet/sandbox
PET_MEMORY_DB=/home/vitamin_c/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db
DSH_MEMORY_DB=/home/vitamin_c/桌面/测试/.dsh-meow/memory.db
PET_ACTIVE_DSH_HOST_COUNT=1
SINGLE_CLICK_EXACTLY_ONCE=PASS
DOUBLE_CLICK_EXACTLY_ONCE=PASS
CLIENT_HOST_RPC=PASS
CLICK_INTERACTION=PASS
MULTI_CLICK_COUNT_CONSISTENCY=PASS
DATABASES_SEPARATE=YES
PERSISTENCE=PASS
DEEPSEEK_REQUESTS_FROM_PET=0
CONVERSATION_INJECTION=NONE
MODEL_TOOL_REGISTERED=NO
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
MULTI_DSH_BACKEND_CONCURRENT_WRITE=OUT_OF_SCOPE_V0_1
CURRENT_COMMIT=UI_RELEASE_COMMIT_RECORDED_IN_GIT
```

Interaction acceptance recorded:

- Single-click baseline: `lifetimeInteractions=9`, `attachment=0.578`, `fact_count=27`.
- Single-click result: `lifetimeInteractions=10`, `attachment=0.584`, `fact_count=28`; latest fact is `主人和我互动了：pet。累计互动次数：10。`.
- Double-click acceptance: one logical `play` interaction, as confirmed by the user; no further interaction testing is required for v0.1.

The package remains isolated from DSH memory and model activity. v0.1 does not include local LLM, VLM, Dream, Reflection, DSH event awareness, or computer control. Luna Team and `vc-tool-activity-fold` remain unchanged.

## v0.3-A implementation status

Recent Conversation Continuity is implemented on branch
`feat/v0.3-recent-conversation` as a host-side RAM-only buffer of the latest
12 successful user/assistant turns. It is not persisted to the sandbox or any
memory database. Automated and manual acceptance are complete; the package
version is `0.3.0-alpha.1`.

## v0.3-B Dream / Reflection status

The feature branch `feat/v0.3-dream` adds two independent, Pet-only thought
layers. Micro Reflection uses a separate 30-minute checkpoint and a maximum of
4 new raw memories, 4 related rows, and 1 additive derived row. Deep Dream is
restricted to sleep, uses a 15-minute sleep minimum, allows night runs from
22:30 to 08:00 or a daytime nap after 45 minutes of continuous fixed GPU
availability, and uses 24 new / 24 related rows per batch with at most 3
derived rows. Both layers use only Local Brain API v1 at
`http://127.0.0.1:17862`; neither writes `rules` or uses physical context.

Acceptance is complete on `feat/v0.3-dream`:

```text
VERSION=0.3.0-alpha.2
DREAM_SOURCE_SESSION=vc-ai-pet:dream
DREAM_WINDOW=vc-ai-pet:dream-window
REFLECTION_SOURCE_SESSION=vc-ai-pet:reflection
REFLECTION_WINDOW=vc-ai-pet:reflection-window
CHECKPOINTS_INDEPENDENT=PASS
RAW_MEMORY_HISTORY_PRESERVED=PASS
EMERGENT_SOUL=PASS
SOUL_WRITE_FROM_CHAT=DENIED
SOUL_WRITE_FROM_REFLECTION=DENIED
SOUL_WRITE_FROM_DREAM=ALLOWED_GATED
PRODUCTION_DREAM_ACCEPTANCE=PASS
PRODUCTION_DREAM_SOURCE_COUNT=4
PRODUCTION_DREAM_BATCH_COUNT=1
PRODUCTION_DREAM_DERIVED_COUNT=2
PRODUCTION_DREAM_DUPLICATE_COUNT=1
```

The production `dream_log` entry is additive and records
`changes.kind=dream`; no raw chat transcript or source-row rewrite occurred.

## v0.3-C Historical Recall

The feature branch `feat/v0.3-historical-recall` adds an on-demand historical
read path above the sealed v0.3-B Dream/Reflection layers. Normal chat keeps
`memory.recall(userText, 5)` and does not scan all history or read `dream_log`.
Historical questions use deterministic intent routing, meow-memory BM25
retrieval over `soul/user/project/fact/lesson/topic`, temporal ordering, and a
bounded read-only provenance expansion from the existing `dream_log`.

```text
VERSION=0.3.0-alpha.3
HISTORICAL_RECALL_MODE=ON_DEMAND_ONLY
HISTORICAL_SEARCH_MAX=12
HISTORICAL_LINEAGE_MAX_DEPTH=3
HISTORICAL_LINEAGE_MAX_NODES=18
HISTORICAL_CONTEXT_MAX=16
DREAM_PROVENANCE=EXISTING_DREAM_LOG
PROVENANCE_DB_WRITE=NO
NEW_PROVENANCE_DB=NO
RAW_SOURCE_PRIORITY=PASS
CONTRADICTION_HANDLING=TEMPORAL_READ_ONLY
FULL_MEMORY_CONTEXT_INJECTION=NO
NORMAL_CHAT_HISTORICAL_SCAN=0
NORMAL_CHAT_DREAM_LOG_READS=0
RAW_CHAT_HISTORY_PERSISTED=NO
MODEL_INFERENCES_PER_CHAT=1
PET_DEEPSEEK_REQUESTS=0
```

Historical Recall is read-only: it does not create derived memory, mutate
source rows, update status, touch Dream/Reflection checkpoints, or append
`dream_log`. The prompt exposes short source labels and readable timestamps;
it does not claim compressed memory content is a persisted raw transcript.

## v0.3-C Pet-side Busy Gate Removal

```text
FINAL_STATUS=VC_AI_PET_V0_3_C_UI_PENDING
PET_API_CALL_POLICY=DIRECT
PET_API_DIRECT_CALL=PASS
CHAT_GPU_BUSY_GATE=REMOVED
REFLECTION_GPU_BUSY_GATE=REMOVED
DREAM_GPU_BUSY_GATE=REMOVED
DAYTIME_NAP_TRIGGER=SLEEP_DURATION_45M
LOCAL_BRAIN_REQUEST_TIMEOUT_MS=180000
QUEUE_FULL_RETRY=250/500/1000ms
QUEUE_FULL_RETRY_BOUNDED=PASS
OWNER_BUSY_CANNED_REPLY=REMOVED_FROM_PRODUCTION
HISTORICAL_RECALL_AUTO_TESTS=PASS
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

The Pet layer now sends Chat, Reflection, and Dream requests directly to the
loopback Local Brain API. GPU utilization, VRAM, and owner-busy state no longer
produce a Pet-side admission decision; the API queue owns that scheduling.

## v0.3-D Phase 1 Memory Consolidation Foundation

v0.3-D Phase 1 is complete. The foundation adds Memory Provenance metadata,
Semantic Stability validation for derived memories, and an explicit Dream
Candidate layer before derived-memory approval. Existing `source_session`
values remain readable, and Assistant Response provenance cannot become a
confirmed memory.

```text
FINAL_STATUS=VC_AI_PET_V0_3_D_PHASE1
MEMORY_PROVENANCE=PASS
SEMANTIC_STABILITY=PASS
DREAM_CANDIDATE_LAYER=PASS
LEGACY_MEMORY_COMPATIBILITY=PASS
PRODUCTION_DB_MODIFIED=NO
DREAM_RERUN=NO
```

Deferred to v0.3-D Phase 2: Reflection Engine, Personality Emergence, and
Contradiction Detection. These require accumulated real long-term interaction
data before the next consolidation layer is developed.

## v0.3-E Phase 1 UI / Visual Presence

The overlay now owns a small, presentation-only visual state layer. It keeps
the existing persistent pet state unchanged and chooses exactly one state in
this order: `dreaming`, `thinking`, `excited`, `happy`, `sleep`, `walk`, then
`idle`. Dream status is a read-only report of the actual `DreamEngine`
in-flight flag; it is never inferred from clock time or written to storage.

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE1_PASS
VERSION=0.3.0-alpha.4
VISUAL_STATE_PRIORITY=CENTRALIZED
VISUAL_IDLE=PASS
VISUAL_THINKING=PASS
VISUAL_SLEEP=PASS
VISUAL_DREAMING=PASS
VISUAL_HAPPY=PASS
VISUAL_EXCITED=PASS
VISUAL_WALK=PASS
ENV_NIGHT_TIME=PASS
ENV_LONG_NO_INTERACTION=PASS
ENV_CHAT_PENDING=PASS
ENV_DREAM_RUNNING=PASS
ENV_OWNER_WORKING=PASS
ENVIRONMENT_CONTENT_READS=NONE
OVERLAY_INTERACTION_TEST=PASS
CLIENT_BUNDLE_VERIFY=PASS
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

`ownerWorking` is deliberately only a weak UI label: long pet inactivity,
daytime, and a visible DSH page. It does not inspect titles, content,
clipboard, files, or any other user data, and it cannot affect Local Brain or
Dream decisions. `readPresence` is an additive package-private RPC for the
browser overlay; it exposes only boolean `chatPending` and `dreamRunning`
flags plus the UI-only visual configuration.

## v0.3-E Phase 2 — Emotion & Living Interaction Layer

The browser overlay now keeps a momentary emotion runtime in React memory. It
uses only owner interactions, elapsed time, the read-only Dream in-flight flag,
and the existing attachment value as an initial/refresh hint. The runtime is
never written to `pet-memory.db`, `state.json`, localStorage, the Local Brain,
or conversation/memory paths.

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE2_PASS
EMOTION_RUNTIME=PASS
CLICK_FEEDBACK=PASS
DOUBLE_CLICK_FEEDBACK=PASS
LONG_PRESS_FEEDBACK=PASS
INTERACTION_BURST=PASS
WAITING_STATE=PASS
IDLE_RANDOM_ACTION=PASS
DREAM_VISUAL_ENHANCEMENT=PASS
VISUAL_IDLE=PASS
VISUAL_HAPPY=PASS
VISUAL_EXCITED=PASS
VISUAL_RELAXED=PASS
VISUAL_WAITING=PASS
VISUAL_CONFUSED=PASS
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
PRODUCTION_DB_MODIFIED=NO
MEMORY_SCHEMA_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
```

The 30-second burst detector is bounded to happy (1–5), excited (6–15), and
curious/confused (>15) feedback; it never emits a negative owner judgement.
Long press is a relaxed visual-only interaction and does not create an extra
host persistence event. Waiting is silent and appears only when chat is closed
after a recent interaction. Idle actions are weighted and scheduled by one
low-frequency timeout in the browser.

## v0.3-E Phase 3-A LAN Companion UI

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE3A_PASS
LAN_SERVER=PASS
MOBILE_UI=PASS
STATE_SYNC=PASS
CHAT_SYNC=PASS
CLICK_SYNC=PASS
DOUBLE_CLICK_SYNC=PASS
LONG_PRESS_SYNC=PASS
EMOTION_SYNC=PASS
DREAM_SYNC=PASS
LOCAL_ONLY=PASS
PUBLIC_NETWORK_BIND=NO
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
EMOTION_RUNTIME_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
MEMORY_SCHEMA_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
```

The host-owned LAN listener uses `0.0.0.0:17870` only to accept devices on the
local network. It rejects every client except localhost and private IPv4
(`10/8`, `172.16/12`, `192.168/16`). The mobile page polls every 1.5 seconds;
it calls the same runtime interaction and chat methods as the desktop overlay.

## Current DSH background Reflection loop hotfix

The DSH-hosted Pet Reflection request was exhausting its 500-token completion
budget with the Relay's low-thinking profile (`finish_reason=length`), leaving
the reflection checkpoint unchanged and causing the 10-second host tick to
retry. Reflection now uses the existing `off` profile so the bounded budget is
reserved for its structured JSON; normal Chat remains `off`, and Deep Dream
remains `medium`. Both idle DSH Web instances were reloaded from the working
tree without restarting llama or Relay. The LAN/state surfaces remained
available and no Relay activity was observed during the post-reload window.

```text
REFLECTION_THINKING=OFF
NORMAL_CHAT_CONTRACT=UNCHANGED
DEEP_DREAM_CONTRACT=UNCHANGED
DSH_3082_RELOADED=PASS
DSH_3080_RELOADED=PASS
LOCAL_BRAIN_RELAY_RESTARTED=NO
LLAMA_RESTARTED=NO
POST_RELOAD_PERIODIC_REQUESTS=0_OBSERVED
```

## v0.3-E Current Time Context Hotfix

The Local Brain now receives one ephemeral snapshot of the real local system
clock on every chat reply. The snapshot contains `currentDate`, `currentTime`,
`weekday`, `dayPeriod`, and `season`; it is system environment context rather
than memory or user-provided content. The same provider is reused by the
presentation layer's night-time check. It is not written to `pet-memory.db`
and is not passed into Dream or Historical Recall input builders.

```text
FINAL_STATUS=VC_AI_PET_TIME_CONTEXT_PASS
TIME_PROVIDER=PASS
LOCAL_BRAIN_TIME_CONTEXT=PASS
MEMORY_SCHEMA_CHANGED=NO
DREAM_CHANGED=NO
```

## Vision Input v0.1 — LAN owner-triggered image chat

The LAN companion chat now accepts one owner-selected JPEG, PNG, or WebP per
turn. The browser downsizes images to a maximum 1920px long edge and exports
WebP (or JPEG fallback) before sending the additive `image.dataUrl` field to
the existing `/api/pet/chat` route. The server accepts only approved base64
image data URLs, keeps the larger body limit scoped to Chat, and never exposes
filesystem paths or remote URLs.

Vision turns use the existing Local Brain API v1 multimodal message contract
and exactly one inference. The image is request-only: Recent Conversation
stores only `[主人发送了一张图片]` plus any actual owner text, and the
MemoryGate is skipped for vision turns so neither image bytes nor visual
inferences become Pet memory.

```text
FINAL_STATUS=VC_AI_PET_VISION_INPUT_V0_1_AUTOMATED_PASS
LAN_IMAGE_PICKER=PASS
IMAGE_PREVIEW=PASS
IMAGE_REMOVE=PASS
IMAGE_ONLY_CHAT=PASS
IMAGE_PLUS_TEXT_CHAT=PASS
LOCAL_BRAIN_VISION=PASS
MODEL_INFERENCES_PER_CHAT=1
SUPPORTED_IMAGE_TYPES=JPEG,PNG,WEBP
MAX_IMAGES_PER_TURN=1
IMAGE_LONG_EDGE_MAX=1920
RAW_IMAGE_PERSISTED=NO
IMAGE_BASE64_IN_RECENT_CONVERSATION=NO
IMAGE_BASE64_IN_PET_MEMORY=NO
VISION_DERIVED_MEMORY_WRITE=NO
TEXT_CHAT_REGRESSION=PASS
DREAM_REGRESSION=PASS
HISTORICAL_RECALL_REGRESSION=PASS
UI_PRESENCE_REGRESSION=PASS
EMOTION_REGRESSION=PASS
LAN_COMPANION_REGRESSION=PASS
MANUAL_REAL_PHOTO_ACCEPTANCE=PENDING
```

## Vision v0.1 — real-image E2E diagnosis

The first real-image failure was isolated to a stale DSH Web host: the
running host had started before the Vision commits, so its already-loaded LAN
handler still rejected an image-only chat as `invalid-message`. Static mobile
assets were current because they are read per request, which made the stale
handler easy to miss. The DSH host was reloaded to the current `d77a242`
working tree without restarting Relay or llama.

A generated 128×128 red/blue PNG (390 bytes) then passed the complete LAN →
PetRuntime → Local Brain path. A direct Local Brain v1 probe passed both
without `response_format` and with the current Pet JSON response format, so no
Vision compatibility workaround or lower-layer change was needed. Vision
turns retain one inference and skip MemoryGate; image bytes remain request
only. Internal failure logging now records only code, retryable, and request ID
without returning or logging image/prompt/response content.

```text
REAL_IMAGE_E2E=PASS_FOR_CURRENT_RELOADED_HOST
ROOT_CAUSE_LAYER=STALE_DSH_HOST_NOT_RELOADED
ROOT_CAUSE=RUNNING_HOST_PREDATED_VISION_COMMIT
LAN_TINY_PNG=PASS
PET_RUNTIME_TINY_PNG=PASS
LOCAL_BRAIN_MINIMAL_VISION=PASS
VISION_NO_RESPONSE_FORMAT=PASS
VISION_WITH_RESPONSE_FORMAT=PASS
LOCAL_BRAIN_VISION_REGRESSION=NO
MOBILE_REAL_PHOTO=PENDING_USER_RETEST
INTERNAL_ERROR_CODE_LOGGING=PASS
IMAGE_CONTENT_LOGGED=NO
PRODUCTION_DB_MODIFIED=NO
DREAM_RERUN=NO
```

## v0.3-F — Conversation Persistence

The LAN companion now has an independent Conversation Persistence Layer. The
store is separate from `pet-memory.db`, stores short-term message records and
local date-partitioned image assets, and is not read by Memory, Historical
Recall, Dream, Reflection, Local Brain, or Emotion Runtime. The mobile page
loads the latest 50 records on startup and renders persisted user images from
thumbnail URLs after a browser refresh.

```text
FINAL_STATUS=VC_AI_PET_CONVERSATION_PERSISTENCE_PASS
VERSION=0.3.0-alpha.5
CONVERSATION_STORE=conversation-store.json
CONVERSATION_ASSETS=conversation-assets/YYYY/MM/DD
CONVERSATION_HISTORY_LIMIT=50
CONVERSATION_IMAGE_MAX_EDGE=1920
CONVERSATION_THUMBNAIL_MAX_EDGE=256
CONVERSATION_BASE64_PERSISTED=NO
HISTORY_API=/api/pet/history
IMAGE_UPLOAD_API=/api/pet/upload
USER_RECORD_BEFORE_LOCAL_BRAIN=PASS
REFRESH_HISTORY=PASS
IMAGE_THUMBNAIL_RENDERING=PASS
MEMORY=UNCHANGED
DREAM=UNCHANGED
HISTORICAL_RECALL=UNCHANGED
LOCAL_BRAIN_API=UNCHANGED
EMOTION_RUNTIME=UNCHANGED
```

## v0.3-F — Mobile App Shell / Chat & Play Split

The LAN companion mobile page now uses a full-screen two-view app shell. Play
and Chat are mutually exclusive views under one global header, with a normal
content bottom navigation. The selected tab is restored from
`vc-ai-pet-mobile-active-tab-v1`; missing or invalid values default to Play.
Tab changes only update DOM visibility and selection state, so chat drafts,
selected image previews, message scroll position, and pet presentation state
remain intact. Chat fills the active area and assigns scrolling only to the
message list; the old 220px message cap is removed.

```text
FINAL_STATUS=VC_AI_PET_MOBILE_APP_SHELL_PASS
APP_SHELL=PASS
PLAY_VIEW=PASS
CHAT_VIEW=PASS
BOTTOM_NAV=PASS
DEFAULT_TAB=PLAY
TAB_PERSISTENCE=PASS
TAB_SWITCH_NO_RELOAD=PASS
BODY_SCROLL=LOCKED
PLAY_VIEW_NORMAL_SCROLL=NO
CHAT_VIEW_SCROLL_OWNER=MESSAGES_ONLY
CHAT_COMPOSER_FIXED_IN_VIEW=PASS
IMAGE_PREVIEW_PERSISTS_ACROSS_TAB_SWITCH=PASS
MOBILE_UI_CONTRACT=PASS
MOBILE_NARROW_VIEWPORT=PASS
WEB_UI_UPDATE_WITHOUT_APK_REINSTALL=PASS
ANDROID_NATIVE_CHANGED=NO
APK_REBUILT=NO
APK_REINSTALLED=NO
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
HISTORICAL_RECALL_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
CONVERSATION_STORE_CHANGED=NO
LAN_SERVER_CHANGED=NO
```

Production changes are limited to the three LAN mobile UI files. The
Conversation Persistence Layer, Memory, Dream, Historical Recall, Local Brain
API, Emotion Runtime, and Android Companion remain unchanged.

## v0.3-F — Mobile UI Polish Phase 2

The LAN companion mobile UI now hides the bottom navigation while the Chat
composer has focus on a mobile viewport. VisualViewport resize/scroll events,
window resize, focus lifecycle, and a conservative legacy-WebView fallback are
coalesced into a `keyboard-open` root state. During that state the navigation
releases its layout height and the shell tracks the visible viewport without
allowing body scrolling.

Play has a compact stage/actions composition with an explicit hint, a larger
centered sprite, closer status metrics, and a 6–8% bottom breathing buffer.
Chat messages retain the existing article data flow while rendering through a
shared `.message-bubble`; owner and pet bubbles have distinct warm tones and
images remain inside the same message block as accompanying text.

```text
FINAL_STATUS=VC_AI_PET_MOBILE_UI_POLISH_PHASE2_PASS
KEYBOARD_NAV_HIDE=PASS
PLAY_LAYOUT_REBALANCE=PASS
CHAT_BUBBLES=PASS
CHAT_COMPOSER_STABLE=PASS
BOTTOM_NAV_POLISH=PASS
IMAGE_PREVIEW_UI=PASS
TEXT_CHAT_REGRESSION=PASS
IMAGE_CHAT_REGRESSION=PASS
PLAY_INTERACTION_REGRESSION=PASS
TAB_PERSISTENCE=PASS
APK_REBUILD_REQUIRED=NO
ANDROID_NATIVE_CHANGED=NO
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
RELAY_CHANGED=NO
CONVERSATION_STORE_CHANGED=NO
LAN_SERVER_CHANGED=NO
```

## v0.1 Android Companion

The Android Companion is a thin native shell around the existing LAN Companion
Web UI. It adds no Pet business implementation and does not package HTML, CSS,
JavaScript, conversation data, or model code into the APK. The host is editable
and only the normalized `host:port` value is stored in Android
`SharedPreferences` under `pet_host`.

```text
ANDROID_COMPANION_STATUS=IMPLEMENTED_PENDING_USER_DEVICE_ACCEPTANCE
ANDROID_COMPANION_BRANCH=feat/android-companion
CHANGED_FILES=android-companion/,PROJECT_STATE.md
ANDROID_PROJECT=PASS
GRADLE_WRAPPER=PASS
DEBUG_APK_BUILD=PASS
ANDROID_LINT=PASS_WITH_EXPECTED_WARNINGS
WEBVIEW=PASS
JAVASCRIPT=PASS
DOM_STORAGE=PASS
FILE_ACCESS_DISABLED=PASS
JAVASCRIPT_BRIDGE=NONE
LAN_HOST_CONFIG=PASS
LAN_CLEAR_TEXT=PASS
PUBLIC_NAVIGATION_BLOCKED=PASS
IMMERSIVE_FULLSCREEN=PASS
PORTRAIT_MODE=PASS
BACK_NAVIGATION=PASS
ANDROID_FILE_CHOOSER=IMPLEMENTED_PENDING_USER_DEVICE_ACCEPTANCE
ANDROID_PERMISSIONS=INTERNET
ADB_DEVICE=NOT_CONNECTED
APK_PATH=android-companion/dist/李花花-Android-Companion-v0.1-debug.apk
APK_SIZE_BYTES=2545700
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
WEB_UI_UPDATE_WITHOUT_APK_REINSTALL=PENDING_USER_DEVICE_ACCEPTANCE
TEXT_CHAT=PENDING_USER_DEVICE_ACCEPTANCE
VISION_REPLY=PENDING_USER_DEVICE_ACCEPTANCE
CONVERSATION_HISTORY=PENDING_USER_DEVICE_ACCEPTANCE
IMAGE_HISTORY=PENDING_USER_DEVICE_ACCEPTANCE
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
PUSH=PASS
```

## v0.3-G — Reasoning Profiles + Thinking Feedback

Interactive Pet inference now uses one centralized reasoning profile: ordinary
text chat is `low`, Vision chat is `medium`, Dream is `high`, and Reflection
remains `off`. LocalBrain measures monotonic request duration around the single
Local Brain call, including bounded queue retry waits. The LAN/mobile API
passes only the structured `reasoning.effort` and `reasoning.durationMs`
telemetry; Conversation Store and Memory schemas remain unchanged.

Both the LAN Companion and DSH desktop bubble insert a pet-style temporary
thinking message with paw/dot motion, remove it on success or failure, and show
the completed duration below successful Pet replies. The existing
`chatPending`/host presence link still drives the Pet `thinking` visual state.

```text
FINAL_STATUS=VC_AI_PET_REASONING_AND_THINKING_UI_PASS
TEXT_REASONING=low
VISION_REASONING=medium
DREAM_REASONING=high
REFLECTION_REASONING=off
TEXT_REASONING_LOW=PASS
VISION_REASONING_MEDIUM=PASS
DREAM_REASONING_HIGH=PASS
REFLECTION_REASONING_OFF=PASS
MODEL_INFERENCES_PER_CHAT=1
THINKING_TIMER=PASS
THINKING_DURATION_SOURCE=PET_LOCAL_BRAIN_REQUEST
THINKING_DURATION_INCLUDES_QUEUE_WAIT=YES
THINKING_DURATION_PERSISTED=NO
MOBILE_THINKING_INDICATOR=PASS
MOBILE_THINKING_ANIMATION=PASS
MOBILE_THINKING_DURATION=PASS
DESKTOP_THINKING_INDICATOR=PASS
DESKTOP_THINKING_DURATION=PASS
PET_THINKING_VISUAL_STATE=PASS
VISION_THINKING_COPY=PASS
DREAM_UI_REGRESSION=PASS
VISION_REGRESSION=PASS
TEXT_CHAT_REGRESSION=PASS
CONVERSATION_REGRESSION=PASS
MOBILE_UI_REGRESSION=PASS
CHAIN_OF_THOUGHT_EXPOSED=NO
ANDROID_NATIVE_CHANGED=NO
APK_REBUILT=NO
APK_REINSTALLED=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
BRANCH=feat/mobile-app-shell
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE=CLEAN_AFTER_COMMIT
```

## v0.3-H — Recent Visual Recall + Persistent Thinking Duration

Thinking duration is now sanitized into optional assistant-message metadata in
the independent Conversation Store. Existing messages without the field remain
valid, and the mobile history renderer displays `🐾 思考了 X.X 秒` for both live
and refreshed assistant replies without exposing reasoning effort.

Recent Visual Resolver keeps the latest ten owner messages that carry an
attachment, resolves only on an explicit visual reference or an immediate weak
follow-up, and materializes at most one full stored asset. New images take
priority; recalled images are never attached to the new user message. The
resolver is persistent across runtime restart, does not put base64 into Recent
Conversation or the JSON store, and skips MemoryGate for visual context.

```text
FINAL_STATUS=VC_AI_PET_RECENT_VISUAL_RECALL_PASS
LIVE_THINKING_DURATION=PASS
THINKING_DURATION_PERSISTED=YES
THINKING_DURATION_STORAGE=CONVERSATION_METADATA_ONLY
THINKING_DURATION_AFTER_REFRESH=PASS
RECENT_VISUAL_RECALL=PASS
RECENT_VISUAL_MAX_ATTACHMENTS=10
RECENT_VISUAL_SOURCE=CONVERSATION_STORE
RECENT_VISUAL_BASE64_PERSISTED_IN_CONTEXT=NO
LATEST_IMAGE_FOLLOWUP=PASS
STRONG_VISUAL_REFERENCE=PASS
WEAK_IMMEDIATE_REFERENCE=PASS
UNRELATED_CHAT_NO_VISUAL_RECALL=PASS
RECENT_VISUAL_RECALL_AFTER_RESTART=PASS
CURRENT_IMAGE_PRIORITY=PASS
HISTORICAL_IMAGE_DUPLICATED_IN_CONVERSATION=NO
MODEL_INFERENCES_PER_CHAT=1
TEXT_REASONING=low
VISION_REASONING=medium
RECALLED_VISION_REASONING=medium
DREAM_REASONING=high
REFLECTION_REASONING=off
VISUAL_RECALL_MEMORY_WRITE=NO
PET_MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
ANDROID_NATIVE_CHANGED=NO
APK_REBUILT=NO
APK_REINSTALLED=NO
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

## Visual Presentation Cleanup

The Visual Memory presentation cleanup keeps attachment ownership in the
visual event semantics: the owner message owns the first current image,
`media_ref` owns recalled/previous/revisit inspection images, and activity rows
remain text-only. Legacy activity rows that already contain attachment
metadata are also rendered without an image. Visual activity copy is projected
to short natural-language labels, while the stored observation/evidence path
remains intact.

```text
FINAL_STATUS=READY_FOR_PRODUCTION_DEPLOYMENT
BASE_COMMIT=b3b2cce09fd463fcc09e77444843da6ace16a54c
BRANCH=feat/visual-presentation-cleanup
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
WORKTREE=CLEAN_AFTER_COMMIT
ROOT_CAUSE_DUPLICATE_IMAGE=ACTIVITY_SOURCE_ATTACHMENT_AUTOMATICALLY_RENDERED
IMAGE_RENDER_OWNER=USER_DIALOGUE_FIRST_CURRENT_MEDIA_REF_RECALLED_PREVIOUS_REVISIT
LONG_TERM_ATTACHMENT_VISIBLE_COUNT=1
ORIGINAL_IMAGE_REOPEN=PASS
LOCAL_BRAIN_REINSPECTION=PASS
LONG_TERM_VISIBLE_ACTIVITY_STEPS=2
FULL_OBSERVATION_VISIBLE=NO
FULL_OBSERVATION_PERSISTED=YES
LONG_TERM_FINAL_DEFAULT_BUBBLES=1
LONG_TERM_FINAL_MAX_BUBBLES=2
CURRENT_IMAGE_DUPLICATE_RENDER=NO
MULTI_VISUAL_DISTINCT_IMAGES=PASS
A_B_A_REVISIT=PASS
TIMESTAMP_METADATA_LEAK_FIXED=PASS
LONG_TERM_RECALL_REGRESSION=PASS
RECENT_VISUAL_REGRESSION=PASS
MULTI_VISUAL_REGRESSION=PASS
FIVE_INSPECTION_CAP=PASS
VISUAL_MEMORY_CORE_MODIFIED=NO
RETRIEVAL_MODIFIED=NO
PRODUCTION_DATA_MODIFIED=NO
PRODUCTION_DEPLOYED=NO
```

## Household Identity Phase 1C — Session Authentication Foundation

Household credentials can now create opaque, SHA-256-at-rest sessions through
the LAN HTTP boundary. This phase adds only `/api/auth/login`,
`/api/auth/logout`, `/api/auth/me`, and a frozen server-side ActorContext.
Existing pet routes remain deliberately unauthenticated until Phase 1D, while
guest bootstrap and all actor provenance remain deferred.

```text
FINAL_STATUS=HOUSEHOLD_IDENTITY_PHASE1C_AUTH_FOUNDATION_COMPLETE
BASE_COMMIT=f70f7fb490a81d165f2c990c323735c675010b43
SESSION_TOKEN=randomBytes(32)-base64url
SESSION_TOKEN_AT_REST=SHA-256_ONLY
SESSION_TTL=30_days
AUTH_ENFORCEMENT_FOR_EXISTING_PET_ROUTES=NO
GUEST_IMPLEMENTED=NO
PRODUCTION_DB_MODIFIED=NO
DEPLOYED=NO
```
