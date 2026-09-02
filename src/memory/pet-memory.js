import { resolve, relative, sep, join } from 'node:path'
import { MemoryDb, search as rankMemories } from 'meow-memory'
import {
  HISTORICAL_CANDIDATE_LIMIT,
  HISTORICAL_LINEAGE_MAX_DEPTH,
  HISTORICAL_LINEAGE_MAX_NODES,
  HISTORICAL_RECALL_LEVELS,
  HISTORICAL_SEARCH_MAX,
  candidateMatchesTopic,
  extractTopicAnchorTokens,
  historicalTimestamp,
  keepRelevantCluster,
  matchesHistoricalTopic,
  matchesHistoricalTopicInContent,
  memorySourceKind,
  rankHistoricalRows,
  sortHistoricalCandidates,
  sortHistoricalRows,
} from './historical-recall.js'
import {
  createDreamProvenanceReader,
  provenanceForDerived as readProvenanceForDerived,
  resolveMemoryLineage as resolveMemoryLineageGraph,
} from './dream-provenance.js'
import {
  MemoryProvenanceStore,
  normalizeProvenance,
} from './memory-provenance.js'

const PET_SOURCE_SESSION = 'vc-ai-pet'
export const PET_RAW_SOURCE_SESSION = PET_SOURCE_SESSION
export const PET_DREAM_SOURCE_SESSION = 'vc-ai-pet:dream'
export const PET_DREAM_WINDOW = 'vc-ai-pet:dream-window'
export const PET_REFLECTION_SOURCE_SESSION = 'vc-ai-pet:reflection'
export const PET_REFLECTION_WINDOW = 'vc-ai-pet:reflection-window'
const ALLOWED_LEVELS = new Set(['soul','user','project','fact','lesson','topic','rules'])
const RECALL_LEVELS = ['soul','user','project','fact','lesson','topic','rules']
const MEMORY_WRITE_LEVELS = ['user','project','fact','lesson','topic']
const RAW_SOURCE_LEVELS = ['user', 'project', 'fact', 'lesson', 'topic']
const DREAM_SOURCE_LEVELS = RAW_SOURCE_LEVELS
const RELATED_LEVELS = ['soul', ...RAW_SOURCE_LEVELS]
const DREAM_DERIVED_LEVELS = new Set(['soul', 'user', 'fact', 'lesson', 'topic'])
const REFLECTION_DERIVED_LEVELS = new Set(['user', 'fact', 'lesson', 'topic'])
const DREAM_DEDUPE_LEVELS = ['soul', ...MEMORY_WRITE_LEVELS]
const CURRENT_SELF_QUERY = '李花花 自己 性格 习惯 喜欢 相处 主人 自我'
export const HISTORICAL_RECALL_CONTEXT_MAX = 16

export { memorySourceKind }

function inside(root, target) {
  const r = resolve(root), t = resolve(target), rel = relative(r, t)
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.includes(`${sep}..${sep}`))) return t
  throw new Error('PET_MEMORY_DB_MUST_STAY_INSIDE_SANDBOX')
}

function hasText(row, parts) {
  const text = `${row?.title ?? ''}\n${row?.content ?? ''}`
  return parts.every((part) => text.includes(part))
}

function normalizeMemoryText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '')
}

function equivalentText(a, b) {
  const left = normalizeMemoryText(a)
  const right = normalizeMemoryText(b)
  if (!left || !right) return false
  if (left === right) return true

  const shorter = left.length <= right.length ? left : right
  const longer = left.length > right.length ? left : right
  const ratio = shorter.length / longer.length

  // Only treat near-equal wording as duplicate. Do not collapse materially
  // different facts/preferences merely because they share a topic.
  return ratio >= 0.85 && longer.includes(shorter)
}

function selectRelatedHistoricalRows(rows, topicTokens) {
  if (!Array.isArray(rows) || rows.length === 0) return []

  const cluster = keepRelevantCluster(rows, { max: HISTORICAL_CANDIDATE_LIMIT })
  return cluster.filter((row) => candidateMatchesTopic(row, topicTokens))
}

