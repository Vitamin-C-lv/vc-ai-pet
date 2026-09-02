import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocalBrain } from '../src/brain/local-brain.js'
import { MemoryGate } from '../src/memory/memory-gate.js'
import {
  PET_DREAM_SOURCE_SESSION,
  PET_DREAM_WINDOW,
  PET_REFLECTION_SOURCE_SESSION,
  PET_REFLECTION_WINDOW,
  PetMemory,
} from '../src/memory/pet-memory.js'
import { RecentConversation } from '../src/conversation/recent-conversation.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import {
  DEEP_DREAM_BATCH_NEW_MAX,
  DEEP_DREAM_RELATED_MAX,
  DREAM_BATCH_SIZE,
  DREAM_DERIVED_MAX_PER_BATCH,
  DREAM_RESPONSE_FORMAT,
  DREAM_RELATED_LIMIT,
  buildDreamMessages,
  DreamEngine,
} from '../src/dream/dream-engine.js'
import { DreamGate, validateDreamCandidate } from '../src/dream/dream-gate.js'
import {
  REFLECTION_BATCH_SIZE,
  REFLECTION_DERIVED_MAX_PER_BATCH,
  REFLECTION_RELATED_LIMIT,
  REFLECTION_RESPONSE_FORMAT,
  buildReflectionMessages,
  ReflectionEngine,
  ReflectionGate,
  validateReflectionCandidate,
} from '../src/dream/reflection-engine.js'
import {
  AVAILABILITY_PROBE_MIN_INTERVAL_MS,
  DREAM_MIN_NEW_MEMORIES,
  DREAM_OLDEST_SOURCE_AGE_MS,
  DREAM_OWNER_BUSY_COOLDOWN_MS,
  DEEP_DREAM_DAYTIME_AVAILABILITY_MS,
  DEEP_DREAM_MIN_SLEEP_MS,
  DEEP_DREAM_SUCCESS_COOLDOWN_MS,
  REFLECTION_MIN_INTERVAL_MS,
  REFLECTION_MIN_NEW_RAW_MEMORIES,
  DreamScheduler,
} from '../src/dream/dream-scheduler.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'

const NOW = 2_000_000_000_000
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const SOURCE_SESSION = 'vc-ai-pet'
const CHAT_ONLY_SENTINEL = 'CHAT_ONLY_SENTINEL_NOT_FOR_DREAM'
const MICRO_SLEEP_MIN_MS = 15 * 60 * 1000
const MICRO_GPU_MIN_MS = 45 * 60 * 1000
const MICRO_COOLDOWN_MS = 30 * 60 * 1000
const OWNER_BUSY_COOLDOWN_MS = 15 * 60 * 1000
const NIGHT_NOW = Date.parse('2033-05-18T23:00:00+08:00')
const DAY_NOW = Date.parse('2033-05-18T12:00:00+08:00')
const LEVELS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']

