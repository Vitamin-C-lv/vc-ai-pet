# VC AI Pet — Long-term Project Memory

## Product idea
A tiny pixel Bernese Mountain Dog lives beside DeepSeek Harness like a child playing next to an adult working. It is a pet, not an assistant or agent.

## Permanent boundaries
- cannot operate the host computer;
- cannot use shell, DSH tools, Luna, browser control, keyboard/mouse control, or arbitrary files;
- may only touch its own sandbox/toybox through narrow pet-owned APIs;
- never consumes DeepSeek quota or conversation context;
- DSH may know that the pet exists, but work context is not sent to the pet;
- pet memory DB and DSH meow-memory DB are completely separate forever.

## Memory design
Reuse meow-memory CODE/algorithms, never its existing database. Pet gets its own seven-layer `pet-memory.db` inside its sandbox. Later Dream/Reflection, if added, must run on a local pet model only.

## v0.1
Body + life skeleton only: overlay, pixel Bernese assets, zero-model state machine, click/play interaction, independent sandbox, independent persistent memory. No local LLM/VLM yet.

## Character lock
The supplied pixel Bernese design is the v0.1 canonical identity. Do not redraw or reinterpret proportions/markings during integration.

## Current production baseline
- v0.2.0 with Local Brain API v1 at `http://127.0.0.1:17862`.
- v0.3-A adds Recent Conversation RAM continuity for the latest 12 successful turns.
- Pet memory DB and DSH memory DB remain permanently isolated.

## v0.3-B thought layers

- Micro Reflection and Deep Dream are separate Pet upper-layer consumers of the
  Local Brain API v1; neither enters the UI, DSH context, Luna, or DeepSeek.
- Raw evidence is limited to active `user/project/fact/lesson/topic` rows with
  `importance >= 2` and exact `source_session=vc-ai-pet`. Reflection and Dream
  derived rows use `vc-ai-pet:reflection` and `vc-ai-pet:dream` respectively and
  can be related history but never raw NEW evidence.
- The two windows are independent: `vc-ai-pet:reflection-window` and
  `vc-ai-pet:dream-window`. Consolidation is additive; source rows are never
  rewritten, deleted, archived, or marked stale.
- Reflection cannot write `soul`, `rules`, `project`, or personality claims.
  Deep Dream may write `soul` only with the gated first-person form, importance
  3, confidence at least 0.82, two distinct raw source IDs, and one current raw
  source. Chat remains unable to write `soul` or `rules`.
- Deep Dream runs only after the Pet is asleep for at least 15 minutes, at
  night (22:30-08:00) or after 45 minutes of continuous in-RAM availability
  during a daytime nap. The scheduler does not persist its availability or
  cooldown state and does not inspect host activity.
