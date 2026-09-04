# VC AI Pet — Project State

Status: FINAL_STATUS=VC_AI_PET_MOBILE_UI_POLISH_PHASE2_PASS

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
CURRENT_COMMIT=UI_RELEASE_COMMIT_RECORDED_IN_GIT
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

## v0.3-B Dream / Reflection status

The feature branch `feat/v0.3-dream` adds two independent, Pet-only thought
layers. Micro Reflection uses a separate 30-minute checkpoint and a maximum of
4 new raw memories, 4 related rows, and 1 additive derived row. Deep Dream is
restricted to sleep, uses a 15-minute sleep minimum, allows night runs from
22:30 to 08:00 or a daytime nap after 45 minutes of continuous fixed GPU
availability, and uses 24 new / 24 related rows per batch with at most 3
derived rows. Both layers use only Local Brain API v1 at
`http://127.0.0.1:17862`; neither writes `rules` or uses physical context.

Acceptance is complete on `feat/v0.3-dream`:

```text
VERSION=0.3.0-alpha.2
DREAM_SOURCE_SESSION=vc-ai-pet:dream
DREAM_WINDOW=vc-ai-pet:dream-window
REFLECTION_SOURCE_SESSION=vc-ai-pet:reflection
REFLECTION_WINDOW=vc-ai-pet:reflection-window
CHECKPOINTS_INDEPENDENT=PASS
RAW_MEMORY_HISTORY_PRESERVED=PASS
EMERGENT_SOUL=PASS
SOUL_WRITE_FROM_CHAT=DENIED
SOUL_WRITE_FROM_REFLECTION=DENIED
SOUL_WRITE_FROM_DREAM=ALLOWED_GATED
PRODUCTION_DREAM_ACCEPTANCE=PASS
PRODUCTION_DREAM_SOURCE_COUNT=4
PRODUCTION_DREAM_BATCH_COUNT=1
PRODUCTION_DREAM_DERIVED_COUNT=2
PRODUCTION_DREAM_DUPLICATE_COUNT=1
```

The production `dream_log` entry is additive and records
`changes.kind=dream`; no raw chat transcript or source-row rewrite occurred.

## v0.3-C Historical Recall

The feature branch `feat/v0.3-historical-recall` adds an on-demand historical
read path above the sealed v0.3-B Dream/Reflection layers. Normal chat keeps
`memory.recall(userText, 5)` and does not scan all history or read `dream_log`.
Historical questions use deterministic intent routing, meow-memory BM25
retrieval over `soul/user/project/fact/lesson/topic`, temporal ordering, and a
bounded read-only provenance expansion from the existing `dream_log`.

```text
VERSION=0.3.0-alpha.3
HISTORICAL_RECALL_MODE=ON_DEMAND_ONLY
HISTORICAL_SEARCH_MAX=12
HISTORICAL_LINEAGE_MAX_DEPTH=3
HISTORICAL_LINEAGE_MAX_NODES=18
HISTORICAL_CONTEXT_MAX=16
DREAM_PROVENANCE=EXISTING_DREAM_LOG
PROVENANCE_DB_WRITE=NO
NEW_PROVENANCE_DB=NO
RAW_SOURCE_PRIORITY=PASS
CONTRADICTION_HANDLING=TEMPORAL_READ_ONLY
FULL_MEMORY_CONTEXT_INJECTION=NO
NORMAL_CHAT_HISTORICAL_SCAN=0
NORMAL_CHAT_DREAM_LOG_READS=0
RAW_CHAT_HISTORY_PERSISTED=NO
MODEL_INFERENCES_PER_CHAT=1
PET_DEEPSEEK_REQUESTS=0
```

Historical Recall is read-only: it does not create derived memory, mutate
source rows, update status, touch Dream/Reflection checkpoints, or append
`dream_log`. The prompt exposes short source labels and readable timestamps;
it does not claim compressed memory content is a persisted raw transcript.

## v0.3-C Pet-side Busy Gate Removal

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

The Pet layer now sends Chat, Reflection, and Dream requests directly to the
loopback Local Brain API. GPU utilization, VRAM, and owner-busy state no longer
produce a Pet-side admission decision; the API queue owns that scheduling.

## v0.3-D Phase 1 Memory Consolidation Foundation

v0.3-D Phase 1 is complete. The foundation adds Memory Provenance metadata,
Semantic Stability validation for derived memories, and an explicit Dream
Candidate layer before derived-memory approval. Existing `source_session`
values remain readable, and Assistant Response provenance cannot become a
confirmed memory.

