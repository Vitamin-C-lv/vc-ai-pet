import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import {
  buildPetMessages,
  formatHistoricalRecallContext,
  historicalQuestionAllowsIdentityEvidence,
} from '../src/brain/prompt-builder.js'
import {
  candidateMatchesTopic,
  detectHistoricalRecallIntent,
  extractTopicAnchorTokens,
  formatHistoricalTime,
  HISTORICAL_LINEAGE_MAX_DEPTH,
  HISTORICAL_LINEAGE_MAX_NODES,
  HISTORICAL_SEARCH_MAX,
  memorySourceKind,
} from '../src/memory/historical-recall.js'
import {
  PET_DREAM_SOURCE_SESSION,
  PET_DREAM_WINDOW,
  PET_REFLECTION_SOURCE_SESSION,
  PET_REFLECTION_WINDOW,
  PetMemory,
} from '../src/memory/pet-memory.js'
import {
  provenanceForDerived as readProvenanceForDerived,
  readDreamLog,
} from '../src/memory/dream-provenance.js'

const NOW = Date.parse('2033-05-18T12:00:00+08:00')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = NOW - 4 * DAY
const T1 = NOW - 3 * DAY
const T2 = NOW - 2 * DAY
const T3 = NOW - DAY
const T4 = NOW - HOUR
const SOURCE_SESSION = 'vc-ai-pet'
const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

function clone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function snapshotRows(memory) {
  return LEVELS
    .flatMap((level) => memory.db.list(level, {}))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((row) => clone(row))
}

function snapshotWindows(memory) {
  return {
    dream: clone(memory.dreamWindow()),
    reflection: clone(memory.reflectionWindow()),
  }
}

function rowById(memory, id) {
  for (const level of LEVELS) {
    const row = memory.db.list(level, {}).find((candidate) => String(candidate.id) === String(id))
    if (row) return row
  }
  return null
}

function insertRow(
  memory,
  {
    id,
    level = 'fact',
    content = `fixture memory ${id}`,
    title = '',
    importance = 2,
    status = 'active',
    sourceSession = SOURCE_SESSION,
    createdAt = NOW,
    updatedAt = createdAt,
    keywords = [],
  },
) {
  return memory.db.insert({
    id,
    level,
    title,
    content,
    importance,
    status,
    source_session: sourceSession,
    created_at: createdAt,
    updated_at: updatedAt,
    keywords,
  })
}

function insertDerived(memory, { id, sourceSession, content, createdAt, level = 'fact' }) {
  return insertRow(memory, {
    id,
    level,
    title: `${sourceSession === PET_DREAM_SOURCE_SESSION ? 'dream' : 'reflection'}:not-authoritative-prefix`,
    content,
    importance: 3,
    sourceSession,
    createdAt,
    updatedAt: createdAt,
    keywords: ['群青色', '历史', '来源'],
  })
}

function createRecallFixture(memory, { includeSearchFillers = false } = {}) {
  const unrelated = insertRow(memory, {
    id: 'history-unrelated',
    content: '完全无关的天气记录，与颜色偏好没有关系。',
    keywords: ['天气', '无关'],
    createdAt: T0,
  })
  const rawA = insertRow(memory, {
    id: 'history-raw-a',
    content: '主人第一次提到自己喜欢群青色。',
    keywords: ['主人', '喜欢', '群青色', '颜色'],
    createdAt: T1,
  })
  const rawB = insertRow(memory, {
    id: 'history-raw-b',
    content: '主人后来又提到群青色，说这个颜色让他很开心。',
    keywords: ['主人', '群青色', '颜色', '开心'],
    createdAt: T2,
  })
  const rules = insertRow(memory, {
    id: 'history-rule-color',
    level: 'rules',
    content: '规则：群青色只是安全测试词，不是生活历史。',
    keywords: ['群青色', '规则'],
    createdAt: T2,
  })
  const archived = insertRow(memory, {
    id: 'history-archived',
    content: '已归档的群青色历史记录。',
    keywords: ['群青色', '归档'],
    status: 'archived',
    createdAt: T3,
  })
  const reflection = insertDerived(memory, {
    id: 'history-reflection',
    sourceSession: PET_REFLECTION_SOURCE_SESSION,
    content: '后来形成的反思：主人可能喜欢群青色。',
    createdAt: T3,
  })
  const dream = insertDerived(memory, {
    id: 'history-dream',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    content: '后来形成的理解：我觉得主人很喜欢群青色。',
    createdAt: T4,
    level: 'user',
  })

  const fillers = []
  if (includeSearchFillers) {
    for (let index = 0; index < 14; index += 1) {
      fillers.push(insertRow(memory, {
        id: `history-filler-${String(index + 1).padStart(2, '0')}`,
        content: `另一条包含群青色的历史记录 ${index + 1}。`,
        keywords: ['群青色', '历史', String(index + 1)],
        createdAt: T0 + index * 1000,
      }))
    }
  }

  return { unrelated, rawA, rawB, rules, archived, reflection, dream, fillers }
}

