# DEVLOG — Visual Memory Phase 1.2（Long-Term Retrieval Precision + Activity Trace Compact）

Branch: `feat/visual-memory-phase1.2`
Base: `bfe99edbcdd690465127715379aecdd2063d5eff`（Visual Memory Phase 1.1，已部署生产）

## 背景：Android 真机长期视觉复验再次失败

Phase 1.1 交付了 legacy observation 零模型迁移（10 events / 984 terms），但真机复验
「你记得我之前给你发的那盆无花果吗 有很多无花果」仍选中了 Tom&Jerry 找不同图，而非
无花果原图。本轮只读定位真实失败 turn。

## 真实失败 turn（只读定位）

```
TURN_ID=f6268e0f-3098-44eb-b34b-04fdd34a742a
MESSAGE_ID=62ed3933-61d6-483d-8612-79c291cfd2b8
QUERY=你记得我之前给你发的那盆无花果吗 有很多无花果
SELECTED_ATTACHMENT=2c910ee2-fc52-48eb-90b0-eb5456b7af35 (Tom&Jerry 找不同)
CORRECT_ATTACHMENT=047fba61-b59e-46f5-a36e-e10c9143d5c8 (无花果)
```

## 根因（真实证据，与初版假设不同）

**不是 observation term pollution。** 长期打分器（`searchByTerms`）实际上正确地把无花果
排第一：fig（fbae60ae，`你看，无花果到了`）得分 6（无:3 + 果:3），Tom&Jerry
（b320b52a）仅 1（有:1 observation）。

真正根因是 **Recent resolver 的 generic boilerplate 短路**：

1. `chat()` / `startChatTurn()` 先跑 `recentVisualResolver.resolveFromStore()`，再判
   `detectLongTermVisualIntent()`。Recent 的 `overlapScore` **不抑制 generic 套话**。
2. 主人原话里的「给你/你发/一张图片」与最近一张 Tom&Jerry 原话
   「我们来玩找不同吧，我先给你发一张图片」弱匹配：`给:1 + 发:1 + 给你:3 + 你发:3 = 8`。
3. `overlapScore=8 > second=6` → `resolved.matched=true` → 长期 resolver 被短路，永远没跑。
4. 于是按 Recent 路径重开 Tom&Jerry 原图 →「↩️ 花花再回头看看前一张……」→ 描述书架。

```
WRONG_WINNER_OBSERVATION_TERM_CONTRIBUTION=0
FIG_OWNER_TEXT_CONTRIBUTION=6 (long-term scorer 内)
ROOT_CAUSE=RECENT_BOILERPLATE_OVERLAP_SHORT_CIRCUITS_LONG_TERM
```

附带的潜伏问题（本轮顺带修复）：fig 的 user_text terms 是旧规则（stop 字「花」导致
「无花/花果」漏 index），长期打分器只能靠 无+果 拿 6 分，弱。本轮用 exact-phrase owner
bonus 对 raw user_text 直接匹配「无花果」，对旧索引鲁棒。

## 本轮交付

### A. Routing 修复（D-022，coordinator/DeepSeek）

- `src/runtime/pet-runtime.js`：`chat()` 与 `startChatTurn()` 先
  `detectLongTermVisualIntent()`（已排除 刚才/这张/上一张/前一张 立即引用）再跑 Recent
  resolver。显式长期引用不再被 Recent boilerplate 短路。
- `src/runtime/pet-turn-orchestrator.js`：`runVisual()` 中 `detectLongTermVisualIntent`
  命中即走长期，不再受 `resolved.matched` 阻断；仅 `intent==='historical_visual'`
  且 Recent 未命中时才沿用 Recent 优先级。
- 回归：`test/v0.4-visual-routing-phase1.2.mjs` 证明 Recent boilerplate 不能拦截长期。

### B. 检索打分器（D-023..D-027，LUNA-01）

`src/vision/visual-keywords.js` + `long-term-visual-recall.js` +
`visual-experience-store.js(searchByTerms)`：

- 中文 2-4 gram：单字=1 / bigram=3 / trigram=9 / 4-gram=27，仅当 n-gram 全部字符都属
  stop 才过滤（延续 D-017，禁止硬编码具体词）。
- owner exact semantic phrase bonus：query 高信息多字短语（≥3 内容字）完整出现在 owner
  raw user_text → 强 owner bonus（对旧索引鲁棒）。
- observation contribution 归一化/封顶（dedup + bounded），长 observation 不因「话多」
  自动获得巨大检索优势。
- 单字弱辅助；generic content 低权词（很多/这个/里面/这里/画面/看到/一张/照片/东西/内容）
  抑制，内容词（无花果/蜡笔小新）保留。
- margin/confidence：winner 必须对第二名有 semantic margin，否则 AMBIGUOUS 反问。
- `searchByTerms` 增加 `scoreBreakdown`（owner_text_exact / owner_text_ngram /
  owner_text_single_char / observation_ngram / observation_single_char / generic_terms）。

### C. Activity Trace Compact（D-028，LUNA-02）

`src/vision/visual-working-session.js` + `src/remote/mobile-ui/mobile.js`：

- 长期 recall（relation='recalled'）不再对普通主人 UI 展示完整「👀 看到：……」observation
  dump，改为极短「👀 花花重新看了看」；完整 observation 仍正常持久化为 inferred event +
  retrieval terms + 内部诊断。
- 长期 recall final 默认 1 个 bubble，最多 2 个。
- 主人仍看到「↩️ 花花翻到以前的一张照片」+ 原图 +「👀 重新看了看」。

## 回归

- `test/v0.4-visual-memory-acceptance-1.2.mjs`：真实 production copy
  （/tmp/vm-triage-1.2，post-migration）跑无花果 query → fig top1 / matched / 正 margin，
  Tom&Jerry 不得成为 winner；蜡笔小新 observation recall 仍有效。
- `test/v0.4-visual-scorer-phase1.2.mjs`（LUNA-01）：n-gram / exact phrase / observation
  cap / 单字 / generic / margin 单测。
- `test/v0.4-visual-activity-compact.mjs`（LUNA-02）：recall trace 不展示完整 dump、final
  ≤2 bubbles、inferred observation 仍持久化。

## 未做（本轮明确排除）

- 不重构 Visual Memory、不改 migration schema、不加 embedding/vector DB。
- 不加 assistant hint、不做 lazy historical VLM bootstrap、不改 Dream。
- 不改 timestamp leak（DEFERRED_TIMESTAMP_LEAK=PRESERVED）、不改 LAN、不改 initiative、
  不改 Multi-Visual architecture。

## 验收结论

见最终报告（FINAL_STATUS / FIG_TOP1 / SHINCHAN_RECALL / OBSERVATION_ONLY_LEGACY_RECALL /
LONG_TERM_ACTIVITY_MAX_VISIBLE_STEPS / LONG_TERM_FINAL_BUBBLES …）。
