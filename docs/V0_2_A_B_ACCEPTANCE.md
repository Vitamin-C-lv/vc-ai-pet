# v0.2-A/B Acceptance

## A — Identity migration

PASS when:
- name = 李花花
- species = 狗
- breed = 伯恩山犬
- birthday = 2026-08-31
- existing bornAt preserved
- existing attachment preserved
- existing lifetimeInteractions preserved
- existing pet-memory.db preserved
- identity.json created/updated
- active soul states 李花花 + 伯恩山犬 + birthday
- exactly one birthday fact exists after repeated restart/migration

## B — Local Brain foundation

Primary model for v0.2:

- official upstream: `Qwen/Qwen3.5-4B`
- GGUF quant source: `unsloth/Qwen3.5-4B-GGUF`
- file: `Qwen3.5-4B-Q4_K_M.gguf`
- expected file size: about 2.74 GB

PASS when:
- `Qwen3.5-4B-Q4_K_M.gguf` exists under `/mnt/d/VC-AI-Pet/models/Qwen3.5-4B/`
- no equivalent GGUF under C:/WSL filesystem
- cache/temp paths resolve under D:
- a current llama.cpp with Qwen3.5 support starts bound to `127.0.0.1`
- model is text-only in v0.2; no mmproj passed/downloaded
- one local text completion succeeds
- DeepSeek request count caused by pet remains 0
- idle sleep is configured (`--sleep-idle-seconds 900`)
- v0.1 click regression remains PASS
- Luna and tool-fold remain unchanged

A/B does not yet require the DSH chat bubble. That is v0.2-C.
