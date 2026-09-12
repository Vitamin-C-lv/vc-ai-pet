import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PetMemory } from '../src/memory/pet-memory.js'
import { isRawEvidenceRow } from '../src/memory/derived-evidence.js'
import {
  ExperienceConsolidator,
  EXPERIENCE_CONSOLIDATION_MAX_TERMS,
} from '../src/experience/experience-consolidator.js'

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
  }
}

function makeConsolidator(buffer, memory, options = {}) {
  return new ExperienceConsolidator({
    buffer,
    memory,
    now: () => 1_800_000_000_000,
    ...options,
  })
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
    assert.equal(sofaMemoryWithProvenance.provenance.source, 'USER_STATEMENT')
    assert.equal(sofaMemoryWithProvenance.provenance.evidence, 'confirmed')
    assert.equal(sofaMemoryWithProvenance.provenance.evidenceQuote, sofaCandidate.evidence)
    assert.equal(isRawEvidenceRow(sofaMemoryWithProvenance), true)

    // A second pass over the same pending batch is deduplicated before write.
    const duplicateBuffer = new FakeExperienceBuffer(repeatedRows)
    const duplicatePass = await makeConsolidator(duplicateBuffer, memory).consolidate()
    assert.ok(duplicatePass.duplicates >= 1)
    assert.equal(duplicatePass.written, 0)
    assert.equal(memory.findEquivalentMemory(sofaCandidate.content).id, sofaMemory.id)

    // A one-off event is consumed after being inspected, but never written.
    const accidentalBuffer = new FakeExperienceBuffer([row(11, '黑莓睡沙发')])
    const accidental = makeConsolidator(accidentalBuffer, fakeMemory())
    assert.equal((await accidental.analyze()).candidates.length, 0)
    const accidentalResult = await accidental.consolidate()
    assert.equal(accidentalResult.written, 0)
    assert.deepEqual(accidentalResult.processedIds, [11])
    assert.deepEqual(accidentalBuffer.pendingIds(), [])

    // limit bounds the scanned batch; unseen rows remain pending.
    const limitedBuffer = new FakeExperienceBuffer([
      row(21, '黑莓睡沙发', { conversationId: 'l1' }),
      row(22, '黑莓睡沙发', { conversationId: 'l2' }),
      row(23, '黑莓睡沙发', { conversationId: 'l3' }),
    ])
    const limitedResult = await makeConsolidator(limitedBuffer, fakeMemory()).consolidate({ limit: 1 })
    assert.equal(limitedResult.scanned, 1)
    assert.deepEqual(limitedResult.processedIds, [21])
    assert.deepEqual(limitedBuffer.pendingIds(), [22, 23])

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

    console.log('EXPERIENCE_CONSOLIDATOR=PASS')
  } finally {
    try { memory?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    await assert.rejects(stat(root))
  }
}

await main()
