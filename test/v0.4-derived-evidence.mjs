import assert from 'node:assert/strict'
import { evaluateDerivedEvidence, isRawEvidenceRow } from '../src/memory/derived-evidence.js'
import { DreamGate } from '../src/dream/dream-gate.js'
import { DreamEngine } from '../src/dream/dream-engine.js'
import { ReflectionGate, ReflectionEngine } from '../src/dream/reflection-engine.js'

const raw = (id, extra = {}) => ({ id, level: 'fact', content: '主人陪我在公园散步。',
  status: 'active', importance: 2, created_at: 10, source_session: 'vc-ai-pet',
  provenance: { source: 'USER_STATEMENT', evidence: 'confirmed', sourceIds: [] }, ...extra })
const root = raw('original')
const copy = raw('copy', { provenance: { source: 'MEMORY_GATE_ACCEPTED', sourceIds: ['original'] } })
const background = raw('old-dream', { source_session: 'vc-ai-pet:dream',
  provenance: { source: 'DREAM_DERIVED', evidence: 'inferred', sourceIds: ['original'], sourceRoots: ['original'] } })
const proposal = { level: 'soul', content: '我也许喜欢陪主人散步。', importance: 3,
  confidence: 0.99, keywords: ['散步'], source_ids: ['original'] }
const context = (rows, newIds = ['original']) => ({ sourceRows: rows, newSourceIds: newIds,
  availableSourceIds: rows.map((row) => row.id) })

for (const source of ['ASSISTANT_RESPONSE', 'DREAM_DERIVED', 'REFLECTION_DERIVED']) {
  const disguised = raw('disguised', { provenance: { source, evidence: 'confirmed' } })
  assert.equal(isRawEvidenceRow(disguised), false)
  assert.equal(evaluateDerivedEvidence({ ...proposal, source_ids: ['disguised'] }, context([disguised], ['disguised'])), null)
}
assert.equal(isRawEvidenceRow(raw('assistant-role', { role: 'assistant' })), false)
const initial = evaluateDerivedEvidence(proposal, context([root]))
assert.equal(initial.confidence, 0.45)
assert.equal(initial.selfStatus, 'hypothesis')
const repeated = evaluateDerivedEvidence({ ...proposal, source_ids: ['original', 'copy', 'old-dream', 'copy'] }, context([root, copy, background]))
assert.deepEqual(repeated, initial)
assert.equal(evaluateDerivedEvidence({ ...proposal, source_ids: ['old-dream'] }, context([background], ['old-dream'])), null)
assert.equal(evaluateDerivedEvidence(proposal, context([root], [])), null)
const independent = [root, raw('second'), raw('third'), raw('fourth'), raw('fifth'), raw('sixth')]
const supported = evaluateDerivedEvidence({ ...proposal, source_ids: independent.map((row) => row.id) }, context(independent))
assert.equal(supported.confidence, 0.8)
assert.equal(supported.selfStatus, 'evolving')

const written = []
const memory = { findEquivalentMemory: () => null,
  rememberDreamCandidate: (candidate) => { written.push(candidate); return { id: 'dream-new', ...candidate } },
  rememberReflectionCandidate: (candidate) => { written.push(candidate); return { id: 'reflection-new', ...candidate } } }
const dreamGate = new DreamGate({ memory })
const accepted = dreamGate.consider(proposal, context([root]))
assert.equal(accepted.status, 'written')
assert.equal(written[0].confidence, 0.45)
assert.deepEqual(written[0].provenance.sourceRoots, ['original'])
assert.equal(written[0].provenance.evidence, 'inferred')

const prior = { ...background, level: 'lesson' }
const reworded = { ...proposal, level: 'lesson', content: '一起散步可能让我更愿意陪伴主人。', source_ids: ['original', 'old-dream'] }
assert.equal(new ReflectionGate({ memory }).consider(reworded, context([root, prior])).status, 'duplicate')
const priorReflection = { ...prior, source_session: 'vc-ai-pet:reflection', provenance: { ...prior.provenance, source: 'REFLECTION_DERIVED' } }
assert.equal(dreamGate.consider(reworded, context([root, priorReflection])).status, 'duplicate')
assert.equal(written.length, 1)

// An explicit derived/assistant provenance must stop an engine before LLM or lease work.
for (const [Engine, kind] of [[DreamEngine, 'dream'], [ReflectionEngine, 'reflection']]) {
  let calls = 0
  const adapter = { ...memory,
    [`${kind}SourceRows`]: () => [raw('fake', { provenance: { source: 'ASSISTANT_RESPONSE' } }), background],
    [`relatedFor${kind === 'dream' ? 'Dream' : 'Reflection'}`]: () => [],
    [`${kind}Window`]: () => ({ last_dream_time: 0 }),
    [`claim${kind === 'dream' ? 'Dream' : 'Reflection'}`]: () => { calls++; return true },
    [`finish${kind === 'dream' ? 'Dream' : 'Reflection'}`]: () => {},
    [`log${kind === 'dream' ? 'Dream' : 'Reflection'}`]: () => {} }
  const brain = { [`${kind}Completion`]: () => { calls++; throw Error('unexpected completion') } }
  const result = await new Engine({ memory: adapter, brain }).run({ now: 20 })
  assert.equal(result.reason, 'no-new-sources')
  assert.equal(calls, 0)
}
console.log('PASS v0.4 derived evidence: raw identity, root dedupe, weak self, bounded confidence, cross-loop and no-new-raw gates')