function createEvolutionFixture(memory, { includeDream = true } = {}) {
  const rawBirthday = insertRow(memory, {
    id: 'evolution-raw-birthday',
    level: 'fact',
    content: '李花花的生日是 2026-08-31；VC_AI_PET_V0_1_PASS 正式通过，作为出生纪念日。',
    keywords: ['李花花', '生日', 'VC_AI_PET_V0_1_PASS'],
    createdAt: T0,
  })
  const rawColorA = insertRow(memory, {
    id: 'evolution-raw-color-a',
    level: 'topic',
    content: '主人最喜欢的测试颜色是群青色',
    keywords: ['主人', '喜欢', '群青色', '颜色'],
    createdAt: T1,
    updatedAt: T4,
  })
  const rawColorB = insertRow(memory, {
    id: 'evolution-raw-color-b',
    level: 'topic',
    content: '主人最喜欢的测试颜色',
    // A compressed summary may omit the subject in content while retaining
    // its topic anchor in keywords.
    keywords: ['主人', '喜欢', '群青色', '颜色'],
    createdAt: T2,
  })
  const birthdaySoul = insertRow(memory, {
    id: 'evolution-soul-birthday',
    level: 'soul',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    content: '我记得自己的生日是 2026-08-31。',
    keywords: ['自己', '生日', '身份'],
    createdAt: T4,
  })
  let dreamColor = null
  if (includeDream) {
    dreamColor = insertDerived(memory, {
      id: 'evolution-dream-color',
      sourceSession: PET_DREAM_SOURCE_SESSION,
      content: '后来形成的理解：主人似乎很喜欢群青色。',
      createdAt: T3,
      level: 'user',
    })
    memory.logDream(
      'evolution color provenance',
      {
        kind: 'dream',
        derived: [{
          id: dreamColor.id,
          level: dreamColor.level,
          sourceIds: [rawColorA.id, rawColorB.id],
        }],
      },
      'evolution fixture',
    )
  }
  return { rawBirthday, rawColorA, rawColorB, birthdaySoul, dreamColor }
}

