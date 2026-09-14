import assert from 'node:assert/strict'
import {
  evaluateDerivedEvidence,
  isObservationEvidenceRow,
  isRawEvidenceRow,
} from '../src/memory/derived-evidence.js'
import {
  isConfirmedProvenance,
  normalizeProvenance,
} from '../src/memory/memory-provenance.js'

const raw = {
  id: 'raw-1',
  level: 'fact',
  content: '主人陪我在公园散步。',
  source_session: 'vc-ai-pet',
  provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' },
}
const observation = {
  id: 'visual-1',
  role: 'assistant',
  level: 'fact',
  content: '看到画面里有一条红色围巾。',
  provenance: { source: 'VISUAL_OBSERVATION', evidence: 'confirmed' },
}
const assistant = {
  id: 'assistant-1',
  role: 'assistant',
  level: 'fact',
  content: '我觉得主人喜欢红色。',
  provenance: { source: 'ASSISTANT_RESPONSE', evidence: 'confirmed' },
}
const candidate = { level: 'lesson', sourceIds: ['raw-1', 'visual-1'] }
const context = (sourceRows, newSourceIds) => ({ sourceRows, newSourceIds })

const normalizedObservation = normalizeProvenance(observation.provenance)
assert.equal(normalizedObservation.source, 'VISUAL_OBSERVATION')
assert.equal(normalizedObservation.evidence, 'inferred')
assert.equal(isConfirmedProvenance(normalizedObservation), false)
assert.equal(isObservationEvidenceRow(observation), true)
assert.equal(isRawEvidenceRow(observation), false)

// A visual observation is valid supplemental evidence when a real raw root is
// also cited — but it must not enlarge the evidence budget. The declaration the
// Dream/Reflection prompts carry says an observation "不能作为 source_ids，不能增加
// evidenceCount，不能提高 confidence", so citing one may not move either number.
const withoutObservation = evaluateDerivedEvidence(
  { level: 'lesson', sourceIds: ['raw-1'] },
  context([raw, observation], ['raw-1']),
)
const supported = evaluateDerivedEvidence(candidate, context([raw, observation], ['visual-1']))
assert.ok(supported)
assert.deepEqual(supported.sourceRoots, ['raw-1'])
assert.equal(supported.evidenceCount, withoutObservation.evidenceCount)
assert.equal(supported.confidence, withoutObservation.confidence)
assert.equal(supported.evidenceCount, 1)
assert.equal(supported.confidence, 0.45)

// A re-inspection observation cites its image anchor. Traceability flows through
// that anchor — a confirmed root — never through the observation's own id.
const anchoredObservation = {
  id: 'visual-2',
  role: 'assistant',
  level: 'fact',
  content: '花花又看了一眼这张图片：画面里有一条红色围巾。',
  provenance: { source: 'VISUAL_OBSERVATION', evidence: 'inferred', sourceIds: ['raw-1'] },
}
assert.equal(
  evaluateDerivedEvidence({ level: 'lesson', sourceIds: ['visual-2'] }, context([raw, anchoredObservation], ['visual-2'])),
  null,
)
const traced = evaluateDerivedEvidence(
  { level: 'lesson', sourceIds: ['visual-2', 'raw-1'] },
  context([raw, anchoredObservation], ['visual-2']),
)
assert.ok(traced)
assert.deepEqual(traced.sourceRoots, ['raw-1'])
assert.equal(traced.evidenceCount, 1)

// The inferred observation cannot bootstrap a derived memory by itself.
assert.equal(
  evaluateDerivedEvidence({ level: 'lesson', sourceIds: ['visual-1'] }, context([observation], ['visual-1'])),
  null,
)

// Assistant output remains an invalid cited source even when a raw root is
// present alongside it.
assert.equal(
  evaluateDerivedEvidence(
    { level: 'lesson', sourceIds: ['raw-1', 'assistant-1'] },
    context([raw, assistant], ['assistant-1']),
  ),
  null,
)

console.log('VISUAL_DERIVED_EVIDENCE=PASS')
