import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_EMOTION_STATE,
  EMOTION_KEYS,
  IDLE_ACTIONS,
  INTERACTION_BURST_WINDOW_MS,
  advanceEmotion,
  applyInteractionEmotion,
  burstLevelForCount,
  chooseIdleAction,
  createEmotionState,
  interactionBurstCount,
  interactionBurstLevel,
  setDreaming,
  visualFeedbackForInteraction,
} from '../src/client/emotion-state.js'
import { createPetEnvironment } from '../src/client/pet-environment.js'
import { normalizePetVisualConfig, resolvePetVisualState } from '../src/client/pet-visual-state.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const now = 1_800_000_000_000
const base = createEmotionState({}, now)

assert.deepEqual(EMOTION_KEYS, ['happiness', 'energy', 'curiosity', 'comfort', 'attachment'])
assert.equal(base.happiness, DEFAULT_EMOTION_STATE.happiness)
assert.equal(base.energy, DEFAULT_EMOTION_STATE.energy)
assert.deepEqual(base.interactionTimes, [])
assert.equal(base.burstLevel, 'idle')

const pet = applyInteractionEmotion(base, 'pet', { now })
assert.equal(pet.happiness, 0.52)
assert.equal(pet.comfort, 0.62)
assert.equal(pet.attachment, 0.505)
assert.equal(pet.energy, base.energy)
assert.equal(pet.burstCount, 1)
assert.equal(pet.burstLevel, 'happy')
assert.equal(visualFeedbackForInteraction(pet, 'pet', now), 'happy')

const play = applyInteractionEmotion(base, 'play', { now })
assert.equal(play.happiness, 0.55)
assert.ok(Math.abs(play.energy - 0.68) < 1e-9)
assert.equal(play.attachment, 0.51)
assert.equal(visualFeedbackForInteraction(play, 'play', now), 'excited')

const relaxed = applyInteractionEmotion(base, 'long-press', { now })
assert.equal(relaxed.happiness, 0.53)
assert.ok(Math.abs(relaxed.comfort - 0.68) < 1e-9)
assert.equal(visualFeedbackForInteraction(relaxed, 'long-press', now), 'relaxed')

let burst = base
for (let index = 0; index < 5; index += 1) burst = applyInteractionEmotion(burst, 'pet', { now: now + index * 100 })
assert.equal(interactionBurstCount(burst, now + 400), 5)
assert.equal(interactionBurstLevel(burst, now + 400), 'happy')
assert.equal(visualFeedbackForInteraction(burst, 'pet', now + 400), 'happy')
burst = applyInteractionEmotion(burst, 'pet', { now: now + 500 })
assert.equal(burst.burstCount, 6)
assert.equal(burst.burstLevel, 'excited')
assert.equal(visualFeedbackForInteraction(burst, 'pet', now + 500), 'excited')
for (let index = 6; index < 16; index += 1) burst = applyInteractionEmotion(burst, 'pet', { now: now + index * 100 })
assert.equal(burst.burstCount, 16)
assert.equal(burstLevelForCount(16), 'confused')
assert.equal(interactionBurstLevel(burst, now + 1_500), 'confused')
assert.equal(visualFeedbackForInteraction(burst, 'pet', now + 1_500), 'confused')
assert.equal(interactionBurstCount(burst, now + 1_500 + INTERACTION_BURST_WINDOW_MS + 1), 0)
assert.equal(interactionBurstLevel(burst, now + 1_500 + INTERACTION_BURST_WINDOW_MS + 1), 'idle')

const decayed = advanceEmotion(pet, now + 60_000)
assert.ok(decayed.happiness < pet.happiness)
assert.ok(decayed.curiosity > pet.curiosity)
assert.equal(decayed.burstCount, 0)

assert.equal(setDreaming(base, true, now).dreaming, true)
assert.equal(setDreaming(base, false, now).dreaming, false)

const config = normalizePetVisualConfig({ waitingAfterInteractionMinutes: 30 })
const day = new Date(2026, 8, 3, 12, 0, 0).getTime()
const recentClosed = createPetEnvironment({
  petState: { lastInteractionAt: day - 5 * 60_000 },
  chatOpen: false,
  config,
  now: day,
})

assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: { ...recentClosed, dreamRunning: true, chatPending: true },
  config,
  now: day,
}), 'dreaming')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: { ...recentClosed, chatPending: true },
  config,
  now: day,
}), 'thinking')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: { ...recentClosed, chatOpen: true },
  feedback: { kind: 'excited', until: day + 2_000 },
  config,
  now: day,
}), 'excited')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: { ...recentClosed, chatOpen: true },
  feedback: { kind: 'happy', until: day + 2_000 },
  config,
  now: day,
}), 'happy')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: { ...recentClosed, chatOpen: true },
  feedback: { kind: 'relaxed', until: day + 2_000 },
  config,
  now: day,
}), 'relaxed')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: recentClosed,
  config,
  now: day,
}), 'waiting')
const expiredClosed = createPetEnvironment({
  petState: { lastInteractionAt: day - config.waitingAfterInteractionMinutes * 60_000 },
  chatOpen: false,
  config,
  now: day,
})
assert.equal(expiredClosed.recentInteraction, false)
assert.notEqual(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day - config.waitingAfterInteractionMinutes * 60_000 },
  environment: expiredClosed,
  config,
  now: day,
}), 'waiting')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: { ...recentClosed, chatOpen: true },
  emotion: burst,
  config,
  now: day,
}), 'confused')
assert.equal(resolvePetVisualState({
  petState: { current: 'curious', lastInteractionAt: day },
  environment: { ...recentClosed, chatOpen: true },
  config,
  now: day,
}), 'curious')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: null },
  environment: { nightTime: false, longTimeNoInteraction: false, chatOpen: true },
  config,
  now: day,
}), 'idle')

const orderedActions = IDLE_ACTIONS.map(({ kind }) => kind)
assert.deepEqual(orderedActions, ['blink', 'tail_move', 'stretch', 'yawn', 'look_around', 'change_pose'])
assert.equal(chooseIdleAction(0), 'blink')
assert.equal(chooseIdleAction(0.349), 'blink')
assert.equal(chooseIdleAction(0.35), 'tail_move')
assert.equal(chooseIdleAction(0.6), 'stretch')
assert.equal(chooseIdleAction(0.75), 'yawn')
assert.equal(chooseIdleAction(0.9), 'look_around')
assert.equal(chooseIdleAction(0.99), 'change_pose')

const emotionSource = await readFile(join(root, 'src/client/emotion-state.js'), 'utf8')
assert.doesNotMatch(emotionSource, /pet-memory|localStorage|userText|assistant|brain|fetch\(/i)

console.log('VC_AI_PET_V0_3_EMOTION_LAYER=PASS')
