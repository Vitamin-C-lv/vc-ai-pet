# StackChan Body Bridge

Standalone, read-only adapter from VC-AI-PET `GET /api/pet/state` to a small CoreS3 DTO. It does not import PetRuntime, access Memory/Dream databases, or call action/chat routes.

## Runtime

Requires Node.js 20 or newer. No added package dependency.

```sh
VC_AI_PET_UPSTREAM=http://127.0.0.1:17870 \
STACKCHAN_BRIDGE_BIND=127.0.0.1 \
STACKCHAN_BRIDGE_PORT=17871 \
node tools/stackchan-bridge/src/main.mjs
```

`GET /healthz` checks the bridge process. `GET /v1/body/state` performs one upstream GET and returns contract v1. On upstream failure it serves the last successful presentation with `reachable=false` while age is at most 10 seconds. With no cache or older cache it returns the offline face. Device polling target is 2000 ms.

Defaults: upstream `http://127.0.0.1:17870`, bind `127.0.0.1`, port `17871`, upstream timeout `1500` ms, cache maximum age `10000` ms. Environment values: `VC_AI_PET_UPSTREAM`, `STACKCHAN_BRIDGE_BIND`, `STACKCHAN_BRIDGE_PORT`, `STACKCHAN_UPSTREAM_TIMEOUT_MS`, `STACKCHAN_STATE_MAX_AGE_MS`.

The current Phase 0 device runs the M5Stack factory StackChan firmware family, whose boot log identifies the Xiaozhi board stack. No no-reflash extension path or custom HTTP client API has been established for the installed build, so no device client is included. No firewall rule or LAN listener was created as part of this package. For a later device test, bind only to a current private adapter address and add a narrowly scoped Windows firewall rule after confirming the device and host share that network. Never store a historical WLAN address here.

## Contract mapping

The mapping is in `src/contract.mjs`; the illustrative DTO is `docs/stackchan/body-state-contract-v1.json`. Unknown emotion values become `null`; numeric values clamp to `[0,1]`. Unknown visual states retain their source name and use an idle-face fallback. `speaking` remains false and `speechText` remains null in this phase.

`actionCue` is descriptive metadata only. This build never sends a command to the device and never calls `/api/pet/action`.

## Tests

From the WSL feature worktree:

```sh
node tools/stackchan-bridge/test/contract.test.mjs
node tools/stackchan-bridge/test/server.test.mjs
```

The server test uses a local fake upstream and covers success, HTTP failure, invalid JSON, timeout, fresh/stale cache, connection refusal, route/method rejection, compact response, and zero upstream POSTs.

## Rollback

Stop `main.mjs` with Ctrl+C. The bridge is independent and has no persistent state. Pet Runtime, `17870`, Android, Memory, and Dream are unchanged.
