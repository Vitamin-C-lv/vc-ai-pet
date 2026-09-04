# Pet -> Local Brain API v1 migration

## Purpose

Pet no longer owns a llama.cpp process or any model/runtime path. Its brain code
becomes a caller of the shared Local Brain API v1 on loopback.

## Boundary after migration

```text
Pet identity / state / memory / prompt / memory gate
                    |
                    v
          LocalBrainClient (thin)
                    |
          http://127.0.0.1:17862
                    |
             Local Brain API v1
                    |
        context/queue/recovery/model
```

Pet still owns:

- identity/personality/state
- memory recall and write gate
- prompt construction
- the decision to defer a Pet turn when owner GPU utilization is busy
- response parsing

Pet no longer owns or knows:

- llama-server lifecycle
- model/GGUF/mmproj paths
- D:/VC-AI-Pet runtime/cache/temp locations for the model
- backend model alias
- 17861
- n_ctx/context tiers
- GPU layers/KV cache
- Local Brain queue/recovery mechanics

## Resource gate semantic change

The old `minFreeVramMiB=6144` gate was designed for a Pet-owned model that had
not been loaded yet. It is invalid once Local Brain is a shared already-loaded
service because Local Brain's own allocation makes free VRAM low.

Pet therefore keeps only an owner-busy utilization gate. Effective
`minFreeVramMiB` becomes `0`, and Pet never stops the shared model.

This is a Pet behavior policy, not Local Brain scheduling.

## API request

Pet sends no `model`, `chat_template_kwargs`, n_ctx, path, or lifecycle fields.
The request uses the centralized Pet reasoning profile: ordinary text chat is
`low`, Vision chat is `medium`, Deep Dream is `high`, and Reflection remains
`off`. The selected value is sent only through the public logical contract:

```json
{
  "messages": [...],
  "stream": false,
  "reasoning_effort": "low",
  "temperature": 0.72,
  "top_p": 0.9,
  "max_tokens": 256,
  "response_format": {...}
}
```

`max_tokens=256` remains a Pet business-level short-response limit, not a
physical-context setting.

Successful interactive chat responses also carry additive, RAM-only UI
telemetry under `reasoning`:

```json
{
  "reply": "...",
  "reasoning": {
    "effort": "low",
    "durationMs": 2784
  }
}
```

`durationMs` is measured around the Local Brain request and bounded queue retry;
it is not conversation content, Memory data, or hidden reasoning text.

## Error behavior

Retryable Local Brain failures are surfaced to the Pet UI as temporarily
unavailable. Pet never reacts by restarting, killing, reconfiguring, or probing
the physical model.

Non-retryable malformed response/contract failures remain loud developer
errors.
