# VC-AI-PET × StackChan Phase 3 — Final Execution Report

Date: 2026-09-15 (Asia/Shanghai)

## Decision

```text
FINAL_STATUS=STACKCHAN_PHASE3_FLASH_ABORTED_PRECONDITION_FAILED
```

The user performed one ordinary short press on the device's labeled reset control. The passive serial boot output identified the app loaded from offset `0x20000` (`ota_0`). Read-only partition-table/security inspection and a private `otadata` readback succeeded. The required `ota_0` preflash backup failed integrity/length validation at both attempted baud rates, and the custom image does not contain a configured StackChan bridge URL. These are independent stop conditions. No firmware write or OTA switch was attempted; the factory app remains the last known running firmware and no rollback is required.

## Source provenance

```text
PRODUCTION_HEAD=5731cc023c34a832cec80bdbdc9fdcf9301104f0
STACKCHAN_BASE_COMMIT=5731cc023c34a832cec80bdbdc9fdcf9301104f0
STACKCHAN_BRANCH=feat/stackchan-body-mvp
FEATURE_HEAD_BEFORE_FINAL_DOC_UPDATE=352c97f3a79c583d4270458da5d87fe255b8d6fe
FEATURE_FINAL_COMMIT=SEE_GIT_PROVENANCE_SNAPSHOT
STACKCHAN_COMMIT_1=7c904023f5957b608fd1208aca1ce8df93d7fc98 (read-only body bridge)
STACKCHAN_COMMIT_2=381b8e1c9127188d81dd786675bd6f0f4a4eeba3 (factory face app source; built, not installed)
FEATURE_PUSHED=NO
PRODUCTION_DIRTY_PRESERVED=YES (pre-existing android-companion/** changes; not touched)
```

## Device identity and firmware

```text
DEVICE_MODEL=M5Stack StackChan K151 / CoreS3 (device task identity; serial SKU m5stack-stack-chan)
DEVICE_CHIP=ESP32-S3 revision v0.2
DEVICE_FRIENDLY_NAME=USB serial device COM5; USB JTAG/serial debug unit
DEVICE_VID=303A
DEVICE_PID=1001
DEVICE_COM_PORT=COM5
DEVICE_FIRMWARE_MODE=M5STACK_FACTORY_OR_AVATAR
DEVICE_FIRMWARE_VERSION=App 1.5.1; ESP-IDF v5.5.4
DEVICE_MOD_SUPPORT=FAIL for no-reflash third-party app/MOD on the installed factory architecture
DEVICE_OTA_SUPPORT=PASS in observed partition/source architecture; no OTA operation performed
DEVICE_WIFI_CLIENT_SUPPORT=PASS in factory firmware family; device Wi-Fi association USER_CONFIRMED, not independently observed in serial output
DEVICE_RECOVERY_PATH=Private full-flash readback exists; official M5Burner recovery is documented but exact image/version and settings preservation are UNVERIFIED
```

Firmware identity is based on the earlier passive banner (`Project name: stack-chan`, SKU `m5stack-stack-chan`, App `1.5.1`, ESP-IDF `v5.5.4`) and factory-source audit, not merely the visible AVATAR menu. Exact installed binary commit remains unverified. The private 16 MiB factory readback was not touched and is excluded from the handoff; it is not equivalent to this phase's required OTA-slot backups.

## Hardware and current API evidence

| Capability | Hardware / boot evidence | Current custom control API or physical use |
|---|---|---|
| Display | PASS — LCD panel initialized; K151 display | Factory LVGL exists; custom face not installed or physically verified |
| Speaker | PASS — product specification | API/use UNVERIFIED; no audio played |
| Microphone | PASS — product specification / dual-mic hardware | API/use UNVERIFIED; no recording/ASR |
| Camera | PASS — sensor detected/initialized at boot | API/use UNVERIFIED; no image captured |
| IMU | PASS — BMI270 initialized | No motion read/control in this phase |
| Touch | PASS — controller initialized | No touch input tested |
| RGB | PASS — product specification | No LED command tested |
| Servo pan | Hardware PASS by K151 specification | API UNVERIFIED; no movement or command |
| Servo tilt | Hardware PASS by K151 specification | API UNVERIFIED; no movement or command |

## Read-only OTA evidence

```text
BOOT_BANNER=Loaded app from partition at offset 0x20000
ACTIVE_SLOT=ota_0 (inferred from actual boot-loaded offset)
INACTIVE_SLOT=ota_1
PARTITION_TABLE_READ=PASS
SECURE_BOOT=DISABLED (read-only esptool security report)
FLASH_ENCRYPTION=DISABLED (read-only esptool security report)
OTADATA_PRIVATE_READBACK=PASS (8192 bytes; excluded from handoff)
OTA0_PRIVATE_READBACK=FAIL (invalid/incomplete at 460800 and 115200 baud)
OTA1_PRIVATE_READBACK=NOT_ATTEMPTED
```

