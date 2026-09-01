# 李花花 v0.3-A Progress

VC_AI_PET_V0_3_A

## Recent Conversation Continuity

```text
LOCAL_BRAIN_API_V1_BASELINE=PASS
AUTO_TESTS=PASS
DSH_3082_DEPLOYED=PASS
RECENT_CONVERSATION=PASS
RECENT_CONVERSATION_MAX_TURNS=12
RECENT_CONVERSATION_STORAGE=RAM_ONLY
RECENT_CONVERSATION_CONTINUITY=PASS
RECENT_CONVERSATION_RAM_ONLY=PASS
CURRENT_USER_LAST_MESSAGE=PASS
RAW_CHAT_HISTORY_PERSISTED=NO
CLIENT_SEND_FULL_HISTORY=NO
PET_MEMORY_ISOLATION=PASS
DATABASES_SEPARATE=PASS
MODEL_INFERENCES_PER_CHAT=1
PET_DEEPSEEK_REQUESTS=0
PET_DIRECT_17861=NO
PET_MODEL_LIFECYCLE=NONE
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
MEMORY_WRITE_REGRESSION=PASS
MEMORY_OPT_OUT_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
UI_MANUAL_ACCEPTANCE=PASS
VERSION=0.3.0-alpha.1
VERSION_BUMP=PASS
```

`RecentConversation` is owned by the host-side `PetRuntime` and stores only the
latest 12 successful user/assistant turns in RAM. It is not written to
`pet-memory.db`, the sandbox, localStorage, DSH memory, or any file. It is
cleared when the runtime closes and therefore disappears after a host runtime
restart.

The Memory Gate still evaluates only the current `userText`; recent messages
are language context and cannot become long-term memory evidence. The browser
continues to send only the current user text.

Automated and manual acceptance are complete. The package version is
`0.3.0-alpha.1`.

## Planned

- v0.3-B: Dream / Reflection / Memory Consolidation
- v0.3-C: Historical Recall
- Vision is outside this phase.
