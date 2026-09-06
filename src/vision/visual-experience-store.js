import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const VISUAL_EXPERIENCE_DB_FILENAME = 'visual-experience.db'
export const VISUAL_EVENT_KINDS = Object.freeze(['inspection', 'revisit', 'comparison', 'observation'])
export const VISUAL_BACKFILL_CURSOR_KEY = 'backfill_sequence'

const EVENT_KINDS = new Set(VISUAL_EVENT_KINDS)
const TERM_SOURCE_KINDS = new Set(['user_text', 'observation'])
const EVIDENCE_KINDS = new Set(['inferred', 'raw'])

function cleanText(value, maxLength = 1200) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function cleanTerm(value) {
  return String(value ?? '').trim().slice(0, 64)
}

function positiveInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function nonNegativeInteger(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : null
}

function timestamp(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : Number(fallback)
}

function rowToExperience(row) {
  if (!row) return null
  return {
    experienceId: row.experience_id,
    sourceMessageId: row.source_message_id,
    attachmentId: row.attachment_id,
    occurredAt: row.occurred_at,
    userText: row.user_text,
    createdAt: row.created_at,
    lastInspectedAt: row.last_inspected_at ?? null,
    inspectionCount: row.inspection_count,
  }
}

function rowToEvent(row) {
  if (!row) return null
  return {
    eventId: row.event_id,
    experienceId: row.experience_id,
    turnId: row.turn_id ?? null,
    kind: row.kind,
    occurredAt: row.occurred_at,
    focus: row.focus ?? null,
    summary: row.summary ?? null,
    relatedExperienceId: row.related_experience_id ?? null,
    evidence: row.evidence,
  }
}

function boundedLimit(value, fallback, maximum = 500) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(0, Math.min(maximum, Math.floor(number)))
}