Observed app partitions are `ota_0 @ 0x20000`, size `0x4f0000` (5056 KiB), and `ota_1 @ 0x510000`, size `0x4f0000` (5056 KiB). The previous readback error at high baud was not cured by one retry at the baseline 115200 baud; the resulting `ota_0` capture did not pass integrity/length validation. No further read attempts were made.

## Build and tests

```text
WINDOWS_NODE_VERSION=v24.19.0 (previously verified; bridge not started in this phase)
BRIDGE_CONTRACT_TEST=PASS
BRIDGE_FAKE_UPSTREAM_TEST=PASS
BODY_STATE_HOST_TEST=PASS
FACTORY_PRISTINE_BUILD=PASS
CUSTOM_FACTORY_SOURCE_BUILD=PASS
CUSTOM_APP_IMAGE_BYTES=3791184
CUSTOM_APP_IMAGE_HEX=0x39d950
APP_PARTITION_BYTES=5177344 (0x4f0000)
CUSTOM_APP_PARTITION_FREE_BYTES=1386160
CUSTOM_APP_SHA256=dd9eb36430e51bba7d896c9ed875a1a654f61bf2ede8e33660adb2cdcc0e1e91
BRIDGE_URL_EMBEDDED=NO
GIT_DIFF_CHECK=PASS
```

The SHA-256 identifies the locally built, **unconfigured** image only. It is not authorization or recommendation to flash. Build binaries/cache are not included in the ZIP.

```text
BRIDGE_RUNTIME=NOT_STARTED (Windows native was the preferred candidate)
BRIDGE_UPSTREAM=http://127.0.0.1:17870/api/pet/state (Phase 1 read-only GET only; not repeated in Phase 3)
BRIDGE_BIND=NOT_STARTED
BRIDGE_PORT=17871 (planned/default; no listener)
LIVE_PET_STATE_HTTP=200 (Phase 1 only; not repeated)
LIVE_READ_ONLY_UPSTREAM_ADAPTATION=PASS (Phase 1 only; not repeated)
WINDOWS_WLAN_IP=REDACTED_FROM_HANDOFF (current value is ephemeral)
WINDOWS_FORWARDING_CREATED=NO
WINDOWS_FIREWALL_CREATED=NO
FIREWALL_REMOTE_SCOPE=NOT_APPLICABLE
PUBLIC_EXPOSURE_CREATED=NO
```

The user confirmed StackChan Wi-Fi connectivity. No device IP/SSID/password was captured or recorded, and this does not establish that the bridge is reachable from the device.

## Physical acceptance and production invariants

```text
DEVICE_FACE_CLIENT=BLOCKED_BY_FLASH_PRECONDITIONS
DEVICE_POLL_MS=2000 in source; not exercised on device
RELAXED_FACE_PHYSICAL_TEST=NOT_RUN
OFFLINE_FACE_PHYSICAL_TEST=NOT_RUN
RECOVERY_PHYSICAL_TEST=NOT_RUN
DEVICE_REFLASHED=NO
FLASH_WRITE_VERIFY=NOT_APPLICABLE (no write)
OTA_SWITCHED=NO
FACTORY_ROLLBACK_REQUIRED=NO (factory image was never overwritten)
FACTORY_PRIVATE_FULL_FLASH_BACKUP=EXISTS_UNTOUCHED; NOT_INCLUDED
PET_RUNTIME_MODIFIED=NO
MEMORY_MODIFIED=NO
DREAM_MODIFIED=NO
REFLECTION_MODIFIED=NO
ANDROID_MODIFIED=NO
PRODUCTION_RESTARTED=NO
PRODUCTION_POST_OR_ACTION_API_CALLS=0
```

## Stop conditions, recovery, next authorized step

Do not use the current custom image on the device. A future phase must first create a bridge-configured build from the authoritative feature source and produce integrity-valid private backups of `otadata`, `ota_0`, and `ota_1`; then re-check the running slot/partition table and independently review the exact image and recovery route before any write. No retry loop, OTA switch, flash, M5Burner, erase, factory reset, bridge listener, firewall rule, or portproxy is authorized by this report.

The source rollback point is `STACKCHAN_BASE_COMMIT` above; the production worktree remains independent. No device rollback is needed because nothing was written. The private full-flash image remains on the host and is intentionally excluded from all handoff materials.

Operational note: an earlier command replaced the Windows clipboard with a temporary partition-table file path. The previous clipboard contents could not be restored. No credential, MAC, or device serial was included in that value, and the clipboard was not accessed again.

## Handoff archive

The archive cannot contain its own final SHA-256 without changing that hash. The archive's absolute path, byte size, SHA-256, and validation result are therefore supplied in the final delivery response and a sidecar handoff record, not self-embedded in the ZIP.

```text
HANDOFF_ZIP=C:\Users\18442\Downloads\VC-AI-PET_STACKCHAN_PHASE3_HANDOFF_2026-09-15.zip
HANDOFF_ZIP_SIZE=<reported after creation>
HANDOFF_ZIP_SHA256=<reported after creation>
ZIP_VALIDATION=<reported after list, integrity test, and extraction>
```
