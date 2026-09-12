import assert from 'node:assert/strict'

import { RecentConversation } from '../src/conversation/recent-conversation.js'
import {
  CONTEXT_BUDGET_DEFAULT_CHARS,
  CONTEXT_PRIORITY,
  SHORT_TERM_CONTEXT_TURNS,
  classifyTurnPriority,
  resolveShortTermContextTurns,
  selectContextTurns,
} from '../src/conversation/context-budget.js'

assert.equal(SHORT_TERM_CONTEXT_TURNS, 48)
assert.equal(CONTEXT_BUDGET_DEFAULT_CHARS, 24000)
assert.deepEqual(CONTEXT_PRIORITY, { HIGH: 3, MEDIUM: 2, LOW: 1 })

assert.deepEqual(resolveShortTermContextTurns({}), {
  turns: 48,
  source: 'default',
  reason: 'env-not-set',
})
assert.deepEqual(resolveShortTermContextTurns({ SHORT_TERM_CONTEXT_TURNS: '24' }), {
  turns: 24,
  source: 'env',
  reason: null,
})
for (const value of ['abc', '0', '-5']) {
  const resolved = resolveShortTermContextTurns({ SHORT_TERM_CONTEXT_TURNS: value })
  assert.equal(resolved.turns, 48)
  assert.equal(resolved.source, 'default')
  assert.ok(resolved.reason)
}

const highExamples = [
  { user: '记住，我家的猫叫黑莓', assistant: '好，我会记住。' },
  { user: '我家的狗生日是五月五日', assistant: '这是重要信息。' },
  { user: '花花是母狗，品种是伯恩山', assistant: '收到啦。' },
  { user: '我是你的主人，最喜欢你每天迎接我', assistant: '我知道我们是家人。' },
]
const mediumExamples = [
  { user: '你又把球叼回来了', assistant: '我看到了。' },
  { user: '我每天晚上带你散步', assistant: '每天都很期待。' },
  { user: '你还是把球叼到门口', assistant: '这个习惯没变。' },
  { user: '你最近经常在门口等我', assistant: '是呀。' },
]
const lowExamples = [
  { user: '你好呀', assistant: '你好呀！' },
  { user: '早上好', assistant: '早上好。' },
  { user: '哈哈嘿嘿', assistant: '嘿嘿。' },
  { user: '摸摸头，真可爱', assistant: '舒服。' },
]
for (const turn of highExamples) assert.equal(classifyTurnPriority(turn), 'HIGH')
for (const turn of mediumExamples) assert.equal(classifyTurnPriority(turn), 'MEDIUM')
for (const turn of lowExamples) assert.equal(classifyTurnPriority(turn), 'LOW')

const mixedTurns = [
  highExamples[0],
  lowExamples[0],
  mediumExamples[0],
  lowExamples[2],
  highExamples[1],
  lowExamples[1],
  mediumExamples[2],
  lowExamples[3],
]
const keepIndexes = [0, 2, 4, 6, 7]
const mixedBudget = keepIndexes.reduce((total, index) => {
  const turn = mixedTurns[index]
  return total + turn.user.length + turn.assistant.length
}, 0)
const mixedSelected = selectContextTurns(mixedTurns, {
  maxChars: mixedBudget,
  reservedTurns: 2,
})
assert.deepEqual(mixedSelected.turns, keepIndexes.map((index) => mixedTurns[index]))
assert.equal(mixedSelected.reasons.droppedByPriority.LOW, 3)
assert.equal(mixedSelected.reasons.droppedByPriority.MEDIUM, 0)
assert.equal(mixedSelected.reasons.droppedByPriority.HIGH, 0)
assert.equal(mixedSelected.reasons.droppedByReserve, 0)
assert.equal(mixedSelected.dropped, 3)
assert.equal(mixedSelected.approxChars <= mixedBudget, true)

const reservedTurns = Array.from({ length: 6 }, (_, index) => ({
  user: `第${index + 1}轮`,
  assistant: '答',
}))
const reservedSelected = selectContextTurns(reservedTurns, {
  maxChars: 1,
  reservedTurns: 6,
})
assert.deepEqual(reservedSelected.turns, reservedTurns)
assert.equal(reservedSelected.reasons.reservedExceedsBudget, true)
assert.equal(reservedSelected.reasons.reservedTurns, 6)
assert.equal(reservedSelected.reasons.droppedByReserve, 0)
assert.equal(reservedSelected.approxChars > 1, true)

const numberedTurns = Array.from({ length: 8 }, (_, index) => ({
  user: `第${index + 1}号`,
  assistant: '答',
}))
const simultaneous = selectContextTurns(numberedTurns, {
  maxTurns: 5,
  maxChars: 12,
  reservedTurns: 1,
})
assert.deepEqual(simultaneous.turns.map(({ user }) => user), ['第6号', '第7号', '第8号'])
assert.equal(simultaneous.reasons.droppedByMaxTurns, 3)
assert.equal(simultaneous.approxChars, 12)
assert.equal(simultaneous.approxChars <= 12, true)
assert.deepEqual(simultaneous.turns.map(({ user }) => Number(user.match(/\d+/u)[0])), [6, 7, 8])

assert.doesNotThrow(() => selectContextTurns(null))
assert.deepEqual(selectContextTurns(null).turns, [])
assert.equal(selectContextTurns(null).reasons.invalidInput, 'invalid-turns-input')
assert.doesNotThrow(() => selectContextTurns([{ user: '缺 assistant' }]))
assert.equal(selectContextTurns([{ user: '缺 assistant' }]).reasons.invalidInput, 'invalid-turn-entry')
assert.doesNotThrow(() => classifyTurnPriority(null))
assert.equal(classifyTurnPriority(null), 'LOW')
const invalidOptions = selectContextTurns(lowExamples, { maxTurns: '5', maxChars: -1, reservedTurns: null })
assert.ok(invalidOptions.reasons.invalidOptions.length >= 3)

const recent = new RecentConversation({ maxTurns: 4 })
recent.append('你好', '收到')
recent.append('记住，我家的猫叫黑莓', '知道啦')
recent.append('你又在门口等我', '是呀')
const snapshot = recent.snapshot()
const tokenSnapshot = recent.tokenBudgetSnapshot()
const selectedAll = selectContextTurns(snapshot, {
  maxTurns: 4,
  maxChars: CONTEXT_BUDGET_DEFAULT_CHARS,
  reservedTurns: 1,
})
assert.equal(selectedAll.approxChars, tokenSnapshot.approxChars)
assert.equal(selectedAll.approxTokens, tokenSnapshot.approxTokens)
assert.equal(selectedAll.turns.length, tokenSnapshot.turns)

console.log('VC_AI_PET_V0_4_CONTEXT_BUDGET=PASS')
