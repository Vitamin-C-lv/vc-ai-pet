# Phase 3C 验收矩阵

| 验收项 | 结果 | 证据/限制 |
|---|---|---|
| ESP-IDF v5.5.4 enum/CRC 规则 | PASS | 官方源码 `esp_flash_partitions.h:66-83`、`bootloader_common_loader.c:69-92` |
| 两份记录按 0x1000 间隔读取 | PASS | `bootloader_utility.c:92-116`；fresh/post/private 三份一致 |
| copy0 精确解码 | PASS | seq=1、state=VALID、CRC 匹配、映射 ota_0 |
| copy1 精确解码 | PASS | seq=2、state=ABORTED、CRC 匹配但被 invalid 逻辑排除 |
| `OTADATA_SELECTED_SLOT` | PASS | 唯一有效 copy0 → ota_0 |
| ota_1 fresh 头部与 backup | PASS | 64 KiB diff=0；retry 有 reset side effect |
| ota_1 空槽/ESP header | PASS | 非空，magic=0xE9 |
| ota_1 官方 image_info | PASS | checksum/hash/芯片/revision/descriptor 均通过 |
| ota_0 官方 image_info | PASS | 已知工厂对照，checksum/hash 均通过 |
| passive serial 30 秒以上 | PASS（采集完成） | 38 秒，DTR/RTS=false |
| passive serial 新 boot banner | BLOCKED | 只有 SystemInfo；没有新 Loaded 行 |
| `ACTUALLY_LOADED_SLOT` fresh 证明 | BLOCKED | 历史为 ota_0，但本轮未观察 |
| pre/post otadata 一致 | PASS | 8192 bytes，diff=0 |
| 生产 Pet/Memory/Dream/Android | PASS（未触碰） | 无代码、服务或数据修改 |
| Flash/OTA metadata/NVS/eFuse | PASS（0 次） | 本轮 no-write |
| 下一轮写入目标 | CONDITIONAL | ota_1；必须先补 fresh boot 并重新授权 |

## 判定

本轮没有满足“fresh boot 与 metadata 直接一致”的完整证据门槛，因此：

```text
FINAL_STATUS=STACKCHAN_PHASE3C_OTA_TRUTH_UNRESOLVED
```

这是 fail-closed 的审计结果，不代表镜像解析失败。继续禁止刷写、切换 metadata、重启生产服务或启动 Bridge。
