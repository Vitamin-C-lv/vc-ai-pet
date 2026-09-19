# VC-AI-PET × StackChan / 李花花 — Phase 4.1 短暂实体视觉语义报告

日期：2026-09-19（Asia/Shanghai）
分支：`feat/stackchan-body-mvp`

本轮只处理“StackChan 实体摄像头照片”的记忆语义。现有摄像头、4B 原生多模态视觉、Bridge、扬声器、麦克风、OTA1 和 ota_0 Factory 状态沿用既有 Phase 4 报告，不在本轮重复调查或改动。

## 已实现的行为

- `tools/stackchan-bridge/src/embodied.mjs` 上传实体相机照片时发送 `source=stackchan_camera` 和 `visualClass=embodied_transient`。
- `src/remote/lan-server.js` 与 `ConversationStore` 持久化这两个可选元数据；普通上传不带这两个字段时保持原行为。
- 当前轮仍把照片交给现有花花 4B 原生多模态路径；当前聊天历史保留图片和附件，Experience Buffer 只保留低权重文字经历，不携带可重新打开原图的 attachment handle。
- Recent Visual Resolver、Visual Experience、Gallery、Long-Term Visual Recall 和后台视觉重检都会在 transient 标记上 fail closed。标记写入 `visual_transient_attachments`，重启后仍然有效。
- 明确的文本记忆分支在 transient 分支之前，仍可通过显式记忆请求写入；没有引入新模型、付费 API 或第二套视觉架构。

## 历史数据处理

只用两条固定提示词完全匹配的用户消息确认历史实体相机记录；对话消息、原图和缩略图没有删除。两个已确认 attachment 在 Visual Experience index 中被标记为 transient，原有根/occurrence 行保留用于审计但所有公开读取路径都过滤。五条直接绑定这些 attachment 的旧视觉 PetMemory 行被标记为 `archived`；混合来源的 Dream/Reflection 文本没有在无法 100% 拆分时删除。

迁移入口：`scripts/stackchan/migrate-embodied-transient-vision.py`。默认是 dry-run，只有显式 `--apply` 才写入；本轮已经对当前 sandbox 执行一次，重复执行是幂等的。

## 回归证据

- `node --test test/stackchan-embodied-transient-vision.mjs`：9 个集中用例通过，覆盖普通上传、当前图像可见、当前轮视觉输入、Recent Visual 过滤、Visual root/occurrence 跳过、Gallery 源过滤、重启后 transient 标记、低权重经历语义和 raw-image handle 禁止。
- `node test/v0.4-visual-experience-store.mjs`：`VISUAL_EXPERIENCE_STORE=PASS`。
- `node test/v0.4-long-term-visual-recall.mjs`：`LONG_TERM_VISUAL_RECALL=PASS`。
- `python3 scripts/stackchan/test_ota_metadata.py`：6 个 OTA 纯逻辑用例通过；本轮未写设备。ESP-IDF v5.5.4 的 `INVALID=3` / `ABORTED=4` 枚举已校正；两者仍都不可选，selector algorithm 未改变。
- 需要 `meow-memory` 的完整 PetRuntime/Dream 测试在当前 checkout 缺少该可选依赖，因此没有把这类未运行结果冒充为通过；改动文件均已通过 `node --check` / `py_compile`。

本轮还明确记录：pairing-key firmware source 已在既有 StackChan source 中准备，但 Phase 4.1 没有对实体设备重新刷写；没有写 ota_0、ota_1、NVS 或 OTA metadata。

## 验收字段

```text
STACKCHAN_TRANSIENT_VISION=PASS
CURRENT_CHAT_IMAGE_VISIBLE=YES
CURRENT_TURN_VISION=PASS
STACKCHAN_GALLERY_VISIBLE=NO
STACKCHAN_VISUAL_MEMORY_ROOT=NO
STACKCHAN_RECENT_VISUAL_RECALL=NO
STACKCHAN_FUTURE_IMAGE_MATERIALIZATION=NO
STACKCHAN_EXPERIENCE_BUFFER=PASS
STACKCHAN_MEMORY_WEIGHT=LOW
STACKCHAN_RAW_IMAGE_MEMORY_EVIDENCE=NO
EXPLICIT_TEXT_MEMORY_STILL_WORKS=YES
NORMAL_UPLOAD_GALLERY_REGRESSION=PASS
NORMAL_UPLOAD_VISUAL_RECALL_REGRESSION=PASS
HISTORICAL_STACKCHAN_IMAGES_FOUND=2
HISTORICAL_STACKCHAN_VISUAL_ENTRIES_CLEANED=2
STACKCHAN_FIRMWARE_SOURCE_MODIFIED=YES
DEVICE_FIRMWARE_REFLASHED_THIS_ROUND=NO
DEVICE_FLASH_WRITES=0
MEMORY_PIPELINE_ARCHITECTURE_CHANGED=NO
TEST_RESULT=PASS
COMMIT=3d6f3fe8056c86b4ba1a2f03936b72ee36d02bf5
REMOTE_HEAD=3d6f3fe8056c86b4ba1a2f03936b72ee36d02bf5
WORKTREE_CLEAN=YES
```
