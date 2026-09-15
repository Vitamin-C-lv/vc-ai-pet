# StackChan Bridge Phase 1 Acceptance Record

Date: 2026-09-15 (Asia/Shanghai)

## Confirmed

- Production source HEAD before worktree creation: `5731cc023c34a832cec80bdbdc9fdcf9301104f0`.
- New worktree branch `feat/stackchan-body-mvp` was created from that exact HEAD.
- Windows native Node.js `v24.19.0` is available. Windows `127.0.0.1:17870/api/pet/state` returned HTTP 200 with the expected read-only presentation DTO. The Windows Node process imported the bridge source over the WSL UNC path, fetched Pet state once, served the transformed body DTO on an ephemeral loopback port, and closed cleanly.
- Bridge source supports only GET `/healthz` and GET `/v1/body/state`; unit/integration tests use an isolated fake upstream.
- `LIVE_READ_ONLY_UPSTREAM_ADAPTATION=PASS`; observed state was `relaxed`, mapped to `expression=relaxed`, DTO size 443 bytes.
- Device UART identifies an ESP32-S3, SKU `m5stack-stack-chan`, app version `1.5.1`, project `stack-chan`, and `xiaozhi board init`. Cross-check against the official [M5Stack StackChan repository](https://github.com/m5stack/StackChan) supports `DEVICE_FIRMWARE_MODE=M5STACK_FACTORY_OR_AVATAR`, rather than the separate Moddable Stack-chan host.
- Bridge runtime decision is `WINDOWS_NATIVE`, using ephemeral Codex Node `v24.19.0`; development/integration bind was loopback. No persistent bridge service, Windows firewall rule, portproxy, production listener, or device flash was created.
- The pre-existing production dirty paths were exclusively under `android-companion/**`; they were not edited by this task.

## Not accepted / still unverified

- CoreS3 has not fetched the bridge contract. M5Stack factory firmware documents App Center downloads, OTA, and several programming platforms, but this audit did not establish a no-reflash custom app path or an HTTP JSON client API for the installed 1.5.1 build. The separate [Moddable Stack-chan API](https://github.com/stack-chan/stack-chan/blob/main/firmware/docs/api.md) does not establish a generic MOD JSON HTTP client and does not apply to the installed M5Stack firmware.
- Current Windows WLAN adapter is disconnected and has only a link-local address. The active private address belongs to a USB Ethernet adapter, so no WLAN bind/firewall or device network test was attempted.
- Device-side polling, relaxed-face display, offline transition, and recovery remain unverified.
- Speaker, microphone, touch event API, RGB control, servo APIs, OTA flow, and firmware recovery remain unverified at the firmware/API level. No audio, servo, camera, or other peripheral action was issued.

## Required test result fields

```text
BRIDGE_RUNTIME=WINDOWS_NATIVE
WINDOWS_NODE_VERSION=v24.19.0
BRIDGE_BIND=127.0.0.1 (ephemeral integration test only)
BRIDGE_PORT=17871 (configured default; no listener kept running)
BRIDGE_CONTRACT_TEST=PASS
BRIDGE_FAKE_UPSTREAM_TEST=PASS
LIVE_PET_STATE_HTTP=200 (Windows loopback, read-only GET)
LIVE_READ_ONLY_UPSTREAM_ADAPTATION=PASS
DEVICE_FACE_CLIENT=BLOCKED_BY_DEVICE_FIRMWARE_IDENTIFICATION
DEVICE_POLL_MS=2000 (planned only; no device client installed)
WINDOWS_WLAN_IP=NONE (adapter disconnected; only link-local IPv4)
WINDOWS_FORWARDING_CREATED=NO
WINDOWS_FIREWALL_CREATED=NO
PUBLIC_EXPOSURE_CREATED=NO
DEVICE_REFLASHED=NO
PRODUCTION_RESTARTED=NO
```
