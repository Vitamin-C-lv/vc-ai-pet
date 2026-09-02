import { normalizeProvenance } from '../memory/memory-provenance.js'
import { validateDerivedMemorySemantics } from '../memory/semantic-stability.js'

export const DREAM_CANDIDATE_KIND = 'DREAM_CANDIDATE'

function sourceIdsOf(value) {
  const sourceIds = value?.sourceIds ?? value?.source_ids ?? value?.provenance?.sourceIds
  if (!Array.isArray(sourceIds)) return []
  return [...new Set(sourceIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
}

/**
 * Wrap a model response before any derived-memory write is possible. The
 * wrapper remains compatible with the existing snake_case Dream schema.
 */
export function createDreamCandidate(rawCandidate, { source = 'DREAM_DERIVED' } = {}) {
  if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) return null

  const sourceIds = sourceIdsOf(rawCandidate)
  return {
    ...rawCandidate,
    source_ids: sourceIds,
    sourceIds,
    candidateType: DREAM_CANDIDATE_KIND,
    provenance: normalizeProvenance({
      source,
      evidence: 'inferred',
      sourceIds,
    }),
  }
}

/**
 * Run semantic stability after structural/source-id validation and before the
 * DreamGate is allowed to call rememberDreamCandidate().
 */
export function validateDreamCandidateSemantics(candidate, options = {}) {
  const stability = validateDerivedMemorySemantics(candidate, options)
  if (!stability.approved) return { ...stability, candidate: null }

  const sourceIds = sourceIdsOf(candidate)
  return {
    ...stability,
    candidate: {
      ...candidate,
      source_ids: sourceIds,
      sourceIds,
      candidateType: DREAM_CANDIDATE_KIND,
      provenance: normalizeProvenance({
        source: 'DREAM_DERIVED',
        evidence: 'inferred',
        sourceIds,
      }),
    },
  }
}

export function approveDreamCandidate(candidate, options = {}) {
  return validateDreamCandidateSemantics(candidate, options).candidate
}

export const createCandidate = createDreamCandidate
export const validateCandidateSemantics = validateDreamCandidateSemantics
