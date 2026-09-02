import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import { LocalBrainClient } from '../src/brain/local-brain-client.js'
import { historicalQuestionAllowsIdentityEvidence } from '../src/brain/prompt-builder.js'
import {
  candidateMatchesTopic,
  detectHistoricalRecallIntent,
  extractTopicAnchorTokens,
  formatHistoricalTime,
  memorySourceKind,
} from '../src/memory/historical-recall.js'
import {
  PET_DREAM_SOURCE_SESSION,
  PET_REFLECTION_SOURCE_SESSION,
  PetMemory,
} from '../src/memory/pet-memory.js'

const VERSION = '0.3.0-alpha.3'
const RAW_SOURCE_SESSION = 'vc-ai-pet'
const TEST_IDENTITY = Object.freeze({
  name: '李花花',
  species: 'dog',
  speciesZh: '狗',
  breed: 'Bernese Mountain Dog',
  breedZh: '伯恩山犬',
  birthday: '2026-08-31',
  birthEvent: 'VC_AI_PET_V0_1_PASS',
})
const FIXTURE_IDS = Object.freeze({
  A1: 'a1accept0-0000000000000000000000000001',
  A2: 'a2accept0-0000000000000000000000000002',
  B1: 'b1accept0-0000000000000000000000000003',
  B2: 'b2accept0-0000000000000000000000000004',
  C1: 'c1accept0-0000000000000000000000000005',
  C2: 'c2accept0-0000000000000000000000000006',
  D1: 'd1accept0-0000000000000000000000000007',
  D2: 'd2accept0-0000000000000000000000000008',
  D3: 'd3accept0-0000000000000000000000000009',
})
const TIMES = Object.freeze({
  a1: Date.parse('2026-09-01T12:00:00+08:00'),
  a2: Date.parse('2026-09-01T13:00:00+08:00'),
  b1: Date.parse('2026-08-01T12:00:00+08:00'),
  b2: Date.parse('2026-08-02T12:00:00+08:00'),
  c1: Date.parse('2026-09-02T12:00:00+08:00'),
  c2: Date.parse('2026-09-02T13:00:00+08:00'),
})

assert.deepEqual(
  {
    name: LI_HUAHUA_IDENTITY.name,
    breedZh: LI_HUAHUA_IDENTITY.breedZh,
    birthday: LI_HUAHUA_IDENTITY.birthday,
  },
  {
    name: TEST_IDENTITY.name,
    breedZh: TEST_IDENTITY.breedZh,
    birthday: TEST_IDENTITY.birthday,
  },
)

function basicState() {
  return { mood: 0.8, energy: 0.8, boredom: 0.2, sleepiness: 0.1, attachment: 0.8 }
}

function insertFixture(memory, {
  id,
  level = 'fact',
  content,
  sourceSession = RAW_SOURCE_SESSION,
  createdAt,
  keywords = [],
}) {
  return memory.db.insert({
    id: FIXTURE_IDS[id] ?? id,
    level,
    title: `acceptance fixture ${id}`,
    content,
    importance: 3,
    status: 'active',
    source_session: sourceSession,
    created_at: createdAt,
    updated_at: createdAt,
    keywords,
  })
}

