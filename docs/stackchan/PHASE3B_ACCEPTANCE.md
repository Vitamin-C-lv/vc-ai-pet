# Phase 3B 验收记录（安全停止）

## Gate matrix

| Gate | Result | Evidence |
|---|---|---|
| COM/PnP identity | PASS | Windows PnP: COM5, VID/PID 303A:1001 |
| 16 MiB full backup size/hash | PASS | Private backup manifest; binaries excluded from handoff |
| Fresh partition-table compare | PASS | 0x8000/0x1000 equals full-backup slice |
| Fresh otadata compare | PASS | 0xD000/0x2000 equals full-backup slice |
| Fresh ota_0 samples compare | PASS | head 64 KiB and mid 64 KiB equal full-backup slices |
| Active/inactive OTA slot | BLOCKED | otadata candidate conflicts with old boot-offset evidence |
| Bridge LAN healthz | PASS | Windows native bridge, HTTP 200 |
| Bridge body DTO | PASS | HTTP 200, bounded response, LiHuahua/relaxed projection |
| Factory app build | PASS | 3,792,448 bytes; under 0x4f0000 |
| Endpoint embedded in image | PASS | `/v1/body/state` path and current build input found |
| App-only flash | NOT RUN | blocked before write gate |
| Readback hash | NOT RUN | no write |
| otatool switch | NOT RUN | no write |
| Device face UI | NOT RUN | no custom image flashed |
| Offline/reconnect physical test | NOT RUN | no custom image flashed |
| Servo | NOT RUN | safety boundary preserved |

## Acceptance decision

`STACKCHAN_PHASE3B_FLASH_ABORTED_PRECONDITION_FAILED`. This is a deliberate fail-closed result. A successful compile or a valid OTA image does not authorize overwriting a slot whose active/inactive identity is unresolved.

The exact unresolved state is recorded as:

```text
OTADATA_PREFERRED_SLOT=ota_1
LAST_OBSERVED_LOADED_SLOT=ota_0_BY_OLD_SERIAL_BANNER
CURRENT_ACTIVE_OTA=UNRESOLVED
CURRENT_INACTIVE_OTA=UNRESOLVED
```
