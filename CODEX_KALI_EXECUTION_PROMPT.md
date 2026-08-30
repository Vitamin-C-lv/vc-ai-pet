# Kali Codex Execution Task — vc-ai-pet v0.1

You are the onsite integration executor. Most design/core code/assets are already prepared. DO NOT redesign or reimplement them.

## Objective
Install/adapt this project into CURRENT Kali DeepSeek Harness, make the pixel Bernese appear as a non-invasive global pet, persist only its own state + independent pet-memory.db, then push the finished source to a PUBLIC GitHub repository. Final marker: VC_AI_PET_V0_1_PASS.

## Non-negotiable
Pet is not an Agent; no shell/tool/computer control; no arbitrary host FS; no DeepSeek calls or prompt/context consumption; no Luna delegation; no Conversation node/Tool card/model Tool; no Dream/Reflection/local model in v0.1; DSH meow-memory DB and pet DB completely separate; Luna Team and vc-tool-activity-fold untouched; character art frozen.

## Reuse prepared code
Do not rewrite src/core/*, src/memory/pet-memory.js, src/runtime/pet-runtime.js, src/client/pet-overlay.js, src/client/pet.css, or assets/runtime/*. Only src/dsh/* and packaging/build syntax are expected adaptation seams.

## Phase 1 — narrow read-only discovery
Answer only: actual DSH version; profile/package layout; current shell.overlay slot API; current package-private host/client RPC API; installed meow-memory resolution path. Prefer current web profile package.json/cordis bundle, one tiny installed overlay plugin, slot contract, and installed meow-memory/package.json. Read roughly 5–8 directly relevant files maximum before editing. Do not scan runtime/monorepo broadly.

## Phase 2 — source
Preferred repo path: /home/vitamin_c/projects/personal/vc-ai-pet. Run only node test/smoke.mjs and node scripts/validate-assets.mjs before adaptation. No hashing.

## Phase 3 — memory reuse without DB reuse
Use already-installed meow-memory CODE if compatible. Do not change its DSH config/version/database. Pet DB must be ~/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db (or equivalent inside fixed pet sandbox). Existing DSH memory DB must not equal or reside under this root. If module resolution cannot see the installed package, use the smallest local dependency/symlink solution; do not upgrade the installed plugin.

## Phase 4 — DSH client
Use additive global shell.overlay. Confirm actual slot protocol first, then mount prepared createPetOverlay(). Bottom-right default, pointer events only on dog, DSH UI remains usable. Do not patch ChatView/Conversation DOM, register ConversationNode, touch Luna rendering, or touch work-activity folding.

## Phase 5 — host runtime + private bridge
Instantiate PetRuntime with fixed sandbox. Expose only package-private methods equivalent to pet.readState + pet.interact (+ narrow persistence only if required). No generic path RPC; no MemoryDb exposure to client; no model tools. Use current DSH private RPC instead of starting a custom public HTTP service.

## Phase 6 — persistence/isolation
Verify first boot creates pet state and only pet-memory.db; restart preserves bornAt/lifetimeInteractions/attachment/memory; click writes pet fact; existing DSH meow-memory data is unchanged. Compare paths/relevant rows only, no hashes.

## Phase 7 — DeepSeek isolation
Pet startup/tick/click/memory write must not cause LLM requests. Use narrow existing local DSH evidence only; no packet capture or proxy changes. Confirm no pet model tool, no prompt injection, pet absent from Conversation trajectory.

## Phase 8 — visible acceptance
Show dog visible, click reaction, autonomous states, DSH usable, Luna Team visually normal, vc-tool-activity-fold visually normal. A temporary DEV state switch is allowed for quick visual testing but remove/disable before final commit.

## Phase 9 — GitHub
Repository name vc-ai-pet unless an intended repo already exists. Use EXISTING GitHub authentication only. Do not modify VPN/proxy/SSH/credentials. If gh authenticated: gh repo create vc-ai-pet --public --source=. --remote=origin --push. Otherwise use existing valid remote/auth. If push is blocked, report exact blocker and leave clean committed repo; do not reconfigure networking. Before push update PROJECT_STATE.md with actual DSH version, install path, sandbox path, pet DB path, DSH DB path, changed files, acceptance, commit id. Never commit real DB/state.

## Minimal validation only
Required: core smoke, asset manifest, only build/parse needed by DSH, DSH startup, overlay visible, click, persistence, DB isolation, zero DeepSeek invocation, regression glance at Luna/folding, clean git status. Not required: SHA-256/full DSH tests/security audit/GPU benchmark/stress/unrelated upgrades.

## Final report
FINAL_STATUS=
DSH_VERSION=
REPO_PATH=
GITHUB_REPO=
DSH_PLUGIN_INSTALL_PATH=
PET_SANDBOX=
PET_MEMORY_DB=
DSH_MEMORY_DB=
DATABASES_SEPARATE=YES/NO
PET_VISIBLE=PASS/FAIL
CLICK_INTERACTION=PASS/FAIL
PERSISTENCE=PASS/FAIL
DEEPSEEK_REQUESTS_FROM_PET=0/UNKNOWN/FAIL
CONVERSATION_INJECTION=NONE/FAIL
MODEL_TOOL_REGISTERED=NO/FAIL
LUNA_REGRESSION=PASS/FAIL
TOOL_FOLD_REGRESSION=PASS/FAIL
COMMIT=
CHANGED_FILES=
NOTES=

Use FINAL_STATUS=VC_AI_PET_V0_1_PASS only if every required acceptance passes.
