import { search as rankMemories, tokenize } from 'meow-memory'

export const HISTORICAL_RECALL_MODES = Object.freeze([
  'none',
  'past',
  'when',
  'first',
  'evolution',
  'why',
  'exact',
])

export const HISTORICAL_RECALL_LEVELS = Object.freeze([
  'soul',
  'user',
  'project',
  'fact',
  'lesson',
  'topic',
])

export const HISTORICAL_SEARCH_MAX = 12
export const HISTORICAL_CANDIDATE_LIMIT = 20
export const HISTORICAL_LINEAGE_MAX_DEPTH = 3
export const HISTORICAL_LINEAGE_MAX_NODES = 18

const RAW_SOURCE_SESSION = 'vc-ai-pet'
const REFLECTION_SOURCE_SESSION = 'vc-ai-pet:reflection'
const DREAM_SOURCE_SESSION = 'vc-ai-pet:dream'

const HISTORICAL_TOPIC_STOP_PHRASES = Object.freeze([
  '最开始',
  '一开始',
  '起初',
  '什么时候',
  '哪时候',
  '哪一次',
  '第一次',
  '为什么',
  '依据什么',
  '具体发生了什么',
  '具体说过什么',
  '当时怎么说',
  '当时具体说',
  '我说过什么',
  '以前的你',
  '过去的你',
  '你关于',
  '有什么区别',
  '有什么不同',
  '怎么变',
  '东西',
  '最早',
  '开始',
  '以前',
  '之前',
  '过去',
  '曾经',
  '那时候',
  '从前',
  '后来',
  '之后',
  '现在',
  '当时',
  '记忆',
  '想到',
  '认识',
  '理解',
  '区别',
  '不同',
  '变化',
  '怎么',
  '觉得',
  '认为',
  '记得',
  '知道',
  '提到',
  '提过',
  '告诉',
  '聊过',
  '说过',
  '说了',
  '说',
  '发生',
  '原话',
  '具体',
  '关于',
  '主人',
  '有什么',
  '什么',
  '时候',
  '花花',
  '你',
  '我',
  '的',
  '是',
  '和',
  '与',
  '吗',
  '呢',
  '呀',
  '啊',
  '啦',
])

const HISTORICAL_TOPIC_STOP_TOKENS = new Set(
  HISTORICAL_TOPIC_STOP_PHRASES.flatMap((phrase) => tokenize(phrase)),
)

const SOURCE_KIND_PRIORITY = Object.freeze({
  raw: 0,
  reflection: 1,
  dream: 2,
  historical: 3,
})

const SOURCE_KIND_BY_SESSION = Object.freeze({
  [RAW_SOURCE_SESSION]: 'raw',
  [REFLECTION_SOURCE_SESSION]: 'reflection',
  [DREAM_SOURCE_SESSION]: 'dream',
})

/**
 * Lightweight routing only. This identifies whether a request needs a
 * deeper historical read; it never decides whether a historical claim is
 * true.
 */
export function detectHistoricalRecallIntent(userText) {
  const text = String(userText ?? '').normalize('NFKC').trim()

  if (!text) return { mode: 'none', deep: false }

  if (
    /(最早|最开始|一开始|以前|起初).*(后来|之后|现在).*(区别|不同|变化|怎么变)/u.test(text)
    || /(最早.*记忆).*(后来.*(想到|认识|觉得|理解))/u.test(text)
  ) {
    return { mode: 'evolution', deep: true }
  }

  if (
    /为什么.*(觉得|认为|记得|知道)|怎么.*(知道|觉得)|依据什么|为什么会这样想|为什么这么想/u.test(text)
  ) {
    return { mode: 'why', deep: true }
  }

  if (/(第一次|最早|最开始|第一次.*什么时候|什么时候第一次)/u.test(text)) {
    return { mode: 'first', deep: true }
  }

  if (
    /(什么时候|哪天|哪一次|哪时候)/u.test(text) &&
    /(说|告诉|发生|记得|提过|聊过|开始)/u.test(text)
  ) {
    return { mode: 'when', deep: true }
  }

  if (/(原话|具体说(?:过|了)?什么|当时(?:怎么|具体)说|我说过什么|具体发生了什么)/u.test(text)) {
    return { mode: 'exact', deep: true }
  }

  if (/(以前|之前|过去|曾经|那时候|从前|小时候|以前的你|过去的你)/u.test(text)) {
    return { mode: 'past', deep: true }
  }

  return { mode: 'none', deep: false }
}

