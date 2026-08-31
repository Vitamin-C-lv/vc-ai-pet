import { resolve, relative, sep, join } from 'node:path'
import { MemoryDb, search as rankMemories } from 'meow-memory'

const PET_SOURCE_SESSION = 'vc-ai-pet'
const ALLOWED_LEVELS = new Set(['soul','user','project','fact','lesson','topic','rules'])
const RECALL_LEVELS = ['soul','user','project','fact','lesson','topic','rules']
const MEMORY_WRITE_LEVELS = ['user','project','fact','lesson','topic']

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
      const generic = soulRows.find((row) => row.status === 'active' && (row.content.includes('像素伯恩山小狗') || row.content.includes('住在这里')))
      if (generic) this.db.update('soul', generic.id, { content: desiredSoul, importance: Math.max(3, generic.importance ?? 1), keywords: ['李花花','生日','伯恩山犬','主人','宠物','身份','自己','2026-08-31'] })
      else this.remember('soul', desiredSoul, 3, { keywords: ['李花花','生日','伯恩山犬','主人','宠物','身份','自己','2026-08-31'] })
    }
    const birthdayFactExists = this.db.list('fact').some((row) => row.content.includes(identity.birthday) && row.content.includes('生日'))
    if (!birthdayFactExists) this.remember('fact', `${identity.name}的生日是 ${identity.birthday}；这一天 ${identity.birthEvent} 正式通过，作为出生纪念日。`, 3, { keywords: ['李花花','生日','出生','2026-08-31','v0.1','封板','纪念日','伯恩山犬'] })
    return true
  }

  remember(level, content, importance = 1, extra = {}) {
    if (!ALLOWED_LEVELS.has(level)) throw new Error(`PET_MEMORY_LEVEL_DENIED: ${level}`)
    return this.db.insert({ level, content, importance, source_session: PET_SOURCE_SESSION, ...extra })
  }

  rememberInteraction(kind, count) {
    return this.remember('fact', `主人和我互动了：${kind}。累计互动次数：${count}。`, 1)
  }

  findEquivalentMemory(content) {
    for (const level of MEMORY_WRITE_LEVELS) {
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

  recall(query, k = 5) {
    const docs = RECALL_LEVELS.flatMap((level) => this.db.listSearchable(level))
    const hits = rankMemories(query, docs, { k })
    for (const hit of hits) {
      try { this.db.bumpHit(hit.level, hit.id) } catch {}
    }
    return hits
  }

  stableIdentityContext() {
    return [...this.db.list('soul', { status: 'active' }), ...this.db.list('rules', { status: 'active' })]
      .map(({ level, content, importance }) => ({ level, content, importance }))
  }

  close() {
    this.db.close()
  }
}
