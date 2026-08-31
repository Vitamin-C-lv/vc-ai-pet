import assert from 'node:assert/strict'
import {
  createExplicitMemoryFallbackCandidate,
  parseStructuredChatResponse,
  userExplicitlyRequestsMemory,
  userOptedOutOfMemory,
  validateMemoryCandidate,
} from '../src/brain/memory-candidate.js'
import { MemoryGate } from '../src/memory/memory-gate.js'

const explicitColor = '花花，你记住哦，我最喜欢的测试颜色是群青色。'
const optOutFruit = '花花，别记住这个：我最喜欢的测试水果是榴莲。'

const candidate = {
  remember: true,
  level: 'user',
  content: '主人最喜欢蓝色。',
  importance: 3,
  keywords: ['主人', '喜欢', '蓝色'],
  confidence: 0.96,
  evidence: '我最喜欢蓝色',
}

assert.equal(userOptedOutOfMemory('别记住这个，我最喜欢蓝色'), true)
assert.equal(userOptedOutOfMemory('我最喜欢蓝色'), false)
assert.equal(userExplicitlyRequestsMemory(explicitColor), true)
assert.equal(userOptedOutOfMemory(optOutFruit), true)
assert.equal(userExplicitlyRequestsMemory(optOutFruit), false)

assert.equal(validateMemoryCandidate(candidate, '我最喜欢蓝色。').accepted, true)
assert.equal(validateMemoryCandidate({ ...candidate, level: 'soul' }, '我最喜欢蓝色。').accepted, false)
assert.equal(validateMemoryCandidate({ ...candidate, importance: 1 }, '我最喜欢蓝色。').accepted, false)
assert.equal(validateMemoryCandidate({ ...candidate, confidence: 0.3 }, '我最喜欢蓝色。').accepted, false)
assert.equal(validateMemoryCandidate({ ...candidate, evidence: '不存在的证据' }, '我最喜欢蓝色。').accepted, false)
assert.equal(validateMemoryCandidate(candidate, '别记住这个，我最喜欢蓝色。').accepted, false)

const structured = JSON.stringify({
  reply: '记住啦，蓝色很好看。',
  memory: candidate,
})
const parsed = parseStructuredChatResponse(structured, '我最喜欢蓝色。')
assert.equal(parsed.text, '记住啦，蓝色很好看。')
assert.equal(parsed.memoryCandidate.content, '主人最喜欢蓝色。')
assert.equal(parsed.rawMemoryCandidate.content, '主人最喜欢蓝色。')

const plainFallback = parseStructuredChatResponse('我在这儿呢。', '你好')
assert.equal(plainFallback.text, '我在这儿呢。')
assert.equal(plainFallback.memoryCandidate, null)
assert.equal(plainFallback.memoryDecision, 'structured-parse-failed')

const rows = []
const fakeMemory = {
  findEquivalentMemory(content) {
    return rows.find((row) => row.content === content) ?? null
  },
  rememberCandidate(value) {
    const row = { id: rows.length + 1, ...value }
    rows.push(row)
    return row
  },
}
const gate = new MemoryGate({ memory: fakeMemory })

const fallback = createExplicitMemoryFallbackCandidate(explicitColor)
assert.deepEqual(fallback, {
  level: 'user',
  content: '主人最喜欢的测试颜色是群青色。',
  importance: 3,
  keywords: [],
  confidence: 1,
  evidence: '我最喜欢的测试颜色是群青色。',
})

const first = gate.consider(explicitColor, { remember: false })
assert.equal(first.status, 'written')
assert.equal(rows.length, 1)
assert.equal(rows[0].content, '主人最喜欢的测试颜色是群青色。')

const second = gate.consider(explicitColor, { remember: false })
assert.equal(second.status, 'duplicate')
assert.equal(rows.length, 1)

const chatter = gate.consider('摸摸头，花花真可爱。', null)
assert.equal(chatter.status, 'skipped')
assert.equal(rows.length, 1)

const optOut = gate.consider(optOutFruit, candidate)
assert.equal(optOut.status, 'skipped')
assert.equal(rows.length, 1)

console.log('VC_AI_PET_V0_2_MEMORY_GATE_SMOKE=PASS')
