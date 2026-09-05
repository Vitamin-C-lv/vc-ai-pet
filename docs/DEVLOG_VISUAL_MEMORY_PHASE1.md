# DEVLOG — Visual Memory Phase 1

Branch: `feat/visual-memory-phase1`
Base: `ce566c506a9d496ea5ee543b73f28232269c5c99`（`feat/long-term-cognition`，Android 真机 Multi-Visual 已验收）

## 目标

让李花花拥有「长期视觉经历」：三个月前主人发的一张植物照片，在 1000 条聊天、多次
重启、Dream、Reflection 之后仍能被检索到 → 找到原 attachment → 重新打开真正原图 →
Local Brain 再看 → 回答。明确不做「图片 caption 数据库」，也不允许复述旧 caption 冒充当前观察。

## 跨 Agent 软交接

- Canonical 共享目录：`/home/vitamin_c/projects/personal/vc-ai-pet-agent-share/`
  （README / CURRENT / DECISIONS / WORK_CLAIMS / agents / tasks / handoffs）。
- 每个项目 worktree 通过 `.agent-handoff` symlink 指向它；common gitdir `info/exclude`
  排除，`git status` 永远干净，实时日志不进 Git。
- 写权限：coordinator 写 CURRENT/DECISIONS/WORK_CLAIMS/agents/deepseek-v4.md；
  每个 Luna 只写自己的 `agents/<id>.md` 和 `handoffs/<task>.md`；只有 coordinator 改
  WORK_CLAIMS、merge、push。
- 长期规范（本文件 + `docs/AGENT_HANDOFF_PROTOCOL.md`）进仓库；实时日志留在共享目录。

## 数据模型与存储

- ConversationStore 定义不变：RAW LIFE RECORD，原图唯一归属。
- 新增独立 SQLite `visual-experience.db`（位于 ConversationStore 同一 sandbox root）：

```text
visual_experiences   experience_id PK / source_message_id UNIQUE / attachment_id /
                     occurred_at / user_text / created_at / last_inspected_at /
                     inspection_count
visual_events        event_id PK / experience_id / turn_id / kind(inspection|revisit|
                     comparison|observation) / occurred_at / focus / summary /
                     related_experience_id / evidence(default 'inferred')
visual_terms         (experience_id, source_kind, term) PK / source_ref / weight
visual_sync_state    backfill cursor (key='backfill_sequence')
```

索引覆盖 attachment_id / source_message_id / occurred_at / term / experience_id。
Visual Experience 绝不保存第二份图片。

## Backfill 与增量同步

- Backfill：遍历 conversation archive 的 raw user messages，找到 attachment 即建
  Visual Experience Root，只索引主人原话。0 模型调用、0 PetMemory 写入、0 Dream、
  不改原图。旧的 visual observation 本阶段不要求回填（宁缺毋滥）。
- 增量：cursor 记在 `visual_sync_state`，restart-safe；`INSERT OR IGNORE` 幂等，
  重复初始化不产生 duplicate experience。
- 运行时自愈：visual turn 前后各做一次增量 sync（只处理 cursor 之后的新行），
  普通「花花你好」零开销、绝不重扫历史。

## 检索与证据权重

- 共享 `src/vision/visual-keywords.js`：中文字符/中文 bigram/ASCII keyword，
  从 Recent Visual 抽出，Recent / Long-Term 同一套算法（不再漂移）。
- 权重写入时即区分证据等级：user_text（raw）×3，observation（inferred）×1；
  检索分 = query term 命中时累加已存权重之和。
- Assistant old reply 永不进入索引（backfill 只看 role=user）。
- Long-Term 候选只含 metadata（experienceId/attachmentId/sourceMessageId/userText/
  occurredAt/score/provenanceHints），绝不装 image bytes。
- 并列最高分 → AMBIGUOUS（不随机挑、不做 recency tie-break），由花花反问主人。

## Resolver 顺序与触发

CURRENT IMAGE → RECENT VISUAL → LONG-TERM VISUAL → AMBIGUOUS/NONE。

