# StackChan Phase 3 — Offline Build and Gate Report

Date: 2026-09-15 (Asia/Shanghai)

## Outcome

The Phase 3 face-geometry change builds successfully against the isolated M5Stack StackChan factory source and ESP-IDF v5.5.4. Bridge and host-side state/face tests pass. This is **offline build acceptance only**: the device has not been written, the new app has not been opened on the device, and no relaxed/offline/recovery physical loop is claimed.

The Windows host network precondition was confirmed by a live WLAN-interface read. The user then confirmed that StackChan was connected to Wi-Fi; this is user-reported, not independently confirmed by a device network log. No SSID, address, or credential is retained. No bridge listener, firewall rule, or port forwarding was started.

## Provenance and scope

```text
PRODUCTION_HEAD=5731cc023c34a832cec80bdbdc9fdcf9301104f0
STACKCHAN_BASE_COMMIT=5731cc023c34a832cec80bdbdc9fdcf9301104f0
STACKCHAN_BRANCH=feat/stackchan-body-mvp
FACTORY_SOURCE_COMMIT=1b5765599fba8aaad1811d9a79358ccc7051f5f3
ESP_IDF_VERSION=v5.5.4
```

The existing production checkout remained at the stated HEAD. Its pre-existing dirty paths were all under `android-companion/**` and were left untouched. The feature worktree is isolated from that production worktree.

## Offline verification

```text
BRIDGE_CONTRACT_TEST=PASS
BRIDGE_FAKE_UPSTREAM_TEST=PASS
BODY_STATE_HOST_TEST=PASS
DIFF_CHECK=PASS
FACTORY_PRISTINE_BUILD=PASS
CUSTOM_FACTORY_SOURCE_BUILD=PASS
CUSTOM_APP_IMAGE_BYTES=3791184
CUSTOM_APP_IMAGE_HEX=0x39d950
APP_PARTITION_BYTES=5177344
APP_PARTITION_HEX=0x4f0000
CUSTOM_APP_PARTITION_FREE_BYTES=1386160
CUSTOM_APP_PARTITION_FREE_HEX=0x1526b0
```

The custom image was built with an unset `STACKCHAN_BODY_BRIDGE_URL`, so this artifact is not configured to reach a PC bridge. A subsequent local attempt to add the URL did not reach the authoritative WSL source: the exact endpoint string was absent from the resulting image. That build is therefore not device-ready and must not be flashed. Build output and firmware binaries are excluded from Git and the handoff ZIP. No DHCP address is committed.

The host test checks parsing/state behavior and deterministic geometry for idle, relaxed, happy, thinking, curious, confused, sleep, dreaming, and offline faces, including blink geometry and mouth color. It does not exercise rendering on the physical display.

## Device facts carried forward

From the prior read-only device phase: the connected USB serial/JTAG device was identified as VID/PID `303A:1001`, COM5; the installed family was assessed as M5Stack factory/AVATAR firmware, reporting App 1.5.1 and ESP-IDF v5.5.4. Exact installed binary/source commit remains unverified. Factory source registers apps statically; there is no confirmed independent hot-insert MOD API. No servo, speaker, microphone, camera, touch, BLE, or chat behavior is part of this Phase 3 build.

The user-owned complete flash readback was verified in its private location during the prior phase and is intentionally excluded from the repository and handoff. Do not restore or rewrite it without renewed authorization.

## Physical write gate

Read-only checks were performed after the user confirmed the device was connected and visible. The user performed one ordinary short press on the labeled reset control; no BOOT/download-mode operation or serial command was sent. A 115200 8N1 read-only serial window observed `Loaded app from partition at offset 0x20000`, which identifies `ota_0` as the app loaded at that boot. The actual partition table reported `ota_0` at `0x20000` and `ota_1` at `0x510000`, each 5056 KiB. Read-only security information reported Secure Boot disabled and Flash Encryption disabled. A private read of the 8 KiB `otadata` partition completed; an `ota_0` backup attempt failed integrity/length validation at both 460800 and 115200 baud. The failed slot backup is not usable, and `ota_1` was not read.

The mandatory pre-write gate therefore failed: the required app-slot backup set is incomplete, and the candidate image does not contain a bridge endpoint. No firmware write, OTA switch, erase, M5Burner operation, factory reset, or additional device operation was attempted. No bridge LAN binding, firewall rule, portproxy, or public exposure was created. The running factory app and OTA metadata were not written.

Before any future app-partition write, build a candidate image with a locally configured, currently reachable bridge URL, verify it fits the exact inactive OTA slot, and obtain valid private readbacks of `otadata` and both app slots at a baud/rate that passes integrity checks. Reconfirm the actual running slot from a fresh boot banner and the exact partition table. If any precondition remains ambiguous or any backup fails, stop without writing. Keep the complete prior factory readback private and recovery operations separately authorized.

## OTA tool safety review

The ESP-IDF v5.5.4 tool source was reviewed without using it to write the device. `components/partition_table/parttool.py` erases the selected partition before checking whether the input image fits and does not protect the currently running OTA slot. `components/app_update/otatool.py read_otadata` reports sequence/CRC data but does not by itself prove which partition is actually running; bootloader fallback/rollback behavior can make configured selection differ from actual execution. Any future write must therefore prove the actual running partition from boot evidence, independently verify the complete partition table and target size, and keep a verified private backup of each relevant OTA target and metadata. The tool audit is also summarized in `SUBAGENT_AUDIT_SUMMARY.md`.

## Required invariants

```text
DEVICE_REFLASHED=NO
DEVICE_FACE_CLIENT=BLOCKED_BY_FLASH_PRECONDITIONS
PET_RUNTIME_MODIFIED=NO
MEMORY_MODIFIED=NO
DREAM_MODIFIED=NO
ANDROID_MODIFIED=NO
PRODUCTION_RESTARTED=NO
WINDOWS_FORWARDING_CREATED=NO
WINDOWS_FIREWALL_CREATED=NO
PUBLIC_EXPOSURE_CREATED=NO
```

## Next action

Stop this phase before any write. Preserve the factory firmware. For a later authorized attempt, first correct the build configuration so the image embeds a current bridge endpoint, then obtain complete validated private OTA backups; do not retry the failed serial backup by repeatedly changing baud rates within this phase.
