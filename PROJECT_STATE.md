# VC AI Pet — Project State

Status: integrated locally; ready for public GitHub push.

- DSH version: `0.1.1-rc.2`
- DSH web profile: `/home/vitamin_c/.dsh/profiles/web`
- Installed package link: `/home/vitamin_c/.dsh/profiles/web/node_modules/vc-ai-pet`
- Pet sandbox: `/home/vitamin_c/.local/share/vc-ai-pet/sandbox`
- Pet memory DB: `/home/vitamin_c/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db`
- Existing DSH memory DB checked: `/home/vitamin_c/桌面/测试/.dsh-meow/memory.db`
- Database isolation: confirmed; the DSH fact-row count remained `0`, while the pet DB records its own interaction facts.

Changed for DSH adaptation:

- `src/dsh/host-plugin.js` — fixed sandbox runtime, exact private RPC, read-only packaged sprite route.
- `src/dsh/client-plugin.js` — additive `shell.overlay` mount and narrow bridge.
- `scripts/build-client.mjs`, `lib/client.js`, `package.json`, `cordis.patch.yml`, `.gitignore` — client bundle and DSH package metadata.

Acceptance observed:

- DSH starts normally; the dog is visible in the bottom-right global overlay.
- Click changes the dog from idle to happy; direct runtime persistence confirms the interaction fact and restart preservation.
- The pet uses no model tool, prompt/context injection, conversation node, Luna integration, or DSH memory DB.
- Luna Team and `vc-tool-activity-fold` were left unchanged and still render in the DSH page.

Commit: recorded in the final integration commit.