function historicalSource(row) {
  return row?.source ?? memorySourceKind(row)
}

function evolutionSourceKind(row) {
  return row?.level === 'soul' ? 'soul' : historicalSource(row)
}

function uniqueRowsInOrder(rows) {
  const unique = []
  const seen = new Set()
  for (const row of rows) {
    if (!row || row.id === null || row.id === undefined) continue
    const id = String(row.id)
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(row)
  }
  return unique
}

function selectEvolutionCandidates(rows, topicTokens) {
  const topicRows = rows.filter((row) => candidateMatchesTopic(row, topicTokens))
  const rawRows = sortHistoricalRows(topicRows.filter((row) => evolutionSourceKind(row) === 'raw'))
  const explicitRawRows = rawRows.filter((row) => matchesHistoricalTopicInContent(row, topicTokens))
  const preferredRawRows = explicitRawRows.length > 0 ? explicitRawRows : rawRows
  const preferredIds = new Set(preferredRawRows.map((row) => String(row.id)))
  const earlyRaw = [
    ...preferredRawRows,
    ...rawRows.filter((row) => !preferredIds.has(String(row.id))),
  ].slice(0, 3)
  const earliestRaw = preferredRawRows[0] ?? null
  const earliestTime = historicalTimestamp(earliestRaw)
  const laterDerived = sortHistoricalRows(topicRows.filter((row) => {
    const source = evolutionSourceKind(row)
    if (source !== 'dream' && source !== 'reflection' && source !== 'soul') return false
    if (earliestTime === null) return false
    const createdAt = historicalTimestamp(row)
    return createdAt !== null && createdAt >= earliestTime
  })).slice(0, 5)

  return {
    earliestRaw,
    earlyRaw,
    laterDerived,
    rows: [...earlyRaw, ...laterDerived],
  }
}

export class PetMemory {
  constructor(root, { provenanceReader = null } = {}) {
    this.sandboxRoot = resolve(root)
    this.dbPath = inside(this.sandboxRoot, join(this.sandboxRoot, 'memory', 'pet-memory.db'))
    this.db = new MemoryDb(this.dbPath)
    this.provenanceStore = new MemoryProvenanceStore(this.db.db)
    this.provenanceReader = provenanceReader
  }

  seedIfFresh(now = Date.now()) {
    if (!this.db.isFresh()) return false
    this.remember('soul', '我是一个住在这里的像素伯恩山小狗。', 3, { keywords: ['伯恩山','小狗','宠物','身份','自己','住在这里'] })
    this.remember('rules', '我不是工作代理，也不能替主人执行任务。', 3)
    this.remember('rules', '我不能操作宿主电脑；我只能接触自己的小房间和玩具箱。', 3)
    this.remember('rules', '我不调用 DeepSeek，也不读取 DeepSeek、Luna 或 Codex 的工作上下文。', 3)
    this.remember('fact', `我第一次醒来了。时间戳：${now}`, 2)
    return true
  }

  migrateIdentity(identity) {
    const desiredSoul = `我叫${identity.name}，是一只住在主人身边的像素${identity.breedZh}。我的生日是 ${identity.birthday}。`
    const soulRows = this.db.list('soul')
    const already = soulRows.find((row) => hasText(row, [identity.name, identity.birthday]))
    if (!already) {
      // Soul is append-only. Keep the seed as historical evidence instead of
      // rewriting it in place when the fixed Identity Kernel is materialized.
      this.remember('soul', desiredSoul, 3, { keywords: ['李花花','生日','伯恩山犬','主人','宠物','身份','自己','2026-08-31'] })
    }
    const birthdayFactExists = this.db.list('fact').some((row) => row.content.includes(identity.birthday) && row.content.includes('生日'))
    if (!birthdayFactExists) this.remember('fact', `${identity.name}的生日是 ${identity.birthday}；这一天 ${identity.birthEvent} 正式通过，作为出生纪念日。`, 3, { keywords: ['李花花','生日','出生','2026-08-31','v0.1','封板','纪念日','伯恩山犬'] })
    return true
  }

