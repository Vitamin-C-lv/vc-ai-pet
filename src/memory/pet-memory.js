import { resolve, relative, sep, join } from 'node:path'
import { MemoryDb, search as rankMemories } from 'meow-memory'

const PET_SOURCE_SESSION = 'vc-ai-pet'
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

export class PetMemory {
  constructor(root) {
    this.sandboxRoot = resolve(root)
    this.dbPath = inside(this.sandboxRoot, join(this.sandboxRoot, 'memory', 'pet-memory.db'))
    this.db = new MemoryDb(this.dbPath)
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
    const row = this.db.insert({ level, content, importance, source_session: PET_SOURCE_SESSION, ...extra })
    if (
      DREAM_SOURCE_LEVELS.includes(row.level) &&
      Number(row.importance) >= 2 &&
      row.source_session === PET_SOURCE_SESSION
    ) {
      this.db.touchWindow(PET_DREAM_WINDOW, this.sandboxRoot, row.created_at)
      this.db.touchWindow(PET_REFLECTION_WINDOW, this.sandboxRoot, row.created_at)
    }
    return row
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
    return hits.map((hit) => byId.get(hit.id) ?? hit)
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
    const title = `dream:${sourceIds.map((id) => String(id).slice(0, 8)).join(',')}`
    return this.db.insert({
      level: candidate.level,
      title,
      content: candidate.content,
      importance: candidate.importance,
      keywords: candidate.keywords,
      source_session: PET_DREAM_SOURCE_SESSION,
    })
  }

  rememberReflectionCandidate(candidate) {
    if (!candidate || !REFLECTION_DERIVED_LEVELS.has(candidate.level)) {
      throw new Error('PET_REFLECTION_CANDIDATE_LEVEL_DENIED')
    }

    const sourceIds = Array.isArray(candidate.sourceIds) ? candidate.sourceIds : []
    if (sourceIds.length === 0) throw new Error('PET_REFLECTION_SOURCE_IDS_REQUIRED')
    const title = `reflection:${sourceIds.map((id) => String(id).slice(0, 8)).join(',')}`
    return this.db.insert({
      level: candidate.level,
      title,
      content: candidate.content,
      importance: candidate.importance,
      keywords: candidate.keywords,
      source_session: PET_REFLECTION_SOURCE_SESSION,
    })
  }

  recall(query, k = 5) {
    const docs = RECALL_LEVELS.flatMap((level) => this.db.listSearchable(level))
    const hits = rankMemories(query, docs, { k })
    for (const hit of hits) {
      try { this.db.bumpHit(hit.level, hit.id) } catch {}
    }
    return hits
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
  }

  close() {
    this.db.close()
  }
}
