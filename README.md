# vc-ai-pet

A tiny pixel Bernese Mountain Dog that lives beside DeepSeek Harness. It is deliberately not an Agent.

v0.1 includes pixel overlay, idle/curious/walk/rest/sleep state machine, click/double-click interaction, independent sandbox, independent seven-layer pet-memory.db using meow-memory MemoryDb code, and zero DeepSeek usage/context injection/host control.

v0.3-E Phase 1 adds a small UI-presence layer: state-driven sprite selection,
Dream moon/Zzz animation, chat thinking, short happy/excited feedback, a
six-frame local walk cycle, and safe read-only time/inactivity/visibility
labels. It does not change the brain, Dream policies, database schema, or
production data.

Hard rules: PET_HOST_ACCESS=NONE; PET_DEEPSEEK_USAGE=NONE; PET_MEMORY_DATABASE=FULLY_ISOLATED.

Kali Codex: read CODEX_KALI_EXECUTION_PROMPT.md then AGENTS.md.