  ensureDreamTracking() {
    const latestCreatedAt = this.#latestRawCreatedAt()
    if (latestCreatedAt > 0) {
      // This records the latest eligible memory event without marking it as
      // already dreamed. The first manual Dream can therefore consolidate the
      // existing history, while future runs use last_dream_time as checkpoint.
      this.db.touchWindow(PET_DREAM_WINDOW, this.sandboxRoot, latestCreatedAt)
    }

    return latestCreatedAt
  }

  ensureReflectionTracking() {
    const latestCreatedAt = this.#latestRawCreatedAt()
    if (latestCreatedAt > 0) {
      this.db.touchWindow(PET_REFLECTION_WINDOW, this.sandboxRoot, latestCreatedAt)
    }
    return latestCreatedAt
  }

  remember(level, content, importance = 1, extra = {}) {
    if (!ALLOWED_LEVELS.has(level)) throw new Error(`PET_MEMORY_LEVEL_DENIED: ${level}`)
    const fields = extra && typeof extra === 'object' ? extra : {}
    const { provenance = null, ...dbFields } = fields
    const row = this.db.insert({ level, content, importance, source_session: PET_SOURCE_SESSION, ...dbFields })
    if (
      DREAM_SOURCE_LEVELS.includes(row.level) &&
      Number(row.importance) >= 2 &&
      row.source_session === PET_SOURCE_SESSION
    ) {
      this.db.touchWindow(PET_DREAM_WINDOW, this.sandboxRoot, row.created_at)
      this.db.touchWindow(PET_REFLECTION_WINDOW, this.sandboxRoot, row.created_at)
    }
    const rowProvenance = this.provenanceStore.set(row.id, provenance ?? {
      source: 'SYSTEM_EVENT',
      evidence: 'confirmed',
    })
    return { ...row, provenance: rowProvenance }
  }

  rememberInteraction(kind, count) {
    return this.remember('fact', `主人和我互动了：${kind}。累计互动次数：${count}。`, 1)
  }

  findEquivalentMemory(content) {
    for (const level of DREAM_DEDUPE_LEVELS) {
      const rows = this.db.list(level, { status: 'active' })
      const hit = rows.find((row) => equivalentText(row.content, content))
      if (hit) return hit
    }
    return null
  }

  rememberCandidate(candidate) {
    if (!candidate || !MEMORY_WRITE_LEVELS.includes(candidate.level)) {
      throw new Error('PET_MEMORY_CANDIDATE_LEVEL_DENIED')
    }
    return this.remember(candidate.level, candidate.content, candidate.importance, {
      keywords: candidate.keywords,
      provenance: candidate.provenance ?? {
        source: 'MEMORY_GATE_ACCEPTED',
        evidence: 'confirmed',
      },
    })
  }

  dreamSourceRows({ after = 0, before = Date.now() } = {}) {
    return this.#rawSourceRows({ after, before })
  }

  reflectionSourceRows({ after = 0, before = Date.now() } = {}) {
    return this.#rawSourceRows({ after, before })
  }

  relatedForDream(query, { k = 24, excludeIds = [] } = {}) {
    const excluded = new Set(excludeIds)
    const rows = RELATED_LEVELS
      .flatMap((level) => this.db.list(level, { status: 'active' }))
      .filter((row) => Number(row.importance) >= 2 && !excluded.has(row.id))

    const hits = rankMemories(query, rows, { k })
    const byId = new Map(rows.map((row) => [row.id, row]))
    return hits.map((hit) => this.provenanceStore.decorate(byId.get(hit.id) ?? hit))
  }