async function withMemory(name, fn, { counters = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-v0.3-history-${name}-`))
  let memory
  const provenanceReader = counters
    ? {
        provenanceForDerived: (derivedId) => {
          counters.provenanceReads += 1
          return readProvenanceForDerived(derivedId, { dbPath: memory.dbPath })
        },
      }
    : null

  memory = new PetMemory(root, provenanceReader ? { provenanceReader } : {})

  try {
    return await fn({ root, memory, counters })
  } finally {
    memory.close()
    await rm(root, { recursive: true, force: true })
  }
}

function basicState() {
  return { mood: .8, energy: .8, boredom: .2, sleepiness: .1, attachment: .8 }
}

function clientResponse(reply = '收到啦。') {
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

function contextText(context) {
  return (context?.entries ?? []).map((entry) => `${entry.id} ${entry.source} ${entry.content}`).join('\n')
}

// Intent routing is deterministic and precedence-sensitive: why wins over
// first/when when one question contains more than one historical cue.
{
  const cases = [
    [null, { mode: 'none', deep: false }],
    ['', { mode: 'none', deep: false }],
    ['你为什么觉得我喜欢这个？', { mode: 'why', deep: true }],
    ['我第一次什么时候告诉你的？', { mode: 'first', deep: true }],
    ['我什么时候说过这个？', { mode: 'when', deep: true }],
    ['我当时具体说了什么？', { mode: 'exact', deep: true }],
    ['以前的你是什么样？', { mode: 'past', deep: true }],
    ['今天陪我玩', { mode: 'none', deep: false }],
  ]

  for (const [text, expected] of cases) {
    assert.deepEqual(detectHistoricalRecallIntent(text), expected)
  }
  assert.equal(detectHistoricalRecallIntent('你为什么觉得我最早提过这个？').mode, 'why')
  assert.equal(detectHistoricalRecallIntent('为什么今天开心？').mode, 'none')
  assert.equal(detectHistoricalRecallIntent('  我以前问过什么？  ').mode, 'past')
  assert.deepEqual(
    detectHistoricalRecallIntent('花花，你关于群青色最早的记忆和后来想到的东西有什么区别？'),
    { mode: 'evolution', deep: true },
  )

  const evolutionTopicTokens = extractTopicAnchorTokens('花花，你关于群青色最早的记忆和后来想到的东西有什么区别？')
  assert.ok(evolutionTopicTokens instanceof Set)
  assert.deepEqual([...evolutionTopicTokens], ['群青', '青色'])
  console.log('EVOLUTION_TOPIC_ANCHOR=PASS')

  console.log('HISTORICAL_RECALL_INTENT=PASS')
}

// Normal chat keeps the existing recall(query, 5) hot path and must not touch
// the deeper historical reader or prompt section.
{
  const counters = {
    recallCalls: 0,
    historicalSearchCalls: 0,
    historicalContextCalls: 0,
    provenanceReads: 0,
    dreamLogReads: 0,
    clientChatCalls: 0,
  }
  const recallArgs = []
  let capturedRequest = null
  const memory = {
    recall: (query, k) => {
      counters.recallCalls += 1
      recallArgs.push({ query, k })
      return []
    },
    historicalSearch: () => {
      counters.historicalSearchCalls += 1
      throw new Error('normal chat must not call historicalSearch')
    },
    buildHistoricalRecallContext: () => {
      counters.historicalContextCalls += 1
      throw new Error('normal chat must not build historical context')
    },
    provenanceForDerived: () => {
      counters.provenanceReads += 1
      throw new Error('normal chat must not read provenance')
    },
    readDreamLog: () => {
      counters.dreamLogReads += 1
      throw new Error('normal chat must not read dream_log')
    },
    stableRulesContext: () => [],
    currentSelfContext: () => [],
  }
  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory,
    client: {
      chat: async (request) => {
        counters.clientChatCalls += 1
        capturedRequest = request
        return clientResponse()
      },
    },
  })

  const query = '花花今天开心吗？'
  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: basicState(),
    userText: query,
    recentMessages: [],
  })

  assert.equal(result.ok, true)
  assert.equal(counters.recallCalls, 1)
  assert.deepEqual(recallArgs, [{ query, k: 5 }])
  assert.equal(counters.historicalSearchCalls, 0)
  assert.equal(counters.historicalContextCalls, 0)
  assert.equal(counters.provenanceReads, 0)
  assert.equal(counters.dreamLogReads, 0)
  assert.equal(counters.clientChatCalls, 1)
  assert.doesNotMatch(capturedRequest.messages[0].content, /历史回忆模式|RAW_CHAT_HISTORY_PERSISTED/u)

  console.log('NORMAL_CHAT_HISTORICAL_SCAN=0')
  console.log('NORMAL_CHAT_DREAM_LOG_READS=0')
}

// Historical search is bounded, excludes rules, keeps all statuses by default,
// can exclude derived rows, preserves row metadata, and does not bump hits.
await withMemory('search', async ({ memory }) => {
  const fixture = createRecallFixture(memory)
  const before = snapshotRows(memory)
  const rows = memory.historicalSearch('群青色', { k: 99 })

  assert.ok(rows.length <= HISTORICAL_SEARCH_MAX)
  assert.ok(rows.every((row) => row.level !== 'rules'))
  assert.ok(rows.some((row) => row.id === fixture.rawA.id))
  assert.ok(rows.some((row) => row.status === 'archived'))
  assert.ok(rows.some((row) => row.source_session === PET_DREAM_SOURCE_SESSION))
  assert.ok(rows.some((row) => row.source_session === PET_REFLECTION_SOURCE_SESSION))
  for (const row of rows) {
    for (const field of [
      'id',
      'level',
      'content',
      'importance',
      'status',
      'source_session',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(Object.hasOwn(row, field), `historical row must retain ${field}`)
    }
  }
  assert.deepEqual(snapshotRows(memory), before)

  const rawOnly = memory.historicalSearch('群青色', {
    k: HISTORICAL_SEARCH_MAX,
    includeDerived: false,
  })
  assert.ok(rawOnly.length > 0)
  assert.ok(rawOnly.every((row) => (
    row.source_session !== PET_DREAM_SOURCE_SESSION &&
    row.source_session !== PET_REFLECTION_SOURCE_SESSION
  )))
  assert.ok(rawOnly.some((row) => row.id === fixture.rawA.id))
  assert.ok(rawOnly.some((row) => row.status === 'archived'))
  assert.ok(rawOnly.every((row) => row.level !== 'rules'))
  assert.deepEqual(snapshotRows(memory), before)

  assert.equal(memorySourceKind(fixture.rawA), 'raw')
  assert.equal(memorySourceKind(fixture.reflection), 'reflection')
  assert.equal(memorySourceKind(fixture.dream), 'dream')
  assert.equal(memorySourceKind({ source_session: null }), 'historical')

  console.log('HISTORICAL_SEARCH_SCOPE=PASS')
  console.log('HISTORICAL_SEARCH_MAX=12')
  console.log('HISTORICAL_SEARCH_READ_ONLY=PASS')
})

await withMemory('search-cap', async ({ memory }) => {
  createRecallFixture(memory, { includeSearchFillers: true })
  const rows = memory.historicalSearch('群青色', { k: 99 })
  assert.equal(rows.length, HISTORICAL_SEARCH_MAX)
  assert.ok(rows.every((row) => row.level !== 'rules'))

  console.log('HISTORICAL_SEARCH_CAP=PASS')
})

// Semantic retrieval precedes temporal ordering. An unrelated older row must
// not become the answer to first; when/past remain chronologically ordered.
await withMemory('temporal', async ({ memory }) => {
  const fixture = createRecallFixture(memory)
  const firstContext = memory.buildHistoricalRecallContext('群青色', {
    intent: detectHistoricalRecallIntent('我第一次什么时候告诉你的？'),
    currentSelf: [],
    related: [],
  })
  const firstEntries = firstContext.entries
  assert.ok(firstEntries.length > 0)
  assert.equal(firstEntries[0].id, fixture.rawA.id)
  assert.equal(firstEntries[0].source, 'raw')
  assert.ok(!firstEntries.some((entry) => entry.id === fixture.unrelated.id))
  assert.match(firstEntries[0].created_at === T1 ? formatHistoricalTime(T1) : '', /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u)
  assert.ok(firstEntries.length <= 16)

  const whenContext = memory.buildHistoricalRecallContext('群青色', {
    intent: detectHistoricalRecallIntent('我什么时候说过这个？'),
    currentSelf: [],
    related: [],
  })
  const whenIds = whenContext.entries.map((entry) => entry.id)
  const rawAIndex = whenIds.indexOf(fixture.rawA.id)
  const rawBIndex = whenIds.indexOf(fixture.rawB.id)
  assert.ok(rawAIndex >= 0)
  assert.ok(rawBIndex >= 0)
  assert.ok(rawAIndex < rawBIndex)
  assert.equal(whenContext.entries[rawAIndex].source, 'raw')
  assert.equal(whenContext.entries[rawBIndex].source, 'raw')
  assert.equal(whenContext.entries.length <= 16, true)

  console.log('FIRST_RECALL=PASS')
  console.log('WHEN_RECALL=PASS')
  console.log('RAW_SOURCE_PRIORITY=PASS')
})

// Evolution keeps a relevant semantic cluster before applying chronology:
// early raw evidence is compared with later derived understanding, while an
// older identity/birthday row cannot enter merely because it is old.
await withMemory('evolution', async ({ memory }) => {
  const fixture = createEvolutionFixture(memory)
  const q3 = '花花，你关于群青色最早的记忆和后来想到的东西有什么区别？'
  const topicTokens = extractTopicAnchorTokens(q3)
  assert.equal(candidateMatchesTopic(fixture.rawColorA, topicTokens), true)
  assert.equal(candidateMatchesTopic(fixture.rawColorB, topicTokens), true)
  assert.equal(candidateMatchesTopic(fixture.dreamColor, topicTokens), true)
  assert.equal(candidateMatchesTopic(fixture.rawBirthday, topicTokens), false)
  assert.equal(candidateMatchesTopic(fixture.birthdaySoul, topicTokens), false)
  const q3Context = memory.buildHistoricalRecallContext(q3, {
    intent: detectHistoricalRecallIntent(q3),
    currentSelf: [fixture.birthdaySoul],
    related: [fixture.birthdaySoul],
  })
  const q3Ids = q3Context.entries.map((entry) => entry.id)
  assert.equal(q3Context.mode, 'evolution')
  assert.deepEqual(q3Context.topicTokens, [...topicTokens])
  assert.ok(q3Ids.includes(fixture.rawColorA.id))
  assert.ok(q3Ids.includes(fixture.rawColorB.id))
  assert.ok(q3Ids.includes(fixture.dreamColor.id))
  assert.equal(q3Ids.includes(fixture.rawBirthday.id), false)
  assert.equal(q3Ids.includes(fixture.birthdaySoul.id), false)
  assert.equal(q3Context.entries[0].id, fixture.rawColorA.id)
  assert.equal(q3Context.entries[0].section, 'earliest-raw')
  assert.equal(
    q3Context.entries.find((entry) => entry.id === fixture.dreamColor.id).section,
    'later-understanding',
  )
  assert.ok(
    q3Context.entries.find((entry) => entry.id === fixture.rawColorA.id).created_at < fixture.dreamColor.created_at,
  )

  const q2 = '花花，我最早什么时候跟你提到群青色的？'
  const q2Context = memory.buildHistoricalRecallContext(q2, {
    intent: detectHistoricalRecallIntent(q2),
    currentSelf: [],
    related: [],
  })
  assert.equal(q2Context.mode, 'first')
  assert.equal(q2Context.entries[0].id, fixture.rawColorA.id)
  assert.equal(q2Context.entries[0].source, 'raw')
  assert.equal(q2Context.entries.some((entry) => entry.id === fixture.rawBirthday.id), false)
  assert.equal(q2Context.entries[0].created_at, T1)
  assert.equal(q2Context.entries[0].updated_at, T4)
  assert.match(formatHistoricalRecallContext(q2Context), new RegExp(`\\[created=${formatHistoricalTime(T1)}\\]`))

  const q1 = '花花，你为什么觉得我喜欢群青色？'
  const q1Context = memory.buildHistoricalRecallContext(q1, {
    intent: detectHistoricalRecallIntent(q1),
    currentSelf: [],
    related: [],
  })
  assert.equal(q1Context.mode, 'why')
  assert.ok(q1Context.entries.some((entry) => entry.id === fixture.rawColorA.id && entry.source === 'raw'))
  assert.ok(q1Context.entries.some((entry) => entry.id === fixture.dreamColor.id && entry.source === 'dream'))
  assert.equal(q1Context.entries.some((entry) => entry.id === fixture.rawBirthday.id), false)

  const q3Prompt = formatHistoricalRecallContext(q3Context)
  assert.match(q3Prompt, /HISTORICAL MODE: EVOLUTION/u)
  assert.match(q3Prompt, /TOPIC: 群青色/u)
  assert.match(q3Prompt, /EARLIEST RELEVANT RAW MEMORY/u)
  assert.match(q3Prompt, /LATER RELATED UNDERSTANDING/u)
  assert.match(q3Prompt, /SOURCE EVIDENCE/u)
  assert.match(q3Prompt, /evolution-raw-color-a/u)
  assert.match(q3Prompt, /evolution-dream-color/u)
  assert.doesNotMatch(q3Prompt, /evolution-raw-birthday|VC_AI_PET_V0_1_PASS/u)

  console.log('RELEVANCE_BEFORE_TEMPORAL_SORT=PASS')
  console.log('UNRELATED_EARLY_MEMORY_EXCLUDED=PASS')
  console.log('EVOLUTION_RAW_TOPIC_FILTER=PASS')
  console.log('EVOLUTION_DERIVED_TOPIC_FILTER=PASS')
  console.log('UNRELATED_BIRTHDAY_EXCLUDED=PASS')
  console.log('Q1_WHY_AUTO=PASS')
  console.log('Q2_FIRST_AUTO=PASS')
  console.log('Q3_EVOLUTION_AUTO=PASS')
  console.log('EVOLUTION_RECALL=PASS')
  console.log('EARLIEST_RAW=evolution-raw-color-a')
  console.log('LATER_DERIVED=evolution-dream-color')
})

// No relevant later derived memory means an explicitly empty later section;
// identity rows are never substituted to manufacture an evolution.
await withMemory('evolution-empty-later', async ({ memory }) => {
  const fixture = createEvolutionFixture(memory, { includeDream: false })
  const query = '花花，你关于群青色最早的记忆和后来想到的东西有什么区别？'
  const context = memory.buildHistoricalRecallContext(query, {
    intent: detectHistoricalRecallIntent(query),
    currentSelf: [fixture.birthdaySoul],
    related: [fixture.birthdaySoul],
  })
  const ids = context.entries.map((entry) => entry.id)
  assert.ok(ids.includes(fixture.rawColorA.id))
  assert.ok(ids.includes(fixture.rawColorB.id))
  assert.equal(ids.includes(fixture.rawBirthday.id), false)
  assert.equal(ids.includes(fixture.birthdaySoul.id), false)
  assert.equal(context.entries.some((entry) => entry.section === 'later-understanding'), false)
  assert.match(formatHistoricalRecallContext(context), /不要为了比较引入别的主题/u)

  console.log('EVOLUTION_EMPTY_LATER_SAFE=PASS')
})

// Topic isolation is scoped to the historical question. A birthday question
// must still retrieve birthday evidence normally.
await withMemory('identity-topic', async ({ memory }) => {
  const fixture = createEvolutionFixture(memory)
  const query = '花花，你最早什么时候知道自己生日的？'
  const topicTokens = extractTopicAnchorTokens(query)
  const context = memory.buildHistoricalRecallContext(query, {
    intent: detectHistoricalRecallIntent(query),
    currentSelf: [fixture.birthdaySoul],
    related: [fixture.birthdaySoul],
  })
  assert.deepEqual(detectHistoricalRecallIntent(query), { mode: 'first', deep: true })
  assert.ok(topicTokens?.has('生日'))
  assert.equal(candidateMatchesTopic(fixture.rawBirthday, topicTokens), true)
  assert.ok(context.entries.some((entry) => entry.id === fixture.rawBirthday.id))

  console.log('IDENTITY_TOPIC_RECALL=PASS')
})

// Past-self recall uses old and new self rows as temporal evidence without
// changing either row or deciding a contradiction in the database.
await withMemory('past-self', async ({ memory }) => {
  const oldSelf = insertRow(memory, {
    id: 'past-self-old',
    level: 'soul',
    sourceSession: 'seed',
    content: '以前的我更黏主人，总想靠近主人。',
    keywords: ['以前', '黏', '主人', '靠近'],
    createdAt: T1,
  })
  const newSelf = insertRow(memory, {
    id: 'past-self-new',
    level: 'soul',
    sourceSession: 'seed',
    content: '后来现在的我仍然陪着主人，但变得更安静。',
    keywords: ['后来', '现在', '主人', '安静'],
    createdAt: T3,
  })
  const beforeRows = snapshotRows(memory)
  const beforeWindows = snapshotWindows(memory)
  const context = memory.buildHistoricalRecallContext('主人 黏 靠近', {
    intent: detectHistoricalRecallIntent('以前的你是什么样？'),
    currentSelf: [newSelf],
    related: [oldSelf],
  })
  const ids = context.entries.map((entry) => entry.id)
  assert.ok(ids.includes(oldSelf.id))
  assert.ok(ids.includes(newSelf.id))
  assert.ok(ids.indexOf(oldSelf.id) < ids.indexOf(newSelf.id))
  assert.ok(context.entries.length <= 16)
  assert.deepEqual(snapshotRows(memory), beforeRows)
  assert.deepEqual(snapshotWindows(memory), beforeWindows)

  console.log('PAST_SELF_RECALL=PASS')
  console.log('CONTRADICTION_HANDLING=TEMPORAL_READ_ONLY')
})

// Why recall follows the authoritative dream_log derived entry, not the
// shortened title prefix, and exposes raw/reflection/dream as short labels.
await withMemory('why-provenance', async ({ memory, counters }) => {
  const fixture = createRecallFixture(memory)
  memory.logDream(
    '群青色 dream provenance',
    {
      kind: 'dream',
      sourceIds: ['wrong-top-level-id'],
      derived: [{ id: fixture.dream.id, level: fixture.dream.level, sourceIds: [fixture.rawA.id, fixture.rawB.id] }],
    },
    'test why provenance',
  )

  const provenance = memory.provenanceForDerived(fixture.dream.id)
  assert.equal(provenance.kind, 'dream')
  assert.deepEqual(provenance.sourceIds, [fixture.rawA.id, fixture.rawB.id])
  assert.ok(readDreamLog(memory.dbPath).some((log) => String(log.changes).includes(fixture.rawA.id)))

  const context = memory.buildHistoricalRecallContext('群青色', {
    intent: detectHistoricalRecallIntent('你为什么觉得我喜欢这个？'),
    currentSelf: [],
    related: [fixture.dream],
  })
  const entriesById = new Map(context.entries.map((entry) => [entry.id, entry]))
  assert.ok(entriesById.has(fixture.dream.id))
  assert.ok(entriesById.has(fixture.rawA.id))
  assert.ok(entriesById.has(fixture.rawB.id))
  assert.equal(entriesById.get(fixture.dream.id).source, 'dream')
  assert.equal(entriesById.get(fixture.rawA.id).source, 'raw')
  assert.equal(entriesById.get(fixture.rawB.id).source, 'raw')
  assert.ok(counters.provenanceReads >= 1)
  assert.ok(context.entries.length <= 16)

  console.log('WHY_RECALL=PASS')
}, { counters: { provenanceReads: 0 } })

// Recursive lineage is depth-first, root-first, bounded, and cycle-safe.
await withMemory('recursive-lineage', async ({ memory }) => {
  const rawA = insertRow(memory, {
    id: 'lineage-raw-a',
    content: 'lineage raw A：主人喜欢群青色。',
    keywords: ['lineage', '群青色'],
    createdAt: T1,
  })
  const rawB = insertRow(memory, {
    id: 'lineage-raw-b',
    content: 'lineage raw B：主人又提到群青色。',
    keywords: ['lineage', '群青色'],
    createdAt: T2,
  })
  const reflection = insertDerived(memory, {
    id: 'lineage-reflection',
    sourceSession: PET_REFLECTION_SOURCE_SESSION,
    content: 'lineage reflection：主人似乎喜欢群青色。',
    createdAt: T3,
  })
  const dream = insertDerived(memory, {
    id: 'lineage-dream',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    content: 'lineage dream：我形成了这个理解。',
    createdAt: T4,
    level: 'user',
  })
  memory.logReflection(
    'lineage reflection',
    { kind: 'reflection', derived: [{ id: reflection.id, level: reflection.level, sourceIds: [rawA.id] }] },
    'test recursive reflection',
  )
  memory.logDream(
    'lineage dream',
    { kind: 'dream', derived: [{ id: dream.id, level: dream.level, sourceIds: [rawB.id, reflection.id] }] },
    'test recursive dream',
  )

  const lineage = memory.resolveMemoryLineage(dream.id, {
    maxDepth: HISTORICAL_LINEAGE_MAX_DEPTH,
    maxNodes: HISTORICAL_LINEAGE_MAX_NODES,
  })
  assert.deepEqual(lineage.nodes.map((node) => node.id), [dream.id, rawB.id, reflection.id, rawA.id])
  assert.deepEqual(lineage.nodes.map((node) => node.kind), ['dream', 'raw', 'reflection', 'raw'])
  assert.equal(lineage.provenanceAvailable, true)
  assert.equal(lineage.truncated, false)
  assert.equal(lineage.cycleDetected, false)
  assert.ok(lineage.nodes.every((node) => node.depth <= 3))

  const depthBounded = memory.resolveMemoryLineage(dream.id, { maxDepth: 1, maxNodes: 18 })
  assert.equal(depthBounded.truncated, true)
  assert.ok(depthBounded.nodes.length <= 3)
  assert.equal(depthBounded.nodes.some((node) => node.id === rawA.id), false)
  assert.equal(depthBounded.maxDepth, 1)

  const nodeBounded = memory.resolveMemoryLineage(dream.id, { maxDepth: 3, maxNodes: 2 })
  assert.equal(nodeBounded.truncated, true)
  assert.ok(nodeBounded.nodes.length <= 2)
  assert.equal(nodeBounded.maxNodes, 2)

  const cycleA = insertDerived(memory, {
    id: 'lineage-cycle-a',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    content: 'cycle A',
    createdAt: T3,
  })
  const cycleB = insertDerived(memory, {
    id: 'lineage-cycle-b',
    sourceSession: PET_REFLECTION_SOURCE_SESSION,
    content: 'cycle B',
    createdAt: T4,
  })
  memory.logDream(
    'cycle A',
    { kind: 'dream', derived: [{ id: cycleA.id, level: cycleA.level, sourceIds: [cycleB.id] }] },
    'test cycle A',
  )
  memory.logReflection(
    'cycle B',
    { kind: 'reflection', derived: [{ id: cycleB.id, level: cycleB.level, sourceIds: [cycleA.id] }] },
    'test cycle B',
  )
  const cycle = memory.resolveMemoryLineage(cycleA.id, { maxDepth: 3, maxNodes: 18 })
  assert.equal(cycle.cycleDetected, true)
  assert.ok(cycle.nodes.length <= 18)
  assert.equal(new Set(cycle.nodes.map((node) => node.id)).size, cycle.nodes.length)

  const context = memory.buildHistoricalRecallContext('群青色', {
    intent: { mode: 'why', deep: true },
    currentSelf: [],
    related: [dream],
  })
  const contextIds = new Set(context.entries.map((entry) => entry.id))
  for (const id of [dream.id, rawB.id, reflection.id, rawA.id]) assert.ok(contextIds.has(id))
  assert.ok(context.entries.length <= 16)

  console.log('RECURSIVE_LINEAGE=PASS')
})

// Missing and malformed provenance remain best-effort: the semantic derived
// memory survives, while the result carries an explicit unavailable marker.
await withMemory('missing-provenance', async ({ memory }) => {
  const missing = insertDerived(memory, {
    id: 'missing-provenance-dream',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    content: '缺少 provenance 的群青色理解。',
    createdAt: T3,
  })
  const missingContext = memory.buildHistoricalRecallContext('缺少 provenance', {
    intent: { mode: 'why', deep: true },
    currentSelf: [],
    related: [missing],
  })
  assert.equal(missingContext.provenanceUnavailable, true)
  assert.ok(missingContext.provenanceUnavailableIds.includes(missing.id))
  assert.ok(missingContext.entries.some((entry) => entry.id === missing.id && entry.source === 'dream'))
  assert.equal(missingContext.entries.some((entry) => entry.id === 'not-authoritative-prefix'), false)

  const malformed = insertDerived(memory, {
    id: 'malformed-provenance-dream',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    content: 'malformed provenance 的群青色理解。',
    createdAt: T4,
  })
  memory.logDream('malformed provenance', '{not valid json', 'test malformed provenance')
  const malformedContext = memory.buildHistoricalRecallContext('malformed provenance', {
    intent: { mode: 'why', deep: true },
    currentSelf: [],
    related: [malformed],
  })
  assert.equal(malformedContext.provenanceUnavailable, true)
  assert.ok(malformedContext.provenanceUnavailableIds.includes(malformed.id))
  assert.ok(malformedContext.entries.some((entry) => entry.id === malformed.id))

  console.log('MISSING_PROVENANCE=PASS')
})

// Historical Recall is a read path. Existing rows, both independent windows,
// and dream_log remain byte-for-byte equivalent across search/lineage/context.
await withMemory('read-only', async ({ memory }) => {
  const fixture = createRecallFixture(memory)
  memory.ensureDreamTracking()
  memory.ensureReflectionTracking()
  memory.finishDream(T1)
  memory.finishReflection(T2)
  memory.logDream(
    'read-only fixture',
    { kind: 'dream', derived: [{ id: fixture.dream.id, level: fixture.dream.level, sourceIds: [fixture.rawA.id] }] },
    'read-only fixture',
  )

  const beforeRows = snapshotRows(memory)
  const beforeWindows = snapshotWindows(memory)
  const beforeLogs = clone(readDreamLog(memory.dbPath))
  const context = memory.buildHistoricalRecallContext('群青色', {
    intent: { mode: 'when', deep: true },
    currentSelf: [],
    related: [fixture.dream],
  })
  assert.ok(context.entries.length <= 16)
  assert.deepEqual(snapshotRows(memory), beforeRows)
  assert.deepEqual(snapshotWindows(memory), beforeWindows)
  assert.deepEqual(clone(readDreamLog(memory.dbPath)), beforeLogs)
  assert.equal(memory.dreamWindow().last_dream_time, T1)
  assert.equal(memory.reflectionWindow().last_dream_time, T2)

  console.log('RAW_MEMORY_HISTORY_PRESERVED=PASS')
  console.log('CHECKPOINTS_INDEPENDENT=PASS')
  console.log('DREAM_LOG_READ_ONLY=PASS')
})

// The prompt explicitly distinguishes compressed memories from raw chat
// transcript and keeps the current user message last.
{
  const raw = {
    id: 'prompt-history-raw',
    level: 'fact',
    source: 'raw',
    status: 'active',
    created_at: T1,
    updated_at: T1,
    content: 'memory summary: 主人喜欢群青色。',
  }
  const messages = buildPetMessages({
    identity: LI_HUAHUA_IDENTITY,
    state: basicState(),
    stableRules: [],
    currentSelfContext: [],
    memories: [],
    historicalRecallContext: {
      mode: 'exact',
      entries: [raw],
    },
    recentMessages: [{ role: 'assistant', content: '上一句回答' }],
    userText: '我当时具体说了什么？',
    now: new Date(NOW),
  })
  const systemPrompt = messages[0].content
  assert.match(systemPrompt, /历史回忆模式：/u)
  assert.match(systemPrompt, /RAW_CHAT_HISTORY_PERSISTED=NO/u)
  assert.match(systemPrompt, /不要声称逐字引用主人原话/u)
  assert.match(systemPrompt, /不是持久化的原始聊天转录/u)
  assert.match(systemPrompt, /\[source=raw\]/u)
  assert.match(systemPrompt, new RegExp(`\\[created=${formatHistoricalTime(T1)}\\]`))
  assert.doesNotMatch(systemPrompt, /vc-ai-pet(?::(?:dream|reflection))?/u)
  assert.equal(messages.at(-1).role, 'user')
  assert.equal(messages.at(-1).content, '我当时具体说了什么？')

  console.log('EXACT_RECALL=PASS')
  console.log('RAW_CHAT_HISTORY_PERSISTED=NO')
}

// Historical time answers use the retrieved created_at evidence even though
// the fixed Identity Kernel remains visible in the same system prompt.
{
  const q2 = '花花，我最早什么时候跟你提到群青色的？'
  const q2CreatedAt = Date.parse('2026-09-01T12:00:00+08:00')
  const q2Messages = buildPetMessages({
    identity: LI_HUAHUA_IDENTITY,
    state: basicState(),
    stableRules: [],
    currentSelfContext: [],
    memories: [],
    historicalRecallContext: {
      mode: 'first',
      topicTokens: ['群青', '青色'],
      entries: [{
        id: 'q2-time-raw',
        level: 'topic',
        source: 'raw',
        status: 'active',
        created_at: q2CreatedAt,
        updated_at: Date.parse('2026-09-02T12:00:00+08:00'),
        content: '主人最喜欢的测试颜色是群青色',
      }],
    },
    recentMessages: [],
    userText: q2,
    now: new Date('2026-09-02T12:00:00+08:00'),
  })
  const q2Prompt = q2Messages[0].content
  assert.equal(historicalQuestionAllowsIdentityEvidence(q2), false)
  assert.match(q2Prompt, /生日是 2026-08-31/u)
  assert.match(q2Prompt, /EVIDENCE AUTHORITY:/u)
  assert.match(q2Prompt, /唯一历史事件证据/u)
  assert.match(q2Prompt, /Identity Kernel 不是历史事件证据/u)
  assert.match(q2Prompt, /IDENTITY_EVIDENCE_SCOPE=BACKGROUND_ONLY/u)
  assert.match(q2Prompt, /TIME_SOURCE=historical evidence created_at only/u)
  assert.match(q2Prompt, new RegExp(`\\[created=${formatHistoricalTime(q2CreatedAt)}\\]`))
  assert.match(q2Prompt, /不能作为历史事件的时间、原因或发生背景证据/u)
  assert.match(q2Prompt, /不要自行把历史日期与生日、纪念日或其他身份事件关联/u)

  console.log('HISTORICAL_TIME_EVIDENCE_ONLY=PASS')
  console.log('IDENTITY_BIRTHDAY_NOT_EVENT_EVIDENCE=PASS')
}

// Identity questions retain the fixed Identity Kernel path; the boundary is
// scoped to unrelated historical-event questions rather than a global ban.
{
  const identityQuestion = '花花，你生日是什么时候？'
  const identityMessages = buildPetMessages({
    identity: LI_HUAHUA_IDENTITY,
    state: basicState(),
    stableRules: [],
    currentSelfContext: [],
    memories: [],
    recentMessages: [],
    userText: identityQuestion,
    now: new Date('2026-09-02T12:00:00+08:00'),
  })
  const identityPrompt = identityMessages[0].content
  assert.equal(historicalQuestionAllowsIdentityEvidence(identityQuestion), true)
  assert.match(identityPrompt, /生日是 2026-08-31/u)
  assert.match(identityPrompt, /生日：2026-08-31/u)

  console.log('IDENTITY_BIRTHDAY_RECALL=PASS')
}

// Full historical chat integration still performs one and only one Local
// Brain inference; retrieval and provenance are local preparation only.
await withMemory('one-inference', async ({ memory, counters }) => {
  const fixture = createRecallFixture(memory)
  memory.logDream(
    'one inference provenance',
    { kind: 'dream', derived: [{ id: fixture.dream.id, level: fixture.dream.level, sourceIds: [fixture.rawA.id, fixture.rawB.id] }] },
    'one inference fixture',
  )
  const beforeRows = snapshotRows(memory)

  const originalHistoricalSearch = memory.historicalSearch.bind(memory)
  const originalBuildContext = memory.buildHistoricalRecallContext.bind(memory)
  let historicalSearchCalls = 0
  let historicalContextCalls = 0
  memory.historicalSearch = (...args) => {
    historicalSearchCalls += 1
    return originalHistoricalSearch(...args)
  }
  memory.buildHistoricalRecallContext = (...args) => {
    historicalContextCalls += 1
    return originalBuildContext(...args)
  }

  let clientChatCalls = 0
  let capturedRequest = null
  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory,
    client: {
      chat: async (request) => {
        clientChatCalls += 1
        capturedRequest = request
        return clientResponse('我记得一些依据啦。')
      },
    },
  })

  const query = '你为什么觉得我喜欢群青色？'
  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: basicState(),
    userText: query,
    recentMessages: [{ role: 'user', content: '上一句' }, { role: 'assistant', content: '上一答' }],
  })
  assert.equal(result.ok, true)
  assert.equal(clientChatCalls, 1)
  assert.equal(historicalContextCalls, 1)
  assert.equal(historicalSearchCalls, 1)
  assert.ok(counters.provenanceReads >= 1)
  assert.equal(capturedRequest.messages.at(-1).role, 'user')
  assert.equal(capturedRequest.messages.at(-1).content, query)
  const systemPrompt = capturedRequest.messages[0].content
  assert.match(systemPrompt, /历史回忆模式：/u)
  assert.match(systemPrompt, /目标：WHY/u)
  assert.match(systemPrompt, /RAW_CHAT_HISTORY_PERSISTED=NO/u)
  assert.match(systemPrompt, /\[source=raw\]/u)
  assert.match(systemPrompt, /\[source=dream\]/u)
  assert.match(systemPrompt, /与你当前对话相关的历史记忆：\n- 暂无相关长期记忆/u)
  assert.match(systemPrompt, /history-raw-a/u)
  assert.match(systemPrompt, /history-raw-b/u)
  assert.match(systemPrompt, /history-dream/u)
  assert.doesNotMatch(systemPrompt, /vc-ai-pet:dream/u)
  assert.equal((systemPrompt.match(/历史回忆模式：/gu) ?? []).length, 1)
  assert.ok(contextText(memory.buildHistoricalRecallContext(query, {
    intent: { mode: 'why', deep: true },
    currentSelf: [],
    related: [fixture.dream],
  })).length > 0)
  assert.deepEqual(snapshotRows(memory), beforeRows)

  console.log('MODEL_INFERENCES_PER_CHAT=1')
  console.log('FULL_MEMORY_CONTEXT_INJECTION=NO')
  console.log('HISTORICAL_RECALL_READ_ONLY=PASS')
}, { counters: { provenanceReads: 0 } })

assert.equal(HISTORICAL_LINEAGE_MAX_DEPTH, 3)
assert.equal(HISTORICAL_LINEAGE_MAX_NODES, 18)
assert.equal(HISTORICAL_SEARCH_MAX, 12)

console.log('VC_AI_PET_V0_3_HISTORICAL_RECALL_SMOKE=PASS')
