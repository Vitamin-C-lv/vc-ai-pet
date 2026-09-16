# Phase 3C OTA 真相审计报告

日期：2026-09-16
范围：只读 OTA metadata、离线镜像分析、一次被动串口观察。
结论性质：审计与下一轮计划，不是刷写授权。

## 结论先行

本轮修正了上一轮把 `ota_seq=2` 直接当作可选 `ota_1` 的解释。ESP-IDF v5.5.4 会先按 `ota_state` 排除 `ABORTED` 记录；因此当前 `otadata` 中唯一可选记录是 copy0，`ota_seq=1` 映射到 `ota_0`。这与历史启动行 `Loaded app from partition at offset 0x20000` 一致。

`ota_1` 的应用镜像经过官方 `esptool image_info --version 2` 校验，header、六个 segment、checksum、appended hash、芯片和 revision 范围均通过；它是一个不同于工厂应用的旧 `flappy_bird` 镜像，不是空槽或损坏镜像。当前阻止它启动的是 `otadata` copy1 的 `ABORTED` 状态。

本轮 38 秒被动串口窗口只看到了运行中的 `SystemInfo`，没有新的 `ESP-ROM`、`Trying partition` 或 `Loaded app` 行。因此“本轮 fresh boot 的最终 loaded slot”不能冒充已观测值；报告保留为 `UNOBSERVED_THIS_WINDOW`，并单独引用历史 `ota_0` 证据。基于 metadata、镜像和历史运行证据，下一轮的规划目标是保留 `ota_0`、把 `ota_1` 作为条件性写入目标，并明确需要一次 metadata 状态切换；本轮不写入。

## 证据与来源

| 证据 | 结果 | 说明 |
|---|---|---|
| ESP-IDF 源码 | PASS | 本机 `/tmp/esp-idf-v5.5.4`，commit `735507283d5b2f9fb363a1901172dbd9e847945d` |
| `otadata` fresh readback | PASS | `0xD000/0x2000`，与既有 private full-backup slice 逐字节一致；copy1 位于分区内 `+0x1000` |
| `ota_1` fresh head | PASS | `0x510000/0x10000`，65536 bytes，和 full backup 同偏移 diff=0 |
| `ota_0`/`ota_1` image_info | PASS | 官方 esptool v4.12.0、`--version 2`，两者均能完整解析并通过 checksum/hash |
| 被动启动窗口 | PARTIAL | DTR/RTS 均关闭，38 秒；只有 `SystemInfo`，没有新的 boot banner |
| 独立 post-boot readback | PASS | 8192 bytes；与 boot 前 fresh `otadata` diff=0；该命令自身有 reset side effect，未混入被动日志 |
| Flash/OTA 写入 | 0 | 未执行写入、擦除、metadata switch、NVS/eFuse 操作 |

## ESP-IDF 规则（代码证据）

本机 ESP-IDF v5.5.4：

- `components/bootloader_support/include/esp_flash_partitions.h:66-83` 定义状态和 32-byte `esp_ota_select_entry_t`：`ota_seq@0`、`seq_label@4`、`ota_state@24`、`crc@28`；CRC 只覆盖 `ota_seq`。
- 同文件 `:68-73`：`NEW=0`、`PENDING_VERIFY=1`、`VALID=2`、`INVALID=3`、`ABORTED=4`、`UNDEFINED=0xffffffff`；`ABORTED`/`INVALID` 不得选择，`UNDEFINED` 本身可以启动。
- `components/bootloader_support/src/bootloader_common_loader.c:69-82` 以 `esp_rom_crc32_le(UINT32_MAX, &ota_seq, 4)` 计算 CRC，并将 `ota_seq==UINT32_MAX`、`INVALID`、`ABORTED` 判为 invalid。
- `.../bootloader_common_loader.c:84-92,147-170`：先判断两个副本有效性；只有两份都有效时才取较大 `ota_seq`，否则使用唯一有效副本。
- `components/bootloader_support/src/bootloader_utility.c:92-116`：第二份选择记录从 `SPI_SEC_SIZE`（0x1000）读取，不是紧邻 32 bytes。
- `.../bootloader_utility.c:427-450`：active copy 的 `(ota_seq-1) % app_count` 映射到物理 OTA slot；rollback 打开时 `NEW` 会变为 `PENDING_VERIFY`。
- `.../bootloader_utility.c:579-620`：`load_boot_image()` 从首选 index 向后尝试，失败后还会继续尝试其它分区；因此 `Loaded app` 与 metadata preference 必须分开记录。

## 精确 otadata 解码

计算采用 ESP-IDF CRC 初值 `0xffffffff`。以下值在 boot 前 fresh readback、post-readback 和 private full-backup slice 中一致：

| copy | 分区偏移 | `ota_seq` | `ota_state` | stored CRC | computed CRC | CRC | 可选？ | 映射 |
|---:|---:|---:|---|---:|---:|---|---|---|
| 0 | `0x0000`（flash `0xD000`） | 1 | `0x00000002` `VALID` | `0x4743989a` | `0x4743989a` | YES | YES | `ota_0` |
| 1 | `0x1000`（flash `0xE000`） | 2 | `0x00000004` `ABORTED` | `0x55f63774` | `0x55f63774` | YES | NO（状态排除） | `ota_1` |

因此：

```text
OTADATA_SELECTED_COPY=copy0
OTADATA_SELECTED_SLOT=ota_0
OTA_SELECTION_CONFLICT=RESOLVED_AS_METADATA_INVALIDATED_OTA1
```

这不是“ota1 镜像校验失败后 fallback 到 ota0”的已证实事实。当前 metadata 在尝试阶段之前就已经把 copy1/ota1 排除；本轮没有看到新的 bootloader first-attempt 行，不能声称发生过 fallback。

## 当前与下一轮写入边界

```text
ACTUALLY_LOADED_SLOT=UNOBSERVED_THIS_WINDOW (historical boot banner maps to ota_0)
CURRENT_RUNNING_FACTORY_SLOT=UNOBSERVED_THIS_WINDOW (historical known-good ota_0)
SAFE_WRITE_TARGET=ota_1 (conditional; no write authorization)
PRESERVED_FACTORY_SLOT=ota_0
OTA_METADATA_SWITCH_REQUIRED=YES
FLASH_ROUTE_CONFIDENCE=MEDIUM
```

为什么不是 `NO`：仅把新的 app bytes 写到 `ota_1` 不会清除当前 copy1 的 `ABORTED` 状态；按照官方选择规则，bootloader 仍会使用 copy0/`ota_0`。后续若要让新的李花花 app 成为可选目标，需要在 app-only readback 校验通过、且 fresh boot 槽位再次确认后，单独评审官方 metadata 状态切换路径。`otatool.py switch_ota_partition` 会先擦除整个 `otadata` 分区再写回，不能在下一轮未经批准直接调用。

## 本轮停止点

没有 fresh boot `Loaded app` 行，所以本轮不宣称 `STACKCHAN_PHASE3C_OTA_SLOT_RESOLVED_FLASH_PLAN_READY`。当前交付状态是：

```text
FINAL_STATUS=STACKCHAN_PHASE3C_OTA_TRUTH_UNRESOLVED
```

未决项只有“同一启动窗口的实际 loaded slot / first attempt 观测”，而不是 `otadata` 结构、镜像完整性或安全写入方向。下一轮如要进入刷写，必须先补齐该项并重新确认设备仍为同一状态；在此之前继续保持 no-write。
