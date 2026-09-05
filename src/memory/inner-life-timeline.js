import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'

const DAY_MS = 24 * 60 * 60 * 1000
const KIND = "CASE WHEN json_valid(changes) THEN json_extract(changes, '$.kind') END"
const DERIVED_COUNT = "CASE WHEN json_valid(changes) THEN CASE WHEN json_type(changes, '$.derived') = 'array' THEN json_array_length(changes, '$.derived') ELSE 0 END ELSE 0 END"

// These legacy model summaries are free text, not a structured public diary.
// Publish a short, filtered preview only; never expose changes or source bodies.
export function publicInnerLifeSummary(value) {
  if (typeof value !== 'string' || value.length > 600) return ''
  if (/(?:data:image\/|authorization\s*[:=]|bearer\s+|(?:api[_ -]?key|token|password|secret)\s*[:=]|sk-[a-z0-9_-]{12,})/iu.test(value)) return ''
  return sanitizeSafeTraceText(value, 600) ? sanitizeSafeTraceText(value, 180) : ''
}

export function readInnerLifeTimeline(db, { now = Date.now(), limit = 20, offset = 0 } = {}) {
  if (!db?.prepare) throw Object.assign(new Error('inner-life unavailable'), { code: 'INNER_LIFE_UNAVAILABLE' })
  const pageSize = Math.min(50, Math.max(1, Number.isInteger(limit) ? limit : 20))
  const pageOffset = Math.max(0, Number.isInteger(offset) ? offset : 0)
  const stats = db.prepare(`
    SELECT COUNT(*) AS totalDream,
      COALESCE(SUM(CASE WHEN run_at >= ? AND run_at <= ? THEN 1 ELSE 0 END), 0) AS recentDream,
      MAX(run_at) AS lastDreamAt
    FROM dream_log WHERE ${KIND} = 'dream'
  `).get(now - 7 * DAY_MS, now)
  const rows = db.prepare(`
    SELECT id, run_at AS at, ${KIND} AS kind, summary, ${DERIVED_COUNT} AS understandingCount
    FROM dream_log WHERE ${KIND} IN ('dream', 'reflection')
    ORDER BY run_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(pageSize + 1, pageOffset)
  return {
    stats: { totalDream: Number(stats.totalDream), recentDream: Number(stats.recentDream), lastDreamAt: stats.lastDreamAt ?? null },
    items: rows.slice(0, pageSize).map(row => ({
      id: row.id, at: row.at, kind: row.kind, summary: publicInnerLifeSummary(row.summary),
      understandingCount: Number(row.understandingCount), evidence: 'inferred',
    })),
    nextOffset: rows.length > pageSize ? pageOffset + pageSize : null,
  }
}