  relatedForReflection(query, { k = 4, excludeIds = [] } = {}) {
    return this.relatedForDream(query, { k, excludeIds })
  }

  dreamWindow() {
    return this.db.getWindow(PET_DREAM_WINDOW)
  }

  claimDream(owner, T) {
    return this.db.claimDream(PET_DREAM_WINDOW, owner, T, 30 * 60 * 1000)
  }

  reflectionWindow() {
    return this.db.getWindow(PET_REFLECTION_WINDOW)
  }

  claimReflection(owner, T) {
    return this.db.claimDream(PET_REFLECTION_WINDOW, owner, T, 30 * 60 * 1000)
  }

  finishDream(checkpoint) {
    return this.db.finishDream(PET_DREAM_WINDOW, checkpoint)
  }

  finishReflection(checkpoint) {
    return this.db.finishDream(PET_REFLECTION_WINDOW, checkpoint)
  }

  logDream(summary, changes, note = '') {
    return this.db.logDream(summary, changes, note)
  }

  logReflection(summary, changes, note = '') {
    return this.db.logDream(summary, changes, note)
  }

  rememberDreamCandidate(candidate) {
    if (!candidate || !DREAM_DERIVED_LEVELS.has(candidate.level)) {
      throw new Error('PET_DREAM_CANDIDATE_LEVEL_DENIED')
    }

    const sourceIds = Array.isArray(candidate.sourceIds) ? candidate.sourceIds : []
    if (sourceIds.length === 0) throw new Error('PET_DREAM_SOURCE_IDS_REQUIRED')
    if (candidate.level === 'soul' && (
      Number(candidate.importance) !== 3 ||
      !Number.isFinite(Number(candidate.confidence)) ||
      Number(candidate.confidence) < 0.82 ||
      !String(candidate.content ?? '').trim().startsWith('我') ||
      new Set(sourceIds.map((id) => String(id))).size < 2
    )) {
      throw new Error('PET_DREAM_SOUL_CANDIDATE_DENIED')
    }
    const requestedProvenance = candidate.provenance ?? {
      source: 'DREAM_DERIVED',
      evidence: 'inferred',
    }
    const provenance = normalizeProvenance({
      ...requestedProvenance,
      sourceIds,
    })
    if (provenance.source !== 'DREAM_DERIVED' || provenance.evidence !== 'inferred') {
      throw new Error('PET_DREAM_PROVENANCE_DENIED')
    }
    const title = `dream:${sourceIds.map((id) => String(id).slice(0, 8)).join(',')}`
    const row = this.db.insert({
      level: candidate.level,
      title,
      content: candidate.content,
      importance: candidate.importance,
      keywords: candidate.keywords,
      source_session: PET_DREAM_SOURCE_SESSION,
    })
    return { ...row, provenance: this.provenanceStore.set(row.id, provenance) }
  }

  rememberReflectionCandidate(candidate) {
    if (!candidate || !REFLECTION_DERIVED_LEVELS.has(candidate.level)) {
      throw new Error('PET_REFLECTION_CANDIDATE_LEVEL_DENIED')
    }

    const sourceIds = Array.isArray(candidate.sourceIds) ? candidate.sourceIds : []
    if (sourceIds.length === 0) throw new Error('PET_REFLECTION_SOURCE_IDS_REQUIRED')
    const requestedProvenance = candidate.provenance ?? {
      source: 'REFLECTION_DERIVED',
      evidence: 'inferred',
    }
    const provenance = normalizeProvenance({
      ...requestedProvenance,
      sourceIds,
    })
    if (provenance.source !== 'REFLECTION_DERIVED' || provenance.evidence !== 'inferred') {
      throw new Error('PET_REFLECTION_PROVENANCE_DENIED')
    }
    const title = `reflection:${sourceIds.map((id) => String(id).slice(0, 8)).join(',')}`
    const row = this.db.insert({
      level: candidate.level,
      title,
      content: candidate.content,
      importance: candidate.importance,
      keywords: candidate.keywords,
      source_session: PET_REFLECTION_SOURCE_SESSION,
    })
    return { ...row, provenance: this.provenanceStore.set(row.id, provenance) }
  }

