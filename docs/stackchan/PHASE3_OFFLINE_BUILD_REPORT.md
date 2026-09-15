# StackChan Phase 3 — Offline Build and Gate Report

Date: 2026-09-15 (Asia/Shanghai)

## Outcome

The Phase 3 face-geometry change builds successfully against the isolated M5Stack StackChan factory source and ESP-IDF v5.5.4. Bridge and host-side state/face tests pass. This is **offline build acceptance only**: the device has not been written, the new app has not been opened on the device, and no relaxed/offline/recovery physical loop is claimed.

The Windows host network precondition is now confirmed: the latest `netsh wlan show interfaces` check reported `connected`, the physical WLAN adapter was `Up`, and a current RFC1918 address plus gateway were present. The earlier adapter-only snapshot had reported `Disconnected`; it was stale relative to the user's newer WLAN screenshot and the subsequent direct WLAN-interface read. The StackChan's own association to the same LAN has not yet been confirmed. No bridge listener, firewall rule, port forwarding, or device write has been started.

## Provenance and scope

```text
PRODUCTION_HEAD=5731cc023c34a832cec80bdbdc9fdcf9301104f0
STACKCHAN_BASE_COMMIT=8ceb7cf4fe626e4ffc892e799671d81870de637a
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

The custom image was built with an unset `STACKCHAN_BODY_BRIDGE_URL`, so this artifact is not configured to reach a PC bridge. Build output and firmware binaries are excluded from Git and the handoff ZIP. A current WLAN endpoint may only be configured locally after the host WLAN is connected; no DHCP address is committed.

The host test checks parsing/state behavior and deterministic geometry for idle, relaxed, happy, thinking, curious, confused, sleep, dreaming, and offline faces, including blink geometry and mouth color. It does not exercise rendering on the physical display.

## Device facts carried forward

From the prior read-only device phase: the connected USB serial/JTAG device was identified as VID/PID `303A:1001`, COM5; the installed family was assessed as M5Stack factory/AVATAR firmware, reporting App 1.5.1 and ESP-IDF v5.5.4. Exact installed binary/source commit remains unverified. Factory source registers apps statically; there is no confirmed independent hot-insert MOD API. No servo, speaker, microphone, camera, touch, BLE, or chat behavior is part of this Phase 3 build.

The user-owned complete flash readback was verified in its private location during the prior phase and is intentionally excluded from the repository and handoff. Do not restore or rewrite it without renewed authorization.

## Physical write gate

Not attempted in this run:

- no serial reset or boot-mode operation;
- no partition-table, OTA metadata, active-slot, or per-slot flash readback;
- no proof of the currently running OTA partition from boot log;
- no inactive-slot backup in this phase;
- no firmware write, OTA switch, reboot, M5Burner operation, erase, or factory reset;
- no bridge LAN binding, firewall rule, portproxy, or public exposure.

Before any future app-partition write, first establish a live physical WLAN connection for the PC and device, then capture the actual running-slot evidence and exact partition table, make private backups of the relevant OTA metadata and app slots, and independently verify that the intended target is not the running slot. If any precondition remains ambiguous, stop without writing. Keep the complete prior factory readback private and recovery operations separately authorized.

## OTA tool safety review

The ESP-IDF v5.5.4 tool source was reviewed without using it to write the device. `components/partition_table/parttool.py` erases the selected partition before checking whether the input image fits and does not protect the currently running OTA slot. `components/app_update/otatool.py read_otadata` reports sequence/CRC data but does not by itself prove which partition is actually running; bootloader fallback/rollback behavior can make configured selection differ from actual execution. Any future write must therefore prove the actual running partition from boot evidence, independently verify the complete partition table and target size, and keep a verified private backup of each relevant OTA target and metadata. The tool audit is also summarized in `SUBAGENT_AUDIT_SUMMARY.md`.

## Required invariants

```text
DEVICE_REFLASHED=NO
DEVICE_FACE_CLIENT=SOURCE_BUILT_NOT_INSTALLED
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

Confirm that StackChan itself is associated with the same local Wi-Fi as Windows, using only its visible factory setup/status UI. Do not send the Wi-Fi password, SSID, or IP in chat. Re-check both endpoints before starting a narrowly bound bridge; do not use a stale address or Ethernet/VPN/Tailscale as a substitute.
