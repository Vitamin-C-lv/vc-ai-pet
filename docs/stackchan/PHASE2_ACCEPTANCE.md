# Phase 2 Acceptance Record

Date: 2026-09-15 (Asia/Shanghai)

## Confirmed

- Existing production repository HEAD remains based at `5731cc023c34a832cec80bdbdc9fdcf9301104f0`; this task operates only in feature worktree `feat/stackchan-body-mvp`, base HEAD `7c904023f5957b608fd1208aca1ce8df93d7fc98`.
- Production Pet/17870 was not restarted or modified. No Memory/Dream/Reflection/PetRuntime/Android change was made in Phase 2. Previously dirty Android paths in production remain outside this feature worktree and untouched.
- Device passive banner/PnP evidence is recorded in `DEVICE_PHASE_0_CAPABILITY_RECORD.md`. Exact installed firmware Git commit remains unverified.
- A complete 16 MiB read-only device flash image was saved only to the private Downloads path in `DEVICE_PHASE_2_CAPABILITY_AND_RECOVERY.md`. The original binary is excluded from Git and the handoff ZIP.
- esptool's read-flash command automatically finished with `Hard resetting via RTS pin`; this was not a firmware write. Afterwards the VID/PID composite device and COM5 still enumerated as Status OK. No further hardware command was issued.
- Official M5Stack factory source version `1.5.1` / ESP-IDF `v5.5.4` was audited. The App Center path is OTA firmware installation, not a hot-insert user MOD route.
- Official factory source comparison build passed. The final local LiHuahua source build passed: `stack-chan.bin` size `0x39d8e0`; app slot `0x4f0000`, leaving `0x152720` (about 27%) free.
- `device/stackchan/m5stack-factory/test/body_state_test.cpp` compiled with GCC warnings-as-errors and ran successfully: `BODY_STATE_HOST_TEST=PASS`.
- Previous bridge read-only/fake upstream acceptance remains in `PHASE1_ACCEPTANCE.md`: bridge test pass and live GET `/api/pet/state` HTTP 200; no need to re-hit production for Phase 2.

## Not done / not accepted

- No firmware flash, erase, M5Burner Burn, OTA, factory reset, or custom app installation.
- No on-device Bridge GET, screen face, offline, or recovery round-trip acceptance. The PC WLAN IP was not used and no inbound Firewall/portproxy rule was added.
- No servo, speaker, microphone, camera, touch action, BLE, MQTT, WebSocket, or mDNS test.
- Device must remain `DEVICE_FACE_CLIENT=SOURCE_BUILT_NOT_INSTALLED_REFLASH_APPROVAL_REQUIRED`; a compile is not physical acceptance.

## Commands / results summary

| Command/test | Result |
|---|---|
| `esptool --chip esp32s3 --port COM5 --baud 115200 chip_id` | PASS; MAC redacted/not recorded |
| `esptool ... flash_id` | PASS; detected 16 MiB flash |
| `esptool ... read_flash 0x0 0x1000000 <private-path>` | PASS; 16,777,216 bytes; private backup only; tool automatically toggled RTS at completion |
| ESP-IDF v5.5.4 official-source factory build | PASS; WSL `/tmp` isolated clone |
| ESP-IDF v5.5.4 custom LiHuahua app build | PASS; no flash command run |
| `g++ -std=c++17 -Wall -Wextra -Werror ... body_state_test.cpp ...` | PASS; test process exit 0 |
| Production Pet restart / writes | NO |
| Device erase/write/OTA/reflash | NO |
| Windows firewall / portproxy / public exposure | NO / NO / NO |

## Result

`STACKCHAN_CUSTOM_FIRMWARE_READY_FOR_FLASH_APPROVAL` describes source/build readiness only. Before a separate device-write task, confirm user approval, current PC WLAN endpoint, exact recovery version/setting preservation policy, and physically safe USB/power setup. Current round deliberately stops before any device programming.
