import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EXPLICIT_MEMORY_PHRASES,
  detectExplicitMemoryRequest,
  explicitMemoryStatement,
  highPriorityMemoryCandidate,
  userExplicitlyRequestsMemory,
  userOptedOutOfMemory,
} from '../src/brain/memory-candidate.js'
import { ExplicitMemoryQueue } from '../src/memory/explicit-memory-queue.js'
import { EXPLICIT_MEMORY_PRIORITY, MemoryGate } from '../src/memory/memory-gate.js'
import { PetMemory } from '../src/memory/pet-memory.js'

assert.deepEqual(EXPLICIT_MEMORY_PHRASES, [
  '记住', '记下来', '不要忘', '别忘了', '以后叫', '以后知道', '记一下', '记着', '记好',
])

const phraseCases = [
  ['记住', '记住我生日是3月1日'],
  ['记下来', '请你记下来我喜欢青色'],
  ['记一下', '帮我记一下我住在上海'],
  ['记着', '你记着我家猫叫黑莓'],
  ['记好', '记好我的猫叫黑莓'],
  ['不要忘', '我家猫叫黑莓，不要忘'],
  ['不要忘', '我家猫叫黑莓，不要忘记'],
  ['别忘了', '我家猫叫黑莓，别忘了'],
  ['以后叫', '以后叫我小黑'],
  ['以后知道', '以后知道我家的猫叫黑莓'],
]
for (const [phrase, text] of phraseCases) {
  const detection = detectExplicitMemoryRequest(text)
  assert.equal(detection.explicit, true, `phrase should be explicit: ${phrase}`)
  assert.equal(detection.phrase, phrase)
  assert.equal(detection.optOut, false)
}
for (const text of [
  '花花，你记住哦，记住我的猫叫黑莓',
  '李花花，请你记下来，记着我喜欢群青色',
]) {
  const candidate = highPriorityMemoryCandidate(text)
  assert.ok(candidate)
  assert.equal(explicitMemoryStatement(text), candidate.evidence)
  assert.doesNotMatch(candidate.evidence, /记住|记下来|记着/u)
}

for (const text of [
  '你好呀，花花。',
  '早上好，今天感觉怎么样？',
  '你吃饭了吗？',
  '记住吗？',
  '我记住了你说的话。',
  '我们聊聊记忆吧。',
]) {
  assert.equal(detectExplicitMemoryRequest(text).explicit, false, `false positive: ${text}`)
}

for (const text of ['记住', '记住吧', '我记住了', '记住吗？', '记下来', '记着']) {
  assert.equal(detectExplicitMemoryRequest(text).explicit, false, `bare instruction should not write: ${text}`)
  assert.equal(highPriorityMemoryCandidate(text), null)
}

for (const text of ['不要记住这个，我喜欢蓝色', '别记，我只是随口一说', '不用保存这件事']) {
  const detection = detectExplicitMemoryRequest(text)
  assert.equal(detection.optOut, true)
  assert.equal(userOptedOutOfMemory(text), true)
  assert.equal(highPriorityMemoryCandidate(text), null)
}
assert.equal(userOptedOutOfMemory('别记'), true)
assert.equal(userOptedOutOfMemory('不用记'), true)
assert.equal(highPriorityMemoryCandidate('不用记'), null)

assert.equal(highPriorityMemoryCandidate('记住我的密码是hunter2'), null)
assert.equal(highPriorityMemoryCandidate('记住我的 API token 是 abc123'), null)
assert.equal(userExplicitlyRequestsMemory('记住我生日是3月1日'), true)

for (const text of ['我们家的猫猫叫黑莓，你要记住', '我们家的狗叫团子，记住']) {
  const candidate = highPriorityMemoryCandidate(text)
  assert.ok(candidate)
  assert.equal(candidate.level, 'fact')
  assert.doesNotMatch(candidate.content, /主人们/u)
  assert.match(candidate.content, /主人明确要求记住/u)
}

const failureText = '我们家的猫猫叫黑莓，你要记住'
const failureCandidate = highPriorityMemoryCandidate(failureText)
assert.deepEqual(failureCandidate, {
  level: 'fact',
  content: '主人明确要求记住：我们家的猫猫叫黑莓',
  importance: 3,
  keywords: [],
  confidence: 1,
  evidence: '我们家的猫猫叫黑莓',
})
assert.equal(explicitMemoryStatement(failureText), '我们家的猫猫叫黑莓')

const rows = []
const fakeMemory = {
  findEquivalentMemory(content) {
    return rows.find((row) => row.content === content) ?? null
  },
  rememberCandidate(candidate) {
    const row = { id: rows.length + 1, ...candidate }
    rows.push(row)
    return row
  },
}
const fakeGate = new MemoryGate({ memory: fakeMemory })
const fakeWritten = fakeGate.consider(failureText, null, { messageId: 'blackberry-1' })
assert.equal(fakeWritten.status, 'written')
assert.equal(fakeWritten.reason, 'accepted')
assert.equal(fakeWritten.level, 'fact')
assert.equal(fakeWritten.priority, EXPLICIT_MEMORY_PRIORITY)
assert.equal(rows[0].content, '主人说：我们家的猫猫叫黑莓')
assert.equal(rows[0].evidence, '我们家的猫猫叫黑莓')
assert.equal(rows[0].messageId, 'blackberry-1')

const fakeDuplicate = fakeGate.consider(failureText, null)
assert.equal(fakeDuplicate.status, 'duplicate')
assert.equal(fakeDuplicate.level, 'fact')
assert.equal(rows.length, 1)

const skippedOrdinary = fakeGate.consider('今天阳光真好呀。', null)
assert.equal(skippedOrdinary.status, 'skipped')
assert.equal(skippedOrdinary.reason, 'model-skip')
assert.equal(rows.length, 1)

