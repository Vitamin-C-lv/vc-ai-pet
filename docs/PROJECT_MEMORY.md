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
