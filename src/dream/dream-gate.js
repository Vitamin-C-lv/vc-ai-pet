import { evaluateDerivedEvidence, findSameEvidenceDerivation } from '../memory/derived-evidence.js'
import { normalizeProvenance } from '../memory/memory-provenance.js'
import { validateDerivedMemorySemantics } from '../memory/semantic-stability.js'

const DREAM_DERIVED_LEVELS = new Set(['soul', 'user', 'fact', 'lesson', 'topic'])

function cleanString(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function asIdSet(value) {
  if (value instanceof Set) return new Set([...value].map((id) => String(id)))
  if (Array.isArray(value)) return new Set(value.map((id) => String(id)))
  return new Set()
}

/**
 * Validate one model-produced Dream memory without touching the database.
 *
 * `availableSourceIds` is the complete set of IDs shown to the model for the
 * batch. `newSourceIds` is the subset belonging to that batch's new history.
 * When supplied, `rawSourceIds` and `rawNewSourceIds` are row-aware sets for
 * memories whose source_session is exactly `vc-ai-pet`; they are the only
 * provenance accepted as raw evidence.
 */
export function validateDreamCandidate(
  raw,
  {
    newSourceIds = [],
    availableSourceIds = [],
    rawSourceIds = undefined,
    rawNewSourceIds = undefined,
    sourceRows = [],
    findById,
  } = {},
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const level = cleanString(raw.level, 16)
  const content = cleanString(raw.content, 180)
  const importance = Number(raw.importance)
  const confidence = Number(raw.confidence)

  if (!DREAM_DERIVED_LEVELS.has(level)) return null
  if (content.length < 4) return null
  if (!Number.isInteger(importance) || importance < 2 || importance > 3) return null
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null
  if (level === 'soul' && (
    importance !== 3 ||
    !content.startsWith('我')
  )) return null

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords
        .map((item) => cleanString(item, 24))
        .filter(Boolean)
        .slice(0, 6)
    : []

  // Do not truncate provenance. An overlong source list is malformed and
  // must fail closed, even when entries after the eighth are duplicates.
  if (!Array.isArray(raw.source_ids) || raw.source_ids.length > 8) return null

  const sourceIds = [...new Set(
    raw.source_ids
      .map((item) => cleanString(item, 64))
      .filter(Boolean),
  )]

  if (sourceIds.length === 0) return null

  const availableIds = asIdSet(availableSourceIds)
  if (!sourceIds.every((id) => availableIds.has(id))) return null
  const evidence = evaluateDerivedEvidence({ level, sourceIds }, { sourceRows, newSourceIds, findById })
  if (!evidence) return null

  return {
    level,
    content,
    importance,
    ...evidence,
    keywords,
    sourceIds,
  }
}

export class DreamGate {
  constructor({ memory }) {
    this.memory = memory
  }

  consider(raw, context) {
    const candidate = validateDreamCandidate(raw, context)

    if (!candidate) {
      return {
        status: 'skipped',
        reason: 'invalid-candidate',
      }
    }

    const semantic = validateDerivedMemorySemantics(raw, {
      sourceRows: context?.sourceRows,
      protectedTerms: context?.protectedTerms,
    })
    if (!semantic.approved) {
      return {
        status: 'skipped',
        reason: 'semantic-drift',
        semantic,
      }
    }

    const requested = raw?.provenance ?? { source: 'DREAM_DERIVED' }
    if (normalizeProvenance(requested).source !== 'DREAM_DERIVED') return { status: 'skipped', reason: 'invalid-provenance' }
    const provenance = { ...normalizeProvenance({
      source: 'DREAM_DERIVED',
      evidence: 'inferred',
      sourceIds: candidate.sourceIds,
    }), sourceRoots: candidate.sourceRoots, confidence: candidate.confidence,
      evidenceCount: candidate.evidenceCount, ...(candidate.selfStatus ? { selfStatus: candidate.selfStatus } : {}) }
    if (provenance.source !== 'DREAM_DERIVED' || provenance.evidence !== 'inferred') {
      return {
        status: 'skipped',
        reason: 'invalid-provenance',
      }
    }

    const existing = this.memory.findEquivalentMemory(candidate.content) ??
      this.memory.findSameEvidenceDerivation?.({ ...candidate, provenance }) ??
      findSameEvidenceDerivation({ ...candidate, provenance }, context?.sourceRows)

    if (existing) {
      return {
        status: 'duplicate',
        existingId: existing.id,
      }
    }

    const row = this.memory.rememberDreamCandidate({ ...candidate, provenance })

    return {
      status: 'written',
      row,
      sourceIds: candidate.sourceIds,
      provenance,
      semantic,
    }
  }
}