export class VisualExperienceStore {
  constructor(root, { now = () => Date.now(), idFactory = randomUUID } = {}) {
    if (!root) throw new TypeError('PET_VISUAL_EXPERIENCE_STORE_ROOT_REQUIRED')
    if (typeof now !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_STORE_CLOCK_INVALID')
    if (typeof idFactory !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_STORE_ID_FACTORY_INVALID')

    this.root = resolve(root)
    this.dbPath = join(this.root, VISUAL_EXPERIENCE_DB_FILENAME)
    this.now = now
    this.idFactory = idFactory
    this.db = null
    this.initialized = false
    this.initializing = null
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
          CREATE TABLE IF NOT EXISTS visual_experiences (
            experience_id TEXT PRIMARY KEY,
            source_message_id TEXT NOT NULL UNIQUE,
            attachment_id TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            user_text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_inspected_at INTEGER,
            inspection_count INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS visual_events (
            event_id TEXT PRIMARY KEY,
            experience_id TEXT NOT NULL,
            turn_id TEXT,
            kind TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            focus TEXT,
            summary TEXT,
            related_experience_id TEXT,
            evidence TEXT NOT NULL DEFAULT 'inferred'
          );
          CREATE TABLE IF NOT EXISTS visual_terms (
            experience_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_ref TEXT NOT NULL,
            term TEXT NOT NULL,
            weight INTEGER NOT NULL,
            PRIMARY KEY (experience_id, source_kind, term)
          );
          CREATE TABLE IF NOT EXISTS visual_sync_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS visual_experiences_attachment_id_idx ON visual_experiences(attachment_id);
          CREATE INDEX IF NOT EXISTS visual_experiences_source_message_id_idx ON visual_experiences(source_message_id);
          CREATE INDEX IF NOT EXISTS visual_experiences_occurred_at_idx ON visual_experiences(occurred_at);
          CREATE INDEX IF NOT EXISTS visual_terms_term_idx ON visual_terms(term);
          CREATE INDEX IF NOT EXISTS visual_events_experience_id_idx ON visual_events(experience_id);
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

  #cursor() {
    const row = this.db.prepare('SELECT value FROM visual_sync_state WHERE key = ?').get(VISUAL_BACKFILL_CURSOR_KEY)
    return nonNegativeInteger(row?.value) ?? 0
  }

  #writeCursor(cursor) {
    this.db.prepare(`
      INSERT INTO visual_sync_state(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(VISUAL_BACKFILL_CURSOR_KEY, String(cursor))
  }

  #newId(label) {
    const value = String(this.idFactory() ?? '').trim()
    if (!value) throw new TypeError(`PET_VISUAL_EXPERIENCE_${label.toUpperCase()}_ID_INVALID`)
    return value
  }

  #insertExperience(message, archiveSequence = null) {
    if (message?.role !== 'user' || !message?.attachment?.id) {
      return { created: false, experienceId: null }
    }

    const sourceMessageId = String(message.id ?? '').trim()
    const attachmentId = String(message.attachment.id ?? '').trim()
    if (!sourceMessageId || !attachmentId) return { created: false, experienceId: null }

    const existing = this.db.prepare('SELECT experience_id FROM visual_experiences WHERE source_message_id = ?').get(sourceMessageId)
    if (existing) return { created: false, experienceId: existing.experience_id }

    const experienceId = this.#newId('experience')
    this.db.prepare(`
      INSERT OR IGNORE INTO visual_experiences(
        experience_id, source_message_id, attachment_id, occurred_at, user_text, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      experienceId,
      sourceMessageId,
      attachmentId,
      timestamp(message.timestamp, this.now()),
      cleanText(message.text),
      timestamp(this.now(), Date.now()),
    )

    const inserted = this.db.prepare('SELECT experience_id FROM visual_experiences WHERE source_message_id = ?').get(sourceMessageId)
    if (archiveSequence !== null) {
      const sequence = nonNegativeInteger(archiveSequence)
      if (sequence !== null && sequence > this.#cursor()) this.#writeCursor(sequence)
    }
    return { created: inserted?.experience_id === experienceId, experienceId: inserted?.experience_id ?? experienceId }
  }

  async syncFromArchive({ readBatch, readMaxSequence, tokenizeText = null }, { batchSize = 200 } = {}) {
    await this.initialize()
    if (typeof readBatch !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_READ_BATCH_INVALID')
    if (typeof readMaxSequence !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_READ_MAX_SEQUENCE_INVALID')
    if (tokenizeText !== null && typeof tokenizeText !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_TOKENIZER_INVALID')

    const maxSequence = nonNegativeInteger(await readMaxSequence())
    if (maxSequence === null) throw new TypeError('PET_VISUAL_EXPERIENCE_MAX_SEQUENCE_INVALID')
    const requestedBatchSize = boundedLimit(batchSize, 200, 500)
    const pageSize = requestedBatchSize > 0 ? requestedBatchSize : 200
    const cursorBefore = this.#cursor()
    let cursor = cursorBefore
    let processedCount = 0
    let createdCount = 0
    let skippedCount = 0

    while (cursor < maxSequence) {
      const rows = await readBatch(cursor, pageSize)
      if (!Array.isArray(rows) || rows.length === 0) break

      let batchCursor = cursor
      for (const message of rows) {
        processedCount += 1
        const result = this.#insertExperience(message, null)
        if (result.created) {
          createdCount += 1
          if (tokenizeText) {
            const userText = cleanText(message.text)
            const terms = await tokenizeText(userText, {
              boost: 3,
              sourceKind: 'user_text',
              sourceRef: String(message.id ?? '').trim(),
            })
            await this.indexTerms(result.experienceId, Array.isArray(terms) ? terms : [], {
              sourceKind: 'user_text',
              sourceRef: String(message.id ?? '').trim(),
            })
          }
        } else {
          skippedCount += 1
        }

        const sequence = nonNegativeInteger(message?.archiveSequence)
        if (sequence !== null && sequence > batchCursor) batchCursor = sequence
      }

      if (batchCursor <= cursor) break
      cursor = batchCursor
      this.#writeCursor(cursor)
    }

    return {
      ok: true,
      processedCount,
      createdCount,
      skippedCount,
      cursorBefore,
      cursorAfter: this.#cursor(),
      modelCalls: 0,
      petMemoryWrites: 0,
      dreamRuns: 0,
    }
  }

  async syncMessage(message, { archiveSequence = null, tokenizeText = null } = {}) {
    await this.initialize()
    if (tokenizeText !== null && typeof tokenizeText !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_TOKENIZER_INVALID')
    const result = this.#insertExperience(message, archiveSequence)
    if (result.created && tokenizeText) {
      const userText = cleanText(message.text)
      const terms = await tokenizeText(userText, {
        boost: 3,
        sourceKind: 'user_text',
        sourceRef: String(message.id ?? '').trim(),
      })
      await this.indexTerms(result.experienceId, Array.isArray(terms) ? terms : [], {
        sourceKind: 'user_text',
        sourceRef: String(message.id ?? '').trim(),
      })
    }
    return { created: result.created, experienceId: result.experienceId }
  }

  async indexTerms(experienceId, terms, { sourceKind, sourceRef } = {}) {
    await this.initialize()
    if (!TERM_SOURCE_KINDS.has(sourceKind)) throw new TypeError('PET_VISUAL_EXPERIENCE_TERM_SOURCE_INVALID')
    const ref = String(sourceRef ?? '').trim()
    if (!ref) throw new TypeError('PET_VISUAL_EXPERIENCE_TERM_SOURCE_REF_INVALID')
    if (!Array.isArray(terms)) return 0

    const upsert = this.db.prepare(`
      INSERT INTO visual_terms(experience_id, source_kind, source_ref, term, weight)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(experience_id, source_kind, term) DO UPDATE SET
        source_ref = excluded.source_ref,
        weight = CASE WHEN excluded.weight > visual_terms.weight THEN excluded.weight ELSE visual_terms.weight END
    `)
    let count = 0
    for (const entry of terms) {
      const term = cleanTerm(entry?.term)
      const weight = positiveInteger(entry?.weight)
      if (!term || weight === null) continue
      upsert.run(String(experienceId), sourceKind, ref, term, weight)
      count += 1
    }
    return count
  }

  async recordEvent({ experienceId, turnId = null, kind, occurredAt = this.now(), focus = null, summary = null, relatedExperienceId = null, evidence = 'inferred', terms = [], eventId = null } = {}) {
    await this.initialize()
    if (!EVENT_KINDS.has(kind)) throw new TypeError('PET_VISUAL_EXPERIENCE_EVENT_KIND_INVALID')
    if (!EVIDENCE_KINDS.has(evidence)) throw new TypeError('PET_VISUAL_EXPERIENCE_EVIDENCE_INVALID')
    if (kind === 'observation' && evidence !== 'inferred') throw new TypeError('PET_VISUAL_EXPERIENCE_OBSERVATION_EVIDENCE_INVALID')
    const experienceKey = String(experienceId ?? '').trim()
    const experience = this.db.prepare('SELECT experience_id FROM visual_experiences WHERE experience_id = ?').get(experienceKey)
    if (!experience) throw new Error('PET_VISUAL_EXPERIENCE_NOT_FOUND')

    const cleanedSummary = summary === null || summary === undefined ? null : cleanText(summary)
    if (kind === 'observation' && !cleanedSummary) throw new TypeError('PET_VISUAL_EXPERIENCE_OBSERVATION_SUMMARY_REQUIRED')
    if (kind === 'comparison' && !String(relatedExperienceId ?? '').trim()) throw new TypeError('PET_VISUAL_EXPERIENCE_COMPARISON_TARGET_REQUIRED')

    const requestedEventId = eventId === null || eventId === undefined ? null : String(eventId).trim()
    if (eventId !== null && eventId !== undefined && !requestedEventId) throw new TypeError('PET_VISUAL_EXPERIENCE_EVENT_ID_INVALID')
    const persistedEventId = requestedEventId ?? this.#newId('event')
    const occurred = timestamp(occurredAt, this.now())
    this.db.exec('BEGIN')
    try {
      const insertResult = this.db.prepare(`
        INSERT OR IGNORE INTO visual_events(
          event_id, experience_id, turn_id, kind, occurred_at, focus, summary, related_experience_id, evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        persistedEventId,
        experienceKey,
        turnId === null || turnId === undefined ? null : String(turnId),
        kind,
        occurred,
        focus === null || focus === undefined ? null : cleanText(focus, 400),
        cleanedSummary,
        relatedExperienceId === null || relatedExperienceId === undefined ? null : String(relatedExperienceId),
        evidence,
      )
      if (insertResult.changes !== 1) {
        this.db.exec('COMMIT')
        return rowToEvent(this.db.prepare('SELECT * FROM visual_events WHERE event_id = ?').get(persistedEventId))
      }
      if (kind === 'inspection' || kind === 'revisit') {
        this.db.prepare(`
          UPDATE visual_experiences
          SET inspection_count = inspection_count + 1, last_inspected_at = ?
          WHERE experience_id = ?
        `).run(occurred, experienceKey)
      }
      if (Array.isArray(terms) && terms.length > 0) {
        await this.indexTerms(experienceKey, terms, { sourceKind: 'observation', sourceRef: persistedEventId })
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }

    return rowToEvent(this.db.prepare('SELECT * FROM visual_events WHERE event_id = ?').get(persistedEventId))
  }

  async getSyncState(key) {
    await this.initialize()
    const stateKey = String(key ?? '').trim()
    if (!stateKey) throw new TypeError('PET_VISUAL_EXPERIENCE_SYNC_STATE_KEY_INVALID')
    return this.db.prepare('SELECT value FROM visual_sync_state WHERE key = ?').get(stateKey)?.value ?? null
  }

  async setSyncState(key, value) {
    await this.initialize()
    const stateKey = String(key ?? '').trim()
    if (!stateKey) throw new TypeError('PET_VISUAL_EXPERIENCE_SYNC_STATE_KEY_INVALID')
    if (value === null || value === undefined) throw new TypeError('PET_VISUAL_EXPERIENCE_SYNC_STATE_VALUE_INVALID')
    this.db.prepare(`
      INSERT INTO visual_sync_state(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(stateKey, String(value))
  }

  async findExperienceById(experienceId) {
    await this.initialize()
    return rowToExperience(this.db.prepare('SELECT * FROM visual_experiences WHERE experience_id = ?').get(String(experienceId ?? '').trim()))
  }

  async findExperienceByMessageId(sourceMessageId) {
    await this.initialize()
    return rowToExperience(this.db.prepare('SELECT * FROM visual_experiences WHERE source_message_id = ?').get(String(sourceMessageId ?? '').trim()))
  }

  async findExperienceByAttachmentId(attachmentId) {
    await this.initialize()
    return rowToExperience(this.db.prepare('SELECT * FROM visual_experiences WHERE attachment_id = ? ORDER BY occurred_at DESC, experience_id ASC LIMIT 1').get(String(attachmentId ?? '').trim()))
  }

  async recentObservationsFor(experienceId, { limit = 3 } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 3, 100)
    if (count === 0) return []
    return this.db.prepare(`
      SELECT * FROM visual_events
      WHERE experience_id = ? AND kind IN ('observation', 'comparison')
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT ?
    `).all(String(experienceId ?? '').trim(), count).map(rowToEvent)
  }

  async listExperiences({ limit = 100, before = null } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 100, 500)
    if (count === 0) return []
    const beforeValue = before === null || before === undefined ? null : Number(before)
    if (beforeValue !== null && Number.isFinite(beforeValue)) {
      return this.db.prepare(`
        SELECT * FROM visual_experiences
        WHERE occurred_at < ?
        ORDER BY occurred_at DESC, experience_id ASC
        LIMIT ?
      `).all(beforeValue, count).map(rowToExperience)
    }
    return this.db.prepare(`
      SELECT * FROM visual_experiences
      ORDER BY occurred_at DESC, experience_id ASC
      LIMIT ?
    `).all(count).map(rowToExperience)
  }

  async countExperiences() {
    await this.initialize()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM visual_experiences').get().count)
  }

  async countRawRoots() {
    await this.initialize()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM visual_experiences').get().count)
  }

  async searchByTerms(queryTerms, { limit = 10, minScore = 1 } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 10, 100)
    if (count === 0 || !Array.isArray(queryTerms)) return []
    const terms = []
    const seen = new Set()
    for (const entry of queryTerms) {
      const term = cleanTerm(entry?.term)
      if (term && !seen.has(term)) {
        seen.add(term)
        terms.push(term)
      }
    }
    if (terms.length === 0) return []
    const threshold = Number.isFinite(Number(minScore)) ? Number(minScore) : 1
    const placeholders = terms.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT e.*, t.term, t.source_kind, t.weight
      FROM visual_experiences e
      JOIN visual_terms t ON t.experience_id = e.experience_id
      WHERE t.term IN (${placeholders})
    `).all(...terms)
    const grouped = new Map()
    for (const row of rows) {
      let entry = grouped.get(row.experience_id)
      if (!entry) {
        entry = { row, matches: new Map() }
        grouped.set(row.experience_id, entry)
      }
      const existing = entry.matches.get(row.term)
      if (!existing || row.weight > existing.weight) {
        entry.matches.set(row.term, { term: row.term, weight: row.weight, sourceKind: row.source_kind })
      }
    }
    return [...grouped.values()]
      .map(({ row, matches }) => {
        const matchedTerms = terms.filter((term) => matches.has(term)).map((term) => matches.get(term))
        const score = matchedTerms.reduce((total, match) => total + match.weight, 0)
        return {
          experienceId: row.experience_id,
          attachmentId: row.attachment_id,
          sourceMessageId: row.source_message_id,
          userText: row.user_text,
          occurredAt: row.occurred_at,
          score,
          matchedTerms,
        }
      })
      .filter((entry) => entry.score >= threshold)
      .sort((left, right) => right.score - left.score || right.occurredAt - left.occurredAt || left.experienceId.localeCompare(right.experienceId))
      .slice(0, count)
  }

  close() {
    this.db?.close()
    this.db = null
    this.initialized = false
  }
}