{
  const rawRow = {
    id: 'prompt-raw',
    level: 'fact',
    source_session: 'vc-ai-pet',
    created_at: NOW,
    importance: 2,
    content: 'prompt raw content',
  }
  const reflectionRow = {
    id: 'prompt-reflection',
    level: 'fact',
    source_session: 'vc-ai-pet:reflection',
    created_at: NOW + 1,
    importance: 2,
    content: 'prompt reflection content',
  }
  const dreamRow = {
    id: 'prompt-dream',
    level: 'soul',
    source_session: 'vc-ai-pet:dream',
    created_at: NOW + 2,
    importance: 3,
    content: 'prompt dream content',
  }
  const unknownRow = {
    id: 'prompt-unknown',
    level: 'fact',
    source_session: null,
    created_at: NOW + 3,
    importance: 1,
    content: 'prompt unknown content',
  }

  const dreamPrompt = buildDreamMessages({
    newMemories: [rawRow],
    relatedMemories: [reflectionRow, dreamRow, unknownRow],
  }).map((message) => message.content).join('\n')
  const reflectionPrompt = buildReflectionMessages({
    newMemories: [rawRow],
    relatedMemories: [reflectionRow, dreamRow, unknownRow],
  }).map((message) => message.content).join('\n')

  for (const prompt of [dreamPrompt, reflectionPrompt]) {
    assert.match(prompt, /\[source_session=vc-ai-pet\]/)
    assert.match(prompt, /\[source_session=vc-ai-pet:reflection\]/)
    assert.match(prompt, /\[source_session=vc-ai-pet:dream\]/)
    assert.match(prompt, /\[source_session=unknown\]/)
    assert.match(prompt, /prompt raw content/)
    assert.match(prompt, /prompt reflection content/)
    assert.match(prompt, /prompt dream content/)
  }

  console.log('SOURCE_SESSION_VISIBLE_TO_DREAM_MODEL=PASS')
  console.log('SOURCE_SESSION_VISIBLE_TO_REFLECTION_MODEL=PASS')
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function rowSnapshot(row) {
  return clone(row)
}

function findRow(memory, id) {
  for (const level of LEVELS) {
    const row = memory.db.list(level).find((candidate) => candidate.id === id)
    if (row) return row
  }
  return null
}

function snapshotIds(memory, ids) {
  return ids.map((id) => rowSnapshot(findRow(memory, id)))
}

function dreamLogs(memory) {
  // MemoryDb intentionally has no write-capable dream-log adapter. This is a
  // read-only test inspection of the same temporary SQLite connection.
  return memory.db.db.prepare('SELECT * FROM dream_log ORDER BY id ASC').all()
}

function insertMemory(
  memory,
  {
    id,
    level,
    content = `fixture memory ${id}`,
    importance = 2,
    status = 'active',
    sourceSession = SOURCE_SESSION,
    createdAt,
    updatedAt = createdAt,
    keywords = [],
  },
) {
  const extra = {
    id,
    status,
    source_session: sourceSession,
    created_at: createdAt,
    updated_at: updatedAt,
    keywords,
  }

  if (level === 'project') {
    extra.project = 'fixture-project'
    extra.subcategory = 'overview'
  }

  if (level === 'topic') {
    extra.project = 'fixture-project'
    extra.goal = 'fixture topic goal'
  }

  return memory.remember(level, content, importance, extra)
}

async function withMemory(testName, fn) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-v0.3-dream-${testName}-`))
  const memory = new PetMemory(root)

  try {
    return await fn({ root, memory })
  } finally {
    memory.close()
    await rm(root, { recursive: true, force: true })
  }
}

function dreamEligibility(memory, { now, minNewMemories, oldestSourceAgeMs }) {
  const window = memory.dreamWindow()
  const checkpoint = Number.isFinite(Number(window?.last_dream_time))
    ? Number(window.last_dream_time)
    : 0
  const rows = memory.dreamSourceRows({ after: checkpoint, before: now })
  const oldestCreatedAt = rows[0]?.created_at ?? null
  const oldEnough = oldestCreatedAt !== null && Number(now) - Number(oldestCreatedAt) >= oldestSourceAgeMs

  return {
    eligible: rows.length >= minNewMemories || oldEnough,
    sourceCount: rows.length,
    oldestCreatedAt,
    checkpoint,
    reason: rows.length >= minNewMemories
      ? 'new-source-threshold'
      : oldEnough
        ? 'oldest-source-age'
        : rows.length === 0
          ? 'no-new-sources'
          : 'eligibility-threshold-not-met',
  }
}

async function withSchedulerFixture({ count, ageMs, checkpoint = NOW - 100 * HOUR }, fn) {
  return withMemory(`scheduler-${count}-${ageMs}`, async ({ root, memory }) => {
    const createdAt = NOW - ageMs
    const ids = []

    for (let index = 0; index < count; index += 1) {
      const id = `scheduler-${count}-${String(index + 1).padStart(2, '0')}`
      ids.push(id)
      insertMemory(memory, {
        id,
        level: 'fact',
        content: `scheduler source ${id}`,
        importance: 2,
        createdAt,
      })
    }

    memory.ensureDreamTracking()
    memory.finishDream(checkpoint)

    let now = NOW
    let availability = { available: true, reason: 'available' }
    let availabilityCalls = 0
    let eligibilityCalls = 0
    const runCalls = []

    const brain = {
      checkAvailability: async () => {
        availabilityCalls += 1
        return availability
      },
    }

    const eligibility = (options) => {
      eligibilityCalls += 1
      return dreamEligibility(memory, options)
    }

    const engine = {
      run: async (options) => {
        runCalls.push(options)
        return { status: 'completed', sourceCount: count }
      },
    }

    const scheduler = new DreamScheduler({
      engine,
      memory,
      brain,
      eligibility,
      now: () => now,
    })

    return fn({
      root,
      memory,
      ids,
      engine,
      scheduler,
      brain,
      eligibility,
      runCalls,
      get now() { return now },
      set now(value) { now = value },
      get availability() { return availability },
      set availability(value) { availability = value },
      get availabilityCalls() { return availabilityCalls },
      get eligibilityCalls() { return eligibilityCalls },
    })
  })
}

// A: existing eligible history establishes the Dream event clock without
// rewriting any memory row or mistaking soul/rules/derived rows for sources.
await withMemory('tracking', async ({ root, memory }) => {
  const eligible = insertMemory(memory, {
    id: 'track-eligible',
    level: 'fact',
    importance: 2,
    createdAt: NOW - 5000,
  })
  const beforeRows = snapshotIds(memory, [eligible.id])

  insertMemory(memory, {
    id: 'track-low-importance',
    level: 'fact',
    importance: 1,
    createdAt: NOW - 1000,
  })
  insertMemory(memory, {
    id: 'track-soul',
    level: 'soul',
    importance: 3,
    createdAt: NOW - 500,
  })
  insertMemory(memory, {
    id: 'track-rules',
    level: 'rules',
    importance: 3,
    createdAt: NOW - 400,
  })
  insertMemory(memory, {
    id: 'track-derived',
    level: 'fact',
    importance: 3,
    sourceSession: PET_DREAM_SOURCE_SESSION,
    createdAt: NOW - 100,
  })

  assert.equal(memory.ensureDreamTracking(), NOW - 5000)
  const window = memory.dreamWindow()
  assert.equal(window.session_id, PET_DREAM_WINDOW)
  assert.equal(window.workspace, root)
  assert.equal(window.last_event_time, NOW - 5000)
  assert.equal(window.last_dream_time, null)
  assert.deepEqual(snapshotIds(memory, [eligible.id]), beforeRows)
})

// A: source selection is status/importance/level/source-session/boundary gated
// and deterministic for equal timestamps.
await withMemory('source-selection', async ({ memory }) => {
  insertMemory(memory, { id: 'id-boundary-after', level: 'fact', createdAt: NOW - 6000 })
  insertMemory(memory, { id: 'id-user', level: 'user', createdAt: NOW - 5000 })
  insertMemory(memory, { id: 'id-project', level: 'project', createdAt: NOW - 4000 })
  insertMemory(memory, { id: 'id-fact', level: 'fact', createdAt: NOW - 3000 })
  insertMemory(memory, { id: 'id-lesson', level: 'lesson', createdAt: NOW - 3000 })
  insertMemory(memory, { id: 'id-topic', level: 'topic', createdAt: NOW - 2000 })
  insertMemory(memory, { id: 'id-boundary-before', level: 'fact', createdAt: NOW - 1000 })
  insertMemory(memory, { id: 'id-after-before', level: 'fact', createdAt: NOW - 500 })

  insertMemory(memory, {
    id: 'id-low',
    level: 'fact',
    importance: 1,
    createdAt: NOW - 2500,
  })
  insertMemory(memory, {
    id: 'id-soul',
    level: 'soul',
    importance: 3,
    createdAt: NOW - 2400,
  })
  insertMemory(memory, {
    id: 'id-rules',
    level: 'rules',
    importance: 3,
    createdAt: NOW - 2300,
  })
  insertMemory(memory, {
    id: 'id-archived',
    level: 'fact',
    status: 'archived',
    createdAt: NOW - 2200,
  })
  insertMemory(memory, {
    id: 'id-stale',
    level: 'fact',
    status: 'stale',
    createdAt: NOW - 2100,
  })
  insertMemory(memory, {
    id: 'id-derived',
    level: 'topic',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    importance: 3,
    createdAt: NOW - 1500,
  })

  const rows = memory.dreamSourceRows({
    after: NOW - 6000,
    before: NOW - 1000,
  })

  assert.deepEqual(rows.map(({ id }) => id), [
    'id-user',
    'id-project',
    'id-fact',
    'id-lesson',
    'id-topic',
    'id-boundary-before',
  ])
  assert.ok(rows.every((row) => row.status === 'active'))
  assert.ok(rows.every((row) => row.importance >= 2))
  assert.ok(rows.every((row) => row.source_session !== PET_DREAM_SOURCE_SESSION))
  assert.ok(rows.every((row) => ['user', 'project', 'fact', 'lesson', 'topic'].includes(row.level)))
  assert.equal(memory.dreamSourceRows({ after: NOW - 6000, before: NOW - 6000 }).length, 0)
})

// A/J: related history uses pure ranking, excludes the current batch, permits
// old derived memories as context, and does not bump original hit metadata.
await withMemory('related-history', async ({ memory }) => {
  const old = insertMemory(memory, {
    id: 'old-related',
    level: 'fact',
    content: '主人对测试颜色的稳定偏好是群青色。',
    keywords: ['群青色', '颜色'],
    createdAt: NOW - DAY,
  })
  const derived = insertMemory(memory, {
    id: 'derived-old',
    level: 'user',
    content: '过去的理解：主人似乎偏爱群青色。',
    sourceSession: PET_DREAM_SOURCE_SESSION,
    keywords: ['群青色', '偏好'],
    createdAt: NOW - 2 * DAY,
  })
  insertMemory(memory, {
    id: 'new-related',
    level: 'fact',
    content: '本批新经历也提到群青色。',
    createdAt: NOW - 1000,
  })
  insertMemory(memory, {
    id: 'unrelated',
    level: 'fact',
    content: '完全无关的测试天气记录。',
    createdAt: NOW - 900,
  })

  const before = snapshotIds(memory, [old.id, derived.id])
  const related = memory.relatedForDream('群青色', {
    k: DREAM_RELATED_LIMIT,
    excludeIds: ['new-related'],
  })

  assert.ok(related.some(({ id }) => id === old.id))
  assert.ok(related.some(({ id }) => id === derived.id))
  assert.ok(!related.some(({ id }) => id === 'new-related'))
  assert.deepEqual(snapshotIds(memory, [old.id, derived.id]), before)
})

// B/C/D/E: candidate validation enforces level, confidence, provenance, and
// the requirement that at least one cited source belongs to this new batch.
await withMemory('gate', async ({ memory }) => {
  const newSource = insertMemory(memory, {
    id: 'new-a',
    level: 'fact',
    content: '独立来源 A：主人选择了群青色房间。',
    importance: 2,
    createdAt: NOW - 4000,
  })
  const oldSource = insertMemory(memory, {
    id: 'old-a',
    level: 'fact',
    content: '独立来源 B：主人在春天去了公园。',
    importance: 2,
    createdAt: NOW - 3000,
  })
  const oldDerivedSource = insertMemory(memory, {
    id: 'derived-old',
    level: 'user',
    content: '旧派生理解：主人偏好蓝绿色调。',
    importance: 3,
    sourceSession: PET_DREAM_SOURCE_SESSION,
    createdAt: NOW - 2000,
  })
  const oldSoul = insertMemory(memory, {
    id: 'old-soul',
    level: 'soul',
    content: '旧的历史自我认识：我喜欢安静陪伴主人。',
    importance: 3,
    keywords: ['自己', '自我', '陪伴', '主人'],
    createdAt: NOW - 1000,
  })
  const oldSoulBefore = snapshotIds(memory, [oldSoul.id])
  const context = {
    newSourceIds: new Set([newSource.id]),
    availableSourceIds: new Set([newSource.id, oldSource.id, oldDerivedSource.id]),
    rawSourceIds: new Set([newSource.id, oldSource.id]),
    rawNewSourceIds: new Set([newSource.id]),
  }
  const base = {
    level: 'user',
    content: '主人似乎很喜欢群青色。',
    importance: 2,
    keywords: ['群青色', '偏好'],
    confidence: 0.85,
    source_ids: ['new-a', 'old-a'],
  }

  assert.equal(validateDreamCandidate(null, context), null)
  for (const level of ['soul', 'rules', 'project']) {
    assert.equal(validateDreamCandidate({ ...base, level }, context), null)
  }
  assert.equal(validateDreamCandidate({ ...base, content: 'abc' }, context), null)
  assert.equal(validateDreamCandidate({ ...base, importance: 1 }, context), null)
  assert.equal(validateDreamCandidate({ ...base, importance: 4 }, context), null)
  assert.equal(validateDreamCandidate({ ...base, confidence: 0.71 }, context), null)
  assert.equal(validateDreamCandidate({ ...base, source_ids: ['missing'] }, context), null)
  assert.equal(validateDreamCandidate({ ...base, source_ids: ['old-a'] }, context), null)
  assert.equal(validateDreamCandidate({ ...base, source_ids: ['derived-old'] }, context), null)

  const singleSourceSoul = {
    level: 'soul',
    content: '我会把这件事形成新的自我认识。',
    importance: 3,
    keywords: ['自我'],
    confidence: 0.82,
    source_ids: ['new-a'],
  }
  assert.equal(validateDreamCandidate(singleSourceSoul, context), null)

  const accepted = validateDreamCandidate({
    ...base,
    confidence: 0.72,
    source_ids: ['new-a', 'old-a', 'new-a'],
  }, context)
  assert.deepEqual(accepted, {
    level: 'user',
    content: '主人似乎很喜欢群青色。',
    importance: 2,
    confidence: 0.72,
    keywords: ['群青色', '偏好'],
    sourceIds: ['new-a', 'old-a'],
  })

  const acceptedSoul = validateDreamCandidate({
    level: 'soul',
    content: '我会把群青色记成主人的稳定偏好。',
    importance: 3,
    keywords: ['自我', '群青色', '偏好'],
    confidence: 0.82,
    source_ids: ['new-a', 'old-a'],
  }, context)
  assert.deepEqual(acceptedSoul, {
    level: 'soul',
    content: '我会把群青色记成主人的稳定偏好。',
    importance: 3,
    confidence: 0.82,
    keywords: ['自我', '群青色', '偏好'],
    sourceIds: ['new-a', 'old-a'],
  })

  const gate = new DreamGate({ memory })
  const dreamSingleSoul = gate.consider(singleSourceSoul, context)
  assert.equal(dreamSingleSoul.status, 'skipped')
  assert.equal(dreamSingleSoul.reason, 'invalid-candidate')

  const dreamRules = gate.consider({ ...base, level: 'rules' }, context)
  assert.equal(dreamRules.status, 'skipped')
  assert.equal(dreamRules.reason, 'invalid-candidate')

  const chatGate = new MemoryGate({ memory })
  const soulCountBeforeChatGate = memory.db.count('soul')
  const chatSoul = chatGate.consider('我喜欢群青色。', {
    remember: true,
    level: 'soul',
    content: '我喜欢群青色。',
    importance: 3,
    keywords: ['群青色'],
    confidence: 0.95,
    evidence: '我喜欢群青色',
  })
  assert.equal(chatSoul.status, 'skipped')
  assert.equal(chatSoul.reason, 'level-denied')
  assert.equal(memory.db.count('soul'), soulCountBeforeChatGate)

  const written = gate.consider(base, context)
  assert.equal(written.status, 'written')
  assert.equal(written.row.source_session, PET_DREAM_SOURCE_SESSION)
  assert.equal(written.row.level, 'user')
  assert.equal(written.row.title, 'dream:new-a,old-a')
  assert.deepEqual(written.sourceIds, ['new-a', 'old-a'])

  const userCount = memory.db.count('user')
  const duplicate = gate.consider(base, context)
  assert.equal(duplicate.status, 'duplicate')
  assert.equal(duplicate.existingId, written.row.id)
  assert.equal(memory.db.count('user'), userCount)

  const soulWritten = gate.consider({
    level: 'soul',
    content: '我会把群青色记成主人的稳定偏好。',
    importance: 3,
    keywords: ['自我', '群青色', '偏好'],
    confidence: 0.82,
    source_ids: ['new-a', 'old-a'],
  }, context)
  assert.equal(soulWritten.status, 'written')
  assert.equal(soulWritten.row.level, 'soul')
  assert.equal(soulWritten.row.source_session, PET_DREAM_SOURCE_SESSION)
  assert.equal(soulWritten.row.title, 'dream:new-a,old-a')
  assert.deepEqual(snapshotIds(memory, [oldSoul.id]), oldSoulBefore)
  assert.ok(memory.db.list('soul').some(({ id }) => id === oldSoul.id))
  assert.ok(memory.db.list('soul').some(({ id }) => id === soulWritten.row.id))

  const recalledSoul = memory.recall('安静陪伴主人', 5)
  assert.ok(recalledSoul.some(({ id }) => id === oldSoul.id))
  assert.ok(memory.currentSelfContext(99).length <= 3)

  assert.throws(
    () => memory.rememberDreamCandidate({ ...accepted, level: 'project' }),
    /PET_DREAM_CANDIDATE_LEVEL_DENIED/,
  )
})

function engineSources(memory, count, checkpoint) {
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const id = `engine-source-${String(index + 1).padStart(2, '0')}`
    ids.push(id)
    insertMemory(memory, {
      id,
      level: index % 4 === 0 ? 'user' : 'fact',
      content: `engine source ${id} about 群青色 and stable preference`,
      importance: 2,
      keywords: ['群青色', '偏好', id],
      createdAt: checkpoint + index + 1,
    })
  }
  return ids
}

function engineCandidate(content, sourceIds) {
  return {
    level: 'user',
    content,
    importance: 2,
    keywords: ['群青色', '偏好'],
    confidence: 0.9,
    source_ids: sourceIds,
  }
}

function microReflectionCandidate(content, level, sourceIds) {
  return {
    level,
    content,
    importance: 2,
    keywords: ['micro-blue', 'reflection'],
    confidence: 0.9,
    source_ids: sourceIds,
  }
}

function microSchedulerFixture({ kind, state, availability = { available: true, reason: 'available' }, initialNow = NOW }) {
  let now = initialNow
  let currentAvailability = availability
  let availabilityCalls = 0
  let deepEligibilityCalls = 0
  let reflectionEligibilityCalls = 0
  const runCalls = []
  const engine = {
    run: async (options) => {
      runCalls.push(options)
      return { status: 'completed', workflow: kind }
    },
  }
  const brain = {
    checkAvailability: async () => {
      availabilityCalls += 1
      return currentAvailability
    },
  }
  const deepDreamEligibility = () => {
    deepEligibilityCalls += 1
    return { eligible: true, reason: 'raw-source-ready' }
  }
  const reflectionEligibility = () => {
    reflectionEligibilityCalls += 1
    return { eligible: true, reason: 'raw-source-ready' }
  }
  const scheduler = new DreamScheduler({
    engine,
    reflectionEngine: engine,
    brain,
    deepDreamEligibility,
    reflectionEligibility,
    now: () => now,
    timeZone: 'Asia/Shanghai',
    availableSince: state.gpuAvailableSince ?? null,
    sleepSince: state.sleepSince ?? null,
  })

  return {
    scheduler,
    engine,
    state,
    runCalls,
    get now() { return now },
    set now(value) { now = value },
    get availability() { return currentAvailability },
    set availability(value) { currentAvailability = value },
    get availabilityCalls() { return availabilityCalls },
    get eligibilityCalls() { return deepEligibilityCalls + reflectionEligibilityCalls },
    get deepEligibilityCalls() { return deepEligibilityCalls },
    get reflectionEligibilityCalls() { return reflectionEligibilityCalls },
  }
}

// F/G/H/I/J: successful Dream is batched, commits only after every inference,
// advances the checkpoint, writes provenance, and preserves source rows.
await withMemory('engine-success', async ({ memory }) => {
  const previousCheckpoint = NOW - 10_000
  const sourceIds = engineSources(memory, 13, previousCheckpoint)
  memory.ensureDreamTracking()
  memory.finishDream(previousCheckpoint)
  const beforeSources = snapshotIds(memory, sourceIds)
  const calls = []

  const brain = {
    dreamCompletion: async (request) => {
      calls.push(request)
      const batch = calls.length
      const batchSourceIds = batch === 1 ? sourceIds.slice(0, 2) : sourceIds.slice(12, 13)
      return {
        ok: true,
        rawText: JSON.stringify({
          summary: `engine batch ${batch}`,
          memories: batch === 1
            ? [engineCandidate('主人似乎持续喜欢群青色。', batchSourceIds)]
            : [],
        }),
      }
    },
  }

  const engine = new DreamEngine({
    memory,
    brain,
    gate: new DreamGate({ memory }),
    owner: 'test-engine-success',
    now: () => NOW,
    batchSize: 12,
  })

  const result = await engine.run({ force: false, now: NOW })
  assert.equal(result.status, 'completed')
  assert.equal(result.sourceCount, 13)
  assert.equal(result.batchCount, 2)
  assert.equal(result.derivedCount, 1)
  assert.equal(result.duplicateCount, 0)
  assert.equal(result.checkpointBefore, previousCheckpoint)
  assert.equal(result.checkpointAfter, NOW)
  assert.equal(result.checkpoint, NOW)
  assert.equal(engine.isInFlight(), false)
  assert.equal(memory.dreamWindow().last_dream_time, NOW)
  assert.equal(memory.dreamWindow().dream_owner, null)

  assert.equal(calls.length, 2)
  assert.equal(calls[0].responseFormat, DREAM_RESPONSE_FORMAT)
  assert.equal(calls[0].messages.length, 2)
  assert.match(calls[0].messages[0].content, /不是在和主人聊天/)
  assert.match(calls[0].messages[1].content, /NEW MEMORIES/)
  assert.match(calls[0].messages[1].content, /engine-source-01/)
  assert.match(calls[0].messages[1].content, /\[user\]/)
  assert.match(calls[0].messages[1].content, /群青色/)
  assert.doesNotMatch(calls[0].messages.map(({ content }) => content).join('\n'), new RegExp(CHAT_ONLY_SENTINEL))

  assert.deepEqual(snapshotIds(memory, sourceIds), beforeSources)
  const derivedRows = LEVELS.flatMap((level) => memory.db.list(level))
    .filter((row) => row.source_session === PET_DREAM_SOURCE_SESSION)
  assert.equal(derivedRows.length, 1)
  assert.equal(derivedRows[0].content, '主人似乎持续喜欢群青色。')
  assert.equal(
    derivedRows[0].title,
    `dream:${sourceIds.slice(0, 2).map((id) => id.slice(0, 8)).join(',')}`,
  )
  assert.equal(derivedRows[0].title, 'dream:engine-s,engine-s')
  const dreamSystemPrompt = calls[0].messages[0].content
  assert.match(dreamSystemPrompt, /不要预设或硬编码任何人格形容词/)
  assert.doesNotMatch(dreamSystemPrompt, /温柔|勇敢|聪明|活泼|调皮|黏人|胆小/u)
  assert.deepEqual(
    memory.dreamSourceRows({ after: previousCheckpoint, before: NOW + 1 })
      .map(({ id }) => id),
    sourceIds,
  )

  const logs = dreamLogs(memory)
  assert.equal(logs.length, 1)
  assert.match(logs[0].summary, /engine batch 1 engine batch 2/)
  assert.equal(logs[0].note, 'vc-ai-pet v0.3-B deep-dream')
  const changes = JSON.parse(logs[0].changes)
  assert.equal(changes.kind, 'dream')
  assert.equal(changes.checkpointFrom, previousCheckpoint)
  assert.equal(changes.checkpointTo, NOW)
  assert.deepEqual(changes.sourceIds, sourceIds)
  assert.equal(changes.derived.length, 1)
  assert.equal(changes.derived[0].id, derivedRows[0].id)
  assert.deepEqual(changes.derived[0].sourceIds, sourceIds.slice(0, 2))
  assert.equal(changes.duplicates.length, 0)
  assert.equal(changes.skipped, 0)
  assert.doesNotMatch(`${logs[0].summary}\n${logs[0].changes}\n${logs[0].note}`, new RegExp(CHAT_ONLY_SENTINEL))

  // I: the next run sees only genuinely new source history, never the derived
  // row. The same content is therefore handled as a duplicate, not inserted.
  const duplicateSourceId = 'engine-source-14'
  insertMemory(memory, {
    id: duplicateSourceId,
    level: 'fact',
    content: `new source for duplicate ${duplicateSourceId}`,
    importance: 2,
    createdAt: NOW + 1,
  })
  memory.ensureDreamTracking()
  assert.deepEqual(
    memory.dreamSourceRows({ after: NOW, before: NOW + 2 }).map(({ id }) => id),
    [duplicateSourceId],
  )

  const duplicateEngine = new DreamEngine({
    memory,
    brain: {
      dreamCompletion: async () => ({
        ok: true,
        rawText: JSON.stringify({
          summary: 'duplicate batch',
          memories: [engineCandidate('主人似乎持续喜欢群青色。', [duplicateSourceId])],
        }),
      }),
    },
    gate: new DreamGate({ memory }),
    owner: 'test-engine-duplicate',
    now: () => NOW + 2,
  })

  const duplicateResult = await duplicateEngine.run({ force: true, now: NOW + 2 })
  assert.equal(duplicateResult.status, 'completed')
  assert.equal(duplicateResult.sourceCount, 1)
  assert.equal(duplicateResult.derivedCount, 0)
  assert.equal(duplicateResult.duplicateCount, 1)
  assert.equal(duplicateResult.checkpointAfter, NOW + 2)
  const derivedRowsAfterDuplicate = LEVELS.flatMap((level) => memory.db.list(level))
    .filter((row) => row.source_session === PET_DREAM_SOURCE_SESSION)
  assert.deepEqual(derivedRowsAfterDuplicate.map(({ id }) => id), [derivedRows[0].id])
  assert.equal(memory.dreamWindow().last_dream_time, NOW + 2)
})

// F/G: if batch 2 fails, proposals from batch 1 are never committed and the
// checkpoint is restored to the previous value.
await withMemory('engine-failure', async ({ memory }) => {
  const previousCheckpoint = NOW - 20_000
  const sourceIds = engineSources(memory, 13, previousCheckpoint)
  memory.ensureDreamTracking()
  memory.finishDream(previousCheckpoint)
  const beforeSources = snapshotIds(memory, sourceIds)
  let calls = 0

  const engine = new DreamEngine({
    memory,
    brain: {
      dreamCompletion: async () => {
        calls += 1
        if (calls === 2) {
          return { ok: false, unavailable: true, reason: 'local-brain-unavailable' }
        }
        return {
          ok: true,
          rawText: JSON.stringify({
            summary: 'first batch proposal must roll back',
            memories: [engineCandidate('失败时不应落库的理解。', sourceIds.slice(0, 2))],
          }),
        }
      },
    },
    gate: new DreamGate({ memory }),
    owner: 'test-engine-failure',
    now: () => NOW,
    batchSize: 12,
  })

  const result = await engine.run({ force: true, now: NOW })
  assert.equal(result.status, 'failed')
  assert.equal(result.sourceCount, 13)
  assert.equal(result.batchCount, 2)
  assert.equal(result.derivedCount, 0)
  assert.equal(result.checkpoint, previousCheckpoint)
  assert.equal(result.checkpointBefore, previousCheckpoint)
  assert.equal(result.checkpointAfter, previousCheckpoint)
  assert.equal(calls, 2)
  assert.equal(engine.isInFlight(), false)
  assert.equal(memory.dreamWindow().last_dream_time, previousCheckpoint)
  assert.equal(memory.dreamWindow().dream_owner, null)
  assert.deepEqual(snapshotIds(memory, sourceIds), beforeSources)
  assert.equal(
    LEVELS.flatMap((level) => memory.db.list(level))
      .filter((row) => row.source_session === PET_DREAM_SOURCE_SESSION).length,
    0,
  )
})

// Addendum: Micro Reflection and Deep Dream use independent windows. One
// bounded Reflection pass writes A/B-derived history first; Deep Dream must
// still see the original A/B rows as NEW, while both derived kinds remain
// available as related historical context.
await withMemory('micro-reflection-deep-dream', async ({ root, memory }) => {
  const deepCheckpoint = NOW - 5000
  const reflectionCheckpoint = NOW - 6000
  const sourceA = insertMemory(memory, {
    id: 'microA-source',
    level: 'fact',
    content: 'micro-blue source A: 主人选择了群青色房间。',
    importance: 2,
    keywords: ['micro-blue', '群青色', '来源A'],
    createdAt: NOW - 4000,
  })
  const sourceB = insertMemory(memory, {
    id: 'microB-source',
    level: 'fact',
    content: 'micro-blue source B: 主人持续保留这个颜色偏好。',
    importance: 2,
    keywords: ['micro-blue', '颜色', '偏好', '来源B'],
    createdAt: NOW - 3000,
  })
  const rawSourceIds = [sourceA.id, sourceB.id]
  const beforeSources = snapshotIds(memory, rawSourceIds)

  memory.db.touchWindow(PET_REFLECTION_WINDOW, root, reflectionCheckpoint)
  memory.db.finishDream(PET_REFLECTION_WINDOW, reflectionCheckpoint)
  memory.finishDream(deepCheckpoint)

  const reflectionContext = {
    newSourceIds: new Set(rawSourceIds),
    rawSourceIds: new Set(rawSourceIds),
    rawNewSourceIds: new Set(rawSourceIds),
    availableSourceIds: new Set(rawSourceIds),
  }
  const reflectionSoulCandidate = {
    level: 'soul',
    content: '我不能只凭这次微反思形成固定自我认识。',
    importance: 3,
    keywords: ['micro-blue'],
    confidence: 0.95,
    source_ids: rawSourceIds,
  }
  assert.equal(validateReflectionCandidate(reflectionSoulCandidate, reflectionContext), null)
  assert.equal(validateReflectionCandidate({
    ...microReflectionCandidate('不能只引用派生历史。', 'fact', ['reflection-only']),
  }, {
    ...reflectionContext,
    availableSourceIds: new Set(['reflection-only']),
    rawSourceIds: new Set(),
    rawNewSourceIds: new Set(['reflection-only']),
  }), null)
  const reflectionGate = new ReflectionGate({ memory })
  const reflectionSoul = reflectionGate.consider(reflectionSoulCandidate, reflectionContext)
  assert.equal(reflectionSoul.status, 'skipped')
  assert.equal(reflectionSoul.reason, 'invalid-candidate')

  const reflectionRules = reflectionGate.consider({
    level: 'rules',
    content: '反思不能写入固定规则。',
    importance: 3,
    keywords: ['micro-blue'],
    confidence: 0.95,
    source_ids: rawSourceIds,
  }, reflectionContext)
  assert.equal(reflectionRules.status, 'skipped')
  assert.equal(reflectionRules.reason, 'invalid-candidate')

  const reflectionCalls = []
  const reflectionEngine = new ReflectionEngine({
    memory,
    brain: {
      reflectionCompletion: async (request) => {
        reflectionCalls.push(request)
        return {
          ok: true,
          rawText: JSON.stringify({
            summary: `micro reflection ${reflectionCalls.length}`,
            memories: [microReflectionCandidate(
              'micro-blue reflection: 这两段经历值得短暂回味。',
              'fact',
              rawSourceIds,
            )],
          }),
        }
      },
    },
    gate: reflectionGate,
    owner: 'test-micro-reflection',
    now: () => NOW,
    relatedLimit: REFLECTION_RELATED_LIMIT,
  })

  const reflectionResult = await reflectionEngine.run({ force: true, now: NOW })
  assert.equal(reflectionResult.status, 'completed')
  assert.equal(reflectionResult.sourceCount, 2)
  assert.equal(reflectionResult.batchCount, 1)
  assert.equal(reflectionResult.derivedCount, 1)
  assert.equal(reflectionResult.duplicateCount, 0)
  assert.equal(reflectionResult.checkpointBefore, reflectionCheckpoint)
  assert.equal(reflectionResult.checkpointAfter, NOW)
  assert.equal(reflectionEngine.isInFlight(), false)
  assert.equal(reflectionCalls.length, 1)
  assert.equal(reflectionCalls[0].responseFormat, REFLECTION_RESPONSE_FORMAT)
  assert.match(reflectionCalls[0].messages[1].content, /NEW RAW MEMORIES/)
  assert.match(reflectionCalls[0].messages[1].content, /microA-source/)
  assert.doesNotMatch(
    reflectionCalls[0].messages.map(({ content }) => content).join('\n'),
    new RegExp(CHAT_ONLY_SENTINEL),
  )

  const reflectionRows = LEVELS.flatMap((level) => memory.db.list(level))
    .filter((row) => row.source_session === PET_REFLECTION_SOURCE_SESSION)
  const reflectionRow = reflectionRows.find((row) => row.id === reflectionResult.derived[0].id)
  assert.ok(reflectionRow)
  assert.equal(reflectionRows.length, 1)
  assert.deepEqual(
    reflectionRows.map(({ title }) => title).sort(),
    ['reflection:microA-s,microB-s'],
  )
  assert.deepEqual(snapshotIds(memory, rawSourceIds), beforeSources)
  const reflectionWindowAfter = memory.db.getWindow(PET_REFLECTION_WINDOW)
  assert.equal(reflectionWindowAfter.last_dream_time, NOW)
  assert.equal(memory.dreamWindow().last_dream_time, deepCheckpoint)

  // Reflection-derived rows are derived history, never raw NEW input for
  // Deep Dream; raw A/B remain available until Deep Dream advances its own
  // checkpoint.
  assert.deepEqual(
    memory.dreamSourceRows({ after: deepCheckpoint, before: NOW }).map(({ id }) => id),
    rawSourceIds,
  )

  const deepCalls = []
  const deepEngine = new DreamEngine({
    memory,
    brain: {
      dreamCompletion: async (request) => {
        deepCalls.push(request)
        return {
          ok: true,
          rawText: JSON.stringify({
            summary: 'micro deep dream',
            memories: [
              {
                level: 'soul',
                content: '我只凭一条 micro-blue 经历形成自我认识。',
                importance: 3,
                keywords: ['micro-blue'],
                confidence: 0.95,
                source_ids: [sourceA.id],
              },
              {
                level: 'soul',
                content: '我会把 micro-blue 的两段历史形成谨慎的自我认识。',
                importance: 3,
                keywords: ['micro-blue', '自我'],
                confidence: 0.82,
                source_ids: rawSourceIds,
              },
            ],
          }),
        }
      },
    },
    gate: new DreamGate({ memory }),
    owner: 'test-micro-deep-dream',
    now: () => NOW,
    batchSize: DREAM_BATCH_SIZE,
  })

  const deepResult = await deepEngine.run({ force: true, now: NOW })
  assert.equal(deepResult.status, 'completed')
  assert.equal(deepResult.sourceCount, 2)
  assert.equal(deepResult.batchCount, 1)
  assert.equal(deepResult.derivedCount, 1)
  assert.equal(deepResult.skipped, 1)
  assert.equal(deepCalls.length, 1)
  assert.match(deepCalls[0].messages[1].content, /microA-source/)
  assert.match(deepCalls[0].messages[1].content, /microB-source/)

  const deepDerivedRows = LEVELS.flatMap((level) => memory.db.list(level))
    .filter((row) => row.source_session === PET_DREAM_SOURCE_SESSION)
  const deepSoul = deepDerivedRows.find((row) => row.level === 'soul')
  assert.ok(deepSoul)
  assert.equal(deepSoul.title, `dream:${rawSourceIds.map((id) => id.slice(0, 8)).join(',')}`)
  assert.equal(deepSoul.title, 'dream:microA-s,microB-s')
  assert.equal(memory.dreamWindow().last_dream_time, NOW)
  assert.equal(memory.db.getWindow(PET_REFLECTION_WINDOW).last_dream_time, NOW)

  assert.deepEqual(
    memory.dreamSourceRows({ after: deepCheckpoint, before: NOW + 1 }).map(({ id }) => id),
    rawSourceIds,
  )
  const related = memory.relatedForDream('micro-blue', {
    k: DREAM_RELATED_LIMIT,
    excludeIds: rawSourceIds,
  })
  assert.ok(related.some(({ id }) => id === reflectionRow.id))
  assert.ok(related.some(({ id }) => id === deepSoul.id))

  // No physical/screenshot/context tier may enter the seven-layer Pet memory
  // surface or the Deep Dream response enum.
  assert.equal(LEVELS.includes('physical'), false)
  assert.equal(
    DREAM_RESPONSE_FORMAT.schema.properties.memories.items.properties.level.enum.includes('physical'),
    false,
  )
  assert.throws(
    () => memory.remember('physical', '不可写入物理上下文。', 2),
    /PET_MEMORY_LEVEL_DENIED/,
  )
})

// LocalBrain contract: Dream uses the shared API v1 with Dream-only sampling
// controls, while normal Chat remains one off-reasoning inference.
{
  const calls = []
  let healthCalls = 0
  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory: {
      recall: () => [],
      stableIdentityContext: () => [],
    },
    client: {
      health: async () => {
        healthCalls += 1
        return true
      },
      chat: async (request) => {
        calls.push(request)
        const isDream = request.reasoningEffort === 'medium'
        return {
          requestId: isDream ? 'dream-request' : 'chat-request',
          payload: {
            choices: [{
              message: {
                role: 'assistant',
                content: isDream
                  ? JSON.stringify({ summary: 'dream', memories: [] })
                  : JSON.stringify({ reply: '收到啦。', memory: null }),
              },
            }],
          },
        }
      },
    },
  })

  const chatResult = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: { mood: .8, energy: .8, boredom: .2, sleepiness: .1, attachment: .8 },
    recentMessages: [
      { role: 'user', content: '上一句' },
      { role: 'assistant', content: '上一答' },
    ],
    userText: CHAT_ONLY_SENTINEL,
  })
  assert.equal(chatResult.ok, true)

  const dreamResult = await brain.dreamCompletion({
    messages: [{ role: 'user', content: '只给长期 memory' }],
    responseFormat: DREAM_RESPONSE_FORMAT,
  })
  assert.equal(dreamResult.ok, true)
  assert.equal(dreamResult.requestId, 'dream-request')
  assert.equal(calls.length, 2)
  assert.equal(LI_HUAHUA_IDENTITY.schemaVersion, 1)
  assert.equal(LI_HUAHUA_IDENTITY.name, '李花花')
  assert.equal(LI_HUAHUA_IDENTITY.species, 'dog')
  assert.equal(LI_HUAHUA_IDENTITY.breedZh, '伯恩山犬')
  assert.equal(LI_HUAHUA_IDENTITY.birthday, '2026-08-31')
  assert.match(calls[0].messages[0].content, /名字：李花花/)
  assert.match(calls[0].messages[0].content, /品种：伯恩山犬/)
  assert.match(calls[0].messages[0].content, /生日：2026-08-31/)
  assert.equal(calls[0].reasoningEffort, 'off')
  assert.equal(calls[0].temperature, .72)
  assert.equal(calls[0].topP, .9)
  assert.equal(calls[0].maxTokens, 256)
  assert.deepEqual(calls[0].messages.slice(1, -1).map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '上一句' },
    { role: 'assistant', content: '上一答' },
  ])
  assert.equal(calls[1].reasoningEffort, 'medium')
  assert.equal(calls[1].temperature, .35)
  assert.equal(calls[1].topP, .85)
  assert.equal(calls[1].maxTokens, 1600)
  assert.equal(calls[1].omitMaxTokens, true)
  for (const call of calls) {
    assert.equal(Object.hasOwn(call, 'model'), false)
    assert.equal(Object.hasOwn(call, 'n_ctx'), false)
  }
  assert.equal(healthCalls, 0)
}

// J: normal Chat receives at most three current-self soul rows even when
// recall/current-self adapters expose a larger historical soul collection.
await withMemory('chat-soul-limit', async ({ memory }) => {
  const soulRows = []
  for (let index = 0; index < 5; index += 1) {
    soulRows.push(insertMemory(memory, {
      id: `chat-soul-${index + 1}`,
      level: 'soul',
      content: `历史自我认识 ${index + 1}：李花花会记得主人和自己的长期习惯。`,
      importance: 3,
      keywords: ['李花花', '自己', '主人', '习惯', String(index + 1)],
      createdAt: NOW - index - 1,
    }))
  }

  assert.ok(memory.currentSelfContext(99).length <= 3)

  let captured
  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory: {
      recall: () => soulRows,
      stableRulesContext: () => [],
      currentSelfContext: () => soulRows,
    },
    client: {
      chat: async (request) => {
        captured = request
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
    state: { mood: .8, energy: .8, boredom: .2, sleepiness: .1, attachment: .8 },
    userText: '普通聊天测试',
    recentMessages: [],
  })
  assert.equal(result.ok, true)

  const systemPrompt = captured.messages[0].content
  assert.equal((systemPrompt.match(/- \[soul\] /g) ?? []).length, 3)
  assert.ok(soulRows.some(({ content }) => !systemPrompt.includes(content)))
})

// H: scheduler uses sleep plus either threshold/age, and never starts while
// Chat/Dream is busy.
await withSchedulerFixture({ count: 8, ageMs: HOUR }, async (fixture) => {
  const { scheduler, runCalls } = fixture
  const due = await scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  assert.equal(due.status, 'completed')
  assert.equal(due.schedulerStatus, 'started')
  assert.equal(due.schedulerDue, true)
  assert.equal(due.force, false)
  assert.deepEqual(runCalls, [{ force: false }])
  assert.equal(fixture.eligibilityCalls, 1)
  assert.equal(fixture.availabilityCalls, 2)

  const idle = await scheduler.maybeRun({ state: { current: 'idle' }, now: fixture.now })
  assert.equal(idle.status, 'skipped')
  assert.equal(idle.reason, 'not-sleep')
  assert.equal(runCalls.length, 1)
})

await withSchedulerFixture({ count: 1, ageMs: HOUR }, async (fixture) => {
  const { scheduler, runCalls } = fixture
  const notDue = await scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  assert.equal(notDue.status, 'skipped')
  assert.equal(notDue.reason, 'eligibility-threshold-not-met')
  assert.equal(runCalls.length, 0)
  assert.equal(fixture.availabilityCalls, 0)
})

await withSchedulerFixture({ count: 1, ageMs: 73 * HOUR }, async (fixture) => {
  const { scheduler, runCalls } = fixture
  const oldEnough = await scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  assert.equal(oldEnough.status, 'completed')
  assert.equal(oldEnough.schedulerStatus, 'started')
  assert.equal(runCalls.length, 1)
})

await withSchedulerFixture({ count: 8, ageMs: HOUR }, async (fixture) => {
  const { scheduler, runCalls } = fixture
  const chatBusy = await scheduler.maybeRun({ state: { current: 'sleep' }, chatInFlight: 1, now: fixture.now })
  assert.equal(chatBusy.status, 'skipped')
  assert.equal(chatBusy.reason, 'chat-in-flight')
  assert.equal(fixture.eligibilityCalls, 0)
  assert.equal(fixture.availabilityCalls, 0)
  assert.equal(runCalls.length, 0)

  const dreamBusy = await scheduler.maybeRun({ state: { current: 'sleep' }, dreamInFlight: true, now: fixture.now })
  assert.equal(dreamBusy.status, 'skipped')
  assert.equal(dreamBusy.reason, 'dream-in-flight')
  assert.equal(runCalls.length, 0)
})

// H: in-flight is an internal scheduler guard, not just a caller-provided
// flag; a second tick cannot launch a second run.
await withSchedulerFixture({ count: 8, ageMs: HOUR }, async (fixture) => {
  const { scheduler, engine, runCalls } = fixture
  let resolveRun
  const pendingRun = new Promise((resolve) => { resolveRun = resolve })
  engine.run = async (options) => {
    runCalls.push(options)
    return pendingRun
  }

  const first = scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runCalls.length, 1)
  assert.equal(scheduler.dreamInFlight, true)

  const second = await scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  assert.equal(second.status, 'skipped')
  assert.equal(second.reason, 'dream-in-flight')
  assert.equal(runCalls.length, 1)

  resolveRun({ status: 'completed' })
  const firstResult = await first
  assert.equal(firstResult.schedulerStatus, 'started')
  assert.equal(scheduler.dreamInFlight, false)
})

// H: owner-busy sets a 15-minute RAM-only retry cooldown and does not probe
// again before it expires.
await withSchedulerFixture({ count: 8, ageMs: HOUR }, async (fixture) => {
  const { scheduler, runCalls } = fixture
  fixture.availability = { available: false, reason: 'gpu-busy' }
  const busy = await scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  assert.equal(busy.status, 'deferred-owner-busy')
  assert.equal(busy.reason, 'gpu-busy')
  assert.equal(busy.nextAttemptAt, NOW + DREAM_OWNER_BUSY_COOLDOWN_MS)
  assert.equal(fixture.availabilityCalls, 1)
  assert.equal(runCalls.length, 0)

  fixture.now = NOW + 10 * 60 * 1000
  const cooled = await scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  assert.equal(cooled.status, 'skipped')
  assert.equal(cooled.reason, 'owner-busy-cooldown')
  assert.equal(fixture.availabilityCalls, 1)
  assert.equal(runCalls.length, 0)

  fixture.now = NOW + DREAM_OWNER_BUSY_COOLDOWN_MS
  fixture.availability = { available: true, reason: 'available' }
  const retry = await scheduler.maybeRun({ state: { current: 'sleep' }, now: fixture.now })
  assert.equal(retry.schedulerStatus, 'started')
  assert.equal(fixture.availabilityCalls, 3)
  assert.equal(runCalls.length, 1)
  assert.equal(scheduler.getNextAttemptAt(), null)
})

// H: force path skips sleep/count/age only; it still respects Chat and owner
// resource guards.
await withSchedulerFixture({ count: 1, ageMs: HOUR }, async (fixture) => {
  const { scheduler, runCalls } = fixture
  const forced = await scheduler.runNow({ state: { current: 'idle' }, chatInFlight: 0, now: fixture.now })
  assert.equal(forced.schedulerStatus, 'started')
  assert.equal(forced.force, true)
  assert.equal(fixture.eligibilityCalls, 0)
  assert.equal(fixture.availabilityCalls, 2)
  assert.deepEqual(runCalls, [{ force: true }])

  const chatBusy = await scheduler.runNow({ state: { current: 'idle' }, chatInFlight: 1, now: fixture.now })
  assert.equal(chatBusy.reason, 'chat-in-flight')
  assert.equal(runCalls.length, 1)
})

await withSchedulerFixture({ count: 1, ageMs: HOUR }, async (fixture) => {
  fixture.availability = { available: false, reason: 'gpu-busy' }
  const forcedBusy = await fixture.scheduler.runNow({ state: { current: 'idle' }, now: fixture.now })
  assert.equal(forcedBusy.status, 'deferred-owner-busy')
  assert.equal(fixture.runCalls.length, 0)
})

// Addendum scheduling: Micro Reflection and Deep Dream have independent
// gates. Deep Dream needs a 15-minute sleep episode and either nighttime or a
// 45-minute daytime availability streak; Reflection has its own 30-minute
// cooldown and does not advance the Deep Dream gate.
{
  const fixture = microSchedulerFixture({
    kind: 'deep',
    initialNow: NIGHT_NOW,
    state: { sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS },
  })
  const result = await fixture.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS },
    now: fixture.now,
  })
  assert.equal(result.schedulerStatus, 'started')
  assert.equal(result.schedulerGate, 'deep-dream')
  assert.equal(result.workflow, 'deep')
  assert.equal(fixture.deepEligibilityCalls, 1)
  assert.equal(fixture.availabilityCalls, 2)
  assert.deepEqual(fixture.runCalls, [{ force: false }])
}

{
  const fixture = microSchedulerFixture({
    kind: 'deep',
    initialNow: DAY_NOW,
    state: { sleepSince: DAY_NOW - DEEP_DREAM_MIN_SLEEP_MS, gpuAvailableSince: DAY_NOW - DEEP_DREAM_DAYTIME_AVAILABILITY_MS },
  })
  const result = await fixture.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: DAY_NOW - DEEP_DREAM_MIN_SLEEP_MS },
    now: fixture.now,
  })
  assert.equal(result.schedulerStatus, 'started')
  assert.equal(result.schedulerGate, 'deep-dream')
  assert.equal(fixture.availabilityCalls, 2)
}

{
  const fixture = microSchedulerFixture({
    kind: 'deep',
    initialNow: DAY_NOW,
    state: { sleepSince: DAY_NOW - DEEP_DREAM_MIN_SLEEP_MS, gpuAvailableSince: DAY_NOW - 10 * 60 * 1000 },
  })
  const result = await fixture.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: DAY_NOW - DEEP_DREAM_MIN_SLEEP_MS },
    now: fixture.now,
  })
  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'daytime-availability-not-met')
  assert.equal(fixture.deepEligibilityCalls, 1)
  assert.equal(fixture.availabilityCalls, 1)
  assert.equal(fixture.runCalls.length, 0)
}

{
  const fixture = microSchedulerFixture({
    kind: 'deep',
    initialNow: DAY_NOW,
    state: { sleepSince: DAY_NOW - DEEP_DREAM_MIN_SLEEP_MS },
  })
  const tick = (offset) => fixture.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: DAY_NOW - DEEP_DREAM_MIN_SLEEP_MS },
    now: DAY_NOW + offset,
  })

  const first = await tick(0)
  assert.equal(first.reason, 'daytime-availability-not-met')
  assert.equal(fixture.availabilityCalls, 1)

  await tick(10 * 1000)
  await tick(20 * 1000)
  assert.equal(fixture.availabilityCalls, 1)

  await tick(AVAILABILITY_PROBE_MIN_INTERVAL_MS)
  assert.equal(fixture.availabilityCalls, 2)

  const started = await tick(DEEP_DREAM_DAYTIME_AVAILABILITY_MS)
  assert.equal(started.schedulerStatus, 'started')
  assert.equal(fixture.availabilityCalls, 4)
  assert.equal(fixture.runCalls.length, 1)
  assert.equal(
    fixture.scheduler.lastAvailabilityProbeAt,
    DAY_NOW + DEEP_DREAM_DAYTIME_AVAILABILITY_MS,
  )

  console.log('AUTOMATIC_AVAILABILITY_PROBE_THROTTLED=PASS')
  console.log('FINAL_INFERENCE_AVAILABILITY_PROBE_FRESH=PASS')
}

{
  const fixture = microSchedulerFixture({
    kind: 'deep',
    initialNow: NIGHT_NOW,
    state: { sleepSince: NIGHT_NOW - 5 * 60 * 1000 },
  })
  const result = await fixture.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: NIGHT_NOW - 5 * 60 * 1000 },
    now: fixture.now,
  })
  assert.equal(result.status, 'skipped')
  assert.equal(result.reason, 'sleep-duration-not-met')
  assert.equal(fixture.availabilityCalls, 0)
  assert.equal(fixture.runCalls.length, 0)
}

{
  const fixture = microSchedulerFixture({
    kind: 'reflection',
    initialNow: DAY_NOW,
    state: {},
  })
  const first = await fixture.scheduler.maybeRunReflection({
    state: { current: 'idle' },
    now: fixture.now,
  })
  assert.equal(first.schedulerStatus, 'started')
  assert.equal(first.schedulerGate, 'reflection')
  assert.equal(first.workflow, 'reflection')
  assert.equal(fixture.reflectionEligibilityCalls, 1)
  assert.equal(fixture.availabilityCalls, 2)

  fixture.now = DAY_NOW + REFLECTION_MIN_INTERVAL_MS - 1
  const cooled = await fixture.scheduler.maybeRunReflection({
    state: { current: 'idle' },
    now: fixture.now,
  })
  assert.equal(cooled.status, 'skipped')
  assert.equal(cooled.reason, 'reflection-min-interval')
  assert.equal(fixture.reflectionEligibilityCalls, 1)
  assert.equal(fixture.runCalls.length, 1)
}

{
  const fixture = microSchedulerFixture({
    kind: 'deep',
    initialNow: NIGHT_NOW,
    state: { sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS },
  })
  const first = await fixture.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS },
    now: fixture.now,
  })
  assert.equal(first.schedulerStatus, 'started')
  fixture.now = NIGHT_NOW + DEEP_DREAM_SUCCESS_COOLDOWN_MS - 1
  const cooled = await fixture.scheduler.maybeRunDeepDream({
    state: { current: 'sleep', sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS },
    now: fixture.now,
  })
  assert.equal(cooled.status, 'skipped')
  assert.equal(cooled.reason, 'deep-dream-cooldown')
  assert.equal(fixture.runCalls.length, 1)
}

for (const workflow of ['deep', 'reflection']) {
  const fixture = microSchedulerFixture({
    kind: workflow,
    initialNow: NIGHT_NOW,
    state: { sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS },
    availability: { available: false, reason: `${workflow}-owner-busy` },
  })
  const run = workflow === 'deep'
    ? fixture.scheduler.maybeRunDeepDream({ state: { current: 'sleep', sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS }, now: fixture.now })
    : fixture.scheduler.maybeRunReflection({ state: { current: 'idle' }, now: fixture.now })
  const busy = await run
  assert.equal(busy.status, 'deferred-owner-busy')
  assert.equal(busy.nextAttemptAt, NIGHT_NOW + OWNER_BUSY_COOLDOWN_MS)
  assert.equal(fixture.availabilityCalls, 1)

  fixture.now = NIGHT_NOW + OWNER_BUSY_COOLDOWN_MS - 1
  fixture.availability = { available: true, reason: 'available' }
  const early = workflow === 'deep'
    ? await fixture.scheduler.maybeRunDeepDream({ state: { current: 'sleep', sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS }, now: fixture.now })
    : await fixture.scheduler.maybeRunReflection({ state: { current: 'idle' }, now: fixture.now })
  assert.equal(early.status, 'skipped')
  assert.equal(early.reason, 'owner-busy-cooldown')
  assert.equal(fixture.availabilityCalls, 1)

  fixture.now = NIGHT_NOW + OWNER_BUSY_COOLDOWN_MS
  const ready = workflow === 'deep'
    ? await fixture.scheduler.maybeRunDeepDream({ state: { current: 'sleep', sleepSince: NIGHT_NOW - DEEP_DREAM_MIN_SLEEP_MS }, now: fixture.now })
    : await fixture.scheduler.maybeRunReflection({ state: { current: 'idle' }, now: fixture.now })
  assert.equal(ready.schedulerStatus, 'started')
  assert.equal(ready.workflow, workflow)
  assert.equal(fixture.availabilityCalls, 3)
  assert.equal(fixture.runCalls.length, 1)
}

// J: RecentConversation and Chat remain RAM-only, preserve successful turns,
// and expose the same public response shape while Chat is tracked in-flight.
{
  const recent = new RecentConversation({ maxTurns: 2 })
  assert.equal(recent.append('第一句', '第一答'), true)
  assert.equal(recent.append('第二句', '第二答'), true)
  recent.append('第三句', '第三答')
  assert.deepEqual(recent.snapshot(), [
    { user: '第二句', assistant: '第二答' },
    { user: '第三句', assistant: '第三答' },
  ])
  assert.deepEqual(recent.messages(), [
    { role: 'user', content: '第二句' },
    { role: 'assistant', content: '第二答' },
    { role: 'user', content: '第三句' },
    { role: 'assistant', content: '第三答' },
  ])
}

await withMemory('runtime-chat', async ({ root }) => {
  const runtime = new PetRuntime({ sandboxRoot: root })
  runtime.identity = LI_HUAHUA_IDENTITY
  runtime.state = {
    mood: 0.8,
    energy: 0.8,
    boredom: 0.2,
    sleepiness: 0.1,
    attachment: 0.8,
  }

  const gateCalls = []
  runtime.memoryGate = {
    consider: (userText, candidate) => {
      gateCalls.push({ userText, candidate })
      return { status: 'skipped' }
    },
  }

  const brainCalls = []
  let releasePending
  runtime.brain = {
    reply: async ({ recentMessages, userText }) => {
      brainCalls.push({ recentMessages, userText })
      if (userText === '等待轮') {
        await new Promise((resolve) => { releasePending = resolve })
      }
      if (userText === '失败轮') {
        return { ok: false, unavailable: true, reason: 'local-brain-unavailable' }
      }
      if (userText === '抛错轮') throw new Error('test chat failure')
      return {
        ok: true,
        text: `回复 ${brainCalls.length}`,
        rawMemoryCandidate: { evidence: '上一答' },
      }
    },
  }

  const first = await runtime.chat('第一轮')
  assert.deepEqual(Object.keys(first).sort(), ['memoryWrite', 'ok', 'text', 'unavailable'])
  assert.equal(first.ok, true)
  assert.equal(runtime.chatInFlight, 0)
  assert.equal(runtime.conversation.size, 1)

  const second = await runtime.chat('第二轮')
  assert.equal(second.ok, true)
  assert.equal(runtime.conversation.size, 2)
  assert.deepEqual(brainCalls[1].recentMessages, [
    { role: 'user', content: '第一轮' },
    { role: 'assistant', content: '回复 1' },
  ])
  assert.equal(gateCalls[0].userText, '第一轮')
  assert.equal(gateCalls[0].candidate.evidence, '上一答')

  const pending = runtime.chat('等待轮')
  assert.equal(runtime.chatInFlight, 1)
  releasePending()
  await pending
  assert.equal(runtime.chatInFlight, 0)
  assert.equal(runtime.conversation.size, 3)

  const failed = await runtime.chat('失败轮')
  assert.equal(failed.ok, false)
  assert.equal(runtime.chatInFlight, 0)
  assert.equal(runtime.conversation.size, 3)

  await assert.rejects(() => runtime.chat('抛错轮'), /test chat failure/)
  assert.equal(runtime.chatInFlight, 0)
  assert.equal(runtime.conversation.size, 3)

  runtime.close()
  assert.equal(runtime.conversation.size, 0)
})

// Keep the constants in the smoke's assertion surface so an accidental batch
// or proposal-limit regression is immediately visible.
assert.equal(DREAM_BATCH_SIZE, 24)
assert.equal(DEEP_DREAM_BATCH_NEW_MAX, 24)
assert.equal(DREAM_DERIVED_MAX_PER_BATCH, 3)
assert.equal(DREAM_RELATED_LIMIT, 24)
assert.equal(DEEP_DREAM_RELATED_MAX, 24)
assert.equal(DREAM_MIN_NEW_MEMORIES, 8)
assert.equal(DREAM_OLDEST_SOURCE_AGE_MS, 72 * HOUR)
assert.equal(DREAM_OWNER_BUSY_COOLDOWN_MS, 15 * 60 * 1000)
assert.equal(REFLECTION_BATCH_SIZE, 4)
assert.equal(REFLECTION_RELATED_LIMIT, 4)
assert.equal(REFLECTION_DERIVED_MAX_PER_BATCH, 1)
assert.equal(REFLECTION_MIN_NEW_RAW_MEMORIES, 2)
assert.equal(REFLECTION_MIN_INTERVAL_MS, 30 * 60 * 1000)

console.log('VC_AI_PET_V0_3_DREAM_SMOKE=PASS')
