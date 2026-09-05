# Multi-Visual Working Session：第二张图片失败记录

## 症状

生产 turn `b770f00f-1c37-4e14-96ed-934c7e78fac6` 的当前图片 B 已完成 `visual_selected` 和 `visual_image`，随后没有公开 observation 或 final。turn 终态为：

- `TURN_ERROR_CODE=PET_LOCAL_BRAIN_BAD_RESPONSE`
- `REQUEST_ID=lb-fe8c4ef8ccfb4550899319ad66d9d39a`
- `RETRYABLE=false`
- `VISUAL_INSPECTION_COUNT_BEFORE_FAILURE=1`

候选池 metadata 正常：B 为 `V0/current`，上一张 A 为 `V1/previous`。B 的 attachment 为 `5e399df4-ee54-4fcb-b8a6-afe7dd349369`，A 的 attachment 为 `2c910ee2-fc52-48eb-90b0-eb5456b7af35`；两项 metadata、原图文件和缩略图文件均可读，未读取或记录图片字节。

## 根因与失败层

失败发生在 Local Brain 结构化输出层（stage E），不是候选池、attachment persistence 或 `nextVisualId` 路由层。视觉请求使用 `reasoning_effort=medium`，Local Brain relay 为该 profile 保留 2,048 个推理 token；旧的 `max_tokens=768` 小于该推理预算。真实回放的响应形状为 `finish_reason=length`、公开 `content` 为空、`reasoning_content` 非空，因此 Pet 无法解析视觉 JSON，返回 `PET_LOCAL_BRAIN_BAD_RESPONSE`。

## 修复

- `PET_VISUAL_STEP_MAX_TOKENS` 从 768 的隐式值改为 4,096，给 medium 视觉推理和公开 JSON 留出同一 completion budget。
- 视觉响应兼容 text-part array，只拼接公开 text/input_text 部分；不会使用或记录 `reasoning_content`。
- Visual Working Session 对 asset、Local Brain、structured output、protocol 失败返回受限 metadata：`inspectionOrdinal`、`currentVisualId`、`nextVisualId`、`attachmentId`、`requestId`、`retryable`。
- turn_failed 只公开上述诊断字段，不公开图片、prompt、模型内容或隐藏推理。

## 验证

- `node test/v0.3-turn-orchestrator.mjs`：PASS。
- 覆盖 A→B、A→B→A、单图、最近视觉引用、5 次上限、非法 `nextVisualId` 不崩溃诊断、缺失 asset fallback，以及视觉请求 4,096 token 回归。
- 使用生产已有的 B/A 两个 fixture 做一次隔离 Local Brain sandbox session，实际顺序为 `V0(B) -> V1(A) -> answer`，两张不同图片均产生 observation，`uniqueImages=2`，无诊断失败。
- Pet Host PID `1777397` 和 Local Brain Relay PID `823890` 未重启；生产 conversation store 未写入本次 sandbox fixture。

`SOURCE_CODE_CHANGED=YES`
`PRODUCTION_DEPLOYED=NO`
`COMMIT=see git log for this document's commit`