```text
FINAL_STATUS=VC_AI_PET_V0_3_D_PHASE1
MEMORY_PROVENANCE=PASS
SEMANTIC_STABILITY=PASS
DREAM_CANDIDATE_LAYER=PASS
LEGACY_MEMORY_COMPATIBILITY=PASS
PRODUCTION_DB_MODIFIED=NO
DREAM_RERUN=NO
```

Deferred to v0.3-D Phase 2: Reflection Engine, Personality Emergence, and
Contradiction Detection. These require accumulated real long-term interaction
data before the next consolidation layer is developed.

## v0.3-E Phase 1 UI / Visual Presence

The overlay now owns a small, presentation-only visual state layer. It keeps
the existing persistent pet state unchanged and chooses exactly one state in
this order: `dreaming`, `thinking`, `excited`, `happy`, `sleep`, `walk`, then
`idle`. Dream status is a read-only report of the actual `DreamEngine`
in-flight flag; it is never inferred from clock time or written to storage.

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE1_PASS
VERSION=0.3.0-alpha.4
VISUAL_STATE_PRIORITY=CENTRALIZED
VISUAL_IDLE=PASS
VISUAL_THINKING=PASS
VISUAL_SLEEP=PASS
VISUAL_DREAMING=PASS
VISUAL_HAPPY=PASS
VISUAL_EXCITED=PASS
VISUAL_WALK=PASS
ENV_NIGHT_TIME=PASS
ENV_LONG_NO_INTERACTION=PASS
ENV_CHAT_PENDING=PASS
ENV_DREAM_RUNNING=PASS
ENV_OWNER_WORKING=PASS
ENVIRONMENT_CONTENT_READS=NONE
OVERLAY_INTERACTION_TEST=PASS
CLIENT_BUNDLE_VERIFY=PASS
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
PRODUCTION_DB_MODIFIED=NO
PRODUCTION_DREAM_RERUN=NO
```

`ownerWorking` is deliberately only a weak UI label: long pet inactivity,
daytime, and a visible DSH page. It does not inspect titles, content,
clipboard, files, or any other user data, and it cannot affect Local Brain or
Dream decisions. `readPresence` is an additive package-private RPC for the
browser overlay; it exposes only boolean `chatPending` and `dreamRunning`
flags plus the UI-only visual configuration.

## v0.3-E Phase 2 — Emotion & Living Interaction Layer

The browser overlay now keeps a momentary emotion runtime in React memory. It
uses only owner interactions, elapsed time, the read-only Dream in-flight flag,
and the existing attachment value as an initial/refresh hint. The runtime is
never written to `pet-memory.db`, `state.json`, localStorage, the Local Brain,
or conversation/memory paths.

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE2_PASS
EMOTION_RUNTIME=PASS
CLICK_FEEDBACK=PASS
DOUBLE_CLICK_FEEDBACK=PASS
LONG_PRESS_FEEDBACK=PASS
INTERACTION_BURST=PASS
WAITING_STATE=PASS
IDLE_RANDOM_ACTION=PASS
DREAM_VISUAL_ENHANCEMENT=PASS
VISUAL_IDLE=PASS
VISUAL_HAPPY=PASS
VISUAL_EXCITED=PASS
VISUAL_RELAXED=PASS
VISUAL_WAITING=PASS
VISUAL_CONFUSED=PASS
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
PRODUCTION_DB_MODIFIED=NO
MEMORY_SCHEMA_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
```

The 30-second burst detector is bounded to happy (1–5), excited (6–15), and
curious/confused (>15) feedback; it never emits a negative owner judgement.
Long press is a relaxed visual-only interaction and does not create an extra
host persistence event. Waiting is silent and appears only when chat is closed
after a recent interaction. Idle actions are weighted and scheduled by one
low-frequency timeout in the browser.

## v0.3-E Phase 3-A LAN Companion UI

```text
FINAL_STATUS=VC_AI_PET_V0_3_E_PHASE3A_PASS
LAN_SERVER=PASS
MOBILE_UI=PASS
STATE_SYNC=PASS
CHAT_SYNC=PASS
CLICK_SYNC=PASS
DOUBLE_CLICK_SYNC=PASS
LONG_PRESS_SYNC=PASS
EMOTION_SYNC=PASS
DREAM_SYNC=PASS
LOCAL_ONLY=PASS
PUBLIC_NETWORK_BIND=NO
CHAT_BUBBLE_REGRESSION=PASS
CLICK_REGRESSION=PASS
DOUBLE_CLICK_REGRESSION=PASS
DRAG_REGRESSION=PASS
EMOTION_RUNTIME_REGRESSION=PASS
LUNA_REGRESSION=PASS
TOOL_FOLD_REGRESSION=PASS
MEMORY_SCHEMA_CHANGED=NO
LOCAL_BRAIN_API_CHANGED=NO
```

