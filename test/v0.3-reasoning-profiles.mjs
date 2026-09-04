import assert from 'node:assert/strict'

import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import {
  LOCAL_BRAIN_QUEUE_FULL_RETRY_DELAYS_MS,
  LocalBrain,
} from '../src/brain/local-brain.js'
import { PET_REASONING_PROFILE } from '../src/brain/local-brain-config.js'

const IMAGE = { dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn' }

function response(content) {
  return {
    payload: {
      choices: [{ message: { role: 'assistant', content } }],
    },
  }
}

function chatResponse(text = '收到啦。') {
  return response(JSON.stringify({ reply: text, memory: null }))
}

function memory() {
  return {
    recall: () => [],
    stableRulesContext: () => [],
    currentSelfContext: () => [],
  }
}

function state() {
  return { mood: .8, energy: .8, boredom: .1, sleepiness: .1, attachment: .8 }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assertDuration(reasoning, effort, minimum = 0) {
  assert.equal(reasoning.effort, effort)
  assert.equal(Number.isInteger(reasoning.durationMs), true)
  assert.ok(reasoning.durationMs >= minimum, `duration ${reasoning.durationMs}ms < ${minimum}ms`)
}

assert.deepEqual(PET_REASONING_PROFILE, {
  chat: 'low',
  vision: 'medium',
  dream: 'high',
  reflection: 'off',
})

{
  const calls = []
  const brain = new LocalBrain({
    memory: memory(),
    client: {
      chat: async (request) => {
        calls.push(request)
        await wait(120)
        return chatResponse('文字收到啦。')
      },
    },
  })

  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: state(),
    userText: '花花今天开心吗？',
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reasoningEffort, PET_REASONING_PROFILE.chat)
  assertDuration(result.reasoning, PET_REASONING_PROFILE.chat, 90)
  console.log('TEXT_REASONING_LOW=PASS')
  console.log('THINKING_TIMER=PASS')
}

{
  const calls = []
  const brain = new LocalBrain({
    memory: memory(),
    client: {
      chat: async (request) => {
        calls.push(request)
        return chatResponse('图片看到了。')
      },
    },
  })

  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: state(),
    userText: '花花你看看这个。',
    image: IMAGE,
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1, 'vision chat must remain one multimodal inference')
  assert.equal(calls[0].reasoningEffort, PET_REASONING_PROFILE.vision)
  assertDuration(result.reasoning, PET_REASONING_PROFILE.vision)
  console.log('VISION_REASONING_MEDIUM=PASS')
  console.log('MODEL_INFERENCES_PER_CHAT=1')
}

{
  const calls = []
  const brain = new LocalBrain({
    memory: memory(),
    client: {
      chat: async (request) => {
        calls.push(request)
        await wait(25)
        return response(JSON.stringify({ summary: '梦里见到主人。', memories: [] }))
      },
    },
  })

  const result = await brain.dreamCompletion({
    messages: [{ role: 'user', content: '只给长期 memory' }],
    responseFormat: { type: 'json_object' },
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reasoningEffort, PET_REASONING_PROFILE.dream)
  assertDuration(result.reasoning, PET_REASONING_PROFILE.dream, 15)
  console.log('DREAM_REASONING_HIGH=PASS')
}

{
  const calls = []
  const brain = new LocalBrain({
    memory: memory(),
    client: {
      chat: async (request) => {
        calls.push(request)
        return response('{}')
      },
    },
  })

  const result = await brain.reflectionCompletion({
    messages: [{ role: 'user', content: '只给 reflection JSON' }],
    responseFormat: { type: 'json_object' },
  })

  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].reasoningEffort, PET_REASONING_PROFILE.reflection)
  console.log('REFLECTION_REASONING_OFF=PASS')
}

{
  let attempts = 0
  const brain = new LocalBrain({
    memory: memory(),
    client: {
      chat: async () => {
        attempts += 1
        if (attempts === 1) throw { code: 'LOCAL_BRAIN_QUEUE_FULL', retryable: true }
        return chatResponse('排到啦。')
      },
    },
  })

  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: state(),
    userText: '队列重试等待测试',
  })

  assert.equal(attempts, 2)
  assertDuration(result.reasoning, PET_REASONING_PROFILE.chat, LOCAL_BRAIN_QUEUE_FULL_RETRY_DELAYS_MS[0] - 30)
  console.log('THINKING_DURATION_INCLUDES_QUEUE_WAIT=PASS')
}

{
  const runtime = new PetRuntime({ sandboxRoot: '/tmp/vc-ai-pet-v0.3-reasoning-runtime-test' })
  runtime.identity = LI_HUAHUA_IDENTITY
  runtime.state = state()
  runtime.memoryGate = { consider: () => ({ status: 'skipped' }) }
  runtime.brain = {
    reply: async () => ({
      ok: true,
      text: '收到啦。',
      rawMemoryCandidate: null,
      reasoning: { effort: 'low', durationMs: 2784, chainOfThought: 'must not escape' },
    }),
  }

  const result = await runtime.chat('API 元数据测试')
  assert.deepEqual(result.reasoning, { effort: 'low', durationMs: 2784 })
  assert.equal(Object.hasOwn(result.reasoning, 'chainOfThought'), false)
  runtime.close()
  console.log('API_REASONING_METADATA=PASS')
  console.log('CHAIN_OF_THOUGHT_EXPOSED=NO')
}

console.log('FINAL_STATUS=VC_AI_PET_REASONING_PROFILES_PASS')
