# Phase 3B 关键命令与结果（已脱敏）

本文件只记录可复现命令形态和结果，不记录密码、MAC、完整唯一序列、当前 WLAN IPv4 或完整原始串口日志。

## Production/feature state

```text
PRODUCTION_HEAD_AT_FINAL_CHECK=1e1af4c7c99463e727888c95eb6eba08b5c764b7
FEATURE_BRANCH=feat/stackchan-body-mvp
FEATURE_HEAD_BEFORE_PHASE3B=1125c07630543d2ed263d654e4de2d68fabe5293
PRODUCTION_DIRTY_SCOPE=pre-existing android-companion/**; preserved
```

## Device read-only

```powershell
Get-PnpDevice -PresentOnly | ...
Get-CimInstance Win32_SerialPort | ...
python -m esptool --port COM5 --baud 115200 flash_id
python -m esptool --port COM5 --baud 115200 read_flash 0x8000 0x1000 partition-table.bin
python -m esptool --port COM5 --baud 115200 read_flash 0xD000 0x2000 otadata.bin
python -m esptool --port COM5 --baud 115200 read_flash 0x20000 0x10000 ota0-head.bin
python -m esptool --port COM5 --baud 115200 read_flash 0x320000 0x10000 ota0-mid.bin
```

Result: all four fresh slices matched the private full-backup slices. These commands are read-only at the flash content level; esptool performed its normal serial reset side effect.

## OTA metadata review

```powershell
python otatool.py --help
python otatool.py switch_ota_partition --help
python otatool.py --port COM5 --baud 115200 read_otadata
```

Result: official syntax was verified; read-only output showed two CRC-valid sequence records (`1`, `2`). With two OTA app partitions, standard ESP-IDF mapping makes `seq=2` an `ota_1` candidate. Old boot-offset evidence (`0x20000`) was not captured in the same boot window, so write authorization remained blocked.

## Bridge

```powershell
node tools/stackchan-bridge/src/main.mjs --bind <current-physical-wlan-ip> --port 17871
Invoke-WebRequest http://<current-physical-wlan-ip>:17871/healthz
Invoke-WebRequest http://<current-physical-wlan-ip>:17871/v1/body/state
```

Result: `BRIDGE_LAN_HEALTHZ=PASS`, `BRIDGE_LAN_V1_BODY_STATE=PASS`; bridge stopped after the fail-closed decision. The temporary TCP/17871 Wireless LocalSubnet firewall rule was removed.

## Build

```bash
python3 scripts/stackchan/prepare-factory-build.py \
  --official-source-root /tmp/m5stack-stackchan-phase2-source \
  --feature-root /home/vitamin_c/projects/personal/vc-ai-pet-stackchan-body-mvp \
  --output-root /tmp/m5stack-stackchan-phase3b-configured-<timestamp> \
  --bridge-url http://<current-rfc1918-wlan-ip>:17871/v1/body/state

idf.py set-target esp32s3
idf.py build
```

Result: official source HEAD pinned to `1b5765599fba8aaad1811d9a79358ccc7051f5f3`; app image built successfully; endpoint path present; image smaller than `ota_1` partition.

## Explicitly not run

`write_flash`, `write_ota_partition`, `switch_ota_partition`, `erase_flash`, `erase_region`, `idf.py flash`, M5Burner, full-image restore, servo actions, TTS, ASR, WebSocket, MQTT, mDNS, public exposure.
