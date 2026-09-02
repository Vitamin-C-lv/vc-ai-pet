import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { frameDelayForVisualState, nextVisualFrame, spriteForAnimation } from '../src/client/pet-animation.js'
import { createPetEnvironment, isNightTime } from '../src/client/pet-environment.js'
import { PET_SPRITE_MAP, spriteForVisualState } from '../src/client/pet-sprite-map.js'
import {
  DEFAULT_PET_VISUAL_CONFIG,
  PET_VISUAL_STATES,
  normalizePetVisualConfig,
  resolvePetVisualState,
} from '../src/client/pet-visual-state.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { apply as applyHostPlugin } from '../src/dsh/host-plugin.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const day = new Date(2026, 8, 3, 12, 0, 0).getTime()
const night = new Date(2026, 8, 3, 23, 30, 0).getTime()
const config = normalizePetVisualConfig({
  nightStartHour: 23,
  nightEndHour: 6,
  inactivitySleepMinutes: 30,
  happyDurationMs: 2_500,
  excitedDurationMs: 1_700,
  thinkingPulseMs: 700,
  walkFrameMs: 150,
  zzzEnabled: true,
  ambientMoveEnabled: true,
})

assert.deepEqual(Object.keys(config), Object.keys(DEFAULT_PET_VISUAL_CONFIG))
assert.equal(normalizePetVisualConfig({ walkFrameMs: 5 }).walkFrameMs, DEFAULT_PET_VISUAL_CONFIG.walkFrameMs)
assert.equal(normalizePetVisualConfig({ zzzEnabled: false }).zzzEnabled, false)

assert.equal(isNightTime(night, config), true)
assert.equal(isNightTime(day, config), false)

const inactiveDayEnvironment = createPetEnvironment({
  petState: { lastInteractionAt: day - 31 * 60_000 },
  visibilityState: 'visible',
  config,
  now: day,
})
assert.deepEqual(inactiveDayEnvironment, {
  nightTime: false,
  longTimeNoInteraction: true,
  chatPending: false,
  dreamRunning: false,
  ownerWorking: true,
})

const inactiveNightEnvironment = createPetEnvironment({
  petState: { lastInteractionAt: night - 31 * 60_000 },
  visibilityState: 'hidden',
  config,
  now: night,
})
assert.equal(inactiveNightEnvironment.nightTime, true)
assert.equal(inactiveNightEnvironment.longTimeNoInteraction, true)
assert.equal(inactiveNightEnvironment.ownerWorking, false)

const baseState = { current: 'walk', lastInteractionAt: day }
assert.equal(resolvePetVisualState({
  petState: baseState,
  environment: { ...inactiveDayEnvironment, dreamRunning: true, chatPending: true },
  feedback: { kind: 'excited', until: day + 1_000 },
  config,
  now: day,
}), 'dreaming')
assert.equal(resolvePetVisualState({
  petState: baseState,
  environment: { ...inactiveDayEnvironment, chatPending: true },
  feedback: { kind: 'excited', until: day + 1_000 },
  config,
  now: day,
}), 'thinking')
assert.equal(resolvePetVisualState({
  petState: { current: 'happy', lastInteractionAt: day },
  environment: inactiveNightEnvironment,
  feedback: { kind: 'excited', until: day + 1_000 },
  config,
  now: day,
}), 'excited')
assert.equal(resolvePetVisualState({
  petState: { current: 'walk', lastInteractionAt: day },
  environment: inactiveNightEnvironment,
  feedback: { kind: 'happy', until: day + 1_000 },
  config,
  now: day,
}), 'happy')
assert.equal(resolvePetVisualState({
  petState: { current: 'walk', lastInteractionAt: night - 31 * 60_000 },
  environment: inactiveNightEnvironment,
  config,
  now: night,
}), 'sleep')
assert.equal(resolvePetVisualState({
  petState: { current: 'walk', lastInteractionAt: day },
  environment: { nightTime: false, longTimeNoInteraction: false, ownerWorking: false },
  config,
  now: day,
}), 'walk')
assert.equal(resolvePetVisualState({
  petState: { current: 'idle', lastInteractionAt: day },
  environment: { nightTime: false, longTimeNoInteraction: false, ownerWorking: false },
  config,
  now: day,
}), 'idle')
assert.equal(resolvePetVisualState({
  petState: { current: 'happy', lastInteractionAt: day },
  environment: { nightTime: false, longTimeNoInteraction: false, ownerWorking: false },
  config,
  now: day + config.happyDurationMs + 1,
}), 'idle')

assert.deepEqual(Object.keys(PET_SPRITE_MAP).sort(), [...PET_VISUAL_STATES].sort())
for (const visualState of PET_VISUAL_STATES) {
  const frames = PET_SPRITE_MAP[visualState]
  assert.ok(Array.isArray(frames) && frames.length > 0, `${visualState} has mapped frames`)
  for (const filename of frames) {
    assert.equal(existsSync(join(root, 'assets', 'runtime', filename)), true, `${visualState} maps shipped asset ${filename}`)
  }
  assert.equal(spriteForVisualState(visualState, 0), frames[0])
}
assert.equal(PET_SPRITE_MAP.walk.length, 6)
assert.equal(spriteForVisualState('walk', 6), PET_SPRITE_MAP.walk[0])
assert.equal(spriteForAnimation('thinking', 1), PET_SPRITE_MAP.thinking[1])
assert.equal(nextVisualFrame(59), 0)
assert.equal(frameDelayForVisualState('walk', config), config.walkFrameMs)
assert.equal(frameDelayForVisualState('thinking', config), config.thinkingPulseMs)

const runtime = new PetRuntime({ sandboxRoot: join(root, '.ui-presence-test-unused') })
runtime.chatInFlight = 1
runtime.dreamEngine = { isInFlight: () => true }
assert.deepEqual(runtime.presenceSnapshot(), { chatPending: true, dreamRunning: true })
runtime.dreamEngine = { isInFlight: () => false }
assert.deepEqual(runtime.presenceSnapshot(), { chatPending: true, dreamRunning: false })
runtime.close()

const hostSandbox = await mkdtemp(join(tmpdir(), 'vc-ai-pet-ui-presence-'))
const cleanups = []
let rpcHandler = null
const hostContext = {
  logger: { info() {}, warn() {} },
  get() { return null },
  inject(_dependencies, callback) {
    callback({
      connection: {
        rpc: {
          handle(_path, handler) { rpcHandler = handler },
        },
      },
    })
  },
  effect(callback) {
    cleanups.push(callback())
  },
}

try {
  applyHostPlugin(hostContext, {
    sandboxRoot: hostSandbox,
    petVisual: { nightStartHour: 21, zzzEnabled: false },
  })
  assert.equal(typeof rpcHandler, 'function')
  const presenceResponse = await rpcHandler('readPresence', { args: {} })
  assert.equal(presenceResponse.ok, true)
  assert.deepEqual(presenceResponse.value, {
    chatPending: false,
    dreamRunning: false,
    visualConfig: normalizePetVisualConfig({ nightStartHour: 21, zzzEnabled: false }),
  })
  assert.equal((await rpcHandler('readPresence', { args: { unexpected: true } })).ok, false)
} finally {
  for (const cleanup of cleanups.reverse()) cleanup?.()
  await rm(hostSandbox, { recursive: true, force: true })
}

console.log('VC_AI_PET_V0_3_UI_PRESENCE=PASS')
