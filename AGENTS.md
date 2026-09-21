# Agent Rules — vc-ai-pet

This project is intentionally tiny. Adapt only to current installed DSH plugin APIs. Preserve prepared state engine, sandbox, memory isolation, and art. Use additive shell.overlay and package-private RPC only. Keep pet DB inside its sandbox. Update PROJECT_STATE.md and push to GitHub.

DO NOT turn the pet into an Agent; add shell/fs/browser/computer-control tools; expose prompt/reply/source/session bodies; call DeepSeek; share DSH meow-memory DB; add Dream/Reflection/local LLM/VLM in v0.1; patch ChatView/Conversation DOM; modify Luna Team or vc-tool-activity-fold; upgrade DSH/meow-memory just to fit; redesign the dog; run broad audits/hashes/SHA-256/unrelated benchmarks.

## StackChan factory build staging

- `STACKCHAN_CANONICAL_SOURCE=~/.cache/vc-ai-pet/stackchan-official-source`.
- `STACKCHAN_CANONICAL_STAGING=~/.cache/vc-ai-pet/stackchan-factory-staging`; normal firmware iterations must reuse this marked canonical staging tree.
- `FORBIDDEN_NORMAL_PATTERN=/tmp/stackchan-phase<phase>-<topic>-<commit>-r<N>`; do not create per-commit or per-attempt full clones for normal iterations.
- Preserve `firmware/build` as the incremental build cache and reuse `firmware/managed_components`; never recopy the managed component tree on every iteration.
- Use a clean-room staging tree only when isolation is materially required, and remove it at task completion.
- Preserve all existing `ota_0`, Factory recovery, shared assets, and app-only OTA safety boundaries. A staging refresh does not authorize flashing, erasing, or OTA metadata changes.