The host-owned LAN listener uses `0.0.0.0:17870` only to accept devices on the
local network. It rejects every client except localhost and private IPv4
(`10/8`, `172.16/12`, `192.168/16`). The mobile page polls every 1.5 seconds;
it calls the same runtime interaction and chat methods as the desktop overlay.

## Current DSH background Reflection loop hotfix

The DSH-hosted Pet Reflection request was exhausting its 500-token completion
budget with the Relay's low-thinking profile (`finish_reason=length`), leaving
the reflection checkpoint unchanged and causing the 10-second host tick to
retry. Reflection now uses the existing `off` profile so the bounded budget is
reserved for its structured JSON; normal Chat remains `off`, and Deep Dream
remains `medium`. Both idle DSH Web instances were reloaded from the working
tree without restarting llama or Relay. The LAN/state surfaces remained
available and no Relay activity was observed during the post-reload window.

```text
REFLECTION_THINKING=OFF
NORMAL_CHAT_CONTRACT=UNCHANGED
DEEP_DREAM_CONTRACT=UNCHANGED
DSH_3082_RELOADED=PASS
DSH_3080_RELOADED=PASS
LOCAL_BRAIN_RELAY_RESTARTED=NO
LLAMA_RESTARTED=NO
POST_RELOAD_PERIODIC_REQUESTS=0_OBSERVED
```

## v0.3-E Current Time Context Hotfix

The Local Brain now receives one ephemeral snapshot of the real local system
clock on every chat reply. The snapshot contains `currentDate`, `currentTime`,
`weekday`, `dayPeriod`, and `season`; it is system environment context rather
than memory or user-provided content. The same provider is reused by the
presentation layer's night-time check. It is not written to `pet-memory.db`
and is not passed into Dream or Historical Recall input builders.

```text
FINAL_STATUS=VC_AI_PET_TIME_CONTEXT_PASS
TIME_PROVIDER=PASS
LOCAL_BRAIN_TIME_CONTEXT=PASS
MEMORY_SCHEMA_CHANGED=NO
DREAM_CHANGED=NO
```

## Vision Input v0.1 — LAN owner-triggered image chat

The LAN companion chat now accepts one owner-selected JPEG, PNG, or WebP per
turn. The browser downsizes images to a maximum 1920px long edge and exports
WebP (or JPEG fallback) before sending the additive `image.dataUrl` field to
the existing `/api/pet/chat` route. The server accepts only approved base64
image data URLs, keeps the larger body limit scoped to Chat, and never exposes
filesystem paths or remote URLs.

Vision turns use the existing Local Brain API v1 multimodal message contract
and exactly one inference. The image is request-only: Recent Conversation
stores only `[主人发送了一张图片]` plus any actual owner text, and the
MemoryGate is skipped for vision turns so neither image bytes nor visual
inferences become Pet memory.

```text
FINAL_STATUS=VC_AI_PET_VISION_INPUT_V0_1_AUTOMATED_PASS
LAN_IMAGE_PICKER=PASS
IMAGE_PREVIEW=PASS
IMAGE_REMOVE=PASS
IMAGE_ONLY_CHAT=PASS
IMAGE_PLUS_TEXT_CHAT=PASS
LOCAL_BRAIN_VISION=PASS
MODEL_INFERENCES_PER_CHAT=1
SUPPORTED_IMAGE_TYPES=JPEG,PNG,WEBP
MAX_IMAGES_PER_TURN=1
IMAGE_LONG_EDGE_MAX=1920
RAW_IMAGE_PERSISTED=NO
IMAGE_BASE64_IN_RECENT_CONVERSATION=NO
IMAGE_BASE64_IN_PET_MEMORY=NO
VISION_DERIVED_MEMORY_WRITE=NO
TEXT_CHAT_REGRESSION=PASS
DREAM_REGRESSION=PASS
HISTORICAL_RECALL_REGRESSION=PASS
UI_PRESENCE_REGRESSION=PASS
EMOTION_REGRESSION=PASS
LAN_COMPANION_REGRESSION=PASS
MANUAL_REAL_PHOTO_ACCEPTANCE=PENDING
```

## Vision v0.1 — real-image E2E diagnosis