/** Return the short, model-facing source label for a memory row. */
export function memorySourceKind(row) {
  const sourceSession = typeof row === 'string' ? row : row?.source_session
  return Object.prototype.hasOwnProperty.call(SOURCE_KIND_BY_SESSION, sourceSession)
    ? SOURCE_KIND_BY_SESSION[sourceSession]
    : 'historical'
}

/**
 * Extract deterministic topic anchors from a historical question. Routing
 * words such as "最早" and "后来" help choose a mode, but should not win
 * semantic retrieval over the user's actual subject.
 *
 * meow-memory tokenizes CJK text into overlapping bigrams, so the returned
 * set deliberately uses the same token vocabulary as retrieval and matching.
 */
export function extractTopicAnchorTokens(userText) {
  let text = String(userText ?? '').normalize('NFKC').trim()
  for (const phrase of HISTORICAL_TOPIC_STOP_PHRASES) {
    text = text.split(phrase).join(' ')
  }

  const tokens = new Set(tokenize(text).filter((token) => (
    token.length >= 2 && !HISTORICAL_TOPIC_STOP_TOKENS.has(token)
  )))
  return tokens.size > 0 ? tokens : null
}

/** Backward-compatible array form for existing retrieval callers. */
export function historicalTopicAnchors(userText) {
  return [...(extractTopicAnchorTokens(userText) ?? [])]
}

function normalizeTopicTokens(anchorsOrQuery) {
  if (anchorsOrQuery instanceof Set) return new Set(anchorsOrQuery)
  if (Array.isArray(anchorsOrQuery)) return new Set(anchorsOrQuery)
  return extractTopicAnchorTokens(anchorsOrQuery) ?? new Set()
}

function rowSearchText(row) {
  return [
    row?.title ?? '',
    row?.content ?? '',
    Array.isArray(row?.keywords) ? row.keywords.join(' ') : row?.keywords ?? '',
  ].join(' ')
}

function rowContentText(row) {
  return [row?.title ?? '', row?.content ?? ''].join(' ')
}

/** Return whether a row shares at least one deterministic topic token. */
export function candidateMatchesTopic(row, anchorsOrQuery) {
  const anchors = normalizeTopicTokens(anchorsOrQuery)
  if (anchors.size === 0) return true

  const rowTokens = new Set(tokenize(rowSearchText(row)))
  return [...anchors].some((anchor) => rowTokens.has(anchor))
}

/** Backward-compatible name used by the historical lineage reader. */
export function matchesHistoricalTopic(row, anchorsOrQuery) {
  return candidateMatchesTopic(row, anchorsOrQuery)
}

/** Match topic anchors against evidence text, excluding metadata keywords. */
export function matchesHistoricalTopicInContent(row, anchorsOrQuery) {
  const anchors = normalizeTopicTokens(anchorsOrQuery)
  if (anchors.size === 0) return true

  const rowTokens = new Set(tokenize(rowContentText(row)))
  return [...anchors].some((anchor) => rowTokens.has(anchor))
}

/**
 * Keep the semantic neighborhood around the BM25 winner. If the scorer does
 * not expose scores, retain only a small ranked prefix rather than inventing
 * a score that could change the ordering semantics.
 */
export function keepRelevantCluster(hits, { ratio = 0.55, max = 20 } = {}) {
  if (!Array.isArray(hits)) return []

  const requestedMax = Number(max)
  const limit = Number.isFinite(requestedMax)
    ? Math.max(0, Math.floor(requestedMax))
    : 20
  const rows = hits.slice(0, limit)
  if (rows.length === 0) return []

  const topScore = Number(rows[0]?.score)
  if (!Number.isFinite(topScore) || topScore <= 0) {
    return rows.slice(0, Math.min(8, rows.length))
  }

  const requestedRatio = Number(ratio)
  const thresholdRatio = Number.isFinite(requestedRatio) ? requestedRatio : 0.55
  return rows.filter((row) => (
    Number.isFinite(Number(row?.score)) &&
    Number(row.score) >= topScore * thresholdRatio
  ))
}

