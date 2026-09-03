import assert from 'node:assert/strict'

import { getCurrentTimeContext, TIME_CONTEXT_FIELDS } from '../src/core/time-context.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import { formatHistoricalRecallContext } from '../src/brain/prompt-builder.js'
import { buildDreamMessages } from '../src/dream/dream-engine.js'
import { buildReflectionMessages } from '../src/dream/reflection-engine.js'

function expectedDayPeriod(hour) {
  if (hour < 6) return '凌晨'
  if (hour < 12) return '上午'
  if (hour < 18) return '下午'
  return '晚上'
}

function expectedSeason(month) {
  if (month >= 3 && month <= 5) return '春季'
  if (month >= 6 && month <= 8) return '夏季'
  if (month >= 9 && month <= 11) return '秋季'
  return '冬季'
}

const systemNow = Date.now()
const systemDate = new Date(systemNow)
const timeContext = getCurrentTimeContext(systemNow)

assert.deepEqual(Object.keys(timeContext), TIME_CONTEXT_FIELDS)
for (const field of TIME_CONTEXT_FIELDS) {
  assert.equal(typeof timeContext[field], 'string')
  assert.ok(timeContext[field].length > 0)
}
assert.match(timeContext.currentDate, /^\d{4}-\d{2}-\d{2}$/u)
assert.match(timeContext.currentTime, /^\d{2}:\d{2}$/u)
console.log('TIME_CONTEXT_EXISTS=PASS')

const pad = (value) => String(value).padStart(2, '0')
assert.equal(
  timeContext.currentDate,
  `${systemDate.getFullYear()}-${pad(systemDate.getMonth() + 1)}-${pad(systemDate.getDate())}`,
)
assert.equal(timeContext.currentTime, `${pad(systemDate.getHours())}:${pad(systemDate.getMinutes())}`)
assert.equal(timeContext.weekday, ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][systemDate.getDay()])
assert.equal(timeContext.dayPeriod, expectedDayPeriod(systemDate.getHours()))
assert.equal(timeContext.season, expectedSeason(systemDate.getMonth() + 1))
console.log('REAL_SYSTEM_TIME=PASS')

let capturedMessages = null
let timeProviderCalls = 0
let memoryWriteCalls = 0
const brain = new LocalBrain({
  config: { resourceGate: { enabled: false } },
  timeProvider: (now) => {
    timeProviderCalls += 1
    assert.equal(now, systemNow)
    return getCurrentTimeContext(now)
  },
  memory: {
    recall: () => [],
    stableRulesContext: () => [],
    currentSelfContext: () => [],
    remember: () => { memoryWriteCalls += 1 },
    rememberCandidate: () => { memoryWriteCalls += 1 },
    rememberDreamCandidate: () => { memoryWriteCalls += 1 },
    logDream: () => { memoryWriteCalls += 1 },
  },
  client: {
    chat: async ({ messages }) => {
      capturedMessages = messages
      return {
        payload: {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({ reply: '现在陪你聊。', memory: null }),
            },
          }],
        },
      }
    },
  },
})

const userText = '现在几点？'
const result = await brain.reply({
  identity: LI_HUAHUA_IDENTITY,
  state: { mood: 0.8, energy: 0.8, boredom: 0.1, sleepiness: 0.1, attachment: 0.8 },
  userText,
  now: systemNow,
})

assert.equal(result.ok, true)
assert.equal(timeProviderCalls, 1)
const systemPrompt = capturedMessages.find((message) => message.role === 'system')?.content ?? ''
assert.match(systemPrompt, /系统环境时间（TIME_CONTEXT/u)
assert.match(systemPrompt, /当前时间来自系统环境/u)
assert.match(systemPrompt, /不是记忆/u)
assert.match(systemPrompt, /不是用户描述/u)
assert.match(systemPrompt, /不要自行猜测或推算当前时间/u)
assert.match(systemPrompt, new RegExp(`currentDate: ${timeContext.currentDate}`))
assert.match(systemPrompt, new RegExp(`currentTime: ${timeContext.currentTime}`))
assert.match(systemPrompt, new RegExp(`weekday: ${timeContext.weekday}`))
assert.match(systemPrompt, new RegExp(`dayPeriod: ${timeContext.dayPeriod}`))
assert.match(systemPrompt, new RegExp(`season: ${timeContext.season}`))
assert.equal(capturedMessages.at(-1).role, 'user')
assert.equal(capturedMessages.at(-1).content, userText)
assert.doesNotMatch(capturedMessages.at(-1).content, /currentDate|currentTime|TIME_CONTEXT/u)
console.log('PROMPT_INJECTION=PASS')

assert.equal(memoryWriteCalls, 0)
console.log('MEMORY_WRITE=NO')

const dreamPrompt = buildDreamMessages({
  newMemories: [{ id: 'raw-1', level: 'fact', source_session: 'vc-ai-pet', created_at: systemNow, importance: 2, content: '一条原始记忆' }],
  relatedMemories: [],
}).map((message) => message.content).join('\n')
const reflectionPrompt = buildReflectionMessages({
  newMemories: [{ id: 'raw-1', level: 'fact', source_session: 'vc-ai-pet', created_at: systemNow, importance: 2, content: '一条原始记忆' }],
  relatedMemories: [],
}).map((message) => message.content).join('\n')
const historicalPrompt = formatHistoricalRecallContext({
  mode: 'when',
  entries: [{ id: 'history-1', level: 'fact', source: 'raw', created_at: systemNow, status: 'active', content: '一条历史记忆' }],
}, { userText: '我什么时候说过这件事？' })
for (const prompt of [dreamPrompt, reflectionPrompt, historicalPrompt]) {
  assert.doesNotMatch(prompt, /TIME_CONTEXT|currentDate:|currentTime:/u)
}
console.log('DREAM_REGRESSION=PASS')
