# Phase 3C Recovery / Rollback 说明

## 本轮状态

- 未刷写、未擦除、未切换 OTA metadata、未写 NVS/eFuse。
- `ota_0 @ 0x20000` 是唯一 metadata 有效选择对应的工厂/恢复方向；必须保留。
- `ota_1 @ 0x510000` 含一份可解析但被 `ABORTED` metadata 排除的旧应用。
- 私有 full backup、raw readback、raw serial log 均留在用户本机，不进入 Git/ZIP。

## 下一轮进入条件（仍需单独授权）

1. 用一次全新的被动普通重启，直接观察 `Trying partition`/`Loaded app`，确认当前实际运行槽位；不能用历史 banner 代替。
2. 再次只读核对 partition table、otadata 以及目标槽大小；保持生产服务和 Android dirty tree 不动。
3. 生成并复核只适合 `ota_1` 大小的李花花 app-only image；先在私有目录 readback/哈希校验，禁止把 binary 放入 handoff。
4. 只有用户明确批准后，才评审 app-only 写入和 metadata 状态切换的具体工具。当前 copy1 为 `ABORTED`，因此“只写 ota1、不改 metadata”不会让它成为可选 app。
5. metadata 工具必须先审阅擦除范围：ESP-IDF `otatool.py switch_ota_partition` 会通过 `parttool.write_partition()` 擦除整个 otadata 分区后重写两个副本；不得把它当成 32-byte 原子写入。

## 故障回退原则

- 新 app 校验失败：不覆盖 `ota_0`；停止并保留私有 full backup。
- 新 app 写入后无法启动：优先保持设备断电/不重复刷写，使用已验证的 `ota_0` 恢复路径；任何 metadata 修复需另行授权。
- 发现分区表、fresh head、private backup 或设备身份变化：立即停止，重新审计，不使用历史 IP、旧序列号或旧槽位结论。
- 不执行 factory reset、erase flash、整机 restore 或任何 eFuse 操作作为“排障”。

```text
DEVICE_REFLASHED=NO
OTA_METADATA_WRITES=0
DEVICE_FLASH_WRITES=0
```
