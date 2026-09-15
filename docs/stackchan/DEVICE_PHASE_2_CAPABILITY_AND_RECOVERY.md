# StackChan Phase 2 — Factory Firmware / Recovery Audit

采集日期：2026-09-15（Asia/Shanghai）
范围：M5Stack StackChan K151 / CoreS3；只读设备取证、官方源码审计、独立本地构建。没有写入固件。

状态用语：`CONFIRMED`=设备输出或可重现源码/官方文档直接支持；`INFERRED`=由多项证据推导；`UNVERIFIED`=本轮没有足够证据。工厂固件和 Moddable Stack-chan 是两条不同软件栈，本报告不互相套用 API。

## 结论

- **CONFIRMED：**设备被动启动日志为 ESP32-S3、SKU `m5stack-stack-chan`、Project `stack-chan`、App `1.5.1`、ESP-IDF `v5.5.4`；Windows 设备枚举是 Espressif USB/JTAG-serial 复合设备，COM5 当前存在。
- **INFERRED（高）：**设备运行 M5Stack 官方 StackChan/Xiaozhi 工厂固件族。官方 M5Stack 仓库当前 main 的 `PROJECT_VER=1.5.1`、项目名 `stack-chan`、板型 `m5stack-stack-chan` 与设备 banner 相符。**设备安装镜像的精确 Git commit/tag 仍 UNVERIFIED**；官方 Releases 页面没有可用于逐字节对应本机镜像的发布物。
- **CONFIRMED：**Factory `AVATAR` 和 `App Center` 是静态注册的 Mooncake 内置 App。App Center 从服务器读取应用目录，选择条目后转入 OTA 更新流程，不是独立 MOD 插件槽。当前 factory app 中没有可直接安装本项目 face client 的已证实路径。
- **CONFIRMED：**在官方 M5Stack 源码快照上加入一个只读 app 后，ESP-IDF 5.5.4 / ESP32-S3 本地编译通过；工厂源码对照构建也通过。两个构建都只在 WSL `/tmp` 的隔离克隆中进行。
- **未验收：**没有把任何构建物下载、烧写、OTA 到设备；没有设备端 HTTP 请求、显示验收、断网/恢复验收。该 app 仅“源码实现并编译”，不能称为实体 MVP 已接受。

## 设备与私有只读备份

| 字段 | 结果 | 证据 |
|---|---|---|
| Model / SKU | M5Stack StackChan K151/CoreS3 / `m5stack-stack-chan` | 被动启动 banner；K151 产品系列由设备背景和 M5Stack 产品文档佐证 |
| Chip | ESP32-S3 revision v0.2 | esptool chip identification；MAC 未保留在报告 |
| USB VID:PID / COM | `303A:1001` / `COM5` | PnP 与 Win32_SerialPort；未记录 InstanceId 唯一尾段 |
| App / IDF | `1.5.1` / `v5.5.4` | 设备启动 banner |
| 完整 flash 只读备份 | **PASS，16,777,216 bytes** | esptool `read_flash 0x0 0x1000000`；制造商/容量读数为 16 MiB |
| 私有备份位置 | `C:\Users\18442\Downloads\VC-AI-PET-StackChan-PrivateBackup\factory-flash-2026-09-15.bin` | 只保留在本机 Downloads 私有目录；绝不加入 Git 或 handoff ZIP |
| 私有备份 SHA-256 | `E1E7560E5172641C2EDEF405EB354C54481C6E3E71D3F7D2A8D3345C1115DFF8` | 仅用于该私有恢复镜像的完整性识别；未读取或导出镜像内容 |
| 读完后的设备状态 | `UNVERIFIED`（PnP 当前仍显示 COM5、设备状态 OK） | esptool v4.10.0 在 `read_flash` 收尾输出 `Hard resetting via RTS pin`；这是其自动 RTS 收尾复位，不是发送固件写入/擦除命令。此后未再向设备发命令 |

