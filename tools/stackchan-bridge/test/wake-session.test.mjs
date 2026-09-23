import assert from 'node:assert/strict'
import { classifyWakeTranscript, confirmWakeCandidate, isClearFollowUp, normalizeWakeText, stripWakePhrase } from '../src/wake-phrase.mjs'
import { WakeSession, WakeSessionState } from '../src/wake-session.mjs'

assert.equal(normalizeWakeText(' 花花，在吗！ '), '花花在吗')
assert.equal(confirmWakeCandidate('huahua', '花 花'), true)
assert.equal(confirmWakeCandidate('huahua_zaima', '花花，在吗'), true)
assert.equal(confirmWakeCandidate('huahua_zaima', '花花你好'), false)
assert.deepEqual(classifyWakeTranscript('花花'), { confirmed: true, normalized: '花花', wakeKind: 'huahua', query: '', wakeOnly: true })
assert.equal(classifyWakeTranscript('花花在吗看看我').wakeKind, 'huahua_zaima')
assert.equal(confirmWakeCandidate('huahua', '你好花花'), false)
assert.equal(stripWakePhrase('花花你好吗'), '你好吗')
assert.equal(stripWakePhrase('花花在吗看看这个'), '看看这个')
assert.equal(stripWakePhrase('花花，在吗'), '')
assert.equal(stripWakePhrase('普通句子'), '普通句子')
assert.equal(isClearFollowUp('那', 0.466424), false)
assert.equal(isClearFollowUp('看看我', 0.8), true)
assert.equal(isClearFollowUp('看看我', 0.5), false)

let now = 0
const transitions = []
const session = new WakeSession({ now: () => now, followUpMs: 9000, maxIdleMs: 30_000, onStateChange: (event) => transitions.push(event) })
assert.equal(session.state, WakeSessionState.IDLE)
assert.equal(session.beginCandidate(), true)
assert.equal(session.acceptWake('').accepted, true)
assert.equal(session.state, WakeSessionState.LISTENING)
now = 5000
assert.deepEqual(session.acceptFollowUp('看看我').query, '看看我')
assert.equal(session.state, WakeSessionState.THINKING)
session.markSpeaking(true)
assert.equal(session.state, WakeSessionState.SPEAKING)
session.markSpeaking(false)
assert.equal(session.state, WakeSessionState.IDLE)
now = 9000
assert.equal(session.acceptFollowUp('太晚了').accepted, false)
assert.equal(transitions.some(({ state }) => state === WakeSessionState.LISTENING), true)

now = 20_000
assert.equal(session.beginCandidate(), true)
assert.equal(session.acceptWake('').kind, 'wake-only')
assert.equal(session.prepareWakeAcknowledgment(), true)
session.markSpeaking(true)
assert.equal(session.state, WakeSessionState.SPEAKING)
now = 24_000
session.markSpeaking(false)
assert.equal(session.state, WakeSessionState.LISTENING)
now = 29_000
assert.equal(session.acceptFollowUp('你好').kind, 'follow-up')

console.log('LOCAL_WAKE_PHRASE_SESSION_TEST=PASS')