  recall(query, k = 5, { bumpHits = true } = {}) {
    const docs = RECALL_LEVELS.flatMap((level) => this.db.listSearchable(level))
    const hits = rankMemories(query, docs, { k })
    const byKey = new Map(docs.map((row) => [`${row.level}:${row.id}`, row]))
    const enrichedHits = hits.map((hit) => {
      const source = byKey.get(`${hit.level}:${hit.id}`)
      return source ? { ...source, ...hit } : hit
    })
    if (bumpHits) {
      for (const hit of hits) {
        try { this.db.bumpHit(hit.level, hit.id) } catch {}
      }
    }
    return enrichedHits.map((row) => this.provenanceStore.decorate(row))
  }

  historicalSearch(
    query,
    {
      k = HISTORICAL_SEARCH_MAX,
      includeDerived = true,
      allStatuses = true,
    } = {},
  ) {
    const requested = Number(k)
    const limit = Number.isFinite(requested)
      ? Math.min(HISTORICAL_SEARCH_MAX, Math.max(0, Math.floor(requested)))
      : HISTORICAL_SEARCH_MAX
    if (limit === 0) return []

    const listOptions = allStatuses ? {} : { status: 'active' }
    const rows = HISTORICAL_RECALL_LEVELS
      .flatMap((level) => this.db.list(level, listOptions))
      .filter((row) => includeDerived || !['dream', 'reflection'].includes(memorySourceKind(row)))

    return rankHistoricalRows(query, rows, {
      k: limit,
      candidateLimit: HISTORICAL_CANDIDATE_LIMIT,
      mode: 'none',
      now: null,
    })
  }

  stableIdentityContext() {
    return this.stableRulesContext()
  }

  stableRulesContext() {
    return this.db.list('rules', { status: 'active' })
      .map(({ level, content, importance }) => ({ level, content, importance }))
  }

  currentSelfContext(k = 3) {
    const requested = Number.isInteger(k) ? k : 3
    const limit = Math.min(3, Math.max(0, requested))
    if (limit === 0) return []

    const rows = this.db.list('soul', { status: 'active' })
      .filter((row) => Number(row.importance) >= 2)
    const hits = rankMemories(CURRENT_SELF_QUERY, rows, { k: limit })
    const byId = new Map(rows.map((row) => [row.id, row]))
    return hits.map((hit) => byId.get(hit.id) ?? hit)
  }

