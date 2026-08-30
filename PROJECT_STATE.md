# VC AI Pet — Project State

Status: v0.1 closeout recorded; public GitHub push is complete, while the end-to-end browser-click RPC assertion remains unverified in the available browser surface.

```text
DSH_VERSION=0.1.1-rc.2
REPO_PATH=/home/vitamin_c/projects/personal/vc-ai-pet
GITHUB_REPO=https://github.com/Vitamin-C-lv/vc-ai-pet
GITHUB_VISIBILITY=PUBLIC
DSH_PLUGIN_INSTALL_PATH=/home/vitamin_c/.dsh/profiles/web/node_modules/vc-ai-pet
PET_SANDBOX=/home/vitamin_c/.local/share/vc-ai-pet/sandbox
PET_MEMORY_DB=/home/vitamin_c/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db
DSH_MEMORY_DB=/home/vitamin_c/桌面/测试/.dsh-meow/memory.db
DATABASES_SEPARATE=YES
CLIENT_HOST_RPC=UNVERIFIED
PET_VISIBLE=PASS
CLICK_INTERACTION=FAIL
PERSISTENCE=PASS
DEEPSEEK_REQUESTS_FROM_PET=0
CONVERSATION_INJECTION=NONE
MODEL_TOOL_REGISTERED=NO
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
CURRENT_COMMIT=2d0250bb356918ed35f24d93338d71c6b0c266d0
```

Closeout evidence:

- The host registers the package-private `/vc-ai-pet` channel with `connection.rpc.handle`; a local HTTP `readState` request returned a valid server response.
- The real DSH page rendered the dog and a real pointer click changed `idle` to `happy`, but the available Codex in-app browser page exposes neither `fetch` nor `WebSocket`. The client bridge therefore cannot transmit that click in this test surface; the pet DB remained at two facts and `lifetimeInteractions` remained `1`.
- The pre-existing runtime interaction and restart check remain passing: `pet-memory.db` retains its interaction fact and state, and the DSH memory DB remains at zero facts.
- `https://github.com/Vitamin-C-lv/vc-ai-pet` is public; remote `main` matched the local implementation commit above before this documentation-only closeout commit. No README, LICENSE, or initialization commit was added by GitHub.

v0.1 explicitly does not include:

- local LLM or VLM
- Dream or Reflection
- DSH event awareness
- computer control

The DSH adaptation leaves Luna Team and `vc-tool-activity-fold` unchanged.
