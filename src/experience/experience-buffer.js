import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { detectExplicitMemoryRequest } from '../brain/memory-candidate.js'
import { cjkTerms, GENERIC_RECALL_TERMS } from '../vision/visual-keywords.js'

export const EXPERIENCE_BUFFER_DB_FILENAME = 'experience-buffer.sqlite'
export const EXPERIENCE_BUFFER_RETENTION_MS = 14 * 24 * 60 * 60 * 1000

export const EXPERIENCE_BUFFER_ROOT_REQUIRED = 'PET_EXPERIENCE_BUFFER_ROOT_REQUIRED'
export const EXPERIENCE_BUFFER_CLOCK_INVALID = 'PET_EXPERIENCE_BUFFER_CLOCK_INVALID'
export const EXPERIENCE_BUFFER_ID_FACTORY_INVALID = 'PET_EXPERIENCE_BUFFER_ID_FACTORY_INVALID'
export const EXPERIENCE_BUFFER_NOT_INITIALIZED = 'PET_EXPERIENCE_BUFFER_NOT_INITIALIZED'
export const EXPERIENCE_BUFFER_RECORD_FAILED = 'PET_EXPERIENCE_BUFFER_RECORD_FAILED'

const TEXT_MAX_LENGTH = 1200
const ACTOR_IDS = new Set(['owner', 'pet', 'system'])
const IDENTITY_PATTERN = /名字|姓名|叫(?:作)?|生日|出生|性别|公狗|母狗|公猫|母猫|品种|习惯|喜欢|爱吃|总是|每天|经常/u
const EMOTION_PATTERN = /开心|高兴|快乐|难过|伤心|担心|焦虑|害怕|生病|病了|变化|改变|去世|离开|失去|住院|手术/u

function conservativeClassification(reason = 'invalid-input') {
  return {
    sourceType: 'owner_chat',
    importanceScore: 0,
    emotionScore: null,
    memoryCandidate: null,
    admitted: false,
    reason,
  }
}

function safeText(value, { allowNull = true } = {}) {
  if (value === undefined || value === null) {
    if (allowNull) return null
    // A required field that is missing is unusable input, not an empty string.
    // Coercing it to '' made `classifyExperience(null)` look like a legitimate
    // worthless experience, so the caller could not tell "nothing was said" from
    // "the caller passed the wrong thing" — and a bug upstream would be recorded
    // as life experience instead of failing closed.
    throw new TypeError('EXPERIENCE_TEXT_REQUIRED')
  }
  return String(value)
    .replace(/data:[^\s,;]+;base64,[A-Za-z0-9+/=]+/gu, '[图片]')
    .trim()
    .slice(0, TEXT_MAX_LENGTH)
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clampScore(value, fallback = 0) {
  const number = finiteNumber(value)
  if (number === null) return fallback
  return Math.max(0, Math.min(1, number))
}

function boundedLimit(value, fallback, maximum = 200) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(maximum, Math.floor(number)))
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function cloneJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const clone = JSON.parse(JSON.stringify(value))
    return clone && typeof clone === 'object' && !Array.isArray(clone) ? clone : null
  } catch {
    return null
  }
}

function candidateScore(candidate) {
  if (!candidate || typeof candidate !== 'object') return 0
  return Math.max(
    clampScore(candidate.importanceScore),
    clampScore(candidate.importanceCandidate),
    clampScore(finiteNumber(candidate.importance) === null ? null : Number(candidate.importance) / 3),
  )
}

/**
 * Produce a stable text-only key so repeated facts can be counted without
 * retaining attachments or depending on a model call.
 */
export function experienceFingerprint(content = '') {
  try {
    const text = safeText(content, { allowNull: false }).toLocaleLowerCase()
    return text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ')
  } catch {
    return ''
  }
}

/**
 * Informative terms of an experience, used to decide whether two sentences are
 * about the same fact.
 *
 * An exact-string fingerprint cannot see a repeat: "黑莓今天睡沙发",
 * "黑莓又睡沙发了" and "黑莓还是睡沙发" are three different strings describing
 * one behaviour, so the count stayed at 1 forever and `repeated_behavior` was
 * unreachable. Overlap over content words is what actually recognises a repeat.
 */
const EXPERIENCE_STOP_TERMS = new Set([
  '今天', '昨天', '明天', '现在', '刚才', '我们', '你们', '他们', '这个', '那个', '什么',
  '怎么', '可以', '一个', '还是', '然后', '但是', '因为', '所以', '已经', '真的', '非常',
  '主人', '花花', '李花花', '一下', '一点', '有点', '好像', '知道', '记得',
])

