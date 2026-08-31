# 李花花 v0.2-D Memory Gate

## Principle

The model may **propose** at most one memory candidate per chat turn.

Only deterministic code may write `pet-memory.db`.

```text
Qwen3.5-4B
  -> visible reply
  -> optional memory candidate
       |
       v
  MemoryGate
       |
       +-- allowed level?
       +-- importance >= 2?
       +-- confidence >= 0.72?
       +-- evidence exists verbatim in current user message?
       +-- user did not opt out?
       +-- best-effort equivalent active-memory check
       |
       v
  PetMemory.rememberCandidate()
```

## One inference only

v0.2-D must not add a second model call after every chat.

The same local Qwen response contains:
- `reply`
- `memory`

llama.cpp structured output constrains the shape.

The browser never sees the raw candidate/evidence.

## Writable levels

Allowed:
- user
- project
- fact
- lesson
- topic

Never model-write:
- soul
- rules

Identity/rules remain code-owned.

## Do not store

- raw chat transcript
- greetings
- ordinary petting/play chatter
- temporary mood
- one-off commands
- transient short schedules
- passwords
- tokens
- credentials
- inferred facts not explicitly supported by the current user message

## Deduplication and raw history

v0.2 uses conservative exact / near-exact canonical-text dedupe to prevent
obvious repeat spam. It is best-effort: semantically related but materially
different model candidates may both remain active.

`RAW_MEMORY_HISTORY_POLICY=PRESERVE`: accepted historical memory rows are not
rewritten, archived, superseded, or physically deleted by the gate. A future
Dream/Reflection phase may add derived summaries or consolidated knowledge, but
must preserve the source rows for historical recall. Raw memory history does
not mean raw chat transcripts; the transient chat transcript remains outside
`pet-memory.db`.

## Explicit opt-out

If the current user message says not to remember/save it, code rejects the candidate even if the model proposes one.

## v0.2 final boundary

Dream, Reflection, recent conversation context, 8192-context experiments,
historical-recall mode, vision/mmproj, TTS/ASR, Luna awareness, DSH
work-context awareness, and computer-control remain outside v0.2.
