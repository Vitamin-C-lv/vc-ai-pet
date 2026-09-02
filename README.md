# vc-ai-pet

A tiny pixel Bernese Mountain Dog that lives beside DeepSeek Harness. It is deliberately not an Agent.

v0.1 includes pixel overlay, idle/curious/walk/rest/sleep state machine, click/double-click interaction, independent sandbox, independent seven-layer pet-memory.db using meow-memory MemoryDb code, and zero DeepSeek usage/context injection/host control.

v0.3-E Phase 1 adds a small UI-presence layer: state-driven sprite selection,
Dream moon/Zzz animation, chat thinking, short happy/excited feedback, a
six-frame local walk cycle, and safe read-only time/inactivity/visibility
labels. It does not change the brain, Dream policies, database schema, or
production data.

v0.3-E Phase 2 adds a momentary emotion layer: click, double-click,
and long-press feedback; a bounded 30-second interaction burst; silent waiting
after recent interaction; and weighted low-frequency idle actions. Emotion is
never persisted or sourced from model/assistant content. Dream decoration stays
CSS-only and uses the existing sleep sprites.

v0.3-E Phase 3-A adds a tiny LAN Companion UI at port `17870`. It is a
vanilla HTML/CSS/JS control page served by the DSH host and reads/writes the
same PetRuntime as the desktop overlay. The listener binds `0.0.0.0` for Wi-Fi
devices, while every request is limited to localhost or private IPv4 clients;
public IP clients are rejected. It has no account, cloud service, data upload,
or public-network access.

Hard rules: PET_HOST_ACCESS=NONE; PET_DEEPSEEK_USAGE=NONE; PET_MEMORY_DATABASE=FULLY_ISOLATED.

Kali Codex: read CODEX_KALI_EXECUTION_PROMPT.md then AGENTS.md.