export function experienceTerms(content = '') {
  const tokens = new Set()
  try {
    // Reuse the pipeline's own Chinese segmenter rather than inventing a second
    // one: it already handles 2-4 grams and stop characters, and it is the same
    // tokenizer PetMemory's recall index uses. A hand-rolled splitter produced
    // runs like "黑莓今天"/"睡沙发了", which never matched across paraphrases.
    // Bigrams only. The segmenter also emits 1/3/4-grams; keeping them dilutes
    // the comparison, because two paraphrases of one behaviour share their
    // bigrams ("黑莓","睡沙","沙发") but almost none of their longer grams. The
    // 2-gram view is the level at which "same fact, different words" shows up.
    for (const [term] of cjkTerms(safeText(content, { allowNull: false }))) {
      if (term.length !== 2) continue
      if (EXPERIENCE_STOP_TERMS.has(term)) continue
      if (GENERIC_RECALL_TERMS.has(term)) continue
      tokens.add(term)
    }
    for (const match of experienceFingerprint(content).matchAll(/[a-z0-9]{2,}/gu)) tokens.add(match[0])
  } catch {
    return new Set()
  }
  return tokens
}

/**
 * Directed containment: the share of `left`'s content terms that also appear in
 * `right`.
 *
 * Directed rather than symmetric because owners repeat a behaviour with extra
 * detail — "黑莓在沙发上睡着了" against "黑莓今天睡沙发". Jaccard punishes the
 * extra words and reports 0.13, while containment reports the property we care
 * about ("is this the same behaviour?"). Unrelated sentences still score 0,
 * which is what stops a fabricated pattern from being written to memory.
 */
export function experienceSimilarity(left, right) {
  const a = left instanceof Set ? left : experienceTerms(left)
  const b = right instanceof Set ? right : experienceTerms(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const term of a) if (b.has(term)) shared += 1
  return shared / a.size
}

/**
 * Below this overlap two experiences count as different facts.
 *
 * Calibrated against real phrasing pairs: "黑莓今天睡沙发" vs "黑莓又睡沙发了"
 * / "黑莓还是睡沙发" score 0.60, and the more loosely paraphrased "黑莓在沙发上
 * 睡着了" scores 0.40, while unrelated sentences ("今天天气不错",
 * "主人今天有点难过", "花花今天吃了狗粮") all score 0.00-0.29. The threshold
 * sits in that gap; a fabricated pattern is worse than a missed one, so it is
 * not lowered further.
 */
export const EXPERIENCE_REPEAT_MIN_SIMILARITY = 0.4

/**
 * Keep repeated-event detection injectable at the call boundary and pure for
 * unit tests; the buffer owns the occurrence counter passed to this function.
 */
export function detectRepeatedExperience(content = '', occurrenceCount = 1) {
  const fingerprint = experienceFingerprint(content)
  const count = positiveInteger(occurrenceCount) ?? 1
  return { fingerprint, occurrenceCount: count, repeated: Boolean(fingerprint && count >= 2) }
}

