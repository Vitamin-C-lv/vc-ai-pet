# StackChan Phase 2 audit summary — sanitized handoff copy

Date: 2026-09-15 (Asia/Shanghai)

This is a sanitized summary of the Phase 2 capability/recovery audit. It deliberately omits the private full-flash backup path and checksum. That image remains outside Git and the handoff ZIP.

## Firmware identification and extension path

- Passive serial banner identified ESP32-S3, SKU `m5stack-stack-chan`, project `stack-chan`, app `1.5.1`, ESP-IDF `v5.5.4`; Windows enumerated Espressif USB/JTAG serial at `COM5` (`303A:1001`). Exact installed firmware commit remains unverified.
- Evidence strongly matches the M5Stack factory/Xiaozhi StackChan firmware family. The `AVATAR` and `App Center` screens are statically registered factory apps; App Center delivers firmware through OTA and is not a demonstrated hot-plug arbitrary MOD slot.
- A separate Moddable community Stack-chan host/MOD API is not compatible evidence for this installed M5Stack factory firmware. Do not assume its `context.face` or HTTP APIs apply here.
- Factory source has display/network/peripheral implementations, but code presence is not evidence that this project’s custom client can be installed without rebuilding firmware.

## Recovery posture

- A complete private read-only device image was created in the prior phase and remains on the host, untouched. It may include device configuration; its path, hash, and image are intentionally omitted from this handoff.
- Official M5Burner documentation describes a StackChan recovery route, but exact image/version match to the installed 1.5.1 binary and preservation of NVS, account binding, or AI configuration remain unverified. No recovery operation was tested.
- Flash/erase/OTA actions require separate explicit authorization and a verified recovery policy. The Phase 3 report documents why this round stopped before writing.

## Local source PoC (not installed)

- An isolated factory-source AppAbility was added to poll a configured read-only bridge endpoint and render the contract’s face state. Source polling interval is 2 seconds; no servo, audio, microphone, camera, touch action, BLE, MQTT, WebSocket, or chat/action API is used.
- The unmodified factory source and custom source each built locally against ESP-IDF v5.5.4. Host parser/face tests passed. This proves compile/test behavior only; physical screen, Wi-Fi polling, offline rendering, recovery, and rollback were not accepted on device.
- Phase 3 later identified that the candidate image did not embed the bridge URL. It is not flash-ready; see `PHASE3_FINAL_REPORT.md`.

## Evidence references

- `DEVICE_PHASE_0_CAPABILITY_RECORD.md` — device/firmware/hardware observations.
- `PHASE1_ACCEPTANCE.md` — prior bridge contract and read-only upstream evidence.
- `PHASE2_ACCEPTANCE.md` and `PHASE2_COMMANDS_AND_RESULTS.md` — prior offline build and scope results.
- `SUBAGENT_AUDIT_SUMMARY.md` — source and recovery-path reviews.
- `PHASE3_COMMANDS_AND_RESULTS.md` — current read-only OTA/boot evidence and abort gate.

Status vocabulary: `CONFIRMED` means direct observed or source/document evidence; `INFERRED` means the conclusion follows from matching evidence; `UNVERIFIED` means not established in this run.
