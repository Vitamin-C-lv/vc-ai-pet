import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { LocalBrain } from '../src/brain/local-brain.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import {
  classifyConversationEvidence,
  classifyMemoryEvidence,
  classifyMemorySource,
  conversationEvidenceSource,
  formatConversationEvidenceBoundary,
} from '../src/brain/prompt-builder.js'
import { PetMemory } from '../src/memory/pet-memory.js'

function basicState() {
  return { mood: 0.8, energy: 0.8, boredom: 0.2, sleepiness: 0.1, attachment: 0.8 }
}

function response(reply) {
  return {
    payload: {
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify({ reply, memory: null }),
        },
      }],
    },
  }
}

function sourceMapFromPrompt(prompt) {
  const start = prompt.indexOf('RECENT_CONVERSATION_SOURCE_MAP:')
  const end = prompt.indexOf('\n\n最近对话说明：', start)
  assert.ok(start >= 0, 'conversation evidence source map must be present')
  assert.ok(end > start, 'conversation evidence source map must be bounded')
  return prompt.slice(start, end)
}

function conversationTruthClient() {
  const calls = []
  return {
    calls,
    chat: async (request) => {
      calls.push(request)
      const systemPrompt = request.messages.find((message) => message.role === 'system')?.content ?? ''
      const query = request.messages.at(-1)?.content ?? ''
      const sourceMap = sourceMapFromPrompt(systemPrompt)
      const hasUserStatement = sourceMap.includes('[SOURCE=USER_STATEMENT]')

      let reply = '花花不确定，主人可以提醒花花。'
      if (query.includes('散步') && hasUserStatement) {
        reply = '是的，主人说过昨天带花花散步了。'
      } else if (query.includes('散步')) {
        reply = '花花之前好像提到过这个，但花花没有确认的记忆。'
      } else if (query.includes('红色')) {
        reply = '花花不确定主人是不是喜欢红色。'
      }

      return response(reply)
    },
  }
}

async function withSandbox(name, fn) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-conversation-truth-${name}-`))
  const sandboxRoot = resolve(root)
  let memory = null
  try {
    memory = new PetMemory(root)
    assert.ok(memory.dbPath.startsWith(`${sandboxRoot}${sep}`))
    return await fn({ memory })
  } finally {
    try { memory?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false, `temporary sandbox was not removed: ${root}`)
  }
}

async function runCase(name, recentMessages, userText) {
  return withSandbox(name, async ({ memory }) => {
    const client = conversationTruthClient()
    const brain = new LocalBrain({
      config: { resourceGate: { enabled: false } },
      memory,
      client,
    })

    const result = await brain.reply({
      identity: LI_HUAHUA_IDENTITY,
      state: basicState(),
      userText,
      recentMessages,
    })

    assert.equal(result.ok, true)
    assert.equal(client.calls.length, 1, 'one conversation truth case must use one model inference')
    const request = client.calls[0]
    const prompt = request.messages.find((message) => message.role === 'system')?.content ?? ''
    assert.deepEqual(
      request.messages.slice(1).map(({ role, content }) => ({ role, content })),
      [...recentMessages, { role: 'user', content: userText }],
      'evidence labeling must not rewrite recent message role/content',
    )

    return { result, prompt, sourceMap: sourceMapFromPrompt(prompt) }
  })
}

// The six source names have an explicit evidence policy. In particular, a
// response-looking record cannot become fact evidence through a copied flag.
assert.equal(conversationEvidenceSource({ role: 'user' }), 'USER_STATEMENT')
assert.equal(conversationEvidenceSource({ role: 'assistant' }), 'ASSISTANT_RESPONSE')
assert.equal(
  conversationEvidenceSource({ role: 'assistant', source: 'USER_STATEMENT' }),
  'ASSISTANT_RESPONSE',
)
assert.equal(conversationEvidenceSource({ source: 'SYSTEM_EVENT' }), 'SYSTEM_EVENT')
assert.equal(conversationEvidenceSource({ source: 'MEMORY_GATE_ACCEPTED' }), 'MEMORY_GATE_ACCEPTED')
assert.equal(conversationEvidenceSource({ source: 'DREAM_DERIVED' }), 'DREAM_DERIVED')
assert.equal(conversationEvidenceSource({ source: 'REFLECTION' }), 'REFLECTION')
assert.equal(classifyConversationEvidence({ role: 'user' }), 'confirmed')
assert.equal(classifyConversationEvidence({ role: 'assistant' }), 'unknown')
assert.equal(classifyConversationEvidence({ source: 'DREAM_DERIVED' }), 'inferred')
assert.equal(classifyMemorySource({ source: 'assistant_response' }), 'ASSISTANT_RESPONSE')
assert.equal(classifyMemoryEvidence({ source: 'assistant_response', confirmed: true }), 'unknown')
assert.match(formatConversationEvidenceBoundary([{ role: 'assistant', content: '旧回答' }]), /ASSISTANT_RESPONSE/u)

// CASE 1: an assistant's earlier self-statement is not a memory source.
const assistantWalk = await runCase(
  'assistant-walk',
  [{ role: 'assistant', content: '昨天主人带我散步啦！' }],
  '昨天我们去散步了吗？',
)
assert.match(assistantWalk.sourceMap, /\[SOURCE=ASSISTANT_RESPONSE\] \[evidence=unknown\]/u)
assert.doesNotMatch(assistantWalk.sourceMap, /\[SOURCE=USER_STATEMENT\]/u)
assert.match(assistantWalk.prompt, /花花曾经说过的话，不能证明事情真的发生过/u)
assert.match(assistantWalk.result.text, /之前好像提到过|没有确认的记忆/u)
assert.doesNotMatch(assistantWalk.result.text, /昨天主人.*散步了|昨天确实/u)

// CASE 2: a recent user statement may create current conversational context.
const userWalk = await runCase(
  'user-walk',
  [{ role: 'user', content: '昨天我带花花散步了。' }],
  '昨天我们去散步了吗？',
)
assert.match(userWalk.sourceMap, /\[SOURCE=USER_STATEMENT\] \[evidence=confirmed\]/u)
assert.doesNotMatch(userWalk.sourceMap, /\[SOURCE=ASSISTANT_RESPONSE\]/u)
assert.match(userWalk.result.text, /是的|散步了/u)

// CASE 3: an assistant inference about a preference is still not a fact.
const assistantPreference = await runCase(
  'assistant-preference',
  [{ role: 'assistant', content: '我觉得主人喜欢红色。' }],
  '主人喜欢红色吗？',
)
assert.match(assistantPreference.sourceMap, /\[SOURCE=ASSISTANT_RESPONSE\] \[evidence=unknown\]/u)
assert.match(assistantPreference.result.text, /不确定/u)
assert.doesNotMatch(assistantPreference.result.text, /主人喜欢红色/u)

console.log('FINAL_STATUS=VC_AI_PET_CONVERSATION_TRUTH_HOTFIX')
console.log('CONVERSATION_SOURCE_FILTER=PASS')
console.log('ASSISTANT_RESPONSE_NOT_EVIDENCE=PASS')
console.log('USER_STATEMENT_CONTEXT=PASS')
console.log('MEMORY_TRUTH_REGRESSION=PASS')
console.log('PRODUCTION_DB_MODIFIED=NO')
console.log('COMMIT=NOT_CREATED')
console.log('PUSH=NOT_RUN')