export function classifyExperience(input = null) {
  try {
    // Distinguish "some fields were omitted" from "the caller passed nothing".
    // A `{}` default would erase that difference — `undefined` would arrive as an
    // empty object and be recorded as a worthless-but-real experience.
    const inputMissing = input === null || input === undefined
    if (inputMissing) return conservativeClassification()
    const {
      ownerText = '',
      assistantText = '',
      hadVision = false,
      visionSummary = null,
      emotion = null,
      modelCandidate = null,
      explicitMemoryRequest = false,
      occurrenceCount = 1,
    } = input ?? {}
    if (input === null || input === undefined || ownerText === null || ownerText === undefined) {
      return conservativeClassification()
    }
    const owner = safeText(ownerText, { allowNull: false })
    const assistant = safeText(assistantText, { allowNull: false })
    const vision = safeText(visionSummary)
    const detection = detectExplicitMemoryRequest(owner)
    const explicit = !detection.optOut && (explicitMemoryRequest === true || detection.explicit)
    const candidate = cloneJsonObject(modelCandidate)
    const candidateImportance = candidateScore(candidate)
    const count = positiveInteger(occurrenceCount) ?? 1
    const emotionObject = emotion && typeof emotion === 'object' ? emotion : null
    const mood = emotionObject ? safeText(emotionObject.mood) : null
    const intensity = emotionObject ? clampScore(emotionObject.intensity, null) : null
    const emotionSignal = Boolean(EMOTION_PATTERN.test(owner) || mood || (intensity !== null && intensity >= 0.7))
    const identitySignal = IDENTITY_PATTERN.test(owner)
    const repeated = detectRepeatedExperience(owner, count).repeated

    if (inputMissing) return conservativeClassification()

    if (explicit) {
      return {
        sourceType: 'explicit_memory',
        importanceScore: Math.max(0.9, candidateImportance),
        emotionScore: intensity,
        memoryCandidate: candidate ?? { type: 'explicit_memory', content: owner },
        admitted: true,
        reason: 'explicit-memory-request',
      }
    }
    if (identitySignal) {
      return {
        sourceType: 'owner_chat',
        importanceScore: Math.max(0.8, candidateImportance),
        emotionScore: intensity,
        memoryCandidate: candidate,
        admitted: true,
        reason: 'pet-identity-information',
      }
    }
    if (repeated) {
      return {
        sourceType: 'repeated_behavior',
        importanceScore: Math.max(0.8, candidateImportance),
        emotionScore: intensity,
        memoryCandidate: candidate,
        admitted: true,
        reason: 'repeated-fact',
      }
    }
    if (emotionSignal) {
      return {
        sourceType: 'emotion_event',
        importanceScore: Math.max(0.8, candidateImportance),
        emotionScore: intensity ?? 0.8,
        memoryCandidate: candidate,
        admitted: true,
        reason: '明显情绪事件',
      }
    }

    if (inputMissing) return conservativeClassification()
    const sourceType = hadVision || vision ? 'pet_vision' : 'owner_chat'
    // The importance score stays low, but the row is admitted.
    //
    // Rejecting it here makes `repeated_behavior` unreachable: the first
    // "黑莓今天睡沙发" is discarded as low-value chitchat, so the second one has
    // nothing to repeat against and a behaviour the owner asked us to notice can
    // never be noticed. Low importance means "Reflection may ignore this", not
    // "throw the evidence away" — the consolidator's importance gate is what keeps
    // one-off events out of PetMemory.
    const importanceScore = Math.max(candidateImportance, sourceType === 'pet_vision' ? 0.6 : 0.2)
    return {
      sourceType,
      importanceScore,
      emotionScore: intensity,
      memoryCandidate: candidate,
      admitted: true,
      reason: sourceType === 'pet_vision' ? 'visual-experience' : 'low-importance-experience',
    }
  } catch {
    return conservativeClassification()
  }
}

function parseMemoryCandidate(value) {
  if (value === null || value === undefined) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function rowToExperience(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    createdAt: Number(row.created_at),
    sourceType: row.source_type,
    conversationId: row.conversation_id ?? null,
    messageId: row.message_id ?? null,
    actorId: row.actor_id ?? null,
    content: row.content,
    importanceScore: Number(row.importance_score),
    emotionScore: row.emotion_score === null || row.emotion_score === undefined ? null : Number(row.emotion_score),
    memoryCandidate: parseMemoryCandidate(row.memory_candidate),
    processed: Number(row.processed) === 1,
    processedAt: row.processed_at === null || row.processed_at === undefined ? null : Number(row.processed_at),
  }
}

export class ExperienceBuffer {
  constructor({ root, now = () => Date.now(), idFactory = null, retentionMs = EXPERIENCE_BUFFER_RETENTION_MS }) {
    if (!root) throw new TypeError(EXPERIENCE_BUFFER_ROOT_REQUIRED)
    if (typeof now !== 'function') throw new TypeError(EXPERIENCE_BUFFER_CLOCK_INVALID)
    if (idFactory !== null && typeof idFactory !== 'function') throw new TypeError(EXPERIENCE_BUFFER_ID_FACTORY_INVALID)
    if (!Number.isFinite(Number(retentionMs)) || Number(retentionMs) < 0) {
      throw new TypeError('PET_EXPERIENCE_BUFFER_RETENTION_INVALID')
    }

    this.root = resolve(root)
    this.dbPath = join(this.root, EXPERIENCE_BUFFER_DB_FILENAME)
    this.now = now
    this.idFactory = idFactory
    this.retentionMs = Number(retentionMs)
    this.db = null
    this.initialized = false
    this.initializing = null
    this.fingerprintCounts = new Map()
    // Seed the occurrence counter from rows already on disk so a restart does
    // not reset "how many times has this happened" back to one.
    this.occurrenceSignatures = new Map()
  }

