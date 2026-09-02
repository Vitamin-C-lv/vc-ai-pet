import { DatabaseSync } from 'node:sqlite'

const DREAM_LOG_SELECT = `
  SELECT id, run_at, summary, changes, note
  FROM dream_log
  ORDER BY run_at DESC, id DESC
`

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_NODES = 18
export const DREAM_SOURCE_SESSION = 'vc-ai-pet:dream'
export const REFLECTION_SOURCE_SESSION = 'vc-ai-pet:reflection'

/**
 * Read the existing dream_log without opening it through MemoryDb.
 *
 * This adapter deliberately opens the exact caller-provided database path in
 * read-only mode and only prepares the SELECT above. A missing database/table,
 * or a read error, is represented as an empty log so historical recall stays
 * best-effort and cannot turn a chat into a failure.
 */
export function readDreamLog(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') return []

  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    return db.prepare(DREAM_LOG_SELECT).all()
  } catch {
    return []
  } finally {
    try { db?.close() } catch {}
  }
}

function parseChanges(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || value.trim() === '') return null

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null
  } catch {
    return null
  }
}

function normalizeRunAt(value) {
  if (value === null || value === undefined || value === '') return null
  const runAt = Number(value)
  return Number.isFinite(runAt) ? runAt : null
}

function normalizeKind(value) {
  return value === 'dream' || value === 'reflection' ? value : null
}

function normalizeSourceIds(value) {
  if (!Array.isArray(value)) return []

  // Memory IDs are strings. Keep the entry's order and values, while
  // dropping malformed values that cannot be handed to findById().
  return value.filter((id) => (
    (typeof id === 'string' && id.trim() !== '') ||
    (typeof id === 'number' && Number.isFinite(id))
  ))
}

