# Independent Read-Only Audit Notes

Three bounded subagent reviews were used. No subagent changed production or touched the device.

## Official M5Stack source audit

- Device banner matches official M5Stack factory source markers `1.5.1`, IDF `v5.5.4`, project `stack-chan`, target `m5stack-stack-chan`; exact installed build commit is not provable from the banner.
- `AVATAR` and App Center are static Mooncake apps. App Center fetches an app listing and launches the OTA updater; no independent custom MOD slot is evident in the M5Stack factory source.
- The separate Moddable `stack-chan/stack-chan` project is not evidence of the installed factory image's extension or network API.

## Official recovery audit

- Official M5Stack StackChan documentation describes M5Burner `StackChan` search, `Only Official`, download latest, then Burn; it documents a USB-C/RST download-mode path.
- The catalog's exact current image version is not statically identified, so it cannot be asserted to match installed app `1.5.1` or preserve pairing/NVS.
- No recovery/flash was performed. The private full-flash readback provides a per-device recovery point, but restoring it would require a separate explicit write approval.

## Moddable Stack-chan API audit

- The community/Moddable host has a real host/MOD architecture, but is a different firmware from this device's M5Stack factory/Xiaozhi banner.
- Its MOD installation is not a zero-write app install, and the audited public API did not confirm a generic JSON HTTP GET client. It is not a valid basis to claim the current factory image can poll the bridge without firmware replacement.

## Synthesis

Proceed only as a source-rebuild/custom-firmware route. The current phase source-builds and host-tests that route but stops before device flash, network setup, servo/audio tests, or physical acceptance.
