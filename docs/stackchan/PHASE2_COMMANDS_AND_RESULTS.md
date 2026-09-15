# Phase 2 Commands and Results (Sanitized)

Commands below are included for provenance. Device identifiers are reduced to VID/PID and COM; the private flash image itself is not included.

## Windows USB / serial read-only checks

Read-only checks performed:

```powershell
Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match '^USB\\VID_303A&PID_1001' } |
  Select-Object FriendlyName,Class,Status

Get-CimInstance Win32_SerialPort |
  Select-Object DeviceID,Name,Description,PNPDeviceID
```

Observed: USB composite, USB JTAG/serial debug, and `USB 串行设备 (COM5)` were present; Status OK. Only the VID/PID prefix is retained; no device-instance suffix or MAC is recorded.

Temporary isolated esptool environment: Windows uv-managed Python 3.12.13, `esptool==4.10.0`, installed under `%TEMP%\stackchan-esptool-venv`. Commands issued:

```text
python -m esptool --chip esp32s3 --port COM5 --baud 115200 chip_id
python -m esptool --chip esp32s3 --port COM5 --baud 115200 flash_id
python -m esptool --chip esp32s3 --port COM5 --baud 115200 read_flash 0x0 0x1000000 <PRIVATE_DOWNLOADS_FILE> --flash_size 16MB --no-progress
```

Results: chip ESP32-S3 rev 0.2; flash 16 MiB; complete read 16,777,216 bytes in about 24 min. esptool printed `Hard resetting via RTS pin` on completion. No `erase_flash`, `write_flash`, M5Burner Burn, OTA, factory reset, BOOT action, or serial write command was issued. PnP after completion still showed the device/COM5 Status OK. The backup path/hash are in `DEVICE_PHASE_2_CAPABILITY_AND_RECOVERY.md`; its binary remains outside all repositories and archives.

## Official factory source / local build

Source clone: official `m5stack/StackChan` commit `1b5765599fba8aaad1811d9a79358ccc7051f5f3`; ESP-IDF v5.5.4. IDF tools and source were placed under WSL `/tmp`, not installed globally. WSL's system Python lacked `ensurepip`; the Python environment was bootstrapped in the isolated IDF tools path using a `--without-pip` venv plus pip installed into that temporary venv. No apt/system package change was made.

Factory baseline:

```bash
source /tmp/esp-idf-v5.5.4/export.sh
cd /tmp/m5stack-stackchan-phase2-source/firmware
idf.py set-target esp32s3
idf.py build
```

The source was returned to the official factory file set (no custom app in the configure log) for this baseline build. Result: PASS; image `0x39c8c0` bytes; app slot `0x4f0000`; remaining `0x153740` bytes.

Custom source build repeated after restoring the four app source files and the three small static-registration/dependency edits described in `device/stackchan/m5stack-factory/PATCH_NOTES.md`:

```bash
idf.py reconfigure
idf.py build
```

Result: PASS; both custom app sources appeared in the compiler log. Final `stack-chan.bin` was `0x39d8e0` bytes; the `0x4f0000` app slot had `0x152720` bytes remaining (about 27%). No `idf.py flash` was run.

## Host parser / mapping test

```bash
g++ -std=c++17 -Wall -Wextra -Werror \
  -I/tmp/esp-idf-v5.5.4/components/json/cJSON \
  device/stackchan/m5stack-factory/test/body_state_test.cpp \
  device/stackchan/m5stack-factory/lihuahua_body_state.cpp \
  /tmp/esp-idf-v5.5.4/components/json/cJSON/cJSON.c \
  -o /tmp/stackchan-body-state-test
/tmp/stackchan-body-state-test
```

Result: exit 0, `BODY_STATE_HOST_TEST=PASS`.

## Earlier bridge acceptance (Phase 1; not repeated)

See `PHASE1_ACCEPTANCE.md`: fake-upstream tests passed, Windows loopback read-only `/api/pet/state` returned HTTP 200, and transformation produced a 443-byte `relaxed` DTO. That earlier live GET was not repeated for Phase 2. No POST/action/chat route was called.
