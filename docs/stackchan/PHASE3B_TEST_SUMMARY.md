# Phase 3B 测试摘要

## Passed

- `node tools/stackchan-bridge/test/contract.test.mjs` → `BRIDGE_CONTRACT_TEST=PASS`
- `node tools/stackchan-bridge/test/server.test.mjs` → `BRIDGE_FAKE_UPSTREAM_TEST=PASS`
- C++ host state mapping test compiled with `-std=c++17 -Wall -Wextra -Werror` and exited 0.
- `git diff --check` passed for the feature worktree changes.
- Windows native bridge healthz/body-state read-only smoke test passed.
- Fresh device partition/otadata/ota_0 sample comparisons all passed.
- Fresh configured Factory source build passed; final image size 3,792,448 bytes, under 0x4f0000.

## Not run by design

- No full 84-test suite.
- No device client boot/UI test, because no flash occurred.
- No offline/reconnect physical acceptance.
- No servo, audio, microphone, camera, BLE, MQTT, WebSocket or mDNS test.
- No production restart or mutation test.

## Sensitive-output policy

Raw esptool output and raw serial captures are not included. The handoff contains only sanitized conclusions; private full backup and build binaries remain outside Git/ZIP.
