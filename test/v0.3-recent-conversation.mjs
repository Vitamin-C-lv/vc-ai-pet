import assert from 'node:assert/strict'
import { RecentConversation } from '../src/conversation/recent-conversation.js'
import { buildPetMessages } from '../src/brain/prompt-builder.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'

const recent = new RecentConversation({ maxTurns: 2 })

assert.equal(recent.size, 0)

assert.equal(
  recent.append('第一句', '第一答'),
  true,
)

assert.equal(
  recent.append('第二句', '第二答'),
  true,
)

assert.equal(recent.size, 2)

assert.deepEqual(
  recent.messages().map(({ role, content }) => ({ role, content })),
  [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: '第一答' },
    { role: 'user', content: '第二句' },
    { role: 'assistant', content: '第二答' },
  ],
)

recent.append('第三句', '第三答')

assert.equal(recent.size, 2)

assert.deepEqual(
  recent.snapshot(),
  [
    { user: '第二句', assistant: '第二答' },
    { user: '第三句', assistant: '第三答' },
  ],
)

const messages = buildPetMessages({
  identity: LI_HUAHUA_IDENTITY,
  state: {
    mood: 0.8,
    energy: 0.8,
    boredom: 0.2,
    sleepiness: 0.1,
    attachment: 0.8,
  },
  memories: [],
  recentMessages: recent.messages(),
  userText: '现在这一句',
  now: new Date(2026, 8, 2),
})

assert.equal(messages[0].role, 'system')

assert.deepEqual(
  messages.slice(1).map(({ role, content }) => ({ role, content })),
  [
    { role: 'user', content: '第二句' },
    { role: 'assistant', content: '第二答' },
    { role: 'user', content: '第三句' },
    { role: 'assistant', content: '第三答' },
    { role: 'user', content: '现在这一句' },
  ],
)

assert.equal(
  messages.at(-1).content,
  '现在这一句',
)

{
  let capturedMessages
  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory: {
      recall: () => [],
      stableIdentityContext: () => [],
    },
    client: {
      chat: async ({ messages: requestMessages }) => {
        capturedMessages = requestMessages
        return {
          payload: {
            choices: [{
              message: {
                role: 'assistant',
                content: JSON.stringify({ reply: '收到啦。', memory: null }),
              },
            }],
          },
        }
      },
    },
  })

  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: { mood: 0.8, energy: 0.8, boredom: 0.2, sleepiness: 0.1, attachment: 0.8 },
    recentMessages: recent.messages(),
    userText: 'Local Brain 当前句',
  })

  assert.equal(result.ok, true)
  assert.deepEqual(
    capturedMessages.slice(1, -1).map(({ role, content }) => ({ role, content })),
    [
      { role: 'user', content: '第二句' },
      { role: 'assistant', content: '第二答' },
      { role: 'user', content: '第三句' },
      { role: 'assistant', content: '第三答' },
    ],
  )
  assert.equal(capturedMessages.at(-1).content, 'Local Brain 当前句')
}

{
  const runtime = new PetRuntime({ sandboxRoot: '/tmp/vc-ai-pet-v0.3-recent-test' })
  runtime.identity = LI_HUAHUA_IDENTITY
  runtime.state = {
    mood: 0.8,
    energy: 0.8,
    boredom: 0.2,
    sleepiness: 0.1,
    attachment: 0.8,
  }

  const calls = []
  runtime.memoryGate = {
    consider: (userText, candidate) => {
      calls.push({ userText, candidate })
      return { status: 'skipped' }
    },
  }
  runtime.brain = {
    reply: async ({ recentMessages }) => {
      calls.push({ recentMessages })
      return { ok: true, text: `回复 ${calls.filter((call) => call.recentMessages).length}`, rawMemoryCandidate: null }
    },
  }

  const first = await runtime.chat('第一轮')
  assert.equal(first.ok, true)
  assert.equal(runtime.conversation.size, 1)

  const second = await runtime.chat('第二轮')
  assert.equal(second.ok, true)
  assert.equal(runtime.conversation.size, 2)
  assert.deepEqual(calls[2].recentMessages, [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '回复 1' },
  ])

  runtime.brain.reply = async ({ recentMessages }) => {
    calls.push({ recentMessages })
    return { ok: false, unavailable: true, reason: 'local-brain-unavailable' }
  }
  const failed = await runtime.chat('失败轮')
  assert.equal(failed.ok, false)
  assert.equal(runtime.conversation.size, 2)

  runtime.close()
  assert.equal(runtime.conversation.size, 0)
}

recent.clear()

assert.equal(recent.size, 0)

console.log('VC_AI_PET_V0_3_RECENT_CONVERSATION_SMOKE=PASS')
