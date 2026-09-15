# VC-AI-PET × StackChan Phase 2 — Final Execution Report

Date: 2026-09-15 (Asia/Shanghai)

## Outcome

The installed unit is strongly matched to the M5Stack StackChan factory/Xiaozhi firmware family, but the exact installed binary commit is not recoverable from its banner. Factory source has no evidence of an independent custom-MOD slot. A minimal read-only Li Huahua screen app has been implemented in a separate feature worktree, host-tested, and built locally on the official source/IDF versions. A complete private flash readback exists. No image was written to the device, so no physical face, online/offline, or recovery acceptance is claimed.

**Decision:** keep the PC as the Pet Runtime; use a rebuilt factory `AppAbility` only if a future, separately authorized flash task is approved. Do not use the M5Stack App Center listing as a hot-insert plugin mechanism. Do not switch to the separate Moddable Stack-chan host as if it were the installed firmware.

## Required status fields

```text
FINAL_STATUS=STACKCHAN_CUSTOM_FIRMWARE_READY_FOR_FLASH_APPROVAL

PRODUCTION_HEAD=5731cc023c34a832cec80bdbdc9fdcf9301104f0
STACKCHAN_BASE_COMMIT=7c904023f5957b608fd1208aca1ce8df93d7fc98
STACKCHAN_BRANCH=feat/stackchan-body-mvp
STACKCHAN_FINAL_COMMIT=see handoff Git provenance snapshot / final delivery message

DEVICE_MODEL=M5Stack StackChan K151 / CoreS3
DEVICE_CHIP=ESP32-S3 revision v0.2
DEVICE_FRIENDLY_NAME=USB 串行设备 (COM5); USB JTAG/serial debug unit
DEVICE_VID=303A
DEVICE_PID=1001
DEVICE_COM_PORT=COM5

DEVICE_FIRMWARE_MODE=M5STACK_FACTORY_OR_AVATAR
DEVICE_FIRMWARE_VERSION=App 1.5.1; ESP-IDF v5.5.4
DEVICE_MOD_SUPPORT=FAIL for no-reflash custom MOD on installed M5Stack factory source
DEVICE_OTA_SUPPORT=PASS in source/partition; not exercised
DEVICE_WIFI_CLIENT_SUPPORT=PASS in source; current AP association UNVERIFIED
DEVICE_RECOVERY_PATH=PRIVATE_FULL_FLASH_READBACK plus official M5Burner latest path; official image version match UNVERIFIED
FACTORY_FLASH_BACKUP_BYTES=16777216
FACTORY_FLASH_BACKUP_SHA256=E1E7560E5172641C2EDEF405EB354C54481C6E3E71D3F7D2A8D3345C1115DFF8
FACTORY_FLASH_BACKUP_LOCATION=C:\Users\18442\Downloads\VC-AI-PET-StackChan-PrivateBackup\factory-flash-2026-09-15.bin (private; excluded from Git/ZIP)
DEVICE_RESET_AFTER_READ=YES; automatic esptool RTS final reset; no firmware write

DISPLAY_HARDWARE=PASS; factory LVGL source present
SPEAKER_HARDWARE=PASS; current app API/use UNVERIFIED
MIC_HARDWARE=PASS; current app API/use UNVERIFIED
CAMERA_HARDWARE=PASS; camera sensor detected at boot; not called by PoC
IMU_HARDWARE=PASS; BMI270 initialized; no motion read/action
TOUCH_HARDWARE=PASS; controller initialized; no input test
RGB_HARDWARE=PASS; output API not exercised
SERVO_PAN_HARDWARE=PASS; SERVO_PAN_API=UNVERIFIED; NO MOVEMENT
SERVO_TILT_HARDWARE=PASS; SERVO_TILT_API=UNVERIFIED; NO MOVEMENT

BRIDGE_RUNTIME=WINDOWS_NATIVE (previous Phase 1 ephemeral loopback acceptance)
WINDOWS_NODE_VERSION=v24.19.0 (Phase 1)
BRIDGE_UPSTREAM=http://127.0.0.1:17870/api/pet/state (read-only GET in Phase 1)
BRIDGE_BIND=127.0.0.1 in Phase 1; no persistent LAN listener
BRIDGE_PORT=17871 (default only; no listener kept open)
BRIDGE_CONTRACT_TEST=PASS (Phase 1)
BRIDGE_FAKE_UPSTREAM_TEST=PASS (Phase 1)
LIVE_PET_STATE_HTTP=200 in Phase 1; not repeated this phase
LIVE_READ_ONLY_UPSTREAM_ADAPTATION=PASS in Phase 1; not repeated this phase

FACTORY_SOURCE_BUILD=PASS; image 0x39c8c0; app partition remaining 0x153740
LIHUAHUA_CUSTOM_BUILD=PASS; image 0x39d8e0; app partition remaining 0x152720 (~27%)
BODY_STATE_HOST_TEST=PASS
DEVICE_FACE_CLIENT=SOURCE_BUILT_NOT_INSTALLED_REFLASH_APPROVAL_REQUIRED
DEVICE_POLL_MS=2000 in source; not exercised on device

WINDOWS_WLAN_IP=NOT_RECORDED_FOR_THIS_PHASE
WINDOWS_FORWARDING_CREATED=NO
WINDOWS_FIREWALL_CREATED=NO
FIREWALL_REMOTE_SCOPE=NOT_APPLICABLE
PUBLIC_EXPOSURE_CREATED=NO
DEVICE_REFLASHED=NO
PET_RUNTIME_MODIFIED=NO
MEMORY_MODIFIED=NO
DREAM_MODIFIED=NO
REFLECTION_MODIFIED=NO
ANDROID_MODIFIED=NO
PRODUCTION_RESTARTED=NO
PRODUCTION_DIRTY_PRESERVED=YES; existing Android-only production dirty paths remain outside the feature worktree

HANDOFF_ZIP=VC-AI-PET_STACKCHAN_PHASE2_HANDOFF_2026-09-15.zip
HANDOFF_ZIP_SIZE=<reported in final delivery message>
HANDOFF_ZIP_SHA256=<reported in final delivery message>
ZIP_VALIDATION=<reported in final delivery message>
```

## Blocking condition for physical acceptance

This package deliberately stops before firmware installation. Official M5Burner recovery says to download the latest `StackChan` image, but its exact version and NVS/AI-account preservation are not verified against this device's `1.5.1` banner. The private bitwise backup is a recovery point, but restoring it is a flash write and needs separate approval. A later phase must first choose a recovery policy and explicitly approve the exact write path; only then may device-screen and offline/recovery tests begin.

The execution report and capability evidence are in this handoff package. The final archive size/SHA and ZIP validation are emitted in the final delivery message (the ZIP cannot truthfully contain its own hash without changing that hash).
