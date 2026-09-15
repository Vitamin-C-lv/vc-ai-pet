# StackChan Phase 3 — Commands and Sanitized Results

Date: 2026-09-15 (Asia/Shanghai)

This record keeps the commands and results needed to reproduce the offline checks. It intentionally excludes the actual WLAN SSID/IP, MAC/device serial, Wi-Fi credentials, private full-flash image, and raw serial log.

## Repository provenance

```text
PRODUCTION_HEAD=5731cc023c34a832cec80bdbdc9fdcf9301104f0
FEATURE_BASE=5731cc023c34a832cec80bdbdc9fdcf9301104f0
FEATURE_BRANCH=feat/stackchan-body-mvp
PRODUCTION_DIRTY_SCOPE=android-companion/** only; preserved
```

## Bridge tests

```powershell
wsl.exe -d kali-linux -- bash -lc "cd /home/vitamin_c/projects/personal/vc-ai-pet-stackchan-body-mvp && node tools/stackchan-bridge/test/contract.test.mjs && node tools/stackchan-bridge/test/server.test.mjs"
```

Result:

```text
BRIDGE_CONTRACT_TEST=PASS
BRIDGE_FAKE_UPSTREAM_TEST=PASS
```

These are local fake-upstream tests. The fake upstream observed no state-mutating request. No live bridge listener was left running.

## Body-state / face geometry host test

```powershell
wsl.exe -d kali-linux -- bash -lc "cd /home/vitamin_c/projects/personal/vc-ai-pet-stackchan-body-mvp && g++ -std=c++17 -Wall -Wextra -Werror -Idevice/stackchan/m5stack-factory -I/tmp/esp-idf-v5.5.4/components/json/cJSON device/stackchan/m5stack-factory/lihuahua_body_state.cpp device/stackchan/m5stack-factory/test/body_state_test.cpp /tmp/esp-idf-v5.5.4/components/json/cJSON/cJSON.c -o /tmp/stackchan-body-state-test && /tmp/stackchan-body-state-test"
```

Result:

```text
BODY_STATE_HOST_TEST=PASS
```

An initial invocation omitted the ESP-IDF `cJSON` include path and failed to compile; the corrected invocation above passed. No production or tracked test dependency was changed to work around that invocation error.

## Factory source builds

Two isolated builds were completed with ESP-IDF v5.5.4: an unmodified official factory-source baseline and the LiHuahua custom app source. Both reached `Project build complete`. The custom image is 3,791,184 bytes (`0x39d950`), within the 5,177,344-byte (`0x4f0000`) app partition, leaving 1,386,160 bytes (`0x1526b0`). The bridge URL was unset, so this is compile evidence, not a device-ready LAN configuration.

```text
FACTORY_PRISTINE_BUILD=PASS
CUSTOM_FACTORY_SOURCE_BUILD=PASS
CUSTOM_IMAGE=3791184 bytes / 0x39d950
APP_SLOT=5177344 bytes / 0x4f0000
APP_SLOT_FREE=1386160 bytes / 0x1526b0
```

Firmware binaries and build caches are intentionally excluded from the repository and handoff archive.

## Delegated review summaries

- Geometry fix review: the delegated reviewer moved complete face geometry (including mouth color) into a pure `face + blink` mapping and added host tests covering nine faces and blink restoration. Root reran the corrected host test and the custom firmware build successfully.
- OTA tool safety review: ESP-IDF v5.5.4 `parttool.py write_partition` erases the selected app partition before checking image size and does not enforce inactive-slot selection. `otatool.py read_otadata` sequence/CRC output alone does not prove the actually running slot; bootloader fallback/rollback can change the result. No OTA tool was used against the device. A fuller phase 0/recovery research summary is retained in `SUBAGENT_AUDIT_SUMMARY.md`.

## WLAN check

The Windows WLAN interface was re-read after the user's screenshot:

```text
NETSH_STATE=connected
PHYSICAL_WLAN_ADAPTER_STATUS=Up
RFC1918_IPV4_PRESENT=YES
GATEWAY_PRESENT=YES
```

No SSID, exact IPv4, BSSID, or MAC is retained here. The user subsequently confirmed the StackChan was connected to Wi-Fi; this is user-reported and was not independently confirmed by a device network log. It does not prove reachability to the Windows host, so bridge/firewall setup and device flash remain gated.

## Scope and write evidence

```text
LIVE_PRODUCTION_GET=/api/pet/state previously returned HTTP 200 (Phase 1 evidence; not repeated here)
HTTP_POSTS_THIS_PHASE=0
DEVICE_PARTITION_READS_THIS_PHASE=YES_READ_ONLY
DEVICE_FLASH_WRITES_THIS_PHASE=0
OTA_SWITCHES_THIS_PHASE=0
BRIDGE_LAN_LISTENER_STARTED=NO
WINDOWS_FIREWALL_RULE_CREATED=NO
WINDOWS_PORTPROXY_CREATED=NO
PUBLIC_EXPOSURE_CREATED=NO
PET_RUNTIME_MODIFIED=NO
MEMORY_MODIFIED=NO
DREAM_MODIFIED=NO
ANDROID_MODIFIED=NO
PRODUCTION_RESTARTED=NO
```

## Read-only physical slot evidence and final gate

The user performed one ordinary short press on the labeled reset control. A passive serial read at COM5, 115200 8N1, DTR/RTS disabled, observed:

```text
Loaded app from partition at offset 0x20000
```

This supports that `ota_0` (partition offset `0x20000`) was loaded for that boot. No BOOT button, download mode, serial command, or reset command was used. The actual partition table was read-only and reported:

```text
nvs       data/nvs    0x9000    16K
otadata   data/ota    0xd000     8K
phy_init  data        0xf000     4K
ota_0     app/ota_0   0x20000 5056K (0x4f0000)
ota_1     app/ota_1   0x510000 5056K (0x4f0000)
assets    data        0xa00000    4M
coredump  data        0xe00000   64K
```

Read-only security information reported Secure Boot disabled and Flash Encryption disabled. An 8 KiB `otadata` private readback succeeded. A readback of `ota_0` failed integrity/length validation at both 460800 baud (`0xfee` bytes received) and the 115200 retry (`0xfaf` bytes received); it is not a valid backup. `ota_1` was not read. No backup file, raw serial log, MAC, unique device serial, or network identifier is included in this handoff.

The locally built image fits the inactive partition size, but the candidate was built without `STACKCHAN_BODY_BRIDGE_URL`; the attempted local configuration did not reach the authoritative source/build, and the exact URL string was absent from the output image. It must not be flashed as a device-ready image. Its identification hash is recorded in `PHASE3_FINAL_REPORT.md` only.

Final fail-closed decision:

```text
FINAL_STATUS=STACKCHAN_PHASE3_FLASH_ABORTED_PRECONDITION_FAILED
ACTIVE_SLOT=ota_0 (boot log offset 0x20000)
INACTIVE_SLOT=ota_1 (partition offset 0x510000)
PREFLASH_OTADATA_BACKUP=PASS_PRIVATE
PREFLASH_OTA0_BACKUP=FAIL_INVALID_READBACK
PREFLASH_OTA1_BACKUP=NOT_ATTEMPTED
BRIDGE_URL_EMBEDDED=NO
DEVICE_FLASH_WRITES_THIS_PHASE=0
OTA_SWITCHES_THIS_PHASE=0
ROLLBACK_REQUIRED=NO (no write occurred)
```

The prior private complete flash readback is not a substitute for required per-slot preflash backups. No device write, OTA switch, bridge LAN listener, firewall rule, portproxy, or public exposure was performed.
