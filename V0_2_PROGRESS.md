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

## Remaining v0.2-C/D work

- Add the DSH chat bubble and user text input.
- Add the intentionally deferred memory-write gate, Dream/Reflection design,
  and any later UI integration without crossing the v0.1 isolation boundary.
- Keep screenshot vision/mmproj, Luna awareness, work-state awareness, TTS,
  ASR, and computer-control tools out of the v0.2-A/B scope.
