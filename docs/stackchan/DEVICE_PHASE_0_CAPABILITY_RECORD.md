# StackChan K151 / CoreS3 Phase 0 设备识别记录

采集日期：2026-09-15（Asia/Shanghai）
方法：Windows PnP/CIM 只读枚举；COM5、115200 8N1、DTR/RTS=false、被动读取约 10 秒。没有发串口命令、没有进入下载模式、没有写入 flash。原始/脱敏串口临时记录位于 `%TEMP%\stackchan-serial-banner.txt`；不纳入仓库。

状态含义：`PASS` 表示有直接设备日志或官方产品规格证据；`FAIL` 表示该能力与本机观察到的固件形态不相符；`UNVERIFIED` 表示没有足够的当前设备固件/API 证据。硬件存在不等于当前固件可用。

## 设备与固件

| 字段 | 结果 | 证据/说明 |
|---|---|---|
| `DEVICE_MODEL` | `M5Stack StackChan`；日志 SKU=`m5stack-stack-chan` | 串口 `Board: ... SKU=m5stack-stack-chan`；K151 称谓来自设备任务上下文。未记录设备 UUID。 |
| `DEVICE_CHIP` | `ESP32-S3` | `ESP-ROM:esp32s3-20210327`。 |
| `DEVICE_FRIENDLY_NAME` | `USB 串行设备 (COM5)`；同 VID/PID 的 `USB JTAG/serial debug unit` | Windows PnP 当前快照。 |
| `DEVICE_PNP_ID` | `USB\VID_303A&PID_1001&MI_00`；`USB\VID_303A&PID_1001&MI_02` | 仅记录硬件 ID 前缀，不含设备 instance 唯一尾段。 |
| `DEVICE_VID` / `DEVICE_PID` | `303A` / `1001` | Espressif USB composite/JTAG-serial interface。 |
| `DEVICE_COM_PORT` | `COM5` | Windows `Win32_SerialPort` 与 Ports PnP。 |
| `DEVICE_FIRMWARE_MODE` | `M5STACK_FACTORY_OR_AVATAR` | 被动 banner 同时显示 `Project name: stack-chan`、`App version: 1.5.1`、`[HAL] xiaozhi board init`、SKU=`m5stack-stack-chan`；M5Stack 官方 [`m5stack/StackChan`](https://github.com/m5stack/StackChan) 仓库使用该板型/固件族。它不是 `stack-chan/stack-chan` 的 Moddable 社区 host。 |
| `DEVICE_FIRMWARE_VERSION` | 应用 `1.5.1`；ESP-IDF `v5.5.4` | 串口应用信息与 bootloader。 |
| `DEVICE_MOD_SUPPORT` | `UNVERIFIED`；社区 Stack-chan MOD 不适用 | M5Stack 官方工厂固件文档列有 App Center 在线应用下载及 Arduino/UiFlow2/ESP-IDF 编程，但没有确认当前 1.5.1 镜像可无刷机地安装任意自定义 HTTP JSON 客户端。不要把社区 `MOD` API 当成本机 API。 |
| `DEVICE_OTA_SUPPORT` | `PASS`（官方固件族能力；本机未测试） | M5Stack 官方产品/仓库资料列出在线 OTA；串口分区表也有 `otadata`、`ota_0`、`ota_1`。本轮未触发更新。 |
| `DEVICE_WIFI_CLIENT_SUPPORT` | `PASS`（官方固件族能力）；本机连接状态 `UNVERIFIED` | M5Stack 官方固件面向 Wi-Fi/Xiaozhi 联网；本轮没有读取或记录 SSID/密码/IP，也没有确认本机当前是否已关联 AP。 |
| `DEVICE_RECOVERY_PATH` | `UNVERIFIED`；候选为匹配 K151 的 M5Stack 官方固件恢复流程 | 官方资料有 M5Burner/工厂固件和 USB 编程流程，但本轮未下载固件、备份当前镜像或执行恢复；具体兼容镜像及保留设置的能力仍需施工前核实。 |

## 外设能力

| 字段 | 硬件状态 | 当前固件 API 状态 | 证据 |
|---|---|---|---|
| `DISPLAY` | `PASS` | `UNVERIFIED`（本轮未操作显示 API） | 串口 `ili9341: LCD panel create success, version: 1.2.0`；官方 K151 规格为 2.0 英寸电容触控显示屏。 |
| `SPEAKER` | `PASS`（产品规格） | `UNVERIFIED` | [M5Stack K151 规格](https://docs.m5stack.com/en/StackChan)列有扬声器；本轮未播放声音。 |
| `MIC` | `PASS`（产品规格） | `UNVERIFIED` | 官方规格列有双麦克风/ES7210；本轮未录音或调用 ASR。 |
| `CAMERA` | `PASS` | `UNVERIFIED`（本轮未调用拍摄 API） | 启动日志 `Init Camera`、`gc0308: Detected Camera sensor`、`Camera init success`；本轮未取图。 |
| `IMU` | `PASS` | `UNVERIFIED`（仅初始化确认） | `HAL-IMU init`、`BMI270 init ok`；未读取/动作测试。 |
| `TOUCH` | `PASS`（触控控制器初始化） | `UNVERIFIED`（未触摸/未读事件） | `Si12T initialized`；官方规格为电容触控屏。 |
| `RGB` | `PASS`（产品规格） | `UNVERIFIED` | 官方 K151 规格列有 RGB LED；本轮未点灯。 |
| `SERVO_PAN_HARDWARE` | `PASS`（K151 产品规格） | `UNVERIFIED` | 官方 K151 产品规格描述头部舵机/反馈机构；本轮没有转动或发控制命令。 |
| `SERVO_TILT_HARDWARE` | `PASS`（K151 产品规格） | `UNVERIFIED` | 同上；未验证具体机械行程、限位、供电或固件接口。 |

## Phase 0 判定

- 固件可识别为 M5Stack 官方 StackChan 工厂固件族的 Xiaozhi 镜像，日志应用版本为 1.5.1；判定依据是 startup banner/SKU 与 M5Stack 官方 [`m5stack/StackChan`](https://github.com/m5stack/StackChan)，不是单看 `AVATAR` 画面。
- 设备端客户端暂不施工：M5Stack 官方固件提供 App Center/编程生态，但没有确认本机可在不刷写的情况下加载自定义 HTTP JSON polling 客户端。
- 社区 [`stack-chan/stack-chan`](https://github.com/stack-chan/stack-chan/blob/main/firmware/README.md) 的 host/MOD 与 `context.face.setEmotion(...)` API 属于另一套固件，不能套用于当前镜像；它的公开 MOD API 也未证明有通用 JSON HTTP GET 能力。
- 如未来选择自定义 firmware，官方编程路径包含 M5Burner/USB 下载模式/写入；本轮不进入该流程。具体恢复镜像、配置备份及兼容性仍须先做只读确认。
- PC bridge 与 fake-upstream 测试可以独立完成；CoreS3 HTTP JSON polling、表情映射和离线脸仍未在设备上验证。
- 不刷机、不测试舵机、不调用音频/摄像头/触摸/IMU 控制能力。

## Phase 2 后续补充

上述 `DEVICE_RECOVERY_PATH=UNVERIFIED` 是 Phase 0 初始取证时的记录。后续只读整片备份、官方 M5Burner 恢复路径证据、版本匹配限制和自定义源码构建结果见 [`DEVICE_PHASE_2_CAPABILITY_AND_RECOVERY.md`](DEVICE_PHASE_2_CAPABILITY_AND_RECOVERY.md) 与 [`PHASE2_ACCEPTANCE.md`](PHASE2_ACCEPTANCE.md)。Phase 2 未执行任何刷写，不能把本地 build 误读为设备已更新。
