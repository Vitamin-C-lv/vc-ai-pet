import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalBrain } from '../src/brain/local-brain.js'
import { LocalBrainClient } from '../src/brain/local-brain-client.js'
import { ReasoningHistoryStore } from '../src/brain/reasoning-history-store.js'
import { addReasoningHistory } from '../src/brain/reasoning-history-context.js'
import { estimateContextTokens } from '../src/conversation/context-budget.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-reasoning-history-'))
const runtime = new PetRuntime({ sandboxRoot: root, logger: { info() {}, warn() {} } })
const modelCalls = []
const requests = []

function chatResponse(text) {
  return JSON.stringify({
    reply: text,
    memory: { remember: false, level: 'fact', content: '', importance: 1, keywords: [], confidence: 0, evidence: '' },
    beliefs: [],
  })
}

function queueModelCall(reasoning, content = '{}') {
  modelCalls.push({ reasoning, content })
}

function setFakeFetch(client) {
  client.fetchImpl = async (_url, init) => {
    const call = modelCalls.shift()
    assert.ok(call, 'unexpected Local Brain request')
    const request = JSON.parse(init.body)
    assert.equal(Object.hasOwn(request, 'reasoningStage'), false, 'capture stage must stay out of model request')
    requests.push(request)
    return new Response(JSON.stringify({
      choices: [{
        message: { role: 'assistant', content: call.content, reasoning_content: call.reasoning },
        finish_reason: 'stop',
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

function reply(userText) {
  return runtime.brain.reply({
    identity: runtime.identitySnapshot(),
    state: runtime.snapshot(),
    userText,
    now: Date.UTC(2026, 9, 3, 0, 0, 0),
  })
}

function directClientCall(stage) {
  return runtime.brain.client.chat({
    messages: [{ role: 'system', content: `test ${stage}` }, { role: 'user', content: 'inspect' }],
    reasoningEffort: 'medium',
    maxTokens: 16,
    reasoningStage: stage,
  })
}

try {
  await runtime.initialize()
  assert.ok(runtime.brain.client instanceof LocalBrainClient, 'test must exercise the production LocalBrainClient callback')
  assert.deepEqual(runtime.getDeveloperSettings(), { reasoningDebugEnabled: false })
  setFakeFetch(runtime.brain.client)

  queueModelCall('CHAT_ONE_REASONING', chatResponse('第一轮回复'))
  const first = await runtime.runReasoningTurn('chat-one', () => reply('主人第一轮原话'), { userText: '主人第一轮原话' })
  assert.equal(first.ok, true)
  assert.equal(runtime.getDeveloperReasoningTrace('chat-one').status, 'disabled')
  assert.equal((await runtime.reasoningHistoryStore.getChatHistory())[0].calls[0].text, 'CHAT_ONE_REASONING',
    'raw reasoning is retained even when developer reasoning display is off')

  queueModelCall('VISION_REPLY_REASONING')
  queueModelCall('VISION_STEP_REASONING')
  await runtime.runReasoningTurn('vision-turn', async () => {
    await directClientCall('reply')
    await directClientCall('visual-step')
  }, { userText: '主人发送图片并要求看看' })
  const visionHistory = await runtime.reasoningHistoryStore.getChatHistory()
  assert.deepEqual(visionHistory[1].calls.map(({ stage, text }) => ({ stage, text })), [
    { stage: 'reply', text: 'VISION_REPLY_REASONING' },
    { stage: 'visual-step', text: 'VISION_STEP_REASONING' },
  ], 'reply and vision calls in one completed turn stay grouped in call order')

  queueModelCall('DREAM_ONE_REASONING', '第一次梦境原文')
  const dreamMessages = [
    { role: 'system', content: 'DREAM_OWNER_CONTEXT' },
    { role: 'user', content: '做一次梦境整理' },
  ]
  const firstDreamRequestIndex = requests.length
  const firstDream = await runtime.brain.dreamCompletion({ messages: dreamMessages })
  assert.equal(firstDream.ok, true)
  const firstDreamRequest = requests[firstDreamRequestIndex]
  assert.equal(firstDreamRequest.messages[0].content.includes('PET_PREVIOUS_DREAM_REASONING'), false)
  assert.equal(JSON.stringify(firstDreamRequest.messages).includes('CHAT_ONE_REASONING'), false,
    'dream prompts do not read chat reasoning')
  assert.equal(JSON.stringify(firstDreamRequest.messages).includes('VISION_STEP_REASONING'), false)

  queueModelCall('CHAT_TWO_REASONING', chatResponse('第二轮回复'))
  const second = await runtime.runReasoningTurn('chat-two', () => reply('主人第二轮原话'), { userText: '主人第二轮原话' })
  assert.equal(second.ok, true)
  const secondChatRequest = requests.at(-1)
  assert.match(secondChatRequest.messages[0].content, /PET_PREVIOUS_CHAT_REASONING/)
  assert.match(secondChatRequest.messages[0].content, /CHAT_ONE_REASONING/,
    'the next reply consumes reasoning captured by LocalBrainClient')
  assert.doesNotMatch(JSON.stringify(secondChatRequest.messages), /DREAM_ONE_REASONING/,
    'chat prompts do not read dream reasoning')

  queueModelCall('DREAM_TWO_REASONING', '第二次梦境原文')
  const secondDreamRequestIndex = requests.length
  const secondDream = await runtime.brain.dreamCompletion({ messages: dreamMessages })
  assert.equal(secondDream.ok, true)
  const secondDreamRequest = requests[secondDreamRequestIndex]
  assert.match(secondDreamRequest.messages[0].content, /PET_PREVIOUS_DREAM_REASONING/)
  assert.match(secondDreamRequest.messages[0].content, /DREAM_ONE_REASONING/)
  assert.doesNotMatch(JSON.stringify(secondDreamRequest.messages), /CHAT_ONE_REASONING|VISION_STEP_REASONING/)
  assert.deepEqual((await runtime.reasoningHistoryStore.getDreamHistory()).calls.map(({ stage, text }) => ({ stage, text })), [
    { stage: 'dream', text: 'DREAM_TWO_REASONING' },
  ], 'a successful dream replaces the isolated prior dream with its raw reasoning')

  queueModelCall('CHAT_THREE_REASONING', chatResponse('第三轮回复'))
  await runtime.runReasoningTurn('chat-three', () => reply('主人第三轮原话'), { userText: '主人第三轮原话' })
  queueModelCall('CHAT_FOUR_REASONING', chatResponse('第四轮回复'))
  await runtime.runReasoningTurn('chat-four', () => reply('主人第四轮原话'), { userText: '主人第四轮原话' })
  assert.deepEqual((await runtime.reasoningHistoryStore.getChatHistory()).map(({ turnId }) => turnId), [
    'vision-turn', 'chat-two', 'chat-three', 'chat-four',
  ].slice(-3), 'only the last three successful chat turns remain')

  await runtime.runReasoningTurn('empty-turn', async () => {}, { userText: '空推理回合' })
  const withEmptyTurn = await runtime.reasoningHistoryStore.getChatHistory()
  assert.deepEqual(withEmptyTurn.map(({ turnId }) => turnId), ['chat-three', 'chat-four', 'empty-turn'],
    'a completed turn without reasoning still consumes one of the three history slots')
  assert.deepEqual(withEmptyTurn.at(-1).calls, [])

  queueModelCall('FAILED_TURN_REASONING')
  await assert.rejects(runtime.runReasoningTurn('failed-turn', async () => {
    await directClientCall('reply')
    throw new Error('failed after Local Brain response')
  }, { userText: '失败的主人原话' }), /failed after Local Brain response/)
  assert.equal((await runtime.reasoningHistoryStore.getChatHistory()).some(({ turnId }) => turnId === 'failed-turn'), false,
    'reasoning from a failed callback is not included in completed chat history')

  const reloadedStore = new ReasoningHistoryStore({ sandboxRoot: root })
  await reloadedStore.initialize()
  assert.deepEqual((await reloadedStore.getChatHistory()).map(({ turnId }) => turnId), ['chat-three', 'chat-four', 'empty-turn'],
    'completed chat history survives loading a new store instance')
  assert.match(JSON.stringify(await reloadedStore.getDreamHistory()), /DREAM_TWO_REASONING/,
    'the latest dream reasoning survives loading a new store instance')

  const reloadedBrain = new LocalBrain({
    config: runtime.brain.config,
    memory: runtime.memory,
    logger: { info() {}, warn() {} },
    reasoningDebugStore: runtime.reasoningDebugStore,
    reasoningHistoryStore: reloadedStore,
  })
  setFakeFetch(reloadedBrain.client)
  queueModelCall('CHAT_AFTER_RESTART_REASONING', chatResponse('重启后回复'))
  await reloadedStore.run('chat-after-restart', () => reloadedBrain.reply({
    identity: runtime.identitySnapshot(),
    state: runtime.snapshot(),
    userText: '重启后的主人原话',
    now: Date.UTC(2026, 9, 3, 0, 0, 0),
  }), { userText: '重启后的主人原话' })
  const afterRestartRequest = requests.at(-1)
  assert.match(afterRestartRequest.messages[0].content, /CHAT_THREE_REASONING/)
  assert.match(afterRestartRequest.messages[0].content, /CHAT_FOUR_REASONING/)
  assert.doesNotMatch(JSON.stringify(afterRestartRequest.messages), /VISION_REPLY_REASONING|CHAT_TWO_REASONING/,
    'the next reply after reload uses the persisted three-turn window, including the empty slot')
  assert.doesNotMatch(JSON.stringify(afterRestartRequest.messages), /DREAM_TWO_REASONING/)
  assert.equal(modelCalls.length, 0)

  const ownerContext = 'OWNER_CONTEXT_MUST_REMAIN'
  const currentOwnerText = 'CURRENT_OWNER_MESSAGE_MUST_REMAIN'
  const pressured = addReasoningHistory([
    { role: 'system', content: ownerContext },
    { role: 'user', content: currentOwnerText },
  ], ['oldest', 'middle', 'newest'].map((name) => ({
    turnId: name,
    createdAt: 1_700_000_000_000,
    userText: `owner ${name}`,
    calls: [{ stage: 'reply', text: `${name.toUpperCase()}_REASONING ${'x'.repeat(450)}` }],
  })), { contextWindowTokens: 500, outputReserveTokens: 50 })
  assert.ok(pressured.includedTurns >= 1)
  assert.ok(pressured.droppedTurns >= 1)
  assert.match(pressured.messages[0].content, new RegExp(ownerContext))
  assert.ok(pressured.messages.some(({ role, content }) => role === 'user' && content === currentOwnerText))
  assert.match(pressured.messages[0].content, /NEWEST_REASONING/)
  assert.doesNotMatch(JSON.stringify(pressured.messages), /OLDEST_REASONING/)
  const estimatedRequestTokens = pressured.messages.reduce(
    (sum, message) => sum + estimateContextTokens(message.content) + 8, 0,
  ) + 50
  assert.ok(estimatedRequestTokens <= 500, `history-trimmed prompt exceeds context budget: ${estimatedRequestTokens}`)

  console.log('v0.5 reasoning history context passed')
} finally {
  runtime.close()
  await rm(root, { recursive: true, force: true })
}
