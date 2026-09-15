# Factory Source Integration Patch Notes

Target source: M5Stack `m5stack/StackChan` commit `1b5765599fba8aaad1811d9a79358ccc7051f5f3`, firmware `1.5.1`, ESP-IDF `v5.5.4`.

The complete new app code is in this directory. Integrate into a separate upstream source checkout as follows:

1. Copy `lihuahua_body_app.{h,cpp}` and `lihuahua_body_state.{h,cpp}` under `firmware/main/apps/app_lihuahua_body/`.
2. Add `#include "app_lihuahua_body/lihuahua_body_app.h"` to `firmware/main/apps/apps.h`.
3. Add `GetMooncake().installApp(std::make_unique<LiHuahuaBodyApp>());` beside the other static app registrations in `firmware/main/main.cpp`.
4. Add `esp_http_client` to `firmware/main/CMakeLists.txt` `PRIV_REQUIRES` (the source app uses the ESP-IDF HTTP client directly for a strict timeout and bounded response buffer).
5. Optionally copy `stackchan_body_config.example.h` to the untracked `firmware/main/apps/app_lihuahua_body/stackchan_body_config.h` and set `STACKCHAN_BODY_BRIDGE_URL` to the *current* PC LAN endpoint. The committed source has an empty default; never commit a DHCP address or secret.
6. Run `idf.py build`; do not run `idf.py flash` as part of this phase.

The upstream `main/CMakeLists.txt` recursively globs `apps/*.cpp` and `apps/*.h`, so a separate source-list edit is not needed. No changes are required to VC-AI-PET `src/`, Android Companion, Memory, Dream, Reflection, or PetRuntime.

The three tracked upstream registration/dependency edits are also provided as a ready-to-apply diff at patches/app-registration.patch. Copy the app source directory first, then apply that diff from the upstream repository root.

## Review constraints

- `fetchBodyState()` does only HTTP GET. It does not write to VC-AI-PET or device flash.
- No call exists to `GetStackChan().update()`, servo, motion, audio, camera, BLE, App Center, OTA, or chat/action APIs.
- `actionCue` is not parsed or executed.
- UI displays the server expression and stale/offline state. It does not derive emotion from memory/history.
- Custom app source was compiled locally but not installed on hardware.
