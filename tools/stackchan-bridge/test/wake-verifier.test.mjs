import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { evaluateWakeRecognition } from '../src/wake-phrase.mjs'

const policy = { stage1MinScore: 0.8, stage2MinConfidence: 0.8 }

let decision = evaluateWakeRecognition({
  wakeText: '花花',
  wakeConfidence: 0.91,
  fullText: '',
  stage1Score: 0.89,
  ...policy,
})
assert.equal(decision.accepted, true)
assert.equal(decision.wakeOnly, true)
assert.equal(decision.wakeKind, 'huahua')
assert.equal(decision.query, '')

decision = evaluateWakeRecognition({
  wakeText: '花花在吗',
  wakeConfidence: 0.91,
  fullText: '',
  candidate: 'huahua',
  stage1Score: 0.89,
  stage1MinScore: 0.6,
  stage2MinConfidence: 0.6,
})
assert.equal(decision.accepted, true)
assert.equal(decision.wakeKind, 'huahua_zaima')
assert.equal(decision.wakeOnly, true)

decision = evaluateWakeRecognition({
  wakeText: '花花',
  wakeConfidence: 0.91,
  fullText: '你在干嘛',
  stage1Score: 0.89,
  ...policy,
})
assert.equal(decision.accepted, true)
assert.equal(decision.query, '你在干嘛')
assert.equal(decision.wakeOnly, false)

decision = evaluateWakeRecognition({
  wakeText: '',
  wakeConfidence: 0,
  fullText: '今天天气很好',
  stage1Score: 0.89,
  ...policy,
})
assert.equal(decision.accepted, false)
assert.equal(decision.reason, 'wake-verifier-rejected')

decision = evaluateWakeRecognition({
  wakeText: '花花',
  wakeConfidence: 0.79,
  fullText: '',
  stage1Score: 0.89,
  ...policy,
})
assert.equal(decision.accepted, false)
assert.equal(decision.reason, 'wake-confidence-rejected')

decision = evaluateWakeRecognition({
  wakeText: '花花',
  wakeConfidence: 0.91,
  fullText: '花花在吗看看我',
  stage1Score: 0.89,
  ...policy,
})
assert.equal(decision.accepted, true)
assert.equal(decision.wakeKind, 'huahua')
assert.equal(decision.query, '看看我')

const embodied = await readFile(new URL('../src/embodied.mjs', import.meta.url), 'utf8')
assert.match(embodied, /processMicrophone\(pcmPath\).*transcribeLocal\(pcmPath, 24000\)/s)
assert.doesNotMatch(embodied.slice(embodied.indexOf('async function processMicrophone'), embodied.indexOf('async function processWake')), /wakeMode/)

console.log('LOCAL_WAKE_VERIFIER_TEST=PASS')