- Long-Term 触发保守：「以前/上个月/你还记得/好久」等长期时间词 + 视觉对象
  （照片/植物/猫/狗/那盆/那张…）；「刚才/刚刚/这张/上一张/现在」等立即词一律不触发。
- 「刚才的面」「上一张」继续走 Recent Visual（回归锁定）。
- 「花花你好」不加载图片、不调 Vision、不查 Visual 库。

## 找到长期图片以后

Long-Term candidate 进入 Visual Working Session：`attachmentId →
ConversationStore.readAttachmentDataUrl() → 真正原图 → Local Brain Vision`，
然后才允许重要视觉回答。旧 observation 只能帮助找 candidate，不能成为最终视觉事实。
asset 缺失时坦诚回复「原图找不到了」，绝不拿旧 caption 冒充。

## Visual Events（lazy enrichment）

每次真正查看一张图后记录：首次 `inspection`，重开 `revisit`，跨图 `comparison`
（带 related_experience_id），看到的内容 `observation`（evidence=inferred，summary
terms ×1 入索引）。同一 source_message_id 永远是同一个 raw root：看 10 次
inspection_count=10 但 raw evidence roots=1；Dream/Reflection 统计按 raw root 去重。

## Dream / Reflection（bounded adapter）

- `src/dream/visual-dream-context.js`：最多 4 条最近/相关 Visual Experience，每条带
  最近 ≤3 条 observation，强制分节：RAW（主人在 X 时间发了一张图片/主人原话）与
  INFERRED（花花当时观察）。section ≤1200 字符，sanitizeSafeTraceText 过滤。
- DreamEngine/ReflectionEngine 增加可选 `visualContextProvider`；无 provider 时行为
  与上一阶段逐字节一致（回归锁定）。固定声明注入：「INFERRED 只是当时观察，不能
  当作新事实，也不能增加证据数」。
- 产出仍走现有 Gate：DREAM_DERIVED / REFLECTION_DERIVED + evidence=inferred。

## 前端（最小安全渲染）

- 新活动 `visual_recall`（「🐾 花花想起以前好像见过……」）+ media_ref 历史原图缩略图 +
  relation=recalled 的 visual_selected（「↩️ 花花翻到以前的一张照片」），复用现有渲染路径，
  零新增网络请求。禁止输出 CoT / raw prompt / reasoning_content / 内部规则。
- deferred bugs（timestamp/metadata 泄漏、Activity Trace 啰嗦）本阶段未动。

## 验证（全部 sandbox fixture，未触碰生产数据）

- `test/v0.4-visual-experience-store.mjs`（L01）
- `test/v0.4-long-term-visual-recall.mjs`（L02）
- `test/v0.4-visual-memory-orchestrator.mjs`（L03）
- `test/v0.4-visual-dream-context.mjs`（L04）
- `test/v0.4-visual-mobile-rendering.mjs`（L05）
- `test/v0.4-visual-memory-acceptance.mjs`（coordinator 集成验收）：
  A 600+ 消息后召回 / B 重启召回 / C 重开原图 / D 错 observation 只辅助 /
  E AMBIGUOUS / F assistant 不作证据 / G 刚才的面走 Recent / H 问候零视觉开销 /
  I 同图 10 次 roots=1 / J 两图 roots=2 / K asset 缺失坦诚；
  Backfill：MODEL_CALLS=0、PET_MEMORY_WRITES=0、DREAM_RUNS=0、原图 UNCHANGED、重启幂等。
- 回归：`npm run smoke`（含 client build/verify）与 `npm run test:long-life` 全绿；
  Multi-Visual A→B→A 与 MAX_VISUAL_INSPECTIONS_PER_TURN=5 继续 PASS。

## 状态

VISUAL_MEMORY_PHASE1=READY_FOR_PRODUCTION_DEPLOYMENT
PRODUCTION_DEPLOYED=NO（由单独的 deployment closure 处理生产）