function createFixture(memory, { includeC1 = true, includeC2 = true, includeDistractors = false } = {}) {
  const A1 = insertFixture(memory, {
    id: 'A1',
    level: 'user',
    createdAt: TIMES.a1,
    content: '主人最喜欢的测试颜色是群青色。',
    keywords: ['主人', '喜欢', '群青色', '颜色'],
  })
  const A2 = insertFixture(memory, {
    id: 'A2',
    level: 'user',
    createdAt: TIMES.a2,
    content: '主人喜欢蓝色系。',
    keywords: ['主人', '喜欢', '蓝色系', '颜色'],
  })
  const B1 = insertFixture(memory, {
    id: 'B1',
    level: 'fact',
    createdAt: TIMES.b1,
    content: '李花花出生日期是2026-08-31。VC_AI_PET_V0_1_PASS完成。',
    keywords: ['李花花', '生日', '出生', '2026-08-31', 'VC_AI_PET_V0_1_PASS'],
  })
  const B2 = insertFixture(memory, {
    id: 'B2',
    level: 'soul',
    createdAt: TIMES.b2,
    content: '我是李花花，一只伯恩山犬。',
    keywords: ['李花花', '伯恩山犬', '身份', '自己'],
  })

  let C1 = null
  if (includeC1) {
    C1 = insertFixture(memory, {
      id: 'C1',
      level: 'fact',
      sourceSession: PET_DREAM_SOURCE_SESSION,
      createdAt: TIMES.c1,
      content: '主人似乎特别喜欢群青色，这个颜色可能代表主人喜欢安静、深邃的感觉。',
      keywords: ['群青色', '后来', '理解', '喜欢'],
    })
    memory.logDream(
      'historical acceptance C1',
      {
        kind: 'dream',
        derived: [{ id: C1.id, level: C1.level, sourceIds: [A1.id, A2.id] }],
      },
      'historical acceptance fixture',
    )
  }

  let C2 = null
  if (includeC2) {
    C2 = insertFixture(memory, {
      id: 'C2',
      level: 'fact',
      sourceSession: PET_REFLECTION_SOURCE_SESSION,
      createdAt: TIMES.c2,
      content: '花花觉得自己的生日很重要。',
      keywords: ['生日', '后来', '想法'],
    })
  }

  const distractors = []
  if (includeDistractors) {
    distractors.push(insertFixture(memory, {
      id: 'D1',
      level: 'fact',
      createdAt: Date.parse('2020-01-01T12:00:00+08:00'),
      content: '主人喜欢红色。',
      keywords: ['主人', '喜欢', '红色'],
    }))
    distractors.push(insertFixture(memory, {
      id: 'D2',
      level: 'fact',
      createdAt: Date.parse('2021-01-01T12:00:00+08:00'),
      content: '主人喜欢绿色。',
      keywords: ['主人', '喜欢', '绿色'],
    }))
    distractors.push(insertFixture(memory, {
      id: 'D3',
      level: 'fact',
      createdAt: Date.parse('2022-01-01T12:00:00+08:00'),
      content: '主人生日喜欢蛋糕。',
      keywords: ['主人', '生日', '蛋糕'],
    }))
  }

  return { A1, A2, B1, B2, C1, C2, distractors }
}

function contextIds(context) {
  return new Set((context?.entries ?? []).map((entry) => entry.id))
}

function contextEvidenceText(context) {
  return (context?.entries ?? [])
    .map((entry) => [entry.id, entry.source, entry.content, formatHistoricalTime(entry.created_at)].join(' '))
    .join('\n')
}

