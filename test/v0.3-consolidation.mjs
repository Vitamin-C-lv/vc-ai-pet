import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

import { classifyMemoryEvidence, classifyMemorySource } from '../src/brain/prompt-builder.js'
import { createDreamCandidate, validateDreamCandidateSemantics } from '../src/dream/dream-candidate.js'
import { DreamGate, validateDreamCandidate } from '../src/dream/dream-gate.js'
import {
  isConfirmedProvenance,
  normalizeProvenance,
} from '../src/memory/memory-provenance.js'
import { PetMemory } from '../src/memory/pet-memory.js'
import { checkSemanticStability } from '../src/memory/semantic-stability.js'

const NOW = Date.parse('2026-09-03T12:00:00+08:00')

function insertRaw(memory, { id, content, keywords = [], createdAt = NOW - 1000 }) {
  return memory.db.insert({
    id,
    level: 'fact',
    title: null,
    content,
    importance: 2,
    keywords,
    status: 'active',
    source_session: 'vc-ai-pet',
    created_at: createdAt,
    updated_at: createdAt,
  })
}

function candidate(content, sourceId) {
  return {
    level: 'fact',
    content,
    importance: 2,
    keywords: ['颜色', '偏好'],
    confidence: 0.9,
    source_ids: [sourceId],
  }
}

function candidateContext(sourceRow) {
  const id = sourceRow.id
  return {
    newSourceIds: new Set([id]),
    availableSourceIds: new Set([id]),
    rawSourceIds: new Set([id]),
    rawNewSourceIds: new Set([id]),
    sourceRows: [sourceRow],
  }
}

