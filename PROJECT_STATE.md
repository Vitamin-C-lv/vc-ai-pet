# VC AI Pet — Project State

Status: FINAL_STATUS=VC_AI_PET_V0_3_A_PASS

```text
DSH_VERSION=0.1.1-rc.2
REPO_PATH=/home/vitamin_c/projects/personal/vc-ai-pet
GITHUB_REPO=https://github.com/Vitamin-C-lv/vc-ai-pet
GITHUB_VISIBILITY=PUBLIC
DSH_PLUGIN_INSTALL_PATH=/home/vitamin_c/.dsh/profiles/web/node_modules/vc-ai-pet
PET_SANDBOX=/home/vitamin_c/.local/share/vc-ai-pet/sandbox
PET_MEMORY_DB=/home/vitamin_c/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db
DSH_MEMORY_DB=/home/vitamin_c/桌面/测试/.dsh-meow/memory.db
PET_ACTIVE_DSH_HOST_COUNT=1
SINGLE_CLICK_EXACTLY_ONCE=PASS
DOUBLE_CLICK_EXACTLY_ONCE=PASS
CLIENT_HOST_RPC=PASS
CLICK_INTERACTION=PASS
MULTI_CLICK_COUNT_CONSISTENCY=PASS
DATABASES_SEPARATE=YES
PERSISTENCE=PASS
DEEPSEEK_REQUESTS_FROM_PET=0
CONVERSATION_INJECTION=NONE
MODEL_TOOL_REGISTERED=NO
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
MULTI_DSH_BACKEND_CONCURRENT_WRITE=OUT_OF_SCOPE_V0_1
CURRENT_COMMIT=fd06df7b75c6736e47a500f0128c68800e1044fa
```

Interaction acceptance recorded:

- Single-click baseline: `lifetimeInteractions=9`, `attachment=0.578`, `fact_count=27`.
- Single-click result: `lifetimeInteractions=10`, `attachment=0.584`, `fact_count=28`; latest fact is `主人和我互动了：pet。累计互动次数：10。`.
- Double-click acceptance: one logical `play` interaction, as confirmed by the user; no further interaction testing is required for v0.1.

The package remains isolated from DSH memory and model activity. v0.1 does not include local LLM, VLM, Dream, Reflection, DSH event awareness, or computer control. Luna Team and `vc-tool-activity-fold` remain unchanged.

## v0.3-A implementation status

Recent Conversation Continuity is implemented on branch
`feat/v0.3-recent-conversation` as a host-side RAM-only buffer of the latest
12 successful user/assistant turns. It is not persisted to the sandbox or any
memory database. Automated and manual acceptance are complete; the package
version is `0.3.0-alpha.1`.