原始镜像可能包含 NVS、Wi-Fi 或绑定数据，因此被作为**私有设备数据**处理。没有从备份中提取、打印或核查任何密钥/配置；没有把它复制到源码目录、临时 handoff 目录或 ZIP。

## 官方源码和固件机制

本地审计克隆：`https://github.com/m5stack/StackChan`，main commit `1b5765599fba8aaad1811d9a79358ccc7051f5f3`（commit subject：`Merge pull request #112 from m5stack/firmware-dev`）。ESP-IDF 对照版本为官方 `v5.5.4`。源克隆位于临时 WSL `/tmp/m5stack-stackchan-phase2-source`，工具链位于 `/tmp/esp-idf-tools-v5.5.4`；均不是生产工作树。

源码关键证据：

- `firmware/CMakeLists.txt`：项目为 `stack-chan`、项目版本 `1.5.1`；`firmware/README.md` 指定 ESP-IDF `v5.5.4`、依赖获取和本地 `idf.py build`。
- `firmware/main/main.cpp`：`app_main()` 静态 `installApp()` 注册 AppLauncher、AppAiAgent、AppAvatar、AppAppCenter 等内置 app；无运行时扫描任意第三方 HTTP app 的注册机制。
- `firmware/main/apps/app_avatar/app_avatar.cpp`：`AppAvatar` 是正式内置 `AVATAR` 页面，使用固件自己的 avatar / BLE / WebSocket 通道；它并不直接轮询 VC-AI-PET Bridge。
- `firmware/main/apps/app_app_center/app_app_center.cpp` → `Hal::fetchAppList()`（`firmware/main/hal/hal_app_center.cpp`）：GET 官方应用目录、解析 JSON，再由 `Hal::launchApp()` 调用 `start_ota_update()`。目录条目走固件 OTA，不是 hot-plug MOD。
- `firmware/partitions.csv`：存在 NVS、OTA data、`ota_0`、`ota_1`、assets、coredump；没有独立 StackChan 用户 MOD/app 分区。
- HAL 和 board 支持 LCD/LVGL、网络、摄像头、音频、IMU 与舵机代码，但“存在源码/API”不表示本轮已经安全调用或已对用户开放。这个 PoC 只用显示与只读 HTTP GET，没有调用 servo/audio/mic/camera/BLE/touch action。

M5Stack 官方文档介绍 CoreS3 屏幕、相机、IMU、扬声器、双麦克风和 StackChan 底座舵机；本机 banner/初始化行确认 LCD、camera sensor、BMI270、触控控制器的初始化。硬件与软件 API 仍分开判定：实际音频、舵机限位及安全动作在本轮均未验证。StackChan 官方恢复文档建议烧录时用底座 USB-C 接口以降低意外电机转动风险；该提示不是当前固件允许无风险刷机的证明。

### 固件与扩展状态

| 能力 | 结论 | 备注 |
|---|---|---|
| Factory no-reflash custom MOD | `FAIL`（本固件架构） | App 静态编译注册；App Center 最终做 OTA 镜像更新；没有当前 factory 镜像的独立 MOD 槽/API 证据 |
| 本任务 custom AppAbility | `PASS`（本地构建） | 需要把新 C++ app 集成并重编工厂镜像；尚未安装 |
| Wi-Fi / HTTP client | `PASS`（固件源码能力） | 当前设备是否连上 2.4 GHz WLAN、地址是什么：`UNVERIFIED`；没有记录 SSID/IP/密码 |
| OTA | `PASS`（factory 固件通道） | 仅证明固件支持 OTA 更新，不证明可安全降级或可保留绑定/NVS |
| 设备恢复 | `DOCUMENTED_NOT_TESTED` | 官方 M5Burner 文档提供 `StackChan` + `Only Official` + latest 恢复步骤；本轮未下载/烧录官方镜像 |
| 官方恢复镜像版本匹配本机 `1.5.1` | `UNVERIFIED` | M5Burner “latest” 的实际版本/文件与当前镜像 commit 不可静态确认 |
| 舵机 pan/tilt API 与机械安全 | `UNVERIFIED` | 源码有相应驱动，但没有动作、角度/限位测试 |

