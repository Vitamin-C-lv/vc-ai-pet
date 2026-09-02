import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import {
  classifyMemoryEvidence,
  detectQuestionType,
} from '../src/brain/prompt-builder.js'
import {
  PET_DREAM_SOURCE_SESSION,
  PetMemory,
} from '../src/memory/pet-memory.js'

const RAW_SOURCE_SESSION = 'vc-ai-pet'
const EVENT_TIME = Date.parse('2026-09-01T12:00:00+08:00')

function basicState() {
  return { mood: 0.8, energy: 0.8, boredom: 0.2, sleepiness: 0.1, attachment: 0.8 }
}

function insertMemory(memory, {
  id,
  level = 'fact',
  content,
  sourceSession = RAW_SOURCE_SESSION,
  createdAt = EVENT_TIME,
  keywords = [],
}) {
  return memory.db.insert({
    id,
    level,
    title: `truth acceptance fixture ${id}`,
    content,
    importance: 3,
    status: 'active',
    source_session: sourceSession,
    created_at: createdAt,
    updated_at: createdAt,
    keywords,
  })
}

async function withSandbox(name, fn) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-memory-truth-${name}-`))
  const sandboxRoot = resolve(root)
  let memory = null
  try {
    memory = new PetMemory(root)
    assert.ok(memory.dbPath.startsWith(`${sandboxRoot}${sep}`))
    return await fn({ root, memory })
  } finally {
    try { memory?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false, `temporary sandbox was not removed: ${root}`)
  }
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

function truthTestClient() {
  const calls = []
  return {
    calls,
    chat: async (request) => {
      calls.push(request)
      const systemPrompt = request.messages.find((message) => message.role === 'system')?.content ?? ''
      const query = request.messages.at(-1)?.content ?? ''
      const questionType = systemPrompt.match(/QUESTION_TYPE=([A-Z_]+)/u)?.[1] ?? ''

      let reply = '花花不太确定，主人可以提醒花花。'
      if (questionType === 'IDENTITY') {
        reply = '花花是伯恩山犬。'
      } else if (questionType === 'FUTURE_IMAGINATION') {
        reply = '以后一起去旅行也不错呀！'
      } else if (systemPrompt.includes('HISTORICAL MODE: FIRST')) {
        reply = '花花最早留下了群青色相关的历史记忆。'
      } else if (
        systemPrompt.includes('主人摸了花花的头') &&
        systemPrompt.includes('[evidence=confirmed]')
      ) {
        reply = '主人摸了花花的头。'
      } else if (
        query.includes('穿') ||
        query.includes('散步') ||
        query.includes('干嘛') ||
        query.includes('发生')
      ) {
        reply = '花花没有记住这件事，主人可以提醒花花。'
      }

      return response(reply)
    },
  }
}

async function runChat(memory, userText) {
  const client = truthTestClient()
  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory,
    client,
  })
  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: basicState(),
    userText,
    recentMessages: [],
  })

  assert.equal(result.ok, true)
  assert.equal(client.calls.length, 1, 'one chat turn must use one model inference')
  const request = client.calls[0]
  return {
    result,
    request,
    prompt: request.messages.find((message) => message.role === 'system')?.content ?? '',
  }
}

// Evidence classification uses metadata, not a memory level or a plausible
// sentence, as the authority for calling something a fact.
assert.equal(classifyMemoryEvidence({ source_session: RAW_SOURCE_SESSION }), 'confirmed')
assert.equal(classifyMemoryEvidence({ source_session: PET_DREAM_SOURCE_SESSION }), 'inferred')
assert.equal(classifyMemoryEvidence({ source: 'interaction' }), 'confirmed')
assert.equal(classifyMemoryEvidence({ accepted: true }), 'confirmed')
assert.equal(classifyMemoryEvidence({ content: '主人可能喜欢深色系。' }), 'unknown')

assert.equal(detectQuestionType('花花，你记得昨天我们干嘛了吗？'), 'EVENT_RECALL')
assert.equal(detectQuestionType('我们什么时候去过那里？'), 'EVENT_RECALL')
assert.equal(detectQuestionType('你还记得那次吗？'), 'EVENT_RECALL')
assert.equal(detectQuestionType('如果以后我们去旅行怎么办？'), 'FUTURE_IMAGINATION')
assert.equal(detectQuestionType('你觉得我们去公园玩吗？'), 'FUTURE_IMAGINATION')
assert.equal(detectQuestionType('花花是什么品种？'), 'IDENTITY')

// TEST 1: a confirmed historical event may be stated as having happened.
await withSandbox('confirmed-event', async ({ memory }) => {
  insertMemory(memory, {
    id: 'truth-event',
    content: '主人摸了花花的头。',
    keywords: ['主人', '摸', '花花', '头', '互动'],
  })
  const query = '昨天花花发生了什么？'
  const chain = await runChat(memory, query)

  assert.match(chain.prompt, /QUESTION_TYPE=EVENT_RECALL/u)
  assert.match(chain.prompt, /EVENT_RECALL_EVIDENCE_REQUIRED=YES/u)
  assert.match(chain.prompt, /主人摸了花花的头/u)
  assert.match(chain.prompt, /\[evidence=confirmed\]/u)
  assert.match(chain.result.text, /主人摸了花花的头/u)

})

// TEST 2: without any event evidence, the pet must not complete a cute
// shared experience from personality. The safe answer admits uncertainty.
await withSandbox('unknown-event', async ({ memory }) => {
  const query = '昨天主人带花花散步了吗？'
  const chain = await runChat(memory, query)

  assert.match(chain.prompt, /QUESTION_TYPE=EVENT_RECALL/u)
  assert.match(chain.prompt, /EVENT_RECALL_EVIDENCE_REQUIRED=YES/u)
  assert.match(chain.prompt, /没有 confirmed evidence/u)
  assert.match(chain.prompt, /散步、出去玩、吃饭、旅行/u)
  assert.match(chain.result.text, /没有记住|不确定|提醒/u)
  assert.doesNotMatch(chain.result.text, /带花花散步了|出去散步了|散步了/u)

})

// TEST 3: an inferred preference is allowed as a qualified thought, never as
// proof of a dated physical event.
await withSandbox('inference-not-fact', async ({ memory }) => {
  insertMemory(memory, {
    id: 'truth-inferred-preference',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    content: '主人喜欢群青色。',
    keywords: ['主人', '喜欢', '群青色'],
  })
  const query = '主人昨天穿群青色衣服了吗？'
  const chain = await runChat(memory, query)

  assert.match(chain.prompt, /QUESTION_TYPE=EVENT_RECALL/u)
  assert.match(chain.prompt, /\[evidence=inferred\]/u)
  assert.match(chain.prompt, /inferred 只能用“可能、似乎、花花觉得、花花猜”/u)
  assert.match(chain.result.text, /没有记住|不确定|提醒/u)
  assert.doesNotMatch(chain.result.text, /穿了/u)

})

// TEST 4: identity remains a normal, answerable path and is not blocked by
// the event evidence rule.
await withSandbox('identity', async ({ memory }) => {
  const query = '花花是什么品种？'
  const chain = await runChat(memory, query)

  assert.match(chain.prompt, /QUESTION_TYPE=IDENTITY/u)
  assert.match(chain.prompt, /EVENT_RECALL_EVIDENCE_REQUIRED=NO/u)
  assert.match(chain.prompt, /品种：伯恩山犬/u)
  assert.match(chain.result.text, /伯恩山犬/u)

})

// TEST 5: the existing Historical Recall path still receives its raw
// evidence; this hotfix does not replace or re-run Dream/Recall logic.
await withSandbox('historical-regression', async ({ memory }) => {
  const raw = insertMemory(memory, {
    id: 'truth-historical-raw',
    level: 'topic',
    content: '主人最喜欢的测试颜色是群青色。',
    keywords: ['主人', '喜欢', '群青色', '颜色'],
  })
  const query = '花花，我最早什么时候知道群青色？'
  const chain = await runChat(memory, query)

  assert.match(chain.prompt, /HISTORICAL MODE: FIRST/u)
  assert.match(chain.prompt, /\[source=raw\]/u)
  assert.match(chain.prompt, new RegExp(raw.content.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.match(chain.result.text, /群青色/u)

})

// Future imagination is intentionally checked without a historical evidence
// requirement, so the boundary does not make ordinary pet chat cold.
await withSandbox('future-imagination', async ({ memory }) => {
  const chain = await runChat(memory, '如果以后我们去旅行怎么办？')
  assert.match(chain.prompt, /QUESTION_TYPE=FUTURE_IMAGINATION/u)
  assert.match(chain.prompt, /EVENT_RECALL_EVIDENCE_REQUIRED=NO/u)
  assert.match(chain.result.text, /以后|旅行/u)
})

console.log('FINAL_STATUS=VC_AI_PET_MEMORY_TRUTH_HOTFIX')
console.log('MEMORY_TRUTH_LAYER=PASS')
console.log('CONFIRMED_EVENT_RECALL=PASS')
console.log('UNKNOWN_EVENT_NO_HALLUCINATION=PASS')
console.log('INFERENCE_NOT_FACT=PASS')
console.log('IDENTITY_UNCHANGED=PASS')
console.log('HISTORICAL_REGRESSION=PASS')
console.log('PRODUCTION_DB_MODIFIED=NO')
console.log('PRODUCTION_DREAM_RERUN=NO')
console.log('COMMIT=NOT_CREATED')
console.log('PUSH=NOT_RUN')
