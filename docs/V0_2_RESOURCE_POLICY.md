# 李花花 v0.2 Resource-Aware Brain Policy

## Single model only

李花花只有一个本地模型：

`Qwen3.5-4B Q4_K_M`

不设置备用模型，不下载第二份 GGUF，也不保留重复模型副本。

## Why the brain yields to the owner

The local brain is optional companionship workload.
The owner's foreground GPU workload always has priority.

Before loading the model, the plugin reads only fixed NVIDIA telemetry:

- GPU utilization
- VRAM free / used / total

It does not inspect process names, window titles, game names, files, browser state, or user content.

Default v0.2 thresholds:

```text
GPU utilization >= 55% -> OWNER_BUSY
free VRAM < 6144 MiB   -> OWNER_BUSY
GPU telemetry unavailable -> OWNER_BUSY (fail closed)
```

When OWNER_BUSY before model start:

- do not launch llama.cpp
- do not load GGUF
- do not call DeepSeek

When llama.cpp is already running and the owner becomes busy:

- if no pet inference is currently active, stop the pet-owned llama.cpp process
- release its model/VRAM
- never kill unrelated processes
- never interrupt an active pet inference halfway merely because one sample crosses the threshold

## Busy episode record

Store compact runtime state only:

`sandbox/runtime/brain-availability.json`

Record transitions/episodes:

- ownerBusy
- busySince
- busyEpisodeCount
- lastBusyDurationMs
- last GPU sample

Do not add one long-term pet-memory row per telemetry poll.

A later UI may show a deterministic no-model line:

`主人好像在忙……为什么不陪花花玩呀？`

This line is intentionally generated without an LLM so the pet can react while its brain is asleep.