另有 `stack-chan/stack-chan` 的 Moddable host/MOD 产品：它与本机 M5Stack Xiaozhi factory 栈不是同一固件。其 MOD 机制即使在对应 host 上可用，也要求构建/安装 MOD，并非当前镜像的无侵入扩展路径；它的 SDK API 不可移植地假定为本机 HTTP GET 能力。本轮不建议换栈或刷该 host。

## 本地 App PoC

新增 `device/stackchan/m5stack-factory/`：

- 只解析 body contract v1 的 `online`、`reachable`、name、visualState、expression、animation、dream/sleeping 等展示字段。
- 小于等于 4 KiB 的 HTTP response 缓冲区，HTTP GET，timeout 1.5s，轮询 2s；Bridge URL 默认空值，不包含 LAN IP。
- 断连时最多保留最近一次状态 10s，之后显示 offline；`reachable=false` 显示 stale，且不把缓存误报为实时可达。
- 表情由 bridge 的 `expression` 决定，未知值 fallback idle；sleep/dream 优先显示对应表情；只做脸部 LVGL 屏幕绘制/眨眼。
- 没有舵机、动作 cue 执行、音频、麦克风、摄像头、聊天、Action API、BLE、MQTT、WebSocket 或 mDNS。

源码构建事实：

| 构建 | 结果 | 设备/分区尺寸 |
|---|---|---|
| M5Stack factory source 对照构建 | `PASS` | ESP32-S3，工厂 app slot `0x4f0000` |
| LiHuahua app 增量构建 | `PASS` | `stack-chan.bin` build output `0x39d8e0` bytes，app slot 剩余 `0x152720` bytes（约 27%） |
| C++ parser/face host test | `PASS` | GCC `-std=c++17 -Wall -Wextra -Werror` + ESP-IDF cJSON；运行断言通过 |
| 写入设备 | **NO** | 未执行 `idf.py flash`、`write_flash`、M5Burner Burn、OTA 或 erase |

自定义固件 build artifact 含完整 factory app，今后若写入可能改变现有 app/OTA 状态；本轮不把它作为可恢复性已验收的安装包，也不放 ZIP。先保留为源码、补丁说明、测试和构建日志摘要。

## 恢复与回滚

1. **源码回滚：**只需不采用 `device/stackchan/m5stack-factory/` 的源文件/最小注册改动；VC-AI-PET 生产分支、生产服务、Memory/Dream/Reflection/Android 均未修改。
2. **设备固件回滚：**唯一逐设备镜像备份保存在上表私有目录。将来如需恢复，必须先取得单独的写入授权、核对芯片/容量/文件长度，再制定明确的 write/restore 步骤。当前不执行任何 restore。
3. **官方恢复：**M5Stack 文档给出 Windows M5Burner “StackChan”/“Only Official”/latest 的流程，但 latest 版本匹配、账号绑定/AI 配置保留情况未确认。不要解绑，不要选 Erase，不要把 generic latest 当作当前镜像等价备份。
4. **当前服务回滚：**没有创建 Windows firewall、portproxy 或持久 bridge listener；设备只读备份与本地 build 与 17870/生产网络隔离。

## 官方参考

- [M5Stack StackChan 源码仓库](https://github.com/m5stack/StackChan)
- [M5Stack StackChan 官方使用/恢复说明](https://docs.m5stack.com/zh_CN/StackChan)
- [M5Stack StackChan firmware `main.cpp`](https://github.com/m5stack/StackChan/blob/main/firmware/main/main.cpp)
- [M5Stack StackChan 官方 Releases](https://github.com/m5stack/StackChan/releases)
- [另一套 Moddable Stack-chan releases](https://github.com/stack-chan/stack-chan/releases)
- [另一套 Stack-chan MOD guide](https://github.com/stack-chan/stack-chan/blob/develop/firmware/mods/README.md)
