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
  if (!Number.isFinite(confidence) || confidence < 0.72 || confidence > 1) return null
  if (level === 'soul' && (
    importance !== 3 ||
    confidence < 0.82 ||
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
  if (level === 'soul' && sourceIds.length < 2) return null

  const newIds = asIdSet(newSourceIds)
  const availableIds = asIdSet(availableSourceIds)
  const hasRawProvenance = rawSourceIds !== undefined || rawNewSourceIds !== undefined
  const rawIds = asIdSet(rawSourceIds)
  const rawNewIds = new Set(
    [...asIdSet(rawNewSourceIds)].filter((id) => rawIds.has(id) && newIds.has(id)),
  )

  // Every citation must be a real memory that was supplied in this batch.
  if (!sourceIds.every((id) => availableIds.has(id))) return null

  if (level === 'soul') {
    // Soul is fail-closed when row-aware provenance is unavailable. Related
    // reflection/dream/soul rows may be cited, but at least two cited IDs must
    // resolve to raw vc-ai-pet rows and one of those must be current NEW raw.
    if (rawSourceIds === undefined || rawNewSourceIds === undefined) return null
    const citedRawIds = sourceIds.filter((id) => rawIds.has(id))
    if (citedRawIds.length < 2) return null
    if (!citedRawIds.some((id) => rawNewIds.has(id))) return null
  } else if (hasRawProvenance) {
    // Once row-aware provenance is provided, non-soul candidates also need a
    // current raw NEW source; derived related history cannot satisfy NEW.
    if (rawSourceIds === undefined || rawNewSourceIds === undefined) return null
    if (!sourceIds.some((id) => rawNewIds.has(id))) return null
  } else if (!sourceIds.some((id) => newIds.has(id))) {
    // Backward-compatible callers without row-aware context still retain the
    // original NEW-source check. DreamEngine always supplies the raw sets.
    return null
  }

  return {
    level,
    content,
    importance,
    confidence,
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

    const existing = this.memory.findEquivalentMemory(candidate.content)

    if (existing) {
      return {
        status: 'duplicate',
        existingId: existing.id,
      }
    }

    const row = this.memory.rememberDreamCandidate(candidate)

    return {
      status: 'written',
      row,
      sourceIds: candidate.sourceIds,
    }
  }
}