/**
 * Resolve the timestamp used for historical ordering. created_at is the
 * event time; updated_at is only a defensive fallback for older rows.
 */
export function historicalTimestamp(rowOrTimestamp) {
  const value = rowOrTimestamp && typeof rowOrTimestamp === 'object'
    ? rowOrTimestamp.created_at ?? rowOrTimestamp.updated_at
    : rowOrTimestamp

  if (value === null || value === undefined || String(value).trim() === '') return null

  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

/** Stable chronological comparison: time first, id as the deterministic tie-breaker. */
export function compareHistoricalRows(left, right) {
  const leftTime = historicalTimestamp(left)
  const rightTime = historicalTimestamp(right)

  if (leftTime === null && rightTime !== null) return 1
  if (leftTime !== null && rightTime === null) return -1
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime < rightTime ? -1 : 1
  }

  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''))
}

/** Sort without mutating the input rows. The default is oldest first. */
export function sortHistoricalRows(rows, { direction = 'asc' } = {}) {
  if (!Array.isArray(rows)) return []

  const sign = direction === 'desc' ? -1 : 1
  return [...rows].sort((left, right) => sign * compareHistoricalRows(left, right))
}

/** Format a memory timestamp with the host's local timezone. */
export function formatHistoricalTime(ms) {
  const timestamp = historicalTimestamp(ms)
  if (timestamp === null) return 'unknown'

  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'unknown'

  const pad = (value) => String(value).padStart(2, '0')
  return [
    `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join(' ')
}

function normalizeMode(mode) {
  return HISTORICAL_RECALL_MODES.includes(mode) ? mode : 'none'
}

function rowKey(row, fallbackIndex) {
  return row?.id === null || row?.id === undefined
    ? `historical-row-${fallbackIndex}`
    : String(row.id)
}

function compareCandidateEntries(left, right) {
  const sourceDifference = SOURCE_KIND_PRIORITY[memorySourceKind(left.row)] - SOURCE_KIND_PRIORITY[memorySourceKind(right.row)]
  if (sourceDifference !== 0) return sourceDifference
  if (left.rank !== right.rank) return left.rank - right.rank
  return String(left.row?.id ?? '').localeCompare(String(right.row?.id ?? ''))
}

function compareCandidateTime(left, right) {
  const timeDifference = compareHistoricalRows(left.row, right.row)
  if (timeDifference !== 0) return timeDifference

  const sourceDifference = SOURCE_KIND_PRIORITY[memorySourceKind(left.row)] - SOURCE_KIND_PRIORITY[memorySourceKind(right.row)]
  if (sourceDifference !== 0) return sourceDifference
  return left.rank - right.rank
}

function orderCandidateEntries(entries, mode, limit, query = null) {
  const normalizedMode = normalizeMode(mode)
  let ordered = entries

  if (normalizedMode === 'first') {
    const raw = entries
      .filter(({ row }) => memorySourceKind(row) === 'raw')
      .sort(compareCandidateTime)
    const explicitRaw = raw.filter(({ row }) => matchesHistoricalTopicInContent(row, query))
    const preferredRaw = explicitRaw.length > 0 ? explicitRaw : raw
    const rawRanks = new Set(raw.map(({ rank }) => rank))
    const preferredRanks = new Set(preferredRaw.map(({ rank }) => rank))
    const first = preferredRaw[0]
    const rawRemainder = [
      ...preferredRaw.slice(1),
      ...raw.filter(({ rank }) => !preferredRanks.has(rank)),
    ]
    const rest = entries.filter(({ rank }) => !rawRanks.has(rank))
    ordered = first ? [first, ...rawRemainder, ...rest] : entries
  } else if (normalizedMode === 'when' || normalizedMode === 'past') {
    ordered = [...entries].sort(compareCandidateTime)
  } else if (normalizedMode === 'why' || normalizedMode === 'exact' || normalizedMode === 'evolution') {
    ordered = [...entries].sort(compareCandidateEntries)
  }

  return ordered.slice(0, limit).map(({ row }) => row)
}

/**
 * Apply the temporal/source ordering needed after semantic retrieval. The
 * result is a new array and retains the original row objects unchanged.
 */
export function sortHistoricalCandidates(rows, { mode = 'none', k = HISTORICAL_SEARCH_MAX, query = null } = {}) {
  if (!Array.isArray(rows)) return []

  const limit = Number.isInteger(k)
    ? Math.min(HISTORICAL_SEARCH_MAX, Math.max(0, k))
    : HISTORICAL_SEARCH_MAX
  if (limit === 0) return []

  const entries = rows.map((row, rank) => ({ row, rank }))
  return orderCandidateEntries(entries, mode, limit, query)
}

function historicalSearchDocument(row, index) {
  const timestamp = historicalTimestamp(row)
  return {
    ...row,
    id: rowKey(row, index),
    title: row?.title ?? '',
    content: String(row?.content ?? ''),
    importance: Number.isFinite(Number(row?.importance)) ? Number(row.importance) : 1,
    keywords: Array.isArray(row?.keywords) ? row.keywords : [],
    updated_at: timestamp ?? 0,
  }
}

/**
 * Semantic historical retrieval followed by deterministic mode ordering.
 * `rankMemories` is the existing meow-memory BM25 scorer; this helper only
 * reads the supplied rows and never bumps hits or touches a database.
 */
export function rankHistoricalRows(
  query,
  rows,
  {
    k = HISTORICAL_SEARCH_MAX,
    candidateLimit = HISTORICAL_CANDIDATE_LIMIT,
    mode = 'none',
    now = null,
  } = {},
) {
  const text = String(query ?? '').trim()
  if (!text || !Array.isArray(rows)) return []

  const requestedLimit = Number.isInteger(k)
    ? Math.min(HISTORICAL_SEARCH_MAX, Math.max(0, k))
    : HISTORICAL_SEARCH_MAX
  if (requestedLimit === 0) return []

  const inputRows = rows.filter((row) => (
    row && typeof row === 'object' &&
    (row.level === undefined || HISTORICAL_RECALL_LEVELS.includes(row.level))
  ))
  if (inputRows.length === 0) return []

  const documents = inputRows.map(historicalSearchDocument)
  const limit = Number.isInteger(candidateLimit)
    ? Math.max(requestedLimit, Math.max(0, candidateLimit))
    : Math.max(requestedLimit, HISTORICAL_CANDIDATE_LIMIT)
  const topicTokens = extractTopicAnchorTokens(text)
  const topicQuery = [...(topicTokens ?? [])].join(' ')
  const searchQuery = topicQuery || text
  const hits = rankMemories(searchQuery, documents, { k: limit, now })
  // A deterministic topic hit is the first gate. Do not discard a weaker
  // long-form memory that still explicitly contains the requested topic
  // (for example, a concise birthday fact next to a richer soul summary).
  // For routing-only queries without a topic, retain the existing semantic
  // neighborhood behavior.
  const relevantHits = topicTokens
    ? hits
    : keepRelevantCluster(hits, { max: limit })
  const rowsById = new Map(documents.map((document, index) => [document.id, inputRows[index]]))
  const candidates = relevantHits.map((hit, rank) => ({
    row: withSearchScore(rowsById.get(hit.id) ?? hit, hit.score),
    rank,
    score: hit.score,
  }))
  const selectedCandidates = candidates.filter(({ row }) => candidateMatchesTopic(row, topicTokens))

  return orderCandidateEntries(selectedCandidates, mode, requestedLimit, text)
}

function withSearchScore(row, score) {
  const numericScore = Number(score)
  return Number.isFinite(numericScore) ? { ...row, score: numericScore } : row
}
