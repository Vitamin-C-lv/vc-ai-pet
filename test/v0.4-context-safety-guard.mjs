import assert from 'node:assert/strict'
import { buildPetMessages } from '../src/brain/prompt-builder.js'
import {
  CONTEXT_OUTPUT_SAFETY_MARGIN_TOKENS,
  planFinalRequestBudget,
} from '../src/conversation/context-budget.js'

function realisticTurns(count) {
  return Array.from({ length: count }, (_, index) => ({
    user: `主人第${index + 1}轮说：今天回家后我在窗边坐了一会儿，花花趴在脚边陪着我，我们聊了聊晚饭和明天的安排。`,
    assistant: `花花第${index + 1}轮回答：花花记得这只是最近的聊天，听见主人这样说会很安心，也愿意继续陪主人。`,
  }))
}

function modelMessages(turns, userText = '现在呢') {
  return buildPetMessages({
    identity: { name: '李花花', breedZh: '伯恩山犬', birthday: '2026-08-31' },
    state: { mood: 0.8, energy: 0.7, boredom: 0.2, sleepiness: 0.1, attachment: 0.9 },
    recentMessages: turns.flatMap(({ user, assistant }) => [
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ]),
    userText,
    contextTurns: 50,
    now: new Date('2026-09-14T20:00:00+08:00'),
  })
}

const turns = realisticTurns(50)
const built = modelMessages(turns)
const dialogue = built.slice(1)
assert.equal(dialogue.length, 101)
assert.equal(dialogue.slice(0, -1).length, 100)
assert.doesNotMatch(built[0].content, /RECENT_MESSAGE_\d+/u)
assert.match(built[0].content, /RECENT_CONVERSATION_EVIDENCE:/u)

const planned = planFinalRequestBudget({
  system: built[0].content,
  recentTurns: turns,
  currentUser: built.at(-1),
  outputReserveTokens: 768 + CONTEXT_OUTPUT_SAFETY_MARGIN_TOKENS,
  contextWindowTokens: 16_384,
})
assert.equal(planned.overflow, false)
assert.equal(planned.turns.length, 50)
assert.deepEqual(planned.dropped, [])
console.log(`REQUEST_CONTEXT_OVERFLOW=${planned.overflow ? 'YES' : 'NO'}`)
console.log(`REQUEST_CONTEXT_BUDGET_50_TURNS=${JSON.stringify({ estimatedTokens: planned.estimatedTokens, contextWindowTokens: planned.contextWindowTokens, dropped: planned.dropped })}`)

const oversized = realisticTurns(50).map((turn, index) => ({
  ...turn,
  user: index < 44 ? `随便聊聊第${index + 1}句。` + '闲聊'.repeat(500) : turn.user,
  assistant: index < 44 ? `嗯嗯，第${index + 1}句。` + '回应'.repeat(500) : turn.assistant,
}))
const trimmed = planFinalRequestBudget({
  system: '固定规则：请诚实回答。',
  recentTurns: oversized,
  currentUser: '请继续陪我聊天。',
  outputReserveTokens: 1_024,
  contextWindowTokens: 4_000,
})
assert.equal(trimmed.overflow, false)
assert.ok(trimmed.dropped.length > 0)
assert.equal(trimmed.turns.length >= 6, true)
assert.deepEqual(trimmed.turns.slice(-6), oversized.slice(-6))
assert.ok(trimmed.dropped.some(({ priority }) => priority === 'LOW'))
console.log(`REQUEST_CONTEXT_TRIMMED=${trimmed.dropped.length}`)
console.log('VC_AI_PET_V0_4_CONTEXT_SAFETY_GUARD=PASS')