The first real-image failure was isolated to a stale DSH Web host: the
running host had started before the Vision commits, so its already-loaded LAN
handler still rejected an image-only chat as `invalid-message`. Static mobile
assets were current because they are read per request, which made the stale
handler easy to miss. The DSH host was reloaded to the current `d77a242`
working tree without restarting Relay or llama.

A generated 128×128 red/blue PNG (390 bytes) then passed the complete LAN →
PetRuntime → Local Brain path. A direct Local Brain v1 probe passed both
without `response_format` and with the current Pet JSON response format, so no
Vision compatibility workaround or lower-layer change was needed. Vision
turns retain one inference and skip MemoryGate; image bytes remain request
only. Internal failure logging now records only code, retryable, and request ID
without returning or logging image/prompt/response content.

```text
REAL_IMAGE_E2E=PASS_FOR_CURRENT_RELOADED_HOST
ROOT_CAUSE_LAYER=STALE_DSH_HOST_NOT_RELOADED
ROOT_CAUSE=RUNNING_HOST_PREDATED_VISION_COMMIT
LAN_TINY_PNG=PASS
PET_RUNTIME_TINY_PNG=PASS
LOCAL_BRAIN_MINIMAL_VISION=PASS
VISION_NO_RESPONSE_FORMAT=PASS
VISION_WITH_RESPONSE_FORMAT=PASS
LOCAL_BRAIN_VISION_REGRESSION=NO
MOBILE_REAL_PHOTO=PENDING_USER_RETEST
INTERNAL_ERROR_CODE_LOGGING=PASS
IMAGE_CONTENT_LOGGED=NO
PRODUCTION_DB_MODIFIED=NO
DREAM_RERUN=NO
```

## v0.3-F — Conversation Persistence

The LAN companion now has an independent Conversation Persistence Layer. The
store is separate from `pet-memory.db`, stores short-term message records and
local date-partitioned image assets, and is not read by Memory, Historical
Recall, Dream, Reflection, Local Brain, or Emotion Runtime. The mobile page
loads the latest 50 records on startup and renders persisted user images from
thumbnail URLs after a browser refresh.

```text
FINAL_STATUS=VC_AI_PET_CONVERSATION_PERSISTENCE_PASS
VERSION=0.3.0-alpha.5
CONVERSATION_STORE=conversation-store.json
CONVERSATION_ASSETS=conversation-assets/YYYY/MM/DD
CONVERSATION_HISTORY_LIMIT=50
CONVERSATION_IMAGE_MAX_EDGE=1920
CONVERSATION_THUMBNAIL_MAX_EDGE=256
CONVERSATION_BASE64_PERSISTED=NO
HISTORY_API=/api/pet/history
IMAGE_UPLOAD_API=/api/pet/upload
USER_RECORD_BEFORE_LOCAL_BRAIN=PASS
REFRESH_HISTORY=PASS
IMAGE_THUMBNAIL_RENDERING=PASS
MEMORY=UNCHANGED
DREAM=UNCHANGED
HISTORICAL_RECALL=UNCHANGED
LOCAL_BRAIN_API=UNCHANGED
EMOTION_RUNTIME=UNCHANGED
```

## v0.3-F — Mobile App Shell / Chat & Play Split

The LAN companion mobile page now uses a full-screen two-view app shell. Play
and Chat are mutually exclusive views under one global header, with a normal
content bottom navigation. The selected tab is restored from
`vc-ai-pet-mobile-active-tab-v1`; missing or invalid values default to Play.
Tab changes only update DOM visibility and selection state, so chat drafts,
selected image previews, message scroll position, and pet presentation state
remain intact. Chat fills the active area and assigns scrolling only to the
message list; the old 220px message cap is removed.

```text
FINAL_STATUS=VC_AI_PET_MOBILE_APP_SHELL_PASS
APP_SHELL=PASS
PLAY_VIEW=PASS
CHAT_VIEW=PASS
BOTTOM_NAV=PASS
DEFAULT_TAB=PLAY
TAB_PERSISTENCE=PASS
TAB_SWITCH_NO_RELOAD=PASS
BODY_SCROLL=LOCKED
PLAY_VIEW_NORMAL_SCROLL=NO
CHAT_VIEW_SCROLL_OWNER=MESSAGES_ONLY
CHAT_COMPOSER_FIXED_IN_VIEW=PASS
IMAGE_PREVIEW_PERSISTS_ACROSS_TAB_SWITCH=PASS
MOBILE_UI_CONTRACT=PASS
MOBILE_NARROW_VIEWPORT=PASS
WEB_UI_UPDATE_WITHOUT_APK_REINSTALL=PASS
ANDROID_NATIVE_CHANGED=NO
APK_REBUILT=NO
APK_REINSTALLED=NO
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
HISTORICAL_RECALL_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
CONVERSATION_STORE_CHANGED=NO
LAN_SERVER_CHANGED=NO
```

