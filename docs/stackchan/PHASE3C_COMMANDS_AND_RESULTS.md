# Phase 3C 关键命令与结果

所有设备命令均为只读；路径使用逻辑描述，原始二进制和日志保留在本机私有临时目录。

## Git /生产保护

```text
git -C <feature-worktree> rev-parse HEAD
git -C <feature-worktree> status --short
git -C <production-worktree> rev-parse HEAD
git -C <production-worktree> status --short
```

结果：feature worktree 从 `0ef9399544f7e6898f865e7ec94c5c5efd1d9589` 开始，仅有本轮脚本/文档新增；production HEAD 为 `1e1af4c7c99463e727888c95eb6eba08b5c764b7`，原有 `android-companion/**` dirty changes 保留，未 reset/stash/clean。

## ESP-IDF 源码核对

```text
nl -ba /tmp/esp-idf-v5.5.4/components/bootloader_support/include/esp_flash_partitions.h
nl -ba /tmp/esp-idf-v5.5.4/components/bootloader_support/src/bootloader_common_loader.c
nl -ba /tmp/esp-idf-v5.5.4/components/bootloader_support/src/bootloader_utility.c
```

重点行号见 `PHASE3C_OTA_TRUTH_REPORT.md`。确认了 `ABORTED` 排除、CRC 只覆盖 seq、第二副本偏移 0x1000、seq 到 OTA slot 的映射以及 boot image 的候选尝试逻辑。

## otadata 只读解析

```text
python3 scripts/stackchan/inspect-otadata.py <otadata-readback>
```

结果：copy0 `seq=1 / VALID / CRC_VALID=True / ota_0`；copy1 `seq=2 / ABORTED / CRC_VALID=True / valid_for_selection=False / ota_1`；selected copy=0。

## 设备 fresh readback

```text
python -m esptool --chip esp32s3 --port COM5 --baud 115200 read_flash 0x510000 0x10000 <private-ota1-head>
python -m esptool --chip esp32s3 --port COM5 --baud 115200 read_flash 0xD000 0x2000 <private-otadata-post>
```

`ota_1` 头部一次有界 retry 成功，65536 bytes 与 full-backup 同偏移 diff=0。post `otadata` 成功读取 8192 bytes，与先前 fresh 样本 diff=0。两条 readback 都可能在工具退出时产生 reset side effect；没有任何 write/erase 操作。

## 官方 image_info

```text
/tmp/esp-idf-tools-v5.5.4/python_env/idf5.5_py3.13_env/bin/python -m esptool image_info --help
/tmp/esp-idf-tools-v5.5.4/python_env/idf5.5_py3.13_env/bin/python -m esptool image_info --version 2 <private-ota0-slice>
/tmp/esp-idf-tools-v5.5.4/python_env/idf5.5_py3.13_env/bin/python -m esptool image_info --version 2 <private-ota1-slice>
```

结果摘要在 `PHASE3C_OTA_IMAGE_VALIDATION_REPORT.md`；两镜像均 `VALID_ESP_APP`，差异为 `stack-chan 1.5.1` 与 `flappy_bird 477c384`。

## passive serial

Windows .NET `System.IO.Ports.SerialPort` 115200 8N1，`DtrEnable=false`、`RtsEnable=false`，最多 38 秒；不发送 BOOT/reset/串口命令。结果只有 `SystemInfo`，无新的 boot banner。脱敏日志进入 handoff，raw log 不进入 Git/ZIP。

## 明确未执行

`write_flash`、`erase_flash`、`erase_region`、`write_ota_partition`、`switch_ota_partition`、M5Burner、`idf.py flash`、NVS/eFuse/partition-table 写入、servo/audio/mic/camera、Bridge listener/firewall/portproxy、生产 Pet/Memory/Dream/Android 修改均未执行。
