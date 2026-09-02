# v0.1 Architecture

DSH Web Client -> additive shell.overlay -> Pixel Bernese UI -> zero-model state machine.
DSH Host -> PetRuntime -> PetSandbox + PetMemory -> independent sandbox/memory/pet-memory.db.

Hard isolation: existing DSH meow-memory DB != pet-memory.db; no cross-read/write; no prompt injection; no DeepSeek calls; no model tools; no arbitrary host filesystem or shell.

v0.1 deliberately excludes local LLM/VLM, Dream, Reflection, screenshots, Luna event bridge, TTS, microphone, camera, networking, and agent behavior.

## v0.3-E visual presence seam

`shell.overlay` renders the existing pet state through a browser-only visual
resolver. It can read system time, the pet's public last-interaction timestamp,
the DSH page visibility state, local chat-pending state, and the additive
package-private `readPresence` boolean flags. The host reports actual
`DreamEngine.isInFlight()` without changing Dream scheduling, memory, or the
Local Brain API. No browser-side environmental label reaches the brain.

## v0.3-E Phase 2 emotion seam

`src/client/emotion-state.js` provides the bounded, RAM-only emotion math.
For the Phase 3-A companion page, PetRuntime holds its live values once and
returns a narrow public presentation snapshot to both UIs. It is never written
to `state.json`, localStorage, `pet-memory.db`, Local Brain prompts, or
Dream/Reflection scheduling. The visual resolver remains the single authority
for `dreaming > thinking > excited > happy > relaxed > waiting > confused >
curious > sleep > walk > idle`.

## v0.3-E Phase 3-A LAN companion seam

`src/remote/lan-server.js` is a Node HTTP server owned by the existing DSH
host plugin. It binds `0.0.0.0:17870` so a phone on the same Wi-Fi can reach
it, but admits only localhost and RFC1918 IPv4 peers (`10/8`, `172.16/12`,
`192.168/16`); all public IPv4 and non-loopback IPv6 peers receive `403`.
The three endpoints call the existing runtime methods directly: state reads
`presentationSnapshot`, actions call `runtime.interact`, and chat calls
`runtime.chat` (therefore the existing Local Brain API v1). No model process,
Memory schema, Dream behavior, or account/authentication system is added.