  /**
   * Count how many times an experience like this one has been recorded.
   *
   * A stored signature is reused when it overlaps the new experience above
   * `EXPERIENCE_REPEAT_MIN_SIMILARITY`; otherwise a new signature starts at 1.
   * The first occurrence must still be admitted by the caller, or there would be
   * nothing for the second one to be repeated against.
   */
  #bumpOccurrence(ownerText) {
    const terms = experienceTerms(ownerText)
    if (terms.size === 0) return 1
    let best = null
    let bestScore = 0
    for (const entry of this.occurrenceSignatures.values()) {
      const score = experienceSimilarity(terms, entry.terms)
      if (score > bestScore) {
        bestScore = score
        best = entry
      }
    }
    if (best && bestScore >= EXPERIENCE_REPEAT_MIN_SIMILARITY) {
      best.count += 1
      best.terms = new Set([...best.terms, ...terms])
      return best.count
    }
    this.occurrenceSignatures.set(`${this.occurrenceSignatures.size}:${ownerText.slice(0, 40)}`, { terms, count: 1 })
    return 1
  }

  async initialize() {
    if (this.initialized) return this
    if (this.initializing) return this.initializing

    this.initializing = (async () => {
      await mkdir(this.root, { recursive: true })
      const db = new DatabaseSync(this.dbPath)
      try {
        db.exec(`
          PRAGMA busy_timeout = 1000;
          CREATE TABLE IF NOT EXISTS experience_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at INTEGER NOT NULL,
            source_type TEXT NOT NULL,
            conversation_id TEXT,
            message_id TEXT,
            actor_id TEXT,
            content TEXT NOT NULL,
            importance_score REAL NOT NULL DEFAULT 0,
            emotion_score REAL,
            memory_candidate TEXT,
            processed INTEGER NOT NULL DEFAULT 0,
            processed_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS experience_events_created_at_idx
            ON experience_events(created_at);
          CREATE INDEX IF NOT EXISTS experience_events_processed_id_idx
            ON experience_events(processed, id);
          CREATE INDEX IF NOT EXISTS experience_events_source_type_idx
            ON experience_events(source_type);
          CREATE INDEX IF NOT EXISTS experience_events_conversation_id_idx
            ON experience_events(conversation_id);
        `)
        await chmod(this.dbPath, 0o600)
        this.db = db
        this.initialized = true
        return this
      } catch (error) {
        db.close()
        throw error
      }
    })()

    try {
      return await this.initializing
    } finally {
      this.initializing = null
    }
  }

  #now() {
    const value = finiteNumber(this.now())
    if (value === null) throw new TypeError('PET_EXPERIENCE_BUFFER_CLOCK_VALUE_INVALID')
    return value
  }

  #recordId() {
    if (!this.idFactory) return null
    const id = positiveInteger(this.idFactory())
    if (id === null) throw new TypeError('PET_EXPERIENCE_BUFFER_ID_INVALID')
    return id
  }

  record(input = {}) {
    try {
      if (!this.initialized || !this.db) {
        return { ok: false, id: null, sourceType: 'owner_chat', importanceScore: 0, admitted: false, reason: EXPERIENCE_BUFFER_NOT_INITIALIZED }
      }
      const {
        turnId = null,
        conversationId = turnId,
        messageId = null,
        actor = 'owner',
        actorId = actor,
        ownerText = '',
        assistantText = '',
        hadVision = false,
        visionSummary = null,
        emotion = null,
        modelCandidate = null,
        explicitMemoryRequest = false,
        occurrenceCount = null,
      } = input ?? {}
      const owner = safeText(ownerText, { allowNull: false })
      const assistant = safeText(assistantText, { allowNull: false })
      const conversationKey = conversationId === null || conversationId === undefined ? null : String(conversationId)
      const messageKey = messageId === null || messageId === undefined ? null : String(messageId)
      const actorKey = actorId === null || actorId === undefined
        ? null
        : (ACTOR_IDS.has(actorId) ? actorId : 'owner')
      // Repeat counting works on content-word overlap, not on the exact string,
      // so "黑莓今天睡沙发" / "黑莓又睡沙发了" / "黑莓还是睡沙发" accumulate as
      // one behaviour instead of three unrelated one-off events.
      const seen = this.#bumpOccurrence(owner)
      const classified = classifyExperience({
        ownerText: owner,
        assistantText: assistant,
        hadVision,
        visionSummary,
        emotion,
        modelCandidate,
        explicitMemoryRequest,
        occurrenceCount: occurrenceCount ?? seen,
      })
      const classification = actorKey === 'system' && classified.sourceType === 'owner_chat'
        ? { ...classified, sourceType: 'system' }
        : classified
      if (!classification.admitted) {
        return { ok: true, id: null, ...classification }
      }

      const contentParts = [owner, assistant && `花花回复：${assistant}`].filter(Boolean)
      const content = contentParts.join('\n').slice(0, TEXT_MAX_LENGTH)
      if (!content) return { ok: true, id: null, ...conservativeClassification('empty-content') }
      const createdAt = this.#now()
      const memoryCandidate = classification.memoryCandidate === null
        ? null
        : JSON.stringify(classification.memoryCandidate)
      const id = this.#recordId()
      let result
      if (id === null) {
        result = this.db.prepare(`
          INSERT INTO experience_events(
            created_at, source_type, conversation_id, message_id, actor_id, content,
            importance_score, emotion_score, memory_candidate, processed, processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          createdAt,
          classification.sourceType,
          conversationKey,
          messageKey,
          actorKey,
          content,
          classification.importanceScore,
          classification.emotionScore,
          memoryCandidate,
        )
      } else {
        result = this.db.prepare(`
          INSERT INTO experience_events(
            id, created_at, source_type, conversation_id, message_id, actor_id, content,
            importance_score, emotion_score, memory_candidate, processed, processed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
        `).run(
          id,
          createdAt,
          classification.sourceType,
          conversationKey,
          messageKey,
          actorKey,
          content,
          classification.importanceScore,
          classification.emotionScore,
          memoryCandidate,
        )
      }
      const insertedId = id ?? Number(result.lastInsertRowid)
      if (!positiveInteger(insertedId)) throw new TypeError('PET_EXPERIENCE_BUFFER_ID_INVALID')
      return { ok: true, id: insertedId, ...classification }
    } catch {
      return { ok: false, id: null, sourceType: 'owner_chat', importanceScore: 0, admitted: false, reason: EXPERIENCE_BUFFER_RECORD_FAILED }
    }
  }

  async pendingExperience({ afterId = null, limit = 50, before = null } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 50, 200)
    if (count === 0) return []
    const clauses = ['processed = 0']
    const parameters = []
    const normalizedAfterId = positiveInteger(afterId)
    if (normalizedAfterId !== null) {
      clauses.push('id > ?')
      parameters.push(normalizedAfterId)
    }
    const normalizedBefore = before === null || before === undefined ? null : finiteNumber(before)
    if (normalizedBefore !== null) {
      clauses.push('created_at <= ?')
      parameters.push(normalizedBefore)
    }
    parameters.push(count)
    return this.db.prepare(`
      SELECT * FROM experience_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY id ASC
      LIMIT ?
    `).all(...parameters).map(rowToExperience)
  }

  async markProcessed(ids, { processedAt = this.now() } = {}) {
    await this.initialize()
    const normalizedIds = [...new Set((Array.isArray(ids) ? ids : [])
      .map(positiveInteger)
      .filter((id) => id !== null))]
    if (normalizedIds.length === 0) return { ok: true, processedCount: 0 }
    const timestamp = finiteNumber(processedAt)
    if (timestamp === null) throw new TypeError('PET_EXPERIENCE_BUFFER_PROCESSED_AT_INVALID')
    const placeholders = normalizedIds.map(() => '?').join(', ')
    const result = this.db.prepare(`
      UPDATE experience_events
      SET processed = 1, processed_at = ?
      WHERE id IN (${placeholders}) AND processed = 0
    `).run(timestamp, ...normalizedIds)
    return { ok: true, processedCount: Number(result.changes) }
  }

  async purgeExpired({ now = this.now() } = {}) {
    await this.initialize()
    const timestamp = finiteNumber(now)
    if (timestamp === null) throw new TypeError('PET_EXPERIENCE_BUFFER_PURGE_NOW_INVALID')
    const cutoff = timestamp - this.retentionMs
    const retainedUnprocessed = Number(this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM experience_events
      WHERE created_at < ? AND processed = 0
    `).get(cutoff).count)
    const result = this.db.prepare(`
      DELETE FROM experience_events
      WHERE created_at < ? AND processed = 1
    `).run(cutoff)
    return { ok: true, deletedCount: Number(result.changes), retainedUnprocessed }
  }

  async recent({ limit = 12, before = null } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 12, 200)
    if (count === 0) return []
    const normalizedBefore = before === null || before === undefined ? null : finiteNumber(before)
    const condition = normalizedBefore === null ? '' : 'WHERE created_at <= ?'
    const parameters = normalizedBefore === null ? [count] : [normalizedBefore, count]
    return this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM experience_events
        ${condition}
        ORDER BY id DESC
        LIMIT ?
      )
      ORDER BY id ASC
    `).all(...parameters).map(rowToExperience)
  }

  async count() {
    await this.initialize()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM experience_events').get().count)
  }

  async close() {
    this.db?.close()
    this.db = null
    this.initialized = false
  }
}
