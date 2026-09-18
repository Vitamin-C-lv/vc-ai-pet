# Phase 4 实体部署验收矩阵

日期：2026-09-18

| 验收项 | 结果 | 证据 |
|---|---|---|
| ota_0 Factory 应用区未写 | PASS | 部署结果 OTA0_APP_WRITES=0 |
| ota_1 app-only 镜像写入 | PASS | OTA1_WRITE_VERIFIED=YES |
| ota_1 首次启动 | PASS | 串口 Loaded app ... 0x510000 |
| OTA confirm | PASS | partition=ota_1, state=1 后标记 valid |
| 音量 90 固件 | PASS | SetOutputVolume(90)，重新构建并部署 |
| PC Bridge healthz | PASS | HTTP 200 |
| StackChan body state | PASS | HTTP 200，pet.name=李花花 |
| 表情同步 | PASS | visualState/expression/animation DTO 已实测 |
| 摄像头抓帧 | PASS | 真实 JPEG 上传并产生 attachment |
| 4B 原生视觉理解 | PASS | 现有 Qwen3.5-4B + mmproj 返回环境描述 |
| 实体扬声器播放 | PASS | 设备 speaker ACK ok=true |
| 麦克风 PCM 上传 | PASS | 240,000 bytes / 24 kHz |
| 本地中文 STT | PASS | Vosk 解码出中文测试语句 |
| 语音对话闭环 | PASS | STT → 花花 4B → TTS → speaker |
| 收费 API | PASS | 未使用 |
| 私人 Memory 上传第三方 | PASS | 未上传 |
| Android companion dirty changes | PASS | 本轮未修改/未 stage android-companion/** |
| ota_0 擦除/整盘刷写 | PASS | 未执行 |
| bootloader/partition/eFuse/Secure Boot/Flash Encryption | PASS | 未执行 |

## 判定

    FINAL_STATUS=STACKCHAN_LIHUAHUA_BODY_DEPLOYED_OTA1
    OTA0_FACTORY_PRESERVED=YES
    OTA1_VOLUME90_DEPLOYED=YES
    VISUAL_CHAIN=PASS
    SPEAKER_CHAIN=PASS
    MIC_STT_VOICE_REPLY_CHAIN=PASS

主观音量满意度仍需主人现场确认；这不影响固件已部署和设备 ACK 的事实。