  buildHistoricalRecallContext(
    query,
    {
      intent = null,
      currentSelf = null,
      currentSelfContext = null,
      related = [],
      memories = null,
      maxEntries = HISTORICAL_RECALL_CONTEXT_MAX,
      maxDepth = HISTORICAL_LINEAGE_MAX_DEPTH,
      maxNodes = HISTORICAL_LINEAGE_MAX_NODES,
    } = {},
  ) {
    const mode = typeof intent === 'string' ? intent : intent?.mode ?? 'none'
    const semanticRows = this.historicalSearch(query, {
      k: HISTORICAL_SEARCH_MAX,
      includeDerived: true,
      allStatuses: true,
    })
    const suppliedRelatedRows = Array.isArray(memories)
      ? memories
      : Array.isArray(related)
        ? related
        : []
    const topicTokens = extractTopicAnchorTokens(query)
    const relatedRows = selectRelatedHistoricalRows(suppliedRelatedRows, topicTokens)
    const selfRows = Array.isArray(currentSelf)
      ? currentSelf
      : Array.isArray(currentSelfContext)
        ? currentSelfContext
        : []
    const eligible = (row) => (
      row &&
      typeof row === 'object' &&
      HISTORICAL_RECALL_LEVELS.includes(row.level)
    )
    const rowsById = new Map()
    for (const row of [...semanticRows, ...relatedRows, ...(mode === 'past' ? selfRows : [])]) {
      if (!eligible(row)) continue
      const id = row.id === null || row.id === undefined ? null : String(row.id)
      if (id !== null && !rowsById.has(id)) rowsById.set(id, row)
    }

    const orderedCandidates = sortHistoricalCandidates([...rowsById.values()], {
      mode,
      k: HISTORICAL_SEARCH_MAX,
      query,
    })
    const evolution = mode === 'evolution'
      ? selectEvolutionCandidates(orderedCandidates, topicTokens)
      : null
    const selectedCandidates = evolution?.rows ?? orderedCandidates
    const lineageRows = []
    const lineageIds = new Set()
    const provenanceUnavailableIds = []
    let provenanceUnavailable = false

    const lineageTargets = new Map()
    const lineageSeedRows = mode === 'evolution'
      ? selectedCandidates
      : [...orderedCandidates, ...relatedRows]
    for (const row of lineageSeedRows) {
      if (row?.id !== null && row?.id !== undefined && !lineageTargets.has(String(row.id))) {
        lineageTargets.set(String(row.id), row)
      }
    }
    for (const row of lineageTargets.values()) {
      const sourceKind = historicalSource(row)
      if (sourceKind !== 'dream' && sourceKind !== 'reflection') continue

      const lineage = this.resolveMemoryLineage(row.id, { maxDepth, maxNodes })
      if (lineage?.provenanceUnavailable || lineage?.provenanceAvailable === false || lineage?.missingIds?.length > 0) {
        provenanceUnavailable = true
        provenanceUnavailableIds.push(String(row.id))
      }
      for (const node of Array.isArray(lineage?.nodes) ? lineage.nodes : []) {
        if (!node?.row || node.row.id === null || node.row.id === undefined) continue
        if (node.id !== row.id && !matchesHistoricalTopic(node.row, query)) continue
        const id = String(node.row.id)
        if (lineageIds.has(id)) continue
        lineageIds.add(id)
        lineageRows.push({
          ...node.row,
          source: node.kind ?? memorySourceKind(node.row),
        })
      }
    }

    const combined = [...lineageRows, ...selectedCandidates]
    const uniqueRows = uniqueRowsInOrder(combined)

    const sourcePriority = { raw: 0, reflection: 1, dream: 2, historical: 3 }
    const sectionById = new Map()
    if (evolution) {
      for (const row of evolution.earlyRaw) sectionById.set(String(row.id), 'earliest-raw')
      for (const row of evolution.laterDerived) sectionById.set(String(row.id), 'later-understanding')
      for (const row of lineageRows) {
        const id = String(row.id)
        if (!sectionById.has(id)) sectionById.set(id, 'source-evidence')
      }
    }
    const orderedRows = mode === 'evolution'
      ? [
          ...(evolution?.earlyRaw ?? []),
          ...(evolution?.laterDerived ?? []),
          ...lineageRows.filter((row) => !sectionById.has(String(row.id)) || sectionById.get(String(row.id)) === 'source-evidence'),
        ]
      : mode === 'first'
        ? uniqueRowsInOrder([...orderedCandidates, ...lineageRows])
      : (mode === 'when' || mode === 'past')
        ? sortHistoricalRows(uniqueRows)
      : mode === 'why' || mode === 'exact'
        ? uniqueRows
          .map((row, index) => ({ row, index }))
          .sort((left, right) => (
            (sourcePriority[left.row.source ?? memorySourceKind(left.row)] ?? 3) -
            (sourcePriority[right.row.source ?? memorySourceKind(right.row)] ?? 3) ||
            left.index - right.index
          ))
          .map(({ row }) => row)
        : uniqueRows
    const requestedMax = Number(maxEntries)
    const entryLimit = Number.isFinite(requestedMax)
      ? Math.min(HISTORICAL_RECALL_CONTEXT_MAX, Math.max(0, Math.floor(requestedMax)))
      : HISTORICAL_RECALL_CONTEXT_MAX
    const entries = orderedRows.slice(0, entryLimit).map((row) => ({
      id: String(row.id),
      level: row.level,
      content: row.content,
      importance: row.importance,
      status: row.status,
      source_session: row.source_session ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      source: row.source ?? memorySourceKind(row),
      section: sectionById.get(String(row.id)) ?? null,
    }))

    return {
      mode,
      topicTokens: [...(topicTokens ?? [])],
      entries,
      provenanceUnavailable,
      provenanceUnavailableIds: [...new Set(provenanceUnavailableIds)],
      lineageMaxDepth: maxDepth,
      lineageMaxNodes: maxNodes,
    }
  }

