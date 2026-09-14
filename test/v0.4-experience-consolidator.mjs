import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PetMemory } from '../src/memory/pet-memory.js'
import { isRawEvidenceRow } from '../src/memory/derived-evidence.js'
import {
  ExperienceBuffer,
} from '../src/experience/experience-buffer.js'
import {
  ExperienceConsolidator,
  EXPERIENCE_CONSOLIDATION_MAX_TERMS,
} from '../src/experience/experience-consolidator.js'
import { MemoryGate } from '../src/memory/memory-gate.js'

function row(id, content, { actorId = 'owner', conversationId = `conversation-${id}`, createdAt = id * 1000 } = {}) {
  return {
    id,
    sourceType: 'conversation',
    conversationId,
    messageId: `message-${id}`,
    actorId,
    content,
    importanceScore: null,
    emotionScore: null,
    memoryCandidate: null,
    processed: false,
    processedAt: null,
    createdAt,
  }
}

class FakeExperienceBuffer {
  constructor(rows, { failPending = false, failMark = false } = {}) {
    this.rows = rows
    this.processed = new Set()
    this.markCalls = []
    this.failPending = failPending
    this.failMark = failMark
  }

  async pendingExperience({ afterId = null, limit = 50, before = null } = {}) {
    if (this.failPending) throw new Error('BUFFER_PENDING_FAILURE')
    return this.rows
      .filter((entry) => !this.processed.has(entry.id))
      .filter((entry) => afterId === null || entry.id > afterId)
      .filter((entry) => before === null || Number(entry.createdAt) <= Number(before))
      .slice(0, limit)
  }

  async markProcessed(ids, { processedAt = 0 } = {}) {
    if (this.failMark) throw new Error('BUFFER_MARK_FAILURE')
    this.markCalls.push({ ids: [...ids], processedAt })
    for (const id of ids) this.processed.add(id)
  }

  pendingIds() {
    return this.rows.filter((entry) => !this.processed.has(entry.id)).map((entry) => entry.id)
  }
}

function fakeMemory({ failFind = false, failRemember = false } = {}) {
  const rows = []
  return {
    rows,
    findEquivalentMemory() {
      if (failFind) throw new Error('MEMORY_FIND_FAILURE')
      return null
    },
    remember(level, content, importance, extra) {
      if (failRemember) throw new Error('MEMORY_WRITE_FAILURE')
      const saved = { id: rows.length + 1, level, content, importance, ...extra }
      rows.push(saved)
      return saved
    },
    rememberCandidate(candidate) {
      if (failRemember) throw new Error('MEMORY_WRITE_FAILURE')
      const saved = { id: rows.length + 1, ...candidate }
      rows.push(saved)
      return saved
    },
  }
}

function makeConsolidator(buffer, memory, options = {}) {
  return new ExperienceConsolidator({
    buffer,
    memory,
    now: () => 1_800_000_000_000,
    memoryGate: new MemoryGate({ memory }),
    // These legacy unit fixtures focus on term grouping. The production
    // default (24h) is covered by v0.4-experience-session-guard.mjs.
    minDaySpanMs: 0,
    ...options,
  })
}

function memoryRowCount(memory) {
  return ['user', 'project', 'fact', 'lesson', 'topic']
    .flatMap((level) => memory.db.list(level))
    .length
}

async function realGateCase(root, name, entries, { seed = null, tokenize = null, injectGate = true } = {}) {
  const caseRoot = join(root, 'real-gate', name)
  let now = entries[0]?.createdAt ?? 1_900_000_000_000
  const buffer = new ExperienceBuffer({
    root: caseRoot,
    now: () => now,
  })
  const memory = new PetMemory(caseRoot)
  try {
    await buffer.initialize()
    const recorded = []
    for (const entry of entries) {
      now = entry.createdAt
      recorded.push(buffer.record({
        turnId: entry.conversationId,
        conversationId: entry.conversationId,
        conversationKey: entry.conversationKey,
        messageId: entry.messageId,
        ownerText: entry.text,
        assistantText: '收到。',
      }))
    }
    const gate = injectGate ? new MemoryGate({ memory }) : null
    if (seed) seed({ gate, memory })
    const consolidator = new ExperienceConsolidator({
      buffer,
      memory,
      memoryGate: gate,
      now: () => now,
      maxTerms: 100,
      tokenize,
    })
    const result = await consolidator.consolidate()
    return { result, recorded, memory, buffer }
  } catch (error) {
    try { memory.close() } catch {}
    try { await buffer.close() } catch {}
    throw error
  }
}

