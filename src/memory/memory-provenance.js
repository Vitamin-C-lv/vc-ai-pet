/**
 * Provenance metadata for Pet Memory rows.
 *
 * The meow-memory tables are intentionally kept backward compatible: old rows
 * still use source_session and are never rewritten. New metadata is recorded
 * in a small side table only when a new memory is written, then exposed on the
 * in-memory row as `provenance`.
 */

export const MEMORY_PROVENANCE_SOURCES = Object.freeze([
  'USER_STATEMENT',
  'SYSTEM_EVENT',
  'MEMORY_GATE_ACCEPTED',
  'DREAM_DERIVED',
  'REFLECTION_DERIVED',
  'ASSISTANT_RESPONSE',
])

export const MEMORY_PROVENANCE_EVIDENCE = Object.freeze(['confirmed', 'inferred', 'unknown'])
export const UNKNOWN_PROVENANCE_SOURCE = 'UNKNOWN'
export const MEMORY_PROVENANCE_TABLE = 'memory_provenance'

const CONFIRMED_SOURCES = new Set([
  'USER_STATEMENT',
  'SYSTEM_EVENT',
  'MEMORY_GATE_ACCEPTED',
])
const INFERRED_SOURCES = new Set(['DREAM_DERIVED', 'REFLECTION_DERIVED'])

const SOURCE_ALIASES = new Map([
  ['USER_STATEMENT', 'USER_STATEMENT'],
  ['USER', 'USER_STATEMENT'],
  ['USER_MESSAGE', 'USER_STATEMENT'],
  ['SYSTEM_EVENT', 'SYSTEM_EVENT'],
  ['SYSTEM', 'SYSTEM_EVENT'],
  ['RAW', 'SYSTEM_EVENT'],
  ['INTERACTION', 'SYSTEM_EVENT'],
  ['INTERACTION_EVENT', 'SYSTEM_EVENT'],
  ['MEMORY_GATE_ACCEPTED', 'MEMORY_GATE_ACCEPTED'],
  ['MEMORY_GATE', 'MEMORY_GATE_ACCEPTED'],
  ['ACCEPTED', 'MEMORY_GATE_ACCEPTED'],
  ['DREAM_DERIVED', 'DREAM_DERIVED'],
  ['DREAM', 'DREAM_DERIVED'],
  ['REFLECTION_DERIVED', 'REFLECTION_DERIVED'],
  ['REFLECTION', 'REFLECTION_DERIVED'],
  ['ASSISTANT_RESPONSE', 'ASSISTANT_RESPONSE'],
  ['ASSISTANT', 'ASSISTANT_RESPONSE'],
  ['ASSISTANT_MESSAGE', 'ASSISTANT_RESPONSE'],
  ['MODEL_RESPONSE', 'ASSISTANT_RESPONSE'],
])

function normalizedSource(value) {
  return String(value ?? '').normalize('NFKC').trim().toUpperCase().replace(/[\s-]+/gu, '_')
}

export function normalizeProvenanceSource(value) {
  const normalized = normalizedSource(value)
  return SOURCE_ALIASES.get(normalized) ?? (
    normalized === UNKNOWN_PROVENANCE_SOURCE ? UNKNOWN_PROVENANCE_SOURCE : null
  )
}

function uniqueSourceIds(value) {
  const values = Array.isArray(value) ? value : []
  return [...new Set(values
    .map((id) => String(id ?? '').trim().slice(0, 64))
    .filter(Boolean))]
}

function evidenceForSource(source, requested) {
  if (source === 'ASSISTANT_RESPONSE') return 'unknown'
  if (CONFIRMED_SOURCES.has(source)) return 'confirmed'
  if (INFERRED_SOURCES.has(source)) return 'inferred'
  return MEMORY_PROVENANCE_EVIDENCE.includes(requested) ? requested : 'unknown'
}

/**
 * Normalize provenance while failing closed for unsupported or assistant
 * response sources. Assistant output can never be upgraded to confirmed.
 */
export function normalizeProvenance(input = {}, { fallbackSource = UNKNOWN_PROVENANCE_SOURCE } = {}) {
  const raw = typeof input === 'string' ? { source: input } : (input ?? {})
  const source = normalizeProvenanceSource(
    raw.source ?? raw.sourceType ?? raw.evidence_source,
  ) ?? normalizeProvenanceSource(fallbackSource) ?? UNKNOWN_PROVENANCE_SOURCE
  const requestedEvidence = String(raw.evidence ?? raw.evidenceClass ?? '').trim().toLowerCase()
  const sourceIds = uniqueSourceIds(raw.sourceIds ?? raw.source_ids)
  const normalized = {
    source,
    evidence: evidenceForSource(source, requestedEvidence),
    sourceIds,
  }

  if (raw.legacy === true) normalized.legacy = true
  if (typeof raw.sourceSession === 'string' && raw.sourceSession.trim()) {
    normalized.sourceSession = raw.sourceSession.trim().slice(0, 120)
  }
  if (Number.isFinite(Number(raw.confidence))) {
    normalized.confidence = Math.max(0, Math.min(1, Number(raw.confidence)))
  }
  if (Array.isArray(raw.sourceRoots)) normalized.sourceRoots = uniqueSourceIds(raw.sourceRoots)
  if (Number.isInteger(raw.evidenceCount)) normalized.evidenceCount = Math.max(0, raw.evidenceCount)
  if (['hypothesis', 'evolving'].includes(raw.selfStatus)) normalized.selfStatus = raw.selfStatus
  if (typeof raw.evidenceQuote === 'string') normalized.evidenceQuote = raw.evidenceQuote.slice(0, 200)
  if (typeof raw.messageId === 'string') normalized.messageId = raw.messageId.slice(0, 80)
  return normalized
}

