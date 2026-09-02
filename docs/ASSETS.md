# Pixel Bernese Runtime Assets

All runtime frames are transparent PNG normalized to 192x192. Core: idle-front, idle-3q, blink-happy, curious, playbow, sit, walk-right-1..6, rest-awake, rest-curled, sleepy-sit, sleep-curled, sleep-side, stretch. Extra prepared: jump, beg, bark, surprised. Toys/icons: bone, food bowl, ball, paw, avatar. Original generated sheets remain in assets/source. Do not redesign the dog in v0.1.

## v0.3-E visual mapping

Runtime assets deliberately remain flat under `assets/runtime/`: the package
asset route serves a strict filename allowlist there. The visual state mapping
lives in `src/client/pet-sprite-map.js`, where idle uses idle/blink frames,
thinking uses curious/surprised, happy/excited use playbow/jump, sleep and
dreaming use the two sleep frames, and walk uses all six walk-right frames.
Moon, Zzz, question, heart, and sparkle are CSS overlay marks, not replacement
character artwork.

The five supplied source sheets are preserved as:

- `character-reference.png` — base poses and avatar
- `idle-emotions-sheet.png` — idle, happy, and curious emotes
- `interaction-sheet.png` — play, excited, and object poses
- `rest-sleep-sheet.png` — rest, sleep, and Dream source art
- `walk-cycle-sheet.png` — six-frame walk cycle
