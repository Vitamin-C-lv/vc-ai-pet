# VC-AI-PET × StackChan / 李花花 — Phase 4 实体部署报告

日期：2026-09-18（Asia/Shanghai）

分支：feat/stackchan-body-mvp

范围：在既有 Phase 3C handoff 的已确认事实之上，完成 OTA1 app-only 部署、PC Body Bridge、视觉、扬声器、麦克风语音闭环，以及音量 90 固件重部署。

## 结论

李花花已经作为真实 StackChan 身体运行在 ota_1。ota_0 Factory 恢复槽保留，未写入其应用区；本轮没有整盘刷写、erase_flash、bootloader、partition table、eFuse、Secure Boot 或 Flash Encryption 操作。

当前实体链路：

    StackChan/CoreS3 摄像头/麦克风/显示/扬声器
            ⇅ Wi-Fi / LAN
    Windows Body Bridge :17871
            ⇅ HTTP
    VC-AI-PET :17870 → 现有 Li Huahua 4B 多模态链路
            ⇅
    本地 llama-server :17861（Qwen3.5-4B + mmproj）

视觉请求直接复用花花已有的原生多模态 4B 路径，没有新增或依赖独立的 0.8B 模型。

## OTA1 部署与 Factory 保护

| 项目 | 结果 |
|---|---|
| 目标设备 | M5Stack StackChan / CoreS3 / ESP32-S3 |
| 目标端口 | COM5 |
| Factory 槽 | ota_0 @ 0x20000，保留 |
| 部署槽 | ota_1 @ 0x510000，运行中 |
| app-only image | 2,489,776 bytes |
| ota_1 分区容量 | 0x4f0000 bytes |
| ota_0 应用区写入 | 0 |
| ota_1 写入后校验 | YES |
| ota_1 首次启动确认 | YES |
| OTA 元数据策略 | 单独更新选择记录；不触碰 ota_0 应用区 |

部署脚本为 scripts/stackchan/deploy-ota1-app.py。它先读取并解析两份 otadata，为目标槽计算单调递增序号，写入并验证 ota_1，再等待首次启动和 OTA confirm；固定使用 app-only offset，不调用整盘擦除或全片刷写。

首次使用旧固定序号的尝试因无法证明 ota_0 safety boot 而安全停止，没有写入 app。修正为按当前有效序号计算下一组槽位序号后重新执行，最终结果：

    OTA1_IMAGE_BYTES=2489776
    OTA0_APP_WRITES=0
    OTA1_WRITE_VERIFIED=YES
    OTA1_FIRST_BOOT_VALIDATED=YES

首次启动串口证据包含：

    Loaded app from partition at offset 0x510000
    [HAL] ota confirm check: partition=ota_1, state=1
    ota image is stable, marking current app valid

## 实体功能验收

### 状态与表情

Bridge 的 GET /v1/body/state 返回 schema v1 DTO，已映射花花名字、visual state、emotion、dream、sleeping、thinking、speaking 和 avatar。设备持续轮询并上报状态；当前 live snapshot 为 pet.name=李花花、visualState=relaxed、expression=relaxed。

### 摄像头 → 花花视觉理解

已完成真实设备摄像头抓帧、上传到 VC-AI-PET /api/pet/upload、带 attachmentId 启动现有多模态对话、轮询回复并通过实体扬声器播放。一次实际回复识别到白色墙壁、天花板和带窗帘的窗户，证明图片确实进入花花视觉链路，而不是只返回固定文本。

### 扬声器与音量 90

实体扬声器已实际播放花花生成的语音。因用户反馈原音量过小，本轮把固件的 SetOutputVolume(55) 调整为 SetOutputVolume(90)，重新构建并部署到 ota_1。音量 90 控制请求已经由设备确认，Bridge live health 的最后一次 speaker ACK 为成功。

报告记录的是设备 ACK 成功；音量是否达到用户主观满意度仍以用户现场听感为准。

### 麦克风 → 本地 STT → 花花 → TTS → 扬声器

已完成一次真实麦克风闭环：设备上传 24 kHz PCM（240,000 bytes），本地免费开源 Vosk 中文模型解码为“你好 花花 的 到 我 吗”，随后送入现有花花 4B 对话链路，花花生成回复并由实体扬声器播放。新增功能没有把旧的高资源本地语言模型作为依赖。

### 免费与隐私边界

- 不使用收费 API。
- 视觉和对话继续走本机已有 Qwen3.5-4B 原生多模态路径。
- 麦克风 STT 使用本地 Vosk；TTS 使用 Windows 本机 System.Speech，音频经 Bridge 送给设备。
- 本报告包不包含 Memory 数据库、原始麦克风 PCM、相机原图、访问令牌或个人凭据。

## 当前运行证据

打包时重新读取 Bridge：

- GET <current-private-LAN>:17871/healthz：HTTP 200。
- GET <current-private-LAN>:17871/v1/body/state：HTTP 200。
- 设备持续产生 state requests；live health 的 lastAck.kind=speaker 且 ok=true。

原始 JSON 与构建日志位于本报告 ZIP 的 03-live-evidence；LAN 地址只作为本机当时的运行证据，不写入固件配置和源码。

## 源码与可复现入口

- device/stackchan/m5stack-factory/lihuahua_body_io.cpp：摄像头、麦克风、扬声器 I/O；输出音量 90。
- device/stackchan/m5stack-factory/lihuahua_body_app.cpp：状态轮询、发现、显示和输入事件。
- device/stackchan/m5stack-factory/lihuahua_body_main.cpp：只启动李花花身体 app，不启动 Factory AI/App Center。
- tools/stackchan-bridge/src/embodied.mjs：LAN Bridge、视觉请求、语音请求、本地 TTS 和设备 ACK。
- scripts/stackchan/prepare-factory-build.py：构建树准备。
- scripts/stackchan/deploy-ota1-app.py：受边界约束的 ota_1 app-only 部署。

构建日志显示：

    Generated .../build/stack-chan.bin
    stack-chan.bin binary size 0x25fdb0 bytes
    0x290250 bytes (52%) free
    Project build complete

## 明确保留的历史状态

Phase 3C 文档记录的是当时只读审计阶段的 STACKCHAN_PHASE3C_OTA_TRUTH_UNRESOLVED，并且明确没有写入。该状态没有被改写；本报告记录的是之后在同一安全边界内完成的 Phase 4 app-only OTA1 部署事实。两者是时间顺序不同的证据，不是互相矛盾的报告。

## 已知限制

1. 当前 Bridge 依赖运行时 LAN 发现和当前 Windows 私有网卡地址；不把 DHCP 地址硬编码进固件。
2. 设备端摄像头、麦克风和扬声器闭环已实测；语音转写质量仍取决于现场噪声和 Vosk 小模型覆盖度。
3. 音量 90 已部署并收到设备 ACK，最终是否足够响需要主人在设备旁再次听感确认。
