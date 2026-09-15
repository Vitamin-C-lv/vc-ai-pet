import assert from 'node:assert/strict'
import { mapPetStateToBodyContract } from '../src/contract.mjs'

const at = '2026-09-15T00:00:00.000Z'
const makeState = (visualState, extra = {}) => ({
  visualState,
  emotion: { happiness: 0.5, energy: 0.75 },
  dream: false,
  sprite: 'ignored.png',
  ...extra,
})

const mappingCases = [
  ['idle', 'idle', 'blink', 'idle', false, false],
  ['waiting', 'idle', 'blink', 'idle', false, false],
  ['relaxed', 'relaxed', 'stretch', 'idle', false, false],
  ['happy', 'happy', 'bounce', 'wag', false, false],
  ['excited', 'happy', 'bounce', 'wag', false, false],
  ['thinking', 'thinking', 'thinking', 'look', false, true],
  ['curious', 'curious', 'look', 'look', false, false],
  ['confused', 'confused', 'look', 'look', false, false],
  ['sleep', 'sleep', 'zzz', 'sleep', false, false],
  ['dreaming', 'dreaming', 'dream', 'sleep', true, false],
]

for (const [visualState, expression, animation, actionCue, dream, thinking] of mappingCases) {
  const contract = mapPetStateToBodyContract(makeState(visualState), { reachable: true, observedAt: at, stateAgeMs: 0 })
  assert.equal(contract.schemaVersion, 1, visualState)
  assert.equal(contract.online, true, visualState)
  assert.equal(contract.reachable, true, visualState)
  assert.equal(contract.pet.name, '李花花', visualState)
  assert.equal(contract.presentation.visualState, visualState, visualState)
  assert.equal(contract.presentation.expression, expression, visualState)
  assert.equal(contract.presentation.animation, animation, visualState)
  assert.equal(contract.presentation.actionCue, actionCue, visualState)
  assert.equal(contract.presentation.dream, dream, visualState)
  assert.equal(contract.presentation.sleeping, dream || visualState === 'sleep', visualState)
  assert.equal(contract.presentation.thinking, thinking, visualState)
  assert.equal(contract.presentation.speaking, false, visualState)
  assert.equal(contract.presentation.speechText, null, visualState)
}

assert.equal(mapPetStateToBodyContract(makeState('idle', { dream: true }), { observedAt: at }).presentation.expression, 'dreaming')

const unknown = mapPetStateToBodyContract(makeState('custom-state'), { observedAt: at })
assert.equal(unknown.presentation.visualState, 'custom-state')
assert.equal(unknown.presentation.expression, 'idle')
assert.equal(unknown.presentation.animation, 'blink')
assert.equal(unknown.presentation.actionCue, 'idle')

for (const [key, value, expected] of [
  ['happiness', Number.NaN, null],
  ['happiness', '0.5', null],
  ['energy', Number.POSITIVE_INFINITY, null],
  ['happiness', -2, 0],
  ['happiness', 2, 1],
  ['energy', -1, 0],
  ['energy', 4, 1],
]) {
  const contract = mapPetStateToBodyContract(makeState('idle', { emotion: { happiness: 0.3, energy: 0.4, [key]: value } }), { observedAt: at })
  assert.equal(contract.presentation.emotion[key], expected, `${key}=${String(value)}`)
}

const offline = mapPetStateToBodyContract(null, { reachable: false, observedAt: at })
assert.equal(offline.online, false)
assert.equal(offline.reachable, false)
assert.equal(offline.presentation.visualState, 'offline')
assert.equal(offline.presentation.expression, 'offline')
assert.equal(offline.presentation.animation, 'offline')
assert.equal(offline.presentation.emotion.happiness, null)
assert.equal(offline.presentation.emotion.energy, null)
assert.equal(offline.source.stateAgeMs, null)

const cached = mapPetStateToBodyContract(makeState('relaxed'), { reachable: false, observedAt: at, stateAgeMs: 3000 })
assert.equal(cached.online, true)
assert.equal(cached.reachable, false)
assert.equal(cached.source.stateAgeMs, 3000)

console.log('BRIDGE_CONTRACT_TEST=PASS')