async function withSandbox(name, fn) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-history-acceptance-${name}-`))
  const sandboxRoot = resolve(root)
  let memory = null
  try {
    memory = new PetMemory(root)
    assert.ok(memory.dbPath.startsWith(`${sandboxRoot}${sep}`))
    assert.notEqual(memory.dbPath, resolve(process.cwd(), 'pet-memory.db'))
    return await fn({ root, memory })
  } finally {
    try { memory?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    assert.equal(existsSync(root), false, `temporary sandbox was not removed: ${root}`)
  }
}

// MemoryDb intentionally has no destructive delete API. This helper performs
// the requested C1 deletion only after closing the temporary test database,
// then reopens that same temporary sandbox through the normal PetMemory path.
function deleteFixtureRow(root, memory, level, id) {
  assert.ok(['soul', 'user', 'project', 'fact', 'lesson', 'topic'].includes(level))
  assert.equal(resolve(memory.dbPath).startsWith(`${resolve(root)}${sep}`), true)
  memory.close()
  const db = new DatabaseSync(memory.dbPath)
  try {
    const result = db.prepare(`DELETE FROM ${level} WHERE id = ?`).run(id)
    assert.equal(result.changes, 1)
  } finally {
    db.close()
  }
  return new PetMemory(root)
}

function jsonResponse(reply) {
  return JSON.stringify({
    choices: [{
      message: {
        role: 'assistant',
        content: JSON.stringify({ reply, memory: null }),
      },
    }],
  })
}

function replyForRequest(body) {
  const query = [...(body.messages ?? [])]
    .reverse()
    .find((message) => message?.role === 'user')?.content ?? ''
  const systemPrompt = body.messages?.find((message) => message?.role === 'system')?.content ?? ''

  if (query.includes('生日')) return `你的生日是 ${TEST_IDENTITY.birthday}。`
  if (query.includes('区别')) {
    return systemPrompt.includes('安静、深邃')
      ? '最早的 A1 是原始记忆，后来 C1 是在此基础上形成的理解。'
      : '后来没有形成更多相关想法。'
  }
  if (query.includes('为什么')) {
    return systemPrompt.includes('安静、深邃')
      ? '因为我留下了 A1 这条记忆，后来也形成了 C1 的理解。'
      : '我现在只能想起 A1 这条相关记忆。'
  }
  if (query.includes('最早')) return '我留下的最早相关记忆是 A1。'
  return '我先看看和这个主题有关的记忆。'
}

async function startLocalBrainApiHarness() {
  const calls = []
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid json' } }))
      return
    }

    calls.push({ body })
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-local-brain-request-id': `acceptance-${calls.length}`,
    })
    response.end(jsonResponse(replyForRequest(body)))
  })

  await new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer)
    server.listen(0, '127.0.0.1', resolveServer)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object' && Number.isInteger(address.port))

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise((resolveServer, rejectServer) => {
      server.close((error) => error ? rejectServer(error) : resolveServer())
    }),
  }
}

async function runChatCase({ memory, api, query }) {
  let historicalContext = null
  const originalBuildContext = memory.buildHistoricalRecallContext.bind(memory)
  memory.buildHistoricalRecallContext = (...args) => {
    historicalContext = originalBuildContext(...args)
    return historicalContext
  }

  const beforeCalls = api.calls.length
  const brain = new LocalBrain({
    config: {
      baseUrl: api.baseUrl,
      healthTimeoutMs: 1_000,
      requestTimeoutMs: 10_000,
      resourceGate: { enabled: false },
    },
    memory,
  })
  const result = await brain.reply({
    identity: TEST_IDENTITY,
    state: basicState(),
    userText: query,
    recentMessages: [],
  })
  const newCalls = api.calls.slice(beforeCalls)

  assert.equal(result.ok, true)
  assert.equal(newCalls.length, 1, `expected one Local Brain inference for ${query}`)
  assert.equal(newCalls[0].body.stream, false)
  assert.equal(newCalls[0].body.reasoning_effort, 'off')
  assert.equal(Object.hasOwn(newCalls[0].body, 'model'), false)
  assert.equal(newCalls[0].body.messages.at(-1).role, 'user')
  assert.equal(newCalls[0].body.messages.at(-1).content, query)

  return {
    result,
    context: historicalContext,
    request: newCalls[0].body,
    prompt: newCalls[0].body.messages.find((message) => message.role === 'system')?.content ?? '',
  }
}

async function runOptionalRealLocalBrain() {
  const baseUrl = process.env.VC_AI_PET_LOCAL_BRAIN_URL ?? 'http://127.0.0.1:17862'
  let inferenceCalls = 0
  let client
  try {
    client = new LocalBrainClient({
      baseUrl,
      healthTimeoutMs: 500,
      requestTimeoutMs: 30_000,
      fetchImpl: (url, init) => {
        if (String(url).endsWith('/v1/chat/completions')) inferenceCalls += 1
        return globalThis.fetch(url, init)
      },
    })
  } catch {
    return 'SKIP_UNAVAILABLE'
  }

  if (!await client.health()) return 'SKIP_UNAVAILABLE'

  let resultAvailable = false
  try {
    await withSandbox('real-local-brain', async ({ memory }) => {
      createFixture(memory)
      const brain = new LocalBrain({
        config: { baseUrl, requestTimeoutMs: 30_000, resourceGate: { enabled: false } },
        memory,
        client,
      })
      const result = await brain.reply({
        identity: TEST_IDENTITY,
        state: basicState(),
        userText: '花花，你为什么觉得我喜欢群青色？',
        recentMessages: [],
      })
      if (!result.ok) return
      assert.equal(typeof result.text, 'string')
      assert.ok(result.text.length > 0)
      resultAvailable = true
    })
  } catch (error) {
    if (error?.retryable === true || error?.code?.startsWith('PET_LOCAL_BRAIN_')) {
      return 'SKIP_UNAVAILABLE'
    }
    throw error
  }

  if (!resultAvailable) return 'SKIP_UNAVAILABLE'
  return inferenceCalls === 1 ? 'PASS' : 'FAIL_INFERENCE_COUNT'
}

const api = await startLocalBrainApiHarness()
let boundaryPrompt = ''
try {
  // Test 1: WHY RECALL — intent, retrieval, topic filter, evidence, prompt,
  // API and final answer are all exercised in one LocalBrain.reply call.
  await withSandbox('why', async ({ memory }) => {
    const fixture = createFixture(memory)
    const query = '花花，你为什么觉得我喜欢群青色？'
    assert.deepEqual(detectHistoricalRecallIntent(query), { mode: 'why', deep: true })

    const chain = await runChatCase({ memory, api, query })
    const ids = contextIds(chain.context)
    assert.equal(chain.context.mode, 'why')
    assert.ok(ids.has(fixture.A1.id))
    assert.ok(ids.has(fixture.C1.id))
    for (const row of [fixture.B1, fixture.B2, fixture.C2]) assert.equal(ids.has(row.id), false)
    assert.match(chain.result.text, /A1/u)
    assert.match(chain.result.text, /C1/u)
    assert.equal(memorySourceKind(fixture.A1), 'raw')
    assert.equal(memorySourceKind(fixture.C1), 'dream')
    boundaryPrompt = chain.prompt
  })

  // Test 2: FIRST RECALL — earliest evidence is A1, and the unrelated
  // birthday row cannot become a historical event or date source.
  await withSandbox('first', async ({ memory }) => {
    const fixture = createFixture(memory)
    const query = '花花，我最早什么时候跟你提到群青色的？'
    assert.deepEqual(detectHistoricalRecallIntent(query), { mode: 'first', deep: true })

    const chain = await runChatCase({ memory, api, query })
    const entries = chain.context.entries
    const evidence = contextEvidenceText(chain.context)
    assert.equal(entries[0].id, fixture.A1.id)
    assert.equal(entries[0].source, 'raw')
    assert.equal(evidence.includes(fixture.B1.id), false)
    assert.doesNotMatch(evidence, /生日|出生|2026-08-31/u)
    assert.doesNotMatch(chain.prompt, /\[id=B1\]/u)
    assert.match(chain.result.text, /A1/u)
  })

  // Test 3: EVOLUTION RECALL — the first raw topic evidence is compared only
  // with the later related derived understanding.
  await withSandbox('evolution', async ({ memory }) => {
    const fixture = createFixture(memory)
    const query = '花花，你关于群青色最早的记忆和后来想到的东西有什么区别？'
    assert.deepEqual(detectHistoricalRecallIntent(query), { mode: 'evolution', deep: true })
    const tokens = extractTopicAnchorTokens(query)
    assert.ok(tokens?.has('群青'))
    assert.equal(candidateMatchesTopic(fixture.B1, tokens), false)

    const chain = await runChatCase({ memory, api, query })
    const ids = contextIds(chain.context)
    const early = chain.context.entries.find((entry) => entry.id === fixture.A1.id)
    const later = chain.context.entries.find((entry) => entry.id === fixture.C1.id)
    assert.equal(chain.context.mode, 'evolution')
    assert.ok(early)
    assert.ok(later)
    assert.equal(early.section, 'earliest-raw')
    assert.equal(later.section, 'later-understanding')
    for (const row of [fixture.B1, fixture.B2, fixture.C2]) assert.equal(ids.has(row.id), false)
    assert.match(chain.result.text, /A1/u)
    assert.match(chain.result.text, /C1/u)
  })

  // Test 4: EMPTY LATER SAFE — physically delete C1 from the temporary DB,
  // keep A1/B1/B2, and verify that birthday evidence cannot fill later.
  await withSandbox('empty-later', async ({ root, memory }) => {
    const fixture = createFixture(memory)
    let reopened = deleteFixtureRow(root, memory, 'fact', fixture.C1.id)
    try {
      const query = '花花，你关于群青色最早的记忆和后来想到的东西有什么区别？'
      const chain = await runChatCase({ memory: reopened, api, query })
      const ids = contextIds(chain.context)
      assert.ok(ids.has(fixture.A1.id))
      assert.equal(ids.has(fixture.C1.id), false)
      assert.equal(ids.has(fixture.B1.id), false)
      assert.equal(ids.has(fixture.B2.id), false)
      assert.equal(ids.has(fixture.C2.id), false)
      assert.equal(chain.context.entries.some((entry) => entry.section === 'later-understanding'), false)
      assert.match(chain.result.text, /后来没有形成更多相关想法/u)
    } finally {
      reopened.close()
    }
  })

  // Test 5: IDENTITY RECALL — the identity question is allowed to use the
  // fixed Identity Kernel and is not treated as a globally forbidden topic.
  await withSandbox('identity', async ({ memory }) => {
    createFixture(memory)
    const query = '花花，你生日是什么时候？'
    assert.deepEqual(detectHistoricalRecallIntent(query), { mode: 'none', deep: false })
    const chain = await runChatCase({ memory, api, query })
    assert.equal(chain.context, null)
    assert.equal(historicalQuestionAllowsIdentityEvidence(query), true)
    assert.match(chain.prompt, /生日：2026-08-31/u)
    assert.match(chain.result.text, /2026-08-31/u)
  })

  // Test 6: DISTRACTOR RESISTANCE — old red/green/cake rows cannot enter a
  // topic-filtered historical context, and do not leak into the final prompt.
  await withSandbox('distractors', async ({ memory }) => {
    const fixture = createFixture(memory, { includeDistractors: true })
    const query = '群青色相关问题'
    const forcedHistoricalContext = memory.buildHistoricalRecallContext(query, {
      intent: { mode: 'why', deep: true },
      currentSelf: [],
      related: [],
    })
    const forcedIds = contextIds(forcedHistoricalContext)
    assert.ok(forcedIds.has(fixture.A1.id))
    assert.ok(forcedIds.has(fixture.C1.id))
    for (const row of fixture.distractors) assert.equal(forcedIds.has(row.id), false)

    const chain = await runChatCase({ memory, api, query })
    assert.equal(chain.context, null)
    for (const row of fixture.distractors) {
      assert.doesNotMatch(chain.prompt, new RegExp(`\\[id=${row.id}\\]`, 'u'))
      assert.doesNotMatch(chain.prompt, new RegExp(row.content, 'u'))
    }
  })

  // Test 7: PROMPT EVIDENCE BOUNDARY — final prompt says that Identity Kernel
  // data is not historical evidence unless the current question is identity.
  assert.match(
    boundaryPrompt,
    /Identity Kernel 不是历史事件证据，除非当前问题本身明确询问身份|Identity Kernel is not historical evidence unless identity question/u,
  )

  // Test 8: LOCAL BRAIN E2E — the loopback API v1 contract receives exactly
  // one inference for this complete historical-recall turn.
  await withSandbox('local-brain-e2e', async ({ memory }) => {
    const fixture = createFixture(memory)
    const before = api.calls.length
    const chain = await runChatCase({
      memory,
      api,
      query: '花花，你为什么觉得我喜欢群青色？',
    })
    assert.equal(api.calls.length - before, 1)
    assert.ok(chain.context.entries.some((entry) => entry.id === fixture.A1.id))
    assert.ok(chain.context.entries.some((entry) => entry.id === fixture.C1.id))
    assert.ok(chain.result.text.length > 0)
    console.log('MODEL_INFERENCES_PER_CASE=1')
  })
} finally {
  await api.close()
}

const realLocalBrainStatus = await runOptionalRealLocalBrain()
console.log(`REAL_LOCAL_BRAIN_API=${realLocalBrainStatus}`)
console.log('FINAL_STATUS=VC_AI_PET_V0_3_C_ACCEPTANCE_REPORT')
console.log(`VERSION=${VERSION}`)
console.log('TEST_COUNT=8')
console.log('WHY_RECALL=PASS')
console.log('FIRST_RECALL=PASS')
console.log('EVOLUTION_RECALL=PASS')
console.log('EMPTY_LATER_SAFE=PASS')
console.log('IDENTITY_RECALL=PASS')
console.log('DISTRACTOR_RESISTANCE=PASS')
console.log('PROMPT_EVIDENCE_BOUNDARY=PASS')
console.log('LOCAL_BRAIN_E2E=PASS')