export function isConfirmedProvenance(provenance) {
  const normalized = normalizeProvenance(provenance)
  return normalized.evidence === 'confirmed' && CONFIRMED_SOURCES.has(normalized.source)
}

export function isAssistantResponseProvenance(provenance) {
  return normalizeProvenance(provenance).source === 'ASSISTANT_RESPONSE'
}

/**
 * Resolve old source_session values without changing the underlying row.
 * `vc-ai-pet` is the legacy raw/runtime-owned pipeline; its precise old
 * subtype was not persisted, so expose it as a legacy SYSTEM_EVENT fallback.
 */
export function provenanceFromLegacyRow(row) {
  const sourceSession = String(row?.source_session ?? '').trim()
  if (sourceSession === 'vc-ai-pet:dream') {
    return normalizeProvenance({
      source: 'DREAM_DERIVED',
      sourceSession,
      evidence: 'inferred',
      legacy: true,
    })
  }
  if (sourceSession === 'vc-ai-pet:reflection') {
    return normalizeProvenance({
      source: 'REFLECTION_DERIVED',
      sourceSession,
      evidence: 'inferred',
      legacy: true,
    })
  }
  if (sourceSession === 'vc-ai-pet') {
    return normalizeProvenance({
      source: 'SYSTEM_EVENT',
      sourceSession,
      evidence: 'confirmed',
      legacy: true,
    })
  }

  const source = normalizeProvenanceSource(sourceSession)
  return normalizeProvenance({
    source: source ?? UNKNOWN_PROVENANCE_SOURCE,
    sourceSession: sourceSession || undefined,
    legacy: true,
  })
}

export function resolveMemoryProvenance(row, metadata = null) {
  if (metadata && typeof metadata === 'object') return normalizeProvenance(metadata)
  if (row?.provenance && typeof row.provenance === 'object') return normalizeProvenance(row.provenance)
  return provenanceFromLegacyRow(row)
}

function parseSourceIds(value) {
  if (Array.isArray(value)) return uniqueSourceIds(value)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    return uniqueSourceIds(JSON.parse(value))
  } catch {
    return []
  }
}
/**
 * Persist metadata separately from the legacy meow-memory row. This avoids a
 * migration or rewrite of existing memory tables and remains lazy: opening an
 * old database for reads does not create the metadata table.
 */
export class MemoryProvenanceStore {
  constructor(database) {
    if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') {
      throw new TypeError('PET_MEMORY_PROVENANCE_DATABASE_REQUIRED')
    }
    this.database = database
    this.tableState = 'unknown'
  }

  ensureTable() {
    if (this.tableState === 'ready') return
    this.database.exec(`CREATE TABLE IF NOT EXISTS ${MEMORY_PROVENANCE_TABLE} (
      memory_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      evidence TEXT NOT NULL,
      source_ids TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      recorded_at INTEGER NOT NULL
    )`)
    this.tableState = 'ready'
  }

  get(memoryId) {
    const id = String(memoryId ?? '').trim()
    if (!id || this.tableState === 'missing') return null

    try {
      const row = this.database.prepare(
        `SELECT memory_id, source, evidence, source_ids, metadata, recorded_at
         FROM ${MEMORY_PROVENANCE_TABLE}
         WHERE memory_id = ?`,
      ).get(id)
      this.tableState = 'ready'
      if (!row) return null

      let metadata = {}
      try {
        const parsed = JSON.parse(String(row.metadata ?? '{}'))
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
      } catch {}

      return normalizeProvenance({
        ...metadata,
        source: row.source,
        evidence: row.evidence,
        sourceIds: parseSourceIds(row.source_ids),
      })
    } catch {
      // Old databases do not have the side table; source_session fallback is
      // intentionally handled by resolveMemoryProvenance instead.
      this.tableState = 'missing'
      return null
    }
  }

  set(memoryId, provenance) {
    const id = String(memoryId ?? '').trim()
    if (!id) throw new TypeError('PET_MEMORY_PROVENANCE_MEMORY_ID_REQUIRED')

    const normalized = normalizeProvenance(provenance)
    this.ensureTable()
    const metadata = { ...normalized }
    delete metadata.source
    delete metadata.evidence
    delete metadata.sourceIds
    const recordedAt = Date.now()
    this.database.prepare(`
      INSERT INTO ${MEMORY_PROVENANCE_TABLE}
        (memory_id, source, evidence, source_ids, metadata, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        source = excluded.source,
        evidence = excluded.evidence,
        source_ids = excluded.source_ids,
        metadata = excluded.metadata,
        recorded_at = excluded.recorded_at
    `).run(
      id,
      normalized.source,
      normalized.evidence,
      JSON.stringify(normalized.sourceIds),
      JSON.stringify(metadata),
      recordedAt,
    )
    return normalized
  }

  resolve(row) {
    return resolveMemoryProvenance(row, this.get(row?.id))
  }

  decorate(row) {
    if (!row || typeof row !== 'object') return row
    return { ...row, provenance: this.resolve(row) }
  }
}