  findById(id) {
    const found = this.#findMemoryById(id)
    return found?.row
      ? { ...found, row: this.provenanceStore.decorate(found.row) }
      : found
  }

  provenanceForMemory(id) {
    const found = this.#findMemoryById(id)
    return found?.row ? this.provenanceStore.resolve(found.row) : null
  }

  provenanceForDerived(derivedId) {
    const reader = this.#getProvenanceReader()
    if (typeof reader?.provenanceForDerived === 'function') {
      return reader.provenanceForDerived(derivedId)
    }
    return readProvenanceForDerived(derivedId, { dbPath: this.dbPath })
  }

  resolveMemoryLineage(derivedId, options = {}) {
    const reader = this.#getProvenanceReader()
    if (typeof reader?.resolveMemoryLineage === 'function') {
      return reader.resolveMemoryLineage(derivedId, options)
    }
    return resolveMemoryLineageGraph(derivedId, {
      ...options,
      findById: (id) => this.#findMemoryById(id),
      provenanceForDerived: (id) => this.provenanceForDerived(id),
    })
  }

  #latestRawCreatedAt() {
    let latestCreatedAt = 0
    for (const level of RAW_SOURCE_LEVELS) {
      const latest = this.db.list(level, { status: 'active' })
        .filter((row) =>
          row.source_session === PET_SOURCE_SESSION &&
          Number(row.importance) >= 2 &&
          Number.isFinite(Number(row.created_at)),
        )
        .sort((a, b) => Number(b.created_at) - Number(a.created_at))[0]
      if (latest && Number(latest.created_at) > latestCreatedAt) {
        latestCreatedAt = Number(latest.created_at)
      }
    }
    return latestCreatedAt
  }

  #rawSourceRows({ after = 0, before = Date.now() } = {}) {
    const lower = Number(after)
    const upper = Number(before)
    return RAW_SOURCE_LEVELS
      .flatMap((level) => this.db.list(level, { status: 'active' }))
      .filter((row) =>
        row.source_session === PET_SOURCE_SESSION &&
        Number(row.importance) >= 2 &&
        Number.isFinite(Number(row.created_at)) &&
        Number(row.created_at) > lower &&
        Number(row.created_at) <= upper,
      )
      .sort((a, b) => Number(a.created_at) - Number(b.created_at) || String(a.id).localeCompare(String(b.id)))
      .map((row) => this.provenanceStore.decorate(row))
  }

  close() {
    try { this.provenanceReader?.close?.() } catch {}
    this.db.close()
  }

  #getProvenanceReader() {
    if (!this.provenanceReader) {
      this.provenanceReader = createDreamProvenanceReader(this.dbPath, {
        findById: (id) => this.#findMemoryById(id),
      })
    }
    return this.provenanceReader
  }

  #findMemoryById(id) {
    const normalized = String(id ?? '')
    if (!normalized) return undefined

    if (typeof this.db.findById === 'function') {
      return this.db.findById(normalized)
    }

    for (const level of [...HISTORICAL_RECALL_LEVELS, 'rules']) {
      const row = this.db.list(level, {}).find((candidate) => String(candidate.id) === normalized)
      if (row) return { row, level }
    }
    return undefined
  }
}