async function withSandbox(name, fn) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-consolidation-${name}-`))
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

// 1. A user statement is explicit provenance and confirmed context.
await withSandbox('provenance', async ({ memory }) => {
  const row = memory.rememberCandidate({
    level: 'fact',
    content: '主人喜欢群青色。',
    importance: 2,
    keywords: ['主人', '喜欢', '群青色'],
    provenance: { source: 'USER_STATEMENT' },
  })

  assert.equal(row.provenance.source, 'USER_STATEMENT')
  assert.equal(row.provenance.evidence, 'confirmed')
  assert.equal(memory.provenanceForMemory(row.id).source, 'USER_STATEMENT')
  assert.equal(classifyMemorySource(row), 'USER_STATEMENT')
  assert.equal(classifyMemoryEvidence(row), 'confirmed')
})

// 2/3. Protected semantic anchors reject cyan but accept a safe description.
const drift = checkSemanticStability({ source: '群青色', derived: '主人偏好 cyan。' })
assert.equal(drift.status, 'DRIFT_DETECTED')
assert.equal(drift.driftDetected, true)
assert.equal(drift.approved, false)

const stableColor = checkSemanticStability({ source: '群青色', derived: '主人偏好深蓝色调。' })
assert.equal(stableColor.status, 'KEEP_ORIGINAL_TERM')
assert.equal(stableColor.keepOriginalTerm, true)
assert.equal(stableColor.approved, true)

const dateDrift = checkSemanticStability({ source: '事件发生于 2026-08-31。', derived: '事件发生于 2026-09-01。' })
assert.equal(dateDrift.status, 'DRIFT_DETECTED')
assert.equal(dateDrift.conflicts[0].field, 'date')

// 4. Assistant responses can be represented for audit, but never as confirmed.
const assistantProvenance = normalizeProvenance({
  source: 'ASSISTANT_RESPONSE',
  evidence: 'confirmed',
})
assert.equal(assistantProvenance.source, 'ASSISTANT_RESPONSE')
assert.equal(assistantProvenance.evidence, 'unknown')
assert.equal(isConfirmedProvenance(assistantProvenance), false)
assert.equal(classifyMemoryEvidence({ provenance: assistantProvenance }), 'unknown')

// 5. Old rows remain readable through source_session fallback, with no
// metadata backfill or rewrite of the legacy row itself.
await withSandbox('legacy-and-candidate', async ({ memory }) => {
  const legacy = insertRaw(memory, {
    id: 'legacy-color-memory',
    content: '旧版记忆：主人选择了群青色。',
    keywords: ['群青色'],
  })
  const legacyDecorated = memory.provenanceStore.decorate(legacy)
  assert.equal(legacyDecorated.provenance.source, 'SYSTEM_EVENT')
  assert.equal(legacyDecorated.provenance.evidence, 'confirmed')
  assert.equal(legacyDecorated.provenance.legacy, true)
  assert.equal(memory.db.findById(legacy.id).row.content, legacy.content)
  assert.ok(memory.recall('旧版记忆 群青色', 5, { bumpHits: false }).some(({ id }) => id === legacy.id))

  const source = insertRaw(memory, {
    id: 'candidate-color-source',
    content: '主人明确选择了群青色作为房间颜色。',
    keywords: ['主人', '群青色', '颜色'],
  })
  const context = candidateContext(source)
  const gate = new DreamGate({ memory })

  const cyanCandidate = createDreamCandidate(candidate('派生理解：主人喜欢 cyan。', source.id))
  assert.equal(cyanCandidate.candidateType, 'DREAM_CANDIDATE')
  assert.equal(cyanCandidate.provenance.source, 'DREAM_DERIVED')
  assert.equal(validateDreamCandidate(cyanCandidate, context).sourceIds[0], source.id)
  const rejected = validateDreamCandidateSemantics(cyanCandidate, { sourceRows: context.sourceRows })
  assert.equal(rejected.status, 'DRIFT_DETECTED')
  assert.equal(rejected.candidate, null)
  const rejectedWrite = gate.consider(cyanCandidate, context)
  assert.equal(rejectedWrite.status, 'skipped')
  assert.equal(rejectedWrite.reason, 'semantic-drift')
  assert.equal(memory.db.list('fact').filter(({ source_session }) => source_session === 'vc-ai-pet:dream').length, 0)

  const stableCandidate = createDreamCandidate(candidate('派生理解：主人偏好深蓝色调。', source.id))
  const approved = validateDreamCandidateSemantics(stableCandidate, { sourceRows: context.sourceRows })
  assert.equal(approved.status, 'KEEP_ORIGINAL_TERM')
  assert.ok(approved.candidate)
  const written = gate.consider(stableCandidate, context)
  assert.equal(written.status, 'written')
  assert.equal(written.provenance.source, 'DREAM_DERIVED')
  assert.equal(written.provenance.evidence, 'inferred')
  assert.equal(written.row.provenance.source, 'DREAM_DERIVED')
  assert.equal(written.row.provenance.evidence, 'inferred')
  assert.deepEqual(written.row.provenance.sourceIds, [source.id])
  assert.equal(memory.provenanceForMemory(written.row.id).source, 'DREAM_DERIVED')

  const reflection = memory.rememberReflectionCandidate({
    level: 'fact',
    content: 'Reflection 保留了群青色这个原始颜色词。',
    importance: 2,
    keywords: ['群青色'],
    confidence: 0.9,
    sourceIds: [source.id],
  })
  assert.equal(reflection.provenance.source, 'REFLECTION_DERIVED')
  assert.equal(reflection.provenance.evidence, 'inferred')
})

console.log('FINAL_STATUS=VC_AI_PET_V0_3_D_PHASE1')
console.log('MEMORY_PROVENANCE=PASS')
console.log('SEMANTIC_STABILITY=PASS')
console.log('DREAM_CANDIDATE_LAYER=PASS')
console.log('LEGACY_MEMORY_COMPATIBILITY=PASS')
console.log('PRODUCTION_DB_MODIFIED=NO')
console.log('DREAM_RERUN=NO')
console.log('COMMIT=NOT_CREATED')
console.log('PUSH=NOT_RUN')
