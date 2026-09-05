import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { DreamEngine } from '../src/dream/dream-engine.js'
import { ReflectionEngine } from '../src/dream/reflection-engine.js'

const DAY = 86400000
const START = Date.parse('2026-01-01T12:00:00+08:00')
const sandbox = await mkdtemp(join(tmpdir(), 'vc-ai-pet-long-life-'))
const realNow = Date.now
let day = 1
Date.now = () => START + day * DAY
let runtime = new PetRuntime({ sandboxRoot: sandbox })
let calls = []
let proposals = []
const response = { remember: false, level: 'fact', content: '', importance: 1, keywords: [], confidence: 0, evidence: '' }
function connectFixture() {
  runtime.brain.client = { chat: async (request) => {
    calls.push(request)
    return { payload: { choices: [{ message: { content: JSON.stringify({ reply: '花花记下这次谈话了。', memory: response, beliefs: proposals }) } }] } }
  } }
}
async function say(text, topic, value, change = 'assert') {
  proposals = topic ? [{ topic, value, quote: text, change }] : []
  const before = calls.length
  assert.equal((await runtime.chat(text)).ok, true)
  assert.equal(calls.length, before + 1, 'one Local Brain inference per text turn')
}
try {
  await runtime.initialize()
  connectFixture()
  const topic = '最喜欢的颜色'
  await say('我最喜欢蓝色。', topic, '蓝色')
  const first = runtime.memory.beliefs.current(topic)
  assert.equal(first.state, 'supported')
  assert.equal(first.alternatives[0].value, '蓝色')
  day = 7
  await say('我最近越来越喜欢绿色。', topic, '绿色', 'change')
  day = 30
  await say('其实我现在最喜欢白色。', topic, '白色', 'change')
  await say('我现在最喜欢什么颜色？')
  assert.match(calls.at(-1).messages[0].content, /CURRENT_UNDERSTANDING/)
  assert.match(calls.at(-1).messages[0].content, /其实我现在最喜欢白色/)
  await say('我以前喜欢什么颜色，后来怎么变化的？')
  const historyPrompt = calls.at(-1).messages[0].content
  for (const color of ['蓝色', '绿色', '白色']) assert.ok(historyPrompt.includes(color))
  assert.ok(historyPrompt.includes(first.alternatives[0].messageId))
  const raw = await runtime.conversationStore.sourceMessage(first.alternatives[0].messageId)
  assert.equal(raw.text, '我最喜欢蓝色。')
  assert.equal(raw.role, 'user')

  await say('我最喜欢红色。', topic, '红色')
  assert.equal(runtime.memory.beliefs.current(topic).state, 'contested')
  assert.equal(runtime.memory.beliefs.current(topic).alternatives.length, 2)
  day = 31
  await say('纠正一下，我刚才说错了，我最喜欢白色。', topic, '白色', 'correction')
  assert.equal(runtime.memory.beliefs.current(topic).state, 'supported')
  await say('我不确定自己最喜欢什么颜色了。', topic, '', 'uncertain')
  assert.equal(runtime.memory.beliefs.current(topic).state, 'unknown')
  assert.equal(runtime.memory.beliefs.current(topic).confidence, 0)
  await say('我可能更喜欢黄色。', topic, '黄色', 'assert')
  assert.equal(runtime.memory.beliefs.current(topic).state, 'unknown', 'tentative owner language must not become certain even if extraction says assert')
  await say('我今天最喜欢紫色。', topic, '紫色', 'temporary')
  assert.equal(runtime.memory.beliefs.current(topic).state, 'temporary')
  day = 33
  assert.equal(runtime.memory.beliefs.current(topic).state, 'unknown', 'expired temporary state must not resurrect old preference')

  day = 34
  await say('我不喝咖啡。', '喝咖啡频率', '不喝咖啡')
  day = 40
  await say('我最近开始偶尔喝咖啡了。', '喝咖啡频率', '偶尔喝咖啡', 'change')
  day = 90
  await say('我现在每天都会喝咖啡。', '喝咖啡频率', '每天都会喝咖啡', 'change')
  assert.equal(runtime.memory.beliefs.current('喝咖啡频率').alternatives[0].value, '每天都会喝咖啡')
  assert.equal(runtime.memory.beliefs.history('喝咖啡频率').entries.length, 3)
  // An earlier inference finishing late cannot replace a later owner change.
  const lateTopic = '最喜欢的季节'
  const newMessage = { id: 'out-of-order-new', role: 'user', text: '我现在最喜欢秋天。', timestamp: Date.now() }
  const oldMessage = { id: 'out-of-order-old', role: 'user', text: '我最喜欢春天。', timestamp: Date.now() - DAY }
  runtime.memory.beliefs.consider([{ topic: lateTopic, value: '秋天', quote: newMessage.text, change: 'change' }], newMessage)
  runtime.memory.beliefs.consider([{ topic: lateTopic, value: '春天', quote: oldMessage.text, change: 'assert' }], oldMessage)
  assert.equal(runtime.memory.beliefs.current(lateTopic).alternatives[0].value, '秋天')
  assert.equal(runtime.memory.beliefs.history(lateTopic).entries.length, 2)
  assert.deepEqual(runtime.memory.beliefs.consider([{ topic: lateTopic, value: '春天', quote: oldMessage.text, change: 'assert' }], oldMessage), [])
  const before = runtime.memory.beliefs.history(topic).entries.length
  await say('你以前说我最喜欢蓝色，是不是？', topic, '蓝色', 'change')
  await say('如果我最喜欢蓝色。', topic, '蓝色')
  await say('不要记住我最喜欢黑色。', topic, '黑色')
  assert.equal(runtime.memory.beliefs.history(topic).entries.length, before)
  assert.deepEqual(runtime.memory.beliefs.consider([{ topic, value: '蓝色', quote: '我最喜欢蓝色。', change: 'assert' }], { id: 'assistant-only', role: 'assistant', text: '我最喜欢蓝色。', timestamp: Date.now() }), [])
  const misread = runtime.memoryGate.consider('我不喝拿铁。', { remember: true, level: 'user', content: '主人每天喜欢喝拿铁。', evidence: '我不喝拿铁。', importance: 2, confidence: 0.99, keywords: ['拿铁'] })
  assert.equal(runtime.memory.findById(misread.id).row.content, '主人说：我不喝拿铁。', 'model summary cannot overwrite the literal negative evidence')

  // Real Dream and Reflection engines, fixture model only. Both consume the
  // same raw events; repeated derived processing cannot manufacture evidence.
  const event = runtime.memory.remember('fact', '主人陪花花一起玩球。', 2, { created_at: Date.now(), keywords: ['玩球'] })
  const dreamBrain = { dreamCompletion: async () => ({ ok: true, rawText: JSON.stringify({ summary: '回想了一起玩球。', memories: [{ level: 'soul', content: '我也许喜欢一起玩球。', importance: 3, confidence: 0.99, source_ids: [event.id], keywords: ['玩球'] }] }) }) }
  const engine = new DreamEngine({ memory: runtime.memory, brain: dreamBrain })
  const dream = await engine.run({ now: Date.now() + 1 })
  assert.equal(dream.status, 'completed')
  assert.equal(dream.derivedCount, 1)
  const soul = runtime.memory.findById(dream.derived[0].id).row
  assert.equal(soul.provenance.confidence, 0.45)
  assert.equal(soul.provenance.evidence, 'inferred')
  assert.equal(soul.provenance.selfStatus, 'hypothesis')
  const reflection = new ReflectionEngine({ memory: runtime.memory, brain: {
    reflectionCompletion: async () => ({ ok: true, rawText: JSON.stringify({ summary: '又回想了一起玩球。', memories: [] }) }),
  } })
  assert.equal((await reflection.run({ now: Date.now() + 2 })).status, 'completed')
  const countBefore = runtime.memory.db.list('soul').length
  for (let i = 0; i < 15; i++) {
    day++
    assert.equal((await engine.run({ now: Date.now() })).reason, 'no-new-sources')
    assert.equal((await reflection.run({ now: Date.now() })).reason, 'no-new-sources')
  }
  assert.equal(runtime.memory.db.list('soul').length, countBefore)
  assert.equal(runtime.memory.findById(soul.id).row.provenance.confidence, 0.45)
  assert.ok(runtime.memory.currentSelfContext().every((row) => row.provenance))

  // Cross the old 500-message retention boundary without adding memories or
  // sending history to the model, then reopen from the same isolated sandbox.
  for (let i = 0; i < 520; i++) await runtime.conversationStore.appendMessage({ role: i % 2 ? 'assistant' : 'user', text: `fixture ordinary message ${i}` })
  assert.equal((await runtime.conversationStore.listForRecentVisualRecall()).length, 500)
  assert.equal((await runtime.conversationStore.history()).length, 50)
  assert.equal((await runtime.conversationStore.sourceMessage(raw.id)).text, raw.text)
  runtime.close()
  runtime = new PetRuntime({ sandboxRoot: sandbox })
  await runtime.initialize()
  connectFixture()
  assert.equal(runtime.memory.beliefs.current('喝咖啡频率').alternatives[0].value, '每天都会喝咖啡')
  assert.equal((await runtime.conversationStore.sourceMessage(raw.id)).text, raw.text)
  await say('花花你好。')
  assert.doesNotMatch(calls.at(-1).messages[0].content, /CURRENT_UNDERSTANDING/)
  assert.ok(calls.at(-1).messages.length <= 26)
  assert.ok(JSON.stringify(calls.at(-1)).length < 16000)
  console.log('PASS long-life: days 1/7/30/100+, changes, correction, conflict, unknown, expiry, source identity, Dream/Reflection no-new-evidence, restart, bounded greeting')
} finally {
  runtime.close()
  Date.now = realNow
  await rm(sandbox, { recursive: true, force: true })
}
