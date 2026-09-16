# Phase 3B DEVLOG

## 2026-09-16

1. Confirmed feature worktree is independent from production; preserved pre-existing `android-companion/**` dirty files in production.
2. Rechecked the private 16 MiB factory backup and generated comparison slices outside the repository.
3. Enumerated COM5/USB-Serial-JTAG and performed bounded, read-only flash reads.
4. Compared partition table, otadata, ota_0 head and ota_0 middle samples byte-for-byte against the full backup; all passed.
5. Started a Windows-native read-only bridge on the current physical WLAN address, verified `/healthz` and `/v1/body/state`, then stopped it and removed its dedicated LocalSubnet/Wireless firewall rule.
6. Added `scripts/stackchan/prepare-factory-build.py` to make the build staging deterministic: official source commit pin, ignored dependency-tree carryover, reviewed app patch, and local untracked bridge URL header. It never flashes, erases, switches OTA metadata, or writes the URL into the feature repository.
7. Built the configured Factory image successfully and verified the endpoint path is embedded and the image fits an OTA partition.
8. Reviewed official `otatool.py --help`; read-only `read_otadata` showed sequence records 1 and 2. Because this conflicts with an older boot-offset observation, stopped before any write.

## Safety result

No device write, erase, OTA switch, production restart, PetRuntime change, Memory/Dream change, Android change, servo command, or public network exposure occurred.