const skippedSensitive = fakeGate.consider('记住我的密码是hunter2', null)
assert.equal(skippedSensitive.reason, 'memory-sensitive-reject')
assert.equal(rows.length, 1)

const skippedQuestion = fakeGate.consider('记住吗？', null)
assert.equal(skippedQuestion.reason, 'not-owner-assertion')
assert.equal(rows.length, 1)

const followUpFallback = highPriorityMemoryCandidate('记住我们家的猫叫黑莓')
const followUp = fakeGate.consider('我们家的猫叫黑莓', null, { explicitFallback: followUpFallback })
assert.equal(followUp.status, 'written')
assert.equal(followUp.priority, EXPLICIT_MEMORY_PRIORITY)
assert.equal(rows.at(-1).content, '主人说：我们家的猫叫黑莓')

const invalidFallback = fakeGate.consider('我们家的猫叫榴莲', null, {
  explicitFallback: {
    level: 'soul',
    content: '非法 fallback',
    importance: 3,
    keywords: [],
    confidence: 1,
    evidence: '我们家的猫叫榴莲',
  },
})
assert.equal(invalidFallback.status, 'skipped')
assert.equal(rows.at(-1).content, '主人说：我们家的猫叫黑莓')

for (const [text, reason] of [
  ['别记这个，我们家的猫叫榴莲', 'user-opt-out'],
  ['记住我的密码是hunter2', 'memory-sensitive-reject'],
  ['我们家的猫叫榴莲吗？', 'not-owner-assertion'],
]) {
  const protectedResult = fakeGate.consider(text, null, { explicitFallback: followUpFallback })
  assert.equal(protectedResult.reason, reason)
  assert.equal(rows.at(-1).content, '主人说：我们家的猫叫黑莓')
}

async function withSandbox(fn) {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-explicit-memory-'))
  let memory = null
  try {
    memory = new PetMemory(root)
    return await fn({ root, memory })
  } finally {
    try { memory?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false)
  }
}

await withSandbox(async ({ memory }) => {
  const gate = new MemoryGate({ memory })
  const result = gate.consider(failureText, null, { messageId: 'blackberry-real' })
  assert.equal(result.status, 'written')
  assert.equal(result.level, 'fact')
  assert.equal(result.priority, EXPLICIT_MEMORY_PRIORITY)

  const stored = memory.db.list('fact').find((row) => row.content.includes('黑莓'))
  assert.ok(stored)
  assert.equal(stored.content, '主人说：我们家的猫猫叫黑莓')
  assert.equal(stored.importance, 3)

  const modelSkipped = gate.consider('我喜欢睡沙发。', null)
  assert.equal(modelSkipped.status, 'skipped')
  assert.equal(memory.db.list('fact').filter((row) => row.content.includes('睡沙发')).length, 0)
})

let now = 1000
const queue = new ExplicitMemoryQueue({ now: () => now++, maxEntries: 2 })
const first = queue.enqueue({ userText: failureText, messageId: 'q-1' })
const second = queue.enqueue({ userText: '记住我喜欢群青色', messageId: 'q-2' })
assert.equal(queue.size, 2)
assert.deepEqual(queue.listPending().map((entry) => entry.id), ['q-1', 'q-2'])
assert.equal(first.priority, 'HIGH')
assert.equal(first.source, 'USER_EXPLICIT')
assert.equal(first.phrase, '记住')
assert.deepEqual(queue.snapshot().map(({ id, status, priority, source, phrase, reason, messageId, enqueuedAt, writtenAt }) => ({ id, status, priority, source, phrase, reason, messageId, enqueuedAt, writtenAt })), [
  { id: 'q-1', status: 'pending', priority: 'HIGH', source: 'USER_EXPLICIT', phrase: '记住', reason: null, messageId: 'q-1', enqueuedAt: 1000, writtenAt: null },
  { id: 'q-2', status: 'pending', priority: 'HIGH', source: 'USER_EXPLICIT', phrase: '记住', reason: null, messageId: 'q-2', enqueuedAt: 1001, writtenAt: null },
])

const third = queue.enqueue({ userText: '记下来我住在上海', messageId: 'q-3' })
assert.equal(third.dropped.id, 'q-1')
assert.equal(third.discarded.id, 'q-1')
assert.deepEqual(queue.listPending().map((entry) => entry.id), ['q-2', 'q-3'])
assert.equal(queue.markWritten('q-2').status, 'written')
assert.equal(queue.size, 1)
assert.notEqual(queue.snapshot().find((entry) => entry.id === 'q-2').writtenAt, null)
assert.equal(queue.markRejected('q-3', 'memory-sensitive-reject').reason, 'memory-sensitive-reject')
assert.equal(queue.size, 0)
assert.equal(queue.snapshot().find((entry) => entry.id === 'q-2').status, 'written')
assert.equal(queue.snapshot().find((entry) => entry.id === 'q-3').reason, 'memory-sensitive-reject')

const fourth = queue.enqueue({ userText: '以后知道我的猫叫黑莓', messageId: 'q-4' })
const fifth = queue.enqueue({ userText: '记好我喜欢黑莓', messageId: 'q-5' })
const drained = queue.drain()
assert.deepEqual(drained.map((entry) => entry.id), [fourth.id, fifth.id])
assert.equal(queue.size, 0)
assert.equal(queue.listPending().length, 0)
assert.equal(queue.markWritten(fourth.id).status, 'written')
assert.equal(queue.markRejected(fifth.id, 'rejected').status, 'rejected')

console.log('VC_AI_PET_V0_4_EXPLICIT_MEMORY_REQUEST=PASS')
