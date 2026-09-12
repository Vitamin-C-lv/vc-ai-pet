import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  RecentConversation,
  RECENT_CONVERSATION_DEFAULT_MAX_TURNS,
  RECENT_CONVERSATION_MAX_CHARS_PER_TURN,
  RECENT_CONVERSATION_MAX_TURNS_LIMIT,
} from '../src/conversation/recent-conversation.js'
import { ConversationStore } from '../src/conversation/conversation-store.js'

assert.equal(RECENT_CONVERSATION_DEFAULT_MAX_TURNS, 50)
assert.equal(RECENT_CONVERSATION_MAX_TURNS_LIMIT, 50)
assert.equal(RECENT_CONVERSATION_MAX_CHARS_PER_TURN, 1200)

const recent = new RecentConversation()
for (let index = 1; index <= RECENT_CONVERSATION_DEFAULT_MAX_TURNS; index += 1) {
  assert.equal(recent.append(`用户第${index}句`, `花花第${index}答`), true)
}
assert.equal(recent.size, RECENT_CONVERSATION_DEFAULT_MAX_TURNS)
assert.equal(recent.snapshot()[0].user, '用户第1句')

recent.append(`用户第${RECENT_CONVERSATION_DEFAULT_MAX_TURNS + 1}句`, `花花第${RECENT_CONVERSATION_DEFAULT_MAX_TURNS + 1}答`)
assert.equal(recent.size, RECENT_CONVERSATION_DEFAULT_MAX_TURNS)
assert.equal(recent.snapshot()[0].user, '用户第2句')
assert.equal(recent.snapshot({ limit: 2 })[0].user, `用户第${RECENT_CONVERSATION_DEFAULT_MAX_TURNS}句`)

for (const value of [RECENT_CONVERSATION_MAX_TURNS_LIMIT + 1, 0, 1.5, '12']) {
  assert.throws(
    () => new RecentConversation({ maxTurns: value }),
    /PET_RECENT_CONVERSATION_MAX_TURNS_INVALID/u,
  )
}

const legacySized = new RecentConversation({ maxTurns: 12 })
for (let index = 1; index <= 13; index += 1) {
  legacySized.append(`用户${index}`, `回答${index}`)
}
assert.equal(legacySized.size, 12)
assert.equal(legacySized.snapshot()[0].user, '用户2')

const fixedSample = new RecentConversation({ maxTurns: 12 })
fixedSample.append('  第一条用户文本  ', '\n第一条助手文本\n')
fixedSample.append('第二条用户文本', '第二条助手文本')
assert.deepEqual(fixedSample.messages(), [
  { role: 'user', content: '第一条用户文本' },
  { role: 'assistant', content: '第一条助手文本' },
  { role: 'user', content: '第二条用户文本' },
  { role: 'assistant', content: '第二条助手文本' },
])

const optionSample = new RecentConversation()
for (let index = 1; index <= 10; index += 1) {
  optionSample.append(`用户${index}`, `回答${index}`)
}
assert.deepEqual(
  optionSample.messages({ maxTurns: 5 }).map(({ content }) => content),
  ['用户6', '回答6', '用户7', '回答7', '用户8', '回答8', '用户9', '回答9', '用户10', '回答10'],
)

const charsSample = new RecentConversation()
charsSample.append('旧旧旧', '答答答')
charsSample.append('中中中', '答答答')
charsSample.append('新新新', '答答答')
const charsMessages = charsSample.messages({ maxChars: 12 })
assert.equal(charsMessages.reduce((total, message) => total + message.content.length, 0) <= 12, true)
assert.deepEqual(charsMessages.map(({ content }) => content), ['中中中', '答答答', '新新新', '答答答'])

const budgetSample = new RecentConversation()
budgetSample.append('你好', '花花')
budgetSample.append('abc', 'de')
assert.deepEqual(budgetSample.tokenBudgetSnapshot(), {
  turns: 2,
  messages: 4,
  approxChars: 9,
  approxTokens: 5,
})

const longText = '长'.repeat(RECENT_CONVERSATION_MAX_CHARS_PER_TURN + 100)
const cleanSample = new RecentConversation()
assert.equal(cleanSample.append(longText, longText), true)
assert.equal(cleanSample.snapshot()[0].user.length, 1200)
assert.equal(cleanSample.snapshot()[0].assistant.length, 1200)

const beforeEmptyAppend = cleanSample.size
assert.equal(cleanSample.append('', '有效助手文本'), false)
assert.equal(cleanSample.size, beforeEmptyAppend)
assert.equal(cleanSample.append('有效用户文本', ''), false)
assert.equal(cleanSample.size, beforeEmptyAppend)

const extreme = new RecentConversation()
const extremeText = '极'.repeat(1200)
for (let index = 0; index < RECENT_CONVERSATION_MAX_TURNS_LIMIT; index += 1) {
  assert.equal(extreme.append(extremeText, extremeText), true)
}
assert.equal(extreme.size, RECENT_CONVERSATION_MAX_TURNS_LIMIT)
assert.equal(extreme.snapshot().length, RECENT_CONVERSATION_MAX_TURNS_LIMIT)
assert.equal(extreme.messages().length, RECENT_CONVERSATION_MAX_TURNS_LIMIT * 2)
assert.deepEqual(extreme.tokenBudgetSnapshot(), {
  turns: RECENT_CONVERSATION_MAX_TURNS_LIMIT,
  messages: RECENT_CONVERSATION_MAX_TURNS_LIMIT * 2,
  approxChars: RECENT_CONVERSATION_MAX_TURNS_LIMIT * 2400,
  approxTokens: RECENT_CONVERSATION_MAX_TURNS_LIMIT * 1200,
})

const recoveryRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-recent-recovery-'))
let store
try {
  store = new ConversationStore(recoveryRoot)
  for (let index = 1; index <= 55; index += 1) {
    await store.appendMessage({ id: `recovery-user-${index}`, role: 'user', text: `恢复用户${index}` })
    await store.appendMessage({ id: `recovery-assistant-${index}`, role: 'assistant', text: `恢复助手${index}` })
  }

  const recovered48 = await store.semanticHistory(48)
  assert.equal(recovered48.length, 48)
  assert.equal(recovered48[0].text, '恢复用户32')
  assert.equal(recovered48.at(-1).text, '恢复助手55')

  const recovered100 = await store.semanticHistory(100)
  assert.equal(recovered100.length, 100)
  assert.equal(recovered100[0].text, '恢复用户6')
  assert.equal(recovered100.at(-1).text, '恢复助手55')

  console.log('RECOVERY_SEMANTIC_HISTORY_48_MESSAGES=48')
  console.log('RECOVERY_SEMANTIC_HISTORY_48_TURNS=24')
  console.log('RECOVERY_SEMANTIC_HISTORY_100_MESSAGES=100')
  console.log('RECOVERY_SEMANTIC_HISTORY_100_TURNS=50')
} finally {
  store?.close()
  await rm(recoveryRoot, { recursive: true, force: true })
}

console.log('VC_AI_PET_V0_4_RECENT_CONVERSATION_50=PASS')
