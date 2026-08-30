# v0.1 Architecture

DSH Web Client -> additive shell.overlay -> Pixel Bernese UI -> zero-model state machine.
DSH Host -> PetRuntime -> PetSandbox + PetMemory -> independent sandbox/memory/pet-memory.db.

Hard isolation: existing DSH meow-memory DB != pet-memory.db; no cross-read/write; no prompt injection; no DeepSeek calls; no model tools; no arbitrary host filesystem or shell.

v0.1 deliberately excludes local LLM/VLM, Dream, Reflection, screenshots, Luna event bridge, TTS, microphone, camera, networking, and agent behavior.
