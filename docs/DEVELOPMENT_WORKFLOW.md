# Development Workflow

GitHub is the project source of truth after the first Kali integration.

1. Work in `/home/vitamin_c/projects/personal/vc-ai-pet`.
2. Keep `main` usable; use small feature/fix branches only when a change is non-trivial.
3. Every meaningful stage updates `PROJECT_STATE.md`.
4. Commit source, docs, and reusable art. Never commit real `pet-memory.db`, WAL/SHM files, or runtime pet state.
5. Push after each completed stage so later ChatGPT/Codex sessions can inspect the repository instead of exchanging ZIPs.
6. Future work should be additive: v0.2 local brain, then memory recall/dream, then optional multimodal perception. Do not mix these into v0.1.

Recommended first remote: public repo `vc-ai-pet` under the currently authenticated GitHub account.
