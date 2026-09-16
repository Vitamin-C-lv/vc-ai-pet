# Phase 3C DEVLOG

## 2026-09-16

1. 从 feature branch `feat/stackchan-body-mvp` 的 `0ef9399...` 开始，只读检查 Git；生产 worktree 的已有 `android-companion/**` 修改保持原样。
2. 阅读本机 ESP-IDF v5.5.4 源码，确认 `ota_state=ABORTED` 会在 `bootloader_common_ota_select_invalid()` 中排除；修正上一轮“seq2 必然选 ota1”的过度推断。
3. 用 CRC 初值 `0xffffffff`、正确的 0x1000 copy 间隔解码 fresh/private `otadata`：copy0 `VALID`，copy1 `ABORTED`，三份样本一致。
4. 检查 Factory 配置：`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y`、`CONFIG_BOOTLOADER_LOG_LEVEL_INFO=y`、numeric level=3；anti-rollback 未启用。该配置是 Factory source/build 证据，不把它扩大成未经独立 dump 的 bootloader runtime 证明。
5. 对 private full-backup 的 `ota_1` 前 64 KiB 做 fresh readback；第一次传输短读后只做一次有界 retry，得到 65536 bytes、diff=0；记录工具 reset side effect。
6. 使用官方 esptool v4.12.0 `image_info --version 2` 分析两个 private slice。两者均为有效 ESP32-S3 app；ota1 是旧 `flappy_bird`，不是坏镜像。
7. 开启 COM5 被动串口窗口 38 秒，DTR/RTS 关闭；窗口内未观察到新的 boot banner，只观察到 `SystemInfo`。按要求仅提示一次普通 RST，不发送 BOOT 或串口命令。
8. 窗口结束后独立 readback `otadata` 8192 bytes；与 boot 前样本逐字节一致。该次 readback 的 reset side effect 单独记录。
9. 新增通用、无设备秘密的只读解析脚本和 Phase3C 文档；不启动 Bridge，不修改生产，不执行 Flash。

## 停止判断

metadata 选择和镜像状态已经可解释；唯一缺口是本轮没有新的 `Loaded app` 行，故不声称 fresh actual loaded slot，最终保持 `STACKCHAN_PHASE3C_OTA_TRUTH_UNRESOLVED`。下一轮需先补齐同一启动窗口证据，再由用户单独批准任何 app-only/metadata 操作。