async function runRollbackRegression(root) {
  const base = 2_100_000_000_000
  const day = 24 * 60 * 60 * 1000
  const caseRoot = join(root, 'rollback')
  // `record()` timestamps from the buffer's own clock, so advance that clock to
  // place the two groups a day apart.
  let clock = base
  const buffer = new ExperienceBuffer({ root: caseRoot, now: () => clock })
  const memory = new PetMemory(caseRoot)
  try {
    await buffer.initialize()
    // Two independent stable groups, so the commit loop has a second candidate to
    // fail on after the first one has already been written. Each group needs two
    // sessions more than a day apart, and they must not share a timestamp or the
    // buffer will coalesce them into one session key.
    const groups = [
      { text: '我们家的猫猫叫黑莓', createdBase: base },
      { text: '主人喜欢在阳台晒太阳', createdBase: base + day + 1000 },
    ]
    for (const [groupIndex, group] of groups.entries()) {
      for (const offset of [0, day]) {
        clock = group.createdBase + offset
        buffer.record({
          turnId: `turn-${groupIndex}-${offset}`,
          conversationKey: `session-${groupIndex}-${offset === 0 ? 'a' : 'b'}`,
          messageId: `message-${groupIndex}-${offset}`,
          ownerText: group.text,
          assistantText: '收到。',
        })
      }
    }
    assert.equal((await buffer.pendingExperience({ limit: 50 })).length, 4)
    const realGate = new MemoryGate({ memory })
    let calls = 0
    const throwOnSecond = {
      consider(...args) {
        calls += 1
        if (calls >= 2) throw new Error('GATE_THROW_AFTER_WRITE')
        return realGate.consider(...args)
      },
    }
    const consolidator = new ExperienceConsolidator({
      buffer,
      memory,
      memoryGate: throwOnSecond,
      now: () => base + day * 2,
      maxTerms: 100,
    })
    const result = await consolidator.consolidate()
    assert.equal(result.status, 'failed')
    assert.equal(result.ok, false)
    assert.ok(calls >= 2, 'the second candidate must have been attempted')
    // The invariant: a failed pass must not leave a row behind, or a retry would
    // find a memory that the failure report said was never created.
    assert.equal(memoryRowCount(memory), 0, 'a failed pass must roll back the rows it already wrote')
    assert.equal((await buffer.pendingExperience({ limit: 50 })).length, 4)

    // A retry with a healthy gate must succeed and still produce exactly the two
    // rows — no duplicates from the reverted attempt.
    const retry = new ExperienceConsolidator({
      buffer,
      memory,
      memoryGate: realGate,
      now: () => base + day * 2,
      maxTerms: 100,
    })
    const retried = await retry.consolidate()
    assert.equal(retried.status, 'completed')
    assert.equal(retried.written, 2)
    assert.equal(memoryRowCount(memory), 2, 'the retry must write both groups exactly once')
    assert.ok(memory.forget(memory.db.list('fact')[0].id), 'forget() must remove a row this process wrote')
    assert.equal(memoryRowCount(memory), 1)
    assert.equal(memory.forget('no-such-row'), false)
  } finally {
    try { memory.close() } catch {}
    try { await buffer.close() } catch {}
  }
}