Production changes are limited to the three LAN mobile UI files. The
Conversation Persistence Layer, Memory, Dream, Historical Recall, Local Brain
API, Emotion Runtime, and Android Companion remain unchanged.

## v0.3-F — Mobile UI Polish Phase 2

The LAN companion mobile UI now hides the bottom navigation while the Chat
composer has focus on a mobile viewport. VisualViewport resize/scroll events,
window resize, focus lifecycle, and a conservative legacy-WebView fallback are
coalesced into a `keyboard-open` root state. During that state the navigation
releases its layout height and the shell tracks the visible viewport without
allowing body scrolling.

Play has a compact stage/actions composition with an explicit hint, a larger
centered sprite, closer status metrics, and a 6–8% bottom breathing buffer.
Chat messages retain the existing article data flow while rendering through a
shared `.message-bubble`; owner and pet bubbles have distinct warm tones and
images remain inside the same message block as accompanying text.

```text
FINAL_STATUS=VC_AI_PET_MOBILE_UI_POLISH_PHASE2_PASS
KEYBOARD_NAV_HIDE=PASS
PLAY_LAYOUT_REBALANCE=PASS
CHAT_BUBBLES=PASS
CHAT_COMPOSER_STABLE=PASS
BOTTOM_NAV_POLISH=PASS
IMAGE_PREVIEW_UI=PASS
TEXT_CHAT_REGRESSION=PASS
IMAGE_CHAT_REGRESSION=PASS
PLAY_INTERACTION_REGRESSION=PASS
TAB_PERSISTENCE=PASS
APK_REBUILD_REQUIRED=NO
ANDROID_NATIVE_CHANGED=NO
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
RELAY_CHANGED=NO
CONVERSATION_STORE_CHANGED=NO
LAN_SERVER_CHANGED=NO
```

## v0.1 Android Companion

The Android Companion is a thin native shell around the existing LAN Companion
Web UI. It adds no Pet business implementation and does not package HTML, CSS,
JavaScript, conversation data, or model code into the APK. The host is editable
and only the normalized `host:port` value is stored in Android
`SharedPreferences` under `pet_host`.

```text
ANDROID_COMPANION_STATUS=IMPLEMENTED_PENDING_USER_DEVICE_ACCEPTANCE
ANDROID_COMPANION_BRANCH=feat/android-companion
CHANGED_FILES=android-companion/,PROJECT_STATE.md
ANDROID_PROJECT=PASS
GRADLE_WRAPPER=PASS
DEBUG_APK_BUILD=PASS
ANDROID_LINT=PASS_WITH_EXPECTED_WARNINGS
WEBVIEW=PASS
JAVASCRIPT=PASS
DOM_STORAGE=PASS
FILE_ACCESS_DISABLED=PASS
JAVASCRIPT_BRIDGE=NONE
LAN_HOST_CONFIG=PASS
LAN_CLEAR_TEXT=PASS
PUBLIC_NAVIGATION_BLOCKED=PASS
IMMERSIVE_FULLSCREEN=PASS
PORTRAIT_MODE=PASS
BACK_NAVIGATION=PASS
ANDROID_FILE_CHOOSER=IMPLEMENTED_PENDING_USER_DEVICE_ACCEPTANCE
ANDROID_PERMISSIONS=INTERNET
ADB_DEVICE=NOT_CONNECTED
APK_PATH=android-companion/dist/李花花-Android-Companion-v0.1-debug.apk
APK_SIZE_BYTES=2545700
PET_CORE_CHANGED=NO
MEMORY_CHANGED=NO
DREAM_CHANGED=NO
LOCAL_BRAIN_CHANGED=NO
WEB_UI_UPDATE_WITHOUT_APK_REINSTALL=PENDING_USER_DEVICE_ACCEPTANCE
TEXT_CHAT=PENDING_USER_DEVICE_ACCEPTANCE
VISION_REPLY=PENDING_USER_DEVICE_ACCEPTANCE
CONVERSATION_HISTORY=PENDING_USER_DEVICE_ACCEPTANCE
IMAGE_HISTORY=PENDING_USER_DEVICE_ACCEPTANCE
COMMIT=RECORDED_IN_GIT
REMOTE_HEAD=PUSHED_TO_ORIGIN
PUSH=PASS
```
