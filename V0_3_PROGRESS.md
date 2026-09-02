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

- v0.3-C: Historical Recall
- Vision is outside this phase.

## VC_AI_PET_V0_3_B

```text
FINAL_STATUS=VC_AI_PET_V0_3_B_PASS
VERSION=0.3.0-alpha.2
BRANCH=feat/v0.3-dream

LOCAL_BRAIN_API_V1=PASS
LOCAL_BRAIN_ENDPOINT=http://127.0.0.1:17862
PET_DEEPSEEK_REQUESTS=0
DREAM_DEEPSEEK_REQUESTS=0
MODEL_INFERENCES_PER_CHAT=1
MODEL_INFERENCES_PER_DREAM=ceil(sourceCount/24)

DREAM_ENGINE=PASS
DREAM_TRIGGER=state.sleep + no chat/reflection/dream in-flight + raw source; night 22:30-08:00 or daytime nap
DREAM_REASONING_EFFORT=medium
DREAM_BATCH_SIZE=24
DREAM_RELATED_MAX=24
DREAM_DERIVED_MAX_PER_BATCH=3
DREAM_CONSOLIDATION_MODE=ADDITIVE_ONLY
DREAM_STORAGE=pet-memory.db windows checkpoint
DREAM_LOG=dream_log
DREAM_SOURCE_SESSION=vc-ai-pet:dream
DREAM_WINDOW=vc-ai-pet:dream-window
DREAM_SOURCE_LEVELS=user/project/fact/lesson/topic; active importance>=2; source_session=vc-ai-pet
DREAM_DERIVED_LEVELS=soul/user/fact/lesson/topic
RAW_MEMORY_HISTORY_PRESERVED=PASS

MICRO_REFLECTION=PASS
MICRO_REFLECTION_INTERVAL=30m
MICRO_REFLECTION_REASONING=low
MICRO_REFLECTION_BATCH_NEW_MAX=4
MICRO_REFLECTION_RELATED_MAX=4
MICRO_REFLECTION_DERIVED_MAX=1
MICRO_REFLECTION_SOURCE_SESSION=vc-ai-pet:reflection
REFLECTION_WINDOW=vc-ai-pet:reflection-window
MICRO_REFLECTION_SOUL_WRITE=DENIED
CHECKPOINTS_INDEPENDENT=PASS

DEEP_DREAM=PASS
NIGHT_DREAM=PASS
DAYTIME_NAP_DREAM=PASS
DEEP_DREAM_MIN_SLEEP=15m
DAYTIME_GPU_IDLE_THRESHOLD=45m
DEEP_DREAM_SUCCESS_COOLDOWN=30m
REFLECTION_SUCCESS_COOLDOWN=30m

IDENTITY_KERNEL=PASS
PERSONALITY_HARDCODED=NO
EMERGENT_SOUL=PASS
SOUL_WRITE_FROM_CHAT=DENIED
SOUL_WRITE_FROM_REFLECTION=DENIED
SOUL_WRITE_FROM_DREAM=ALLOWED_GATED
SOUL_MIN_SOURCE_COUNT=2
SOUL_MIN_CONFIDENCE=0.82
SOUL_CONTEXT_MODE=RETRIEVAL_PLUS_TOP3_CURRENT_SELF
ALL_SOUL_INJECTED_EVERY_CHAT=NO
FULL_MEMORY_CONTEXT_INJECTION=NO
RAW_CHAT_HISTORY_PERSISTED=NO
LOCAL_BRAIN_PHYSICAL_CONTEXT_CONTROL=NONE

PRODUCTION_DREAM_ACCEPTANCE=PASS
PRODUCTION_DREAM_SOURCE_COUNT=4
PRODUCTION_DREAM_BATCH_COUNT=1
PRODUCTION_DREAM_DERIVED_COUNT=2
PRODUCTION_DREAM_DUPLICATE_COUNT=1
DREAM_CHECKPOINT_BEFORE=0
DREAM_CHECKPOINT_AFTER=1788327857820

RECENT_CONVERSATION_REGRESSION=PASS
MEMORY_GATE_REGRESSION=PASS
MEMORY_OPT_OUT_REGRESSION=PASS
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
```

The production run consumed four active raw rows, including the preserved
`群青色` history, through one Deep Dream batch. It wrote two additive Dream
rows and identified one duplicate; all source `id`, `content`, `status`,
`importance`, `created_at`, and `updated_at` values remained unchanged. The
Dream log records `changes.kind=dream`, source IDs, derived IDs, and the
checkpoint; the independent Reflection window was not advanced.

