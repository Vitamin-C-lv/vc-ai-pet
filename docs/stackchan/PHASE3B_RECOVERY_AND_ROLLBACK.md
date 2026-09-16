# Phase 3B 回滚与恢复说明

## 本轮状态

本轮没有 Flash 写入、没有擦除、没有 OTA metadata switch。因此当前设备仍由原有固件和原有 OTA metadata 管理，不需要执行回滚。Windows 临时 bridge 已停止，专用防火墙规则已删除。

## 下一轮安全前置

1. 保留私有 16 MiB full backup，不复制到 Git、ZIP、聊天或公共位置。
2. 重新进行一次普通 RST 后的被动串口监听，DTR/RTS 关闭。
3. 在同一轮 fresh readback 中记录 `ota_seq`、`ota_state` 和 `Loaded app from partition` 偏移。
4. 用当前分区表将偏移映射到 `ota_0`/`ota_1`，只有冲突消除后才允许选择 inactive slot。

## 若未来获准写入

- 只写已确认 inactive app 分区；不写 bootloader、partition table、NVS、assets、coredump、eFuse。
- 写入后先 readback 比较长度和 SHA-256，再用官方 `otatool.py switch_ota_partition`，不得手写 otadata。
- 启动失败时停止重试，优先用官方 otatool 切回已确认可启动槽位；不要立即 erase 或 full restore。
- 只有在切换回滚无法建立串口/启动证据，且用户另行批准时，才考虑 full backup restore。

## 禁止的捷径

不使用 M5Burner、`erase_flash`、`idf.py flash`、全片写入、猜测 OTA 槽位、未审查的第三方固件或把当前局域网地址硬编码进生产源码。