async function runRealGateRegressions(root) {  const base = 2_000_000_000_000
  const day = 24 * 60 * 60 * 1000
  const entriesFor = (text, times, keys = times.map((_, index) => `session-${index + 1}`)) =>
    times.map((createdAt, index) => ({
      text,
      createdAt,
      conversationId: `turn-${index + 1}`,
      conversationKey: keys[index],
      messageId: `message-${index + 1}`,
    }))
  const finish = async ({ memory, buffer }) => {
    try { memory.close() } catch {}
    try { await buffer.close() } catch {}
  }

  // Sensitive, opted-out, and question-like repeats are all safely consumed
  // without ever reaching PetMemory.
  for (const [name, text, reason] of [
    ['password', '我的密码是 abc123', 'memory-sensitive-reject'],
    ['opt-out', '不要保存这个', 'user-opt-out'],
    ['question', '猫猫叫什么名字？', 'not-owner-assertion'],
  ]) {
    const state = await realGateCase(root, name, entriesFor(text, [base, base + day, base + day * 2]))
    try {
      assert.equal(memoryRowCount(state.memory), 0, `${name} must never write PetMemory`)
      assert.ok(state.result.rejected[reason] >= 1, `${name} must record ${reason}`)
      assert.equal(state.result.processedIds.length, 3)
    } finally {
      await finish(state)
    }
  }

  // A real cross-session, cross-day owner fact is promoted through the gate,
  // and the first occurrence's message id is retained as provenance.
  const fact = await realGateCase(
    root,
    'owner-fact',
    entriesFor('我们家的猫猫叫黑莓', [base, base + day, base + day * 2]),
  )
  try {
    assert.equal(fact.result.written, 1)
    assert.equal(fact.memory.db.list('fact').filter((row) => row.content.includes('黑莓')).length, 1)
    const storedFact = fact.memory.db.list('fact').find((row) => row.content.includes('黑莓'))
    assert.equal(storedFact.content, '主人说：我们家的猫猫叫黑莓')
    assert.equal(fact.memory.findById(storedFact.id).row.provenance.messageId, 'message-1')
  } finally {
    await finish(fact)
  }

  // An equivalent pre-existing row is reported as one duplicate and is not
  // multiplied by the consolidator's keyword groups.
  const duplicate = await realGateCase(
    root,
    'duplicate',
    entriesFor('我们家的猫猫叫黑莓', [base, base + day, base + day * 2]),
    {
      tokenize: () => ['黑莓'],
      seed: ({ gate }) => gate.consider('我们家的猫猫叫黑莓', {
        remember: true,
        level: 'fact',
        content: '我们家的猫猫叫黑莓',
        importance: 3,
        keywords: ['黑莓'],
        confidence: 1,
        evidence: '我们家的猫猫叫黑莓',
      }),
    },
  )
  try {
    assert.equal(duplicate.result.duplicates, 1)
    assert.equal(duplicate.result.written, 0)
    assert.equal(duplicate.memory.db.list('fact').filter((row) => row.content.includes('黑莓')).length, 1)
  } finally {
    await finish(duplicate)
  }

  // Repeated turns under one explicit conversation key never become a
  // cross-conversation candidate.
  const sameSession = await realGateCase(
    root,
    'same-session',
    entriesFor('我们家的猫猫叫黑莓', [base, base + day, base + day * 2], ['same', 'same', 'same']),
  )
  try {
    assert.equal(sameSession.result.candidates, 0)
    assert.equal(memoryRowCount(sameSession.memory), 0)
  } finally {
    await finish(sameSession)
  }

  const underDay = await realGateCase(
    root,
    'under-day',
    entriesFor('我们家的猫猫叫黑莓', [base, base + day - 1], ['under-1', 'under-2']),
  )
  try {
    assert.equal(underDay.result.candidates, 0)
    assert.equal(memoryRowCount(underDay.memory), 0)
  } finally {
    await finish(underDay)
  }

  const allowed = await realGateCase(
    root,
    'allowed',
    entriesFor('我们家的猫猫叫黑莓', [base, base + day], ['allowed-1', 'allowed-2']),
  )
  try {
    assert.ok(allowed.result.candidates >= 1)
    assert.equal(allowed.result.written, 1)
    assert.equal(allowed.memory.db.list('fact').filter((row) => row.content.includes('黑莓')).length, 1)
  } finally {
    await finish(allowed)
  }

  // Missing injection is fail-closed even with real SQLite-backed components.
  const missing = await realGateCase(
    root,
    'missing-gate',
    entriesFor('我们家的猫猫叫黑莓', [base, base + day]),
    { injectGate: false },
  )
  try {
    assert.equal(missing.result.reason, 'memory-gate-missing')
    assert.equal(memoryRowCount(missing.memory), 0)
    assert.equal((await missing.buffer.pendingExperience({ limit: 20 })).length, 2)
  } finally {
    await finish(missing)
  }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-experience-consolidator-'))
  let memory = null
  try {
    // Repeated life experience becomes a raw PetMemory fact for Reflection.
    memory = new PetMemory(root)
    const repeatedRows = [
      row(1, '黑莓又睡沙发了', { conversationId: 'c1', createdAt: 1_800_000_000_000 }),
      row(2, '黑莓今天又睡沙发', { conversationId: 'c2', createdAt: 1_800_086_400_000 }),
      row(3, '黑莓还是睡沙发', { conversationId: 'c3', createdAt: 1_800_172_800_000 }),
    ]
    const repeatedBuffer = new FakeExperienceBuffer(repeatedRows)
    const repeated = makeConsolidator(repeatedBuffer, memory)
    const analysis = await repeated.analyze()
    const sofaCandidate = analysis.candidates.find((candidate) => candidate.term === '睡沙发')
    assert.ok(sofaCandidate)
    assert.equal(sofaCandidate.occurrences, 3)
    assert.equal(sofaCandidate.turns, 3)
    assert.equal(sofaCandidate.evidence, '黑莓又睡沙发了')
    assert.equal(sofaCandidate.content, '主人说：黑莓又睡沙发了')
    assert.equal(sofaCandidate.importance, 3)
    assert.equal(sofaCandidate.level, 'fact')
    assert.equal(sofaCandidate.messageId, 'message-1')
    assert.ok(sofaCandidate.experienceIds.includes(1))
    assert.equal(analysis.scanned, 3)

    const repeatedResult = await repeated.consolidate()
    assert.equal(repeatedResult.ok, true)
    assert.equal(repeatedResult.status, 'completed')
    assert.equal(repeatedResult.written, 1)
    assert.deepEqual(repeatedResult.processedIds, [1, 2, 3])
    assert.equal(repeatedBuffer.markCalls.length, 1)
    assert.equal(typeof repeatedBuffer.markCalls[0].processedAt, 'number')
    const sofaMemory = memory.findEquivalentMemory(sofaCandidate.content)
    assert.ok(sofaMemory)
    assert.equal(sofaMemory.level, 'fact')
    assert.equal(sofaMemory.importance, 3)
    assert.equal(sofaMemory.source_session, 'vc-ai-pet')
    const sofaMemoryWithProvenance = memory.findById(sofaMemory.id).row
    // Consolidation is now a MemoryGate write, so provenance identifies the
    // gate while preserving the same raw owner evidence quote.
    assert.equal(sofaMemoryWithProvenance.provenance.source, 'MEMORY_GATE_ACCEPTED')
    assert.equal(sofaMemoryWithProvenance.provenance.evidence, 'confirmed')
    assert.equal(sofaMemoryWithProvenance.provenance.evidenceQuote, sofaCandidate.evidence)
    assert.equal(isRawEvidenceRow(sofaMemoryWithProvenance), true)

    // A second pass over the same pending batch is deduplicated before write.
    const duplicateBuffer = new FakeExperienceBuffer(repeatedRows)
    const duplicatePass = await makeConsolidator(duplicateBuffer, memory).consolidate()
    assert.ok(duplicatePass.duplicates >= 1)
    assert.equal(duplicatePass.written, 0)
    assert.equal(memory.findEquivalentMemory(sofaCandidate.content).id, sofaMemory.id)

    // A one-off event is inspected but never written, and stays pending.
    //
    // Consolidation may only consume what it decided something about. A single
    // occurrence forms no stable group, so it is *not* consumed: it remains in the
    // buffer for Reflection to read. The previous behaviour marked it processed,
    // which meant one tick could swallow a whole day of ordinary conversation that
    // had not yet been reflected on.
    const accidentalBuffer = new FakeExperienceBuffer([row(11, '黑莓睡沙发')])
    const accidental = makeConsolidator(accidentalBuffer, fakeMemory())
    assert.equal((await accidental.analyze()).candidates.length, 0)
    const accidentalResult = await accidental.consolidate()
    assert.equal(accidentalResult.written, 0)
    assert.deepEqual(accidentalResult.processedIds, [])
    assert.deepEqual(accidentalBuffer.pendingIds(), [11])

    // limit bounds the scanned batch; unseen rows remain pending, and a scanned
    // row with no stable group is not consumed either.
    const limitedBuffer = new FakeExperienceBuffer([
      row(21, '黑莓睡沙发', { conversationId: 'l1' }),
      row(22, '黑莓睡沙发', { conversationId: 'l2' }),
      row(23, '黑莓睡沙发', { conversationId: 'l3' }),
    ])
    const limitedResult = await makeConsolidator(limitedBuffer, fakeMemory()).consolidate({ limit: 1 })
    assert.equal(limitedResult.scanned, 1)
    assert.deepEqual(limitedResult.processedIds, [])
    assert.deepEqual(limitedBuffer.pendingIds(), [21, 22, 23])

    // Five messages in one conversation are still one conversation for stability purposes.
    const sameTurnBuffer = new FakeExperienceBuffer(
      Array.from({ length: 5 }, (_, index) => row(31 + index, '黑莓睡沙发', { conversationId: 'same-conversation' })),
    )
    const sameTurn = await makeConsolidator(sameTurnBuffer, fakeMemory()).analyze()
    assert.equal(sameTurn.candidates.length, 0)

    // Pet/system messages never contribute owner evidence.
    const nonOwnerBuffer = new FakeExperienceBuffer([
      row(41, '黑莓睡沙发', { actorId: 'pet', conversationId: 'p1' }),
      row(42, '黑莓睡沙发', { actorId: 'system', conversationId: 's1' }),
    ])
    const nonOwner = makeConsolidator(nonOwnerBuffer, fakeMemory())
    const nonOwnerAnalysis = await nonOwner.analyze()
    assert.equal(nonOwnerAnalysis.candidates.length, 0)
    assert.equal(nonOwnerAnalysis.skipped.nonOwner, 2)

    // Sensitive owner text is rejected even when it contains memory language.
    const sensitive = makeConsolidator(
      new FakeExperienceBuffer([row(51, '我的密码是 abc，记住')]),
      fakeMemory(),
    )
    const sensitiveAnalysis = await sensitive.analyze()
    assert.ok(sensitiveAnalysis.skipped.sensitive >= 1)
    const sensitiveResult = await sensitive.consolidate()
    assert.equal(sensitiveResult.written, 0)

    // Stop-only text does not produce a life term.
    const stopOnly = await makeConsolidator(
      new FakeExperienceBuffer([row(61, '主人花花今天现在什么怎么可以一个这个那个')]),
      fakeMemory(),
    ).analyze()
    assert.equal(stopOnly.candidates.length, 0)

    // Any failure is returned to the background caller and leaves the buffer untouched.
    const memoryFailureBuffer = new FakeExperienceBuffer([
      row(71, '黑莓睡沙发', { conversationId: 'f1' }),
      row(72, '黑莓睡沙发', { conversationId: 'f2' }),
    ])
    const memoryFailure = await makeConsolidator(memoryFailureBuffer, fakeMemory({ failFind: true })).consolidate()
    assert.deepEqual(memoryFailure, { status: 'failed', ok: false, reason: 'MEMORY_FIND_FAILURE' })
    assert.equal(memoryFailureBuffer.markCalls.length, 0)

    const bufferFailureBuffer = new FakeExperienceBuffer([row(73, '黑莓睡沙发')], { failPending: true })
    const bufferFailure = await makeConsolidator(bufferFailureBuffer, fakeMemory()).consolidate()
    assert.deepEqual(bufferFailure, { status: 'failed', ok: false, reason: 'BUFFER_PENDING_FAILURE' })
    assert.equal(bufferFailureBuffer.markCalls.length, 0)

    // maxTerms limits writes while preserving rows needed by deferred terms.
    const manyTerms = Array.from({ length: 12 }, (_, index) => `life-term-${String(index + 1).padStart(2, '0')}`)
    const manyRows = manyTerms.flatMap((term, index) => [
      row(100 + index * 2, term, { conversationId: `many-${index}-a` }),
      row(101 + index * 2, term, { conversationId: `many-${index}-b` }),
    ])
    const manyBuffer = new FakeExperienceBuffer(manyRows)
    const manyMemory = fakeMemory()
    const manyConsolidator = makeConsolidator(manyBuffer, manyMemory)
    const manyResult = await manyConsolidator.consolidate()
    assert.equal(EXPERIENCE_CONSOLIDATION_MAX_TERMS, 8)
    assert.ok(manyResult.candidates >= 12)
    assert.ok(manyResult.written <= 8)
    assert.ok(manyBuffer.pendingIds().length > 0)
    const remainingResult = await manyConsolidator.consolidate()
    assert.ok(remainingResult.written >= 1)
    assert.deepEqual(manyBuffer.pendingIds(), [])

    // Legacy callers that do not inject MemoryGate fail closed and retain all
    // evidence for a later retry; they must never regain the old direct-write path.
    const missingGateMemory = fakeMemory()
    const missingGateBuffer = new FakeExperienceBuffer([
      row(301, '黑莓睡沙发', { conversationId: 'mg-1' }),
      row(302, '黑莓睡沙发', { conversationId: 'mg-2' }),
    ])
    const missingGate = await new ExperienceConsolidator({
      buffer: missingGateBuffer,
      memory: missingGateMemory,
      now: () => 1_800_000_000_000,
      minDaySpanMs: 0,
    }).consolidate()
    assert.equal(missingGate.status, 'failed')
    assert.equal(missingGate.reason, 'memory-gate-missing')
    assert.equal(missingGateMemory.rows.length, 0)
    assert.deepEqual(missingGateBuffer.pendingIds(), [301, 302])

    await runRealGateRegressions(root)
    await runRollbackRegression(root)

    console.log('EXPERIENCE_CONSOLIDATOR=PASS')
  } finally {
    try { memory?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    await assert.rejects(stat(root))
  }
}

await main()
