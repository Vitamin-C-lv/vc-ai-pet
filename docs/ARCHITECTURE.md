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

`src/client/emotion-state.js` is a browser-only, momentary telemetry layer.
Its values are held by the overlay and are never passed to host RPCs, Local
Brain prompts, Dream/Reflection scheduling, `state.json`, localStorage, or
`pet-memory.db`. Owner pointer interactions update bounded deltas; elapsed
time applies only a small decay; Dream presence toggles a presentation flag;
and the existing attachment is read as a refresh hint. The visual resolver
remains the single authority for `dreaming > thinking > excited > happy >
relaxed > waiting > confused > curious > sleep > walk > idle`.