function logsFrom(options) {
  if (typeof options === 'string') return readDreamLog(options)
  if (!options || typeof options !== 'object') return []

  if (typeof options.readDreamLog === 'function') {
    try {
      const rows = options.readDreamLog()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  if (typeof options.dbPath === 'string') return readDreamLog(options.dbPath)
  return []
}

function newestFirst(rows) {
  return rows.slice().sort((left, right) => {
    const leftRunAt = normalizeRunAt(left?.run_at)
    const rightRunAt = normalizeRunAt(right?.run_at)
    if (leftRunAt === null && rightRunAt !== null) return 1
    if (leftRunAt !== null && rightRunAt === null) return -1
    if (leftRunAt !== rightRunAt) return (rightRunAt ?? 0) - (leftRunAt ?? 0)

    const leftId = Number(left?.id)
    const rightId = Number(right?.id)
    if (Number.isFinite(leftId) && Number.isFinite(rightId)) return rightId - leftId
    return String(right?.id ?? '').localeCompare(String(left?.id ?? ''))
  })
}

/**
 * Find the authoritative dream/reflection log entry for one derived memory.
 *
 * `sourceIds` is copied only from the matching `changes.derived[]` entry.
 * The top-level changes.sourceIds, summary, note, and memory title are never
 * used to infer provenance.
 */
export function provenanceForDerived(derivedId, options = {}) {
  const result = {
    derivedId,
    kind: null,
    runAt: null,
    sourceIds: [],
  }

  if (derivedId === null || derivedId === undefined) return result

  for (const logRow of newestFirst(logsFrom(options))) {
    const changes = parseChanges(logRow?.changes)
    if (!Array.isArray(changes?.derived)) continue

    const derivedEntry = changes.derived.find((entry) => (
      entry && typeof entry === 'object' && entry.id === derivedId
    ))
    if (!derivedEntry) continue

    return {
      derivedId,
      kind: normalizeKind(changes.kind),
      runAt: normalizeRunAt(logRow?.run_at),
      sourceIds: normalizeSourceIds(derivedEntry.sourceIds),
    }
  }

  return result
}

function sourceKind(row) {
  if (row?.source_session === DREAM_SOURCE_SESSION) return 'dream'
  if (row?.source_session === REFLECTION_SOURCE_SESSION) return 'reflection'
  if (row?.source_session === 'vc-ai-pet') return 'raw'
  return null
}

function integerLimit(value, fallback) {
  let number
  try { number = Number(value) } catch { return fallback }
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.floor(number))
}

function safeFindById(findById, id) {
  if (typeof findById !== 'function') return { found: false, value: null }

  try {
    const value = findById(id)
    if (!value || typeof value !== 'object') return { found: false, value: null }

    // The meow-memory contract is { row, level }. Accept a bare row as well
    // so the resolver remains composable with a small test/host reader.
    if (Object.prototype.hasOwnProperty.call(value, 'row')) {
      if (!value.row || typeof value.row !== 'object') return { found: false, value: null }
      return { found: true, value: { row: value.row, level: value.level ?? value.row.level ?? null } }
    }
    return { found: true, value: { row: value, level: value.level ?? null } }
  } catch {
    return { found: false, value: null }
  }
}

function safeProvenance(provenanceReader, id) {
  if (typeof provenanceReader !== 'function') {
    return { value: { derivedId: id, kind: null, runAt: null, sourceIds: [] }, available: false }
  }

  try {
    const value = provenanceReader(id)
    if (!value || typeof value !== 'object') {
      return { value: { derivedId: id, kind: null, runAt: null, sourceIds: [] }, available: false }
    }

    const normalized = {
      derivedId: value.derivedId ?? id,
      kind: normalizeKind(value.kind),
      runAt: normalizeRunAt(value.runAt),
      sourceIds: normalizeSourceIds(value.sourceIds),
    }
    return {
      value: normalized,
      // A valid matching log may have no sources, so runAt is also a useful
      // signal that provenance was found.
      available: normalized.kind !== null || normalized.sourceIds.length > 0 || normalized.runAt !== null,
    }
  } catch {
    return { value: { derivedId: id, kind: null, runAt: null, sourceIds: [] }, available: false }
  }
}

/**
 * Resolve a bounded, depth-first source lineage.
 *
 * The returned nodes are ordered root-first. Each node has:
 *   { id, row, level, kind, depth, provenance, provenanceAvailable }
 * where kind is `dream`, `reflection`, `raw`, or null. `findById` is
 * intentionally injected; the caller can pass `memory.db.findById.bind(...)`
 * and this module will not duplicate the memory-core seven-table lookup.
 *
 * The traversal is synchronous because MemoryDb.findById() is synchronous.
 * Errors, missing rows/provenance, cycles, and bounds become metadata rather
 * than exceptions.
 */
export function resolveMemoryLineage(
  derivedId,
  options = {},
) {
  const {
    maxDepth = DEFAULT_MAX_DEPTH,
    maxNodes = DEFAULT_MAX_NODES,
    findById,
    provenanceForDerived: provenanceReader,
    readDreamLog: readLogs,
    dbPath,
  } = options && typeof options === 'object' ? options : {}
  const depthLimit = integerLimit(maxDepth, DEFAULT_MAX_DEPTH)
  const nodeLimit = integerLimit(maxNodes, DEFAULT_MAX_NODES)
  const lookupProvenance = typeof provenanceReader === 'function'
    ? provenanceReader
    : (id) => provenanceForDerived(id, { readDreamLog: readLogs, dbPath })

  const nodes = []
  const visited = new Set()
  const active = new Set()
  const missingIds = []
  const missingIdKeys = new Set()
  let truncated = false
  let cycleDetected = false
  let provenanceUnavailable = false

  const rememberMissing = (id) => {
    const key = `${typeof id}:${String(id)}`
    if (missingIdKeys.has(key)) return
    missingIdKeys.add(key)
    missingIds.push(id)
  }

  const visit = (id, depth) => {
    const key = `${typeof id}:${String(id)}`
    if (visited.has(key)) {
      if (active.has(key)) cycleDetected = true
      return
    }
    if (depth > depthLimit || nodes.length >= nodeLimit) {
      truncated = true
      return
    }

    visited.add(key)
    active.add(key)

    const found = safeFindById(findById, id)
    const row = found.value?.row ?? null
    const level = found.value?.level ?? row?.level ?? null
    if (!found.found) {
      rememberMissing(id)
      provenanceUnavailable = true
    }
    const rowKind = sourceKind(row)
    // A confirmed raw row cannot have a derived provenance edge. Avoid
    // reopening/scanning dream_log for it; derived, missing, and unknown rows
    // still go through the authoritative provenance reader.
    const provenance = rowKind === 'raw'
      ? {
          value: { derivedId: id, kind: null, runAt: null, sourceIds: [] },
          available: true,
        }
      : safeProvenance(lookupProvenance, id)
    const kind = provenance.value.kind ?? rowKind
    const isDerived = kind === 'dream' || kind === 'reflection'

    if (isDerived && !provenance.available) provenanceUnavailable = true

    const nodeProvenanceAvailable = isDerived
      ? provenance.available
      : rowKind === 'raw' || provenance.available

    nodes.push({
      id,
      row,
      level,
      kind,
      sourceKind: kind,
      sourceIds: provenance.value.sourceIds,
      runAt: provenance.value.runAt,
      depth,
      provenance: provenance.value,
      provenanceAvailable: nodeProvenanceAvailable,
    })

    if (!isDerived) {
      active.delete(key)
      return
    }

    for (const sourceId of provenance.value.sourceIds) {
      if (nodes.length >= nodeLimit) {
        truncated = true
        break
      }
      visit(sourceId, depth + 1)
    }
    active.delete(key)
  }

  if (derivedId !== null && derivedId !== undefined && nodeLimit > 0) {
    visit(derivedId, 0)
  } else if (derivedId !== null && derivedId !== undefined) {
    truncated = true
  }

  return {
    derivedId,
    nodes,
    missingIds,
    provenanceAvailable: !provenanceUnavailable,
    maxDepth: depthLimit,
    maxNodes: nodeLimit,
    truncated,
    cycleDetected,
    provenanceUnavailable,
  }
}

/**
 * Bound the adapter to one existing pet-memory.db path. No database handle is
 * retained; every provenance read opens that same path read-only and closes it
 * immediately after the SELECT.
 */
export class DreamProvenanceReader {
  constructor(dbPath, { findById = null } = {}) {
    this.dbPath = dbPath
    this.findById = typeof findById === 'function' ? findById : null
  }

  readDreamLog() {
    return readDreamLog(this.dbPath)
  }

  provenanceForDerived(derivedId) {
    return provenanceForDerived(derivedId, { readDreamLog: () => this.readDreamLog() })
  }

  resolveMemoryLineage(derivedId, options = {}) {
    return resolveMemoryLineage(derivedId, {
      ...options,
      findById: options.findById ?? this.findById,
      provenanceForDerived: options.provenanceForDerived ?? ((id) => this.provenanceForDerived(id)),
    })
  }
}

export function createDreamProvenanceReader(dbPath, options = {}) {
  // The object form is the public API. Keep the string form as a small
  // compatibility convenience for standalone callers.
  if (dbPath && typeof dbPath === 'object') {
    return new DreamProvenanceReader(dbPath.dbPath, { findById: dbPath.findById })
  }
  return new DreamProvenanceReader(dbPath, options)
}