Deferred to v0.3-C: Historical Recall, contradiction understanding,
source-backed why/when recall, Dream UI, Vision, TTS/ASR, host-idle detection,
physical-context control, and a personality-value model.

## VC_AI_PET_V0_3_C Historical Recall

```text
VERSION=0.3.0-alpha.3
HISTORICAL_RECALL=IMPLEMENTED
HISTORICAL_RECALL_MODE=ON_DEMAND_ONLY
HISTORICAL_SEARCH_MAX=12
HISTORICAL_LINEAGE_MAX_DEPTH=3
HISTORICAL_LINEAGE_MAX_NODES=18

WHY_RECALL=IMPLEMENTED
FIRST_RECALL=IMPLEMENTED
WHEN_RECALL=IMPLEMENTED
PAST_SELF_RECALL=IMPLEMENTED
EXACT_RECALL=IMPLEMENTED

DREAM_PROVENANCE=EXISTING_DREAM_LOG
RAW_SOURCE_PRIORITY=IMPLEMENTED
CONTRADICTION_HANDLING=TEMPORAL_READ_ONLY

FULL_MEMORY_CONTEXT_INJECTION=NO
NORMAL_CHAT_HISTORICAL_SCAN=0
NORMAL_CHAT_DREAM_LOG_READS=0
RAW_CHAT_HISTORY_PERSISTED=NO
RAW_MEMORY_HISTORY_PRESERVED=PASS

MODEL_INFERENCES_PER_CHAT=1
PET_DEEPSEEK_REQUESTS=0
PROVENANCE_STORAGE=EXISTING_DREAM_LOG
PROVENANCE_DB_WRITE=NO
NEW_PROVENANCE_DB=NO
```

Historical Recall is a deterministic, on-demand read path. Normal chat keeps
the existing five-result recall and never scans historical rows or dream_log.
Historical mode retrieves at most 12 semantic candidates, expands only
source-backed Dream/Reflection lineage within bounded limits, and formats at
most 16 records for the existing single Local Brain inference. The provenance
adapter opens the existing pet database read-only and performs only SELECTs;
Historical Recall does not write memory, checkpoints, windows, or dream logs.

## VC_AI_PET_V0_3_C Pet-side Busy Gate Removal

```text
FINAL_STATUS=VC_AI_PET_V0_3_C_UI_PENDING
PET_API_CALL_POLICY=DIRECT
PET_API_DIRECT_CALL=PASS
CHAT_GPU_BUSY_GATE=REMOVED
REFLECTION_GPU_BUSY_GATE=REMOVED
DREAM_GPU_BUSY_GATE=REMOVED
DAYTIME_NAP_TRIGGER=SLEEP_DURATION_45M
LOCAL_BRAIN_REQUEST_TIMEOUT_MS=180000
QUEUE_FULL_RETRY=250/500/1000ms
QUEUE_FULL_RETRY_BOUNDED=PASS
OWNER_BUSY_CANNED_REPLY=REMOVED_FROM_PRODUCTION
HISTORICAL_RECALL_AUTO_TESTS=PASS
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

Pet no longer performs a GPU/resource pre-flight before Chat, Reflection, or
Dream. Local Brain API v1 owns admission and scheduling; Pet retains only
chat/dream/reflection local in-flight idempotency guards. Daytime Deep Dream
eligibility is continuous sleep of 45 minutes, while the existing 15-minute
night sleep threshold and 30-minute success cooldown remain unchanged.

## VC_AI_PET_V0_3_D Phase 1 Memory Consolidation Foundation

```text
FINAL_STATUS=VC_AI_PET_V0_3_D_PHASE1
MEMORY_PROVENANCE=PASS
SEMANTIC_STABILITY=PASS
DREAM_CANDIDATE_LAYER=PASS
LEGACY_MEMORY_COMPATIBILITY=PASS
```

Completed foundation:

- Memory Provenance
- Semantic Stability
- Dream Candidate Layer
- Legacy Memory Compatibility

## VC_AI_PET_V0_3_D Phase 2 Deferred

The following work is deferred:

- Reflection Engine
- Personality Emergence
- Contradiction Detection

Reason: real long-term interaction data must accumulate before these features
can be designed and evaluated safely.
