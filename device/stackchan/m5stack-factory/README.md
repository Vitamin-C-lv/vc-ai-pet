# Li Huahua Body App — M5Stack Factory Firmware Source

This is a source-only app addition for the M5Stack `StackChan` factory firmware family. It is intended for local review and compilation only. It is not a flash image, and no install, OTA, erase, or recovery action is authorized by this package.

The currently observed unit reports ESP32-S3, SKU `m5stack-stack-chan`, application `1.5.1`, ESP-IDF `v5.5.4`, and project `stack-chan`. The exact binary-to-source commit match is unverified. This implementation targets the official M5Stack source commit recorded in the adjacent audit report; it is not a Moddable Stack-chan MOD.

The client performs only a bounded HTTP GET to the configured bridge URL and displays the returned contract. It has no chat/action/audio/camera/BLE/servo behavior. The bridge URL is deliberately left unset in this source package; configure a current PC LAN address in a local, untracked config header before a future build.

Build/install distinction:

- `idf.py build` is local compilation only.
- `idf.py flash`, M5Burner Burn, OTA update, erase, or factory reset are forbidden by the Phase 2 authorization.
- Adding this app requires integrating these source files into a rebuilt factory firmware image. App Center is an OTA image update flow, not an independent hot-insert app installer.

See `PATCH_NOTES.md` for the minimal upstream integration patch and `../../../docs/stackchan/DEVICE_PHASE_2_CAPABILITY_AND_RECOVERY.md` for evidence and recovery caveats.
