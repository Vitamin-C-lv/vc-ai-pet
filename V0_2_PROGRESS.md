# 李花花 v0.2-A/B Progress

## Completed

- Migrated the sealed v0.1 pet identity to 李花花 (狗, 伯恩山犬), with birthday
  `2026-08-31` and birth event `VC_AI_PET_V0_1_PASS`.
- Preserved the existing `bornAt`, attachment, lifetime interaction count, and
  `~/.local/share/vc-ai-pet/sandbox/memory/pet-memory.db` in place. Repeated
  initialization is idempotent: it keeps one active 李花花 soul row and one
  birthday fact.
- Prepared D-only model, runtime, cache, and temporary directories at
  `/mnt/d/VC-AI-Pet`. The only configured pet GGUF is
  `Qwen3.5-4B-Q4_K_M.gguf` from `unsloth/Qwen3.5-4B-GGUF`, for upstream
  `Qwen/Qwen3.5-4B`.
- Installed llama.cpp `b10701` CUDA 12.4 Windows runtime on D: at
  `/mnt/d/VC-AI-Pet/runtime/llama.cpp/llama-server.exe`; its CLI supports
  `--sleep-idle-seconds`. It is configured for 127.0.0.1:17861, CUDA GPU
  layers, context 4096, one parallel request, and no mmproj.
- Downloaded the sole GGUF to
  `/mnt/d/VC-AI-Pet/models/Qwen3.5-4B/Qwen3.5-4B-Q4_K_M.gguf` at fixed
  revision `720bb031aae5488eae5d6a78768e6d826662b2ae`. Its verified size is
  `2740937888` bytes and SHA-256 is
  `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`.
- Completed one local, text-only completion for `花花，你叫什么名字？`; the
  response identified 李花花. No DeepSeek request, tool call, mmproj, or
  secondary GGUF was used.
- Validated the fixed NVIDIA telemetry gate. It defers before launch when
  busy, releases only the pet-owned idle child, and records busy episodes in
  `sandbox/runtime/brain-availability.json`; it does not inspect unrelated
  processes, windows, games, or foreground applications.
- Ran the v0.2 core smoke, sealed v0.1 core smoke, asset validation, and
  client build successfully.

## v0.2-C

- `CHAT_RPC=PASS`: the existing `/vc-ai-pet` RPC accepts only a bounded
  `userText` string and returns the existing LocalBrain result.
- `CHAT_BUBBLE=PASS` and `TEXT_INPUT=PASS`: the DSH overlay has a transient,
  bounded single-line chat bubble beside 李花花.
- `LOCAL_BRAIN_UI=PASS`: opening the bubble does not load the model; only a
  submitted message invokes LocalBrain.
- `NAME_UI_RECALL=PASS` and `BIRTHDAY_UI_RECALL=PASS` by manual UI acceptance.
- `AGE_CONTEXT_FIX=PASS`: every chat prompt now supplies the local calendar
  date, computed Gregorian age, and birthday flag. On 2026-08-31 the UI
  correctly described 李花花 as 0 years old and on her first birthday day.
- `OWNER_BUSY_UI_PATH=CONTRACT_PASS`: the bubble renders LocalBrain's safe
  deterministic pet line without exposing GPU telemetry.
- `OPEN_BUBBLE_MODEL_START=NO`; `CHAT_MEMORY_WRITE=DEFERRED_V0_2_D`; and
  `DEEPSEEK_USAGE=NONE`.
- `CLICK_REGRESSION=PASS`, `LUNA_REGRESSION=PASS`, and
  `TOOL_FOLD_REGRESSION=PASS` by manual UI acceptance.
- `UI_MANUAL_ACCEPTANCE=PASS`: pet visibility, click, double-click, drag,
  bubble placement, text input, response latency, birthday recall, and DSH
  input-area non-obstruction were accepted by the user.

## Remaining v0.2-D work

- Add the memory-write gate, important-conversation candidate extraction, and
  deduplication without persisting raw chat history.
- Complete final v0.2 closeout after the v0.2-D memory-write gate work.
- Keep Dream/Reflection, screenshot vision/mmproj, Luna awareness,
  work-state awareness, TTS, ASR, and computer-control tools deferred.
