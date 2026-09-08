import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  GENERIC_RECALL_TERMS,
  ownerExactPhrases,
  ownerExactPhraseMatches,
} from './visual-keywords.js'
import {
  ASPECT_RATIO_DELTA_MAX,
  DHASH_DISTANCE_MAX,
  PHASH_DISTANCE_MAX,
  aspectRatio,
  fingerprintImage,
  isStrictNearDuplicate,
  parseImageDataUrl,
} from './visual-fingerprint.js'

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
    inspectionCount: Number(row.inspection_count ?? 0),
    occurrenceCount: Number(row.occurrence_count ?? 0),
    lastOccurredAt: row.last_occurred_at ?? row.occurred_at,
  }
}

function rowToOccurrence(row) {
  if (!row) return null
  return {
    occurrenceId: row.occurrence_id,
    experienceId: row.experience_id,
    sourceMessageId: row.source_message_id,
    attachmentId: row.attachment_id,
    occurredAt: row.occurred_at,
    userText: row.user_text,
    sha256: row.sha256 ?? null,
    phash: row.phash ?? null,
    dhash: row.dhash ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    duplicateKind: row.duplicate_kind ?? null,
    createdAt: row.created_at,
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

function boundedOffset(value, maximum = 10_000) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(maximum, Math.floor(number)))
}

function normalizeAttachmentRead(value) {
  if (Buffer.isBuffer(value)) return { bytes: value, mimeType: null, attachment: null }
  if (value instanceof Uint8Array) return { bytes: Buffer.from(value), mimeType: null, attachment: null }
  if (!value || typeof value !== 'object') return null
  if (Buffer.isBuffer(value.bytes) || value.bytes instanceof Uint8Array) {
    return {
      bytes: Buffer.from(value.bytes),
      mimeType: value.mimeType ?? null,
      attachment: value.attachment ?? null,
    }
  }
  const parsed = parseImageDataUrl(value.dataUrl)
  return parsed
    ? { ...parsed, attachment: value.attachment ?? null }
    : null
}

function termWidth(term) {
  return [...String(term ?? '')].length
}

function scoreCandidate(row, matches, queryWeights, queryText) {
  const scoreBreakdown = {
    owner_text_exact: 0,
    owner_text_ngram: 0,
    owner_text_single_char: 0,
    observation_ngram: 0,
    observation_single_char: 0,
    generic_terms: 0,
  }
  const matchedTerms = []
  const contributionBuckets = new Map([
    ['owner_text_ngram', []],
    ['owner_text_single_char', []],
    ['observation_ngram', []],
    ['observation_single_char', []],
  ])

  const semanticMatches = new Map()
  for (const match of matches) {
    const existing = semanticMatches.get(match.term)
    const sameSourceStronger = existing && match.sourceKind === existing.sourceKind && match.weight > existing.weight
    if (!existing || (match.sourceKind === 'user_text' && existing.sourceKind !== 'user_text') || sameSourceStronger) {
      semanticMatches.set(match.term, match)
    }
  }
  for (const match of semanticMatches.values()) {
    const queryWeight = queryWeights.get(match.term) ?? 0
    const storedWeight = Number(match.weight)
    const overlap = Math.min(queryWeight, Number.isFinite(storedWeight) ? storedWeight : 0)
    const generic = GENERIC_RECALL_TERMS.has(match.term)
    const owner = match.sourceKind === 'user_text'
    const single = termWidth(match.term) === 1
    let bucket = null
    let contribution = 0
    if (!generic && overlap > 0) {
      if (owner && single) {
        bucket = 'owner_text_single_char'
        contribution = overlap * 0.25
      } else if (owner) {
        bucket = 'owner_text_ngram'
        contribution = overlap * 3
      } else if (single) {
        bucket = 'observation_single_char'
        contribution = overlap
      } else {
        bucket = 'observation_ngram'
        contribution = overlap
      }
    }
    const result = {
      term: match.term,
      weight: match.weight,
      sourceKind: match.sourceKind,
      sourceRef: match.sourceRef,
      queryWeight,
      contribution,
    }
    matchedTerms.push(result)
    if (bucket) contributionBuckets.get(bucket).push(result)
  }

  const caps = {
    owner_text_ngram: 60,
    owner_text_single_char: 3,
    observation_ngram: 12,
    observation_single_char: 2,
  }
  for (const [bucket, entries] of contributionBuckets) {
    let remaining = caps[bucket]
    for (const entry of entries.sort((left, right) => right.contribution - left.contribution || left.term.localeCompare(right.term))) {
      const contribution = Math.min(entry.contribution, Math.max(0, remaining))
      entry.contribution = contribution
      scoreBreakdown[bucket] += contribution
      remaining -= contribution
    }
  }

  const ownerTexts = Array.isArray(row.ownerTexts) && row.ownerTexts.length > 0
    ? row.ownerTexts
    : [{ text: row.user_text, sourceRef: row.source_message_id }]
  const exactMatches = new Set()
  for (const ownerText of ownerTexts) {
    for (const phrase of ownerExactPhraseMatches(queryText, ownerText.text)) {
      const key = `${ownerText.sourceRef}:${phrase}`
      if (exactMatches.has(key)) continue
      exactMatches.add(key)
      const contribution = 50
      scoreBreakdown.owner_text_exact += contribution
      matchedTerms.push({
        term: phrase,
        weight: contribution,
        sourceKind: 'user_text',
        sourceRef: ownerText.sourceRef,
        queryWeight: contribution,
        contribution,
        matchKind: 'exact_phrase',
      })
    }
  }

  const score = Object.values(scoreBreakdown).reduce((total, value) => total + value, 0)
  return { score, matchedTerms, scoreBreakdown }
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
          CREATE TABLE IF NOT EXISTS visual_occurrences (
            occurrence_id TEXT PRIMARY KEY,
            experience_id TEXT NOT NULL,
            source_message_id TEXT NOT NULL UNIQUE,
            attachment_id TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            user_text TEXT NOT NULL,
            sha256 TEXT,
            phash TEXT,
            dhash TEXT,
            width INTEGER,
            height INTEGER,
            duplicate_kind TEXT NOT NULL DEFAULT 'NEW',
            created_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS visual_experience_aliases (
            alias_experience_id TEXT PRIMARY KEY,
            canonical_experience_id TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL
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
          CREATE INDEX IF NOT EXISTS visual_occurrences_experience_id_idx ON visual_occurrences(experience_id);
          CREATE INDEX IF NOT EXISTS visual_occurrences_attachment_id_idx ON visual_occurrences(attachment_id);
          CREATE INDEX IF NOT EXISTS visual_occurrences_sha256_idx ON visual_occurrences(sha256);
          CREATE INDEX IF NOT EXISTS visual_occurrences_phash_idx ON visual_occurrences(phash);
          CREATE INDEX IF NOT EXISTS visual_occurrences_dhash_idx ON visual_occurrences(dhash);
          CREATE INDEX IF NOT EXISTS visual_experience_aliases_canonical_idx ON visual_experience_aliases(canonical_experience_id);
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

  #canonicalId(experienceId) {
    const key = String(experienceId ?? '').trim()
    if (!key) return null
    return this.db.prepare('SELECT canonical_experience_id FROM visual_experience_aliases WHERE alias_experience_id = ?').get(key)?.canonical_experience_id ?? key
  }

  #experienceIds(canonicalExperienceId) {
    const canonical = this.#canonicalId(canonicalExperienceId)
    if (!canonical) return []
    return [canonical, ...this.db.prepare('SELECT alias_experience_id FROM visual_experience_aliases WHERE canonical_experience_id = ? ORDER BY alias_experience_id ASC').all(canonical).map((row) => row.alias_experience_id)]
  }

  #experienceRow(canonicalExperienceId) {
    const canonical = this.#canonicalId(canonicalExperienceId)
    if (!canonical) return null
    return this.db.prepare('SELECT * FROM visual_experiences WHERE experience_id = ?').get(canonical) ?? null
  }

  #experienceWithSummary(canonicalExperienceId) {
    const canonical = this.#canonicalId(canonicalExperienceId)
    const row = this.#experienceRow(canonical)
    if (!row) return null
    const ids = this.#experienceIds(canonical)
    const placeholders = ids.map(() => '?').join(', ')
    const summary = this.db.prepare(`
      SELECT COUNT(*) AS occurrence_count, MAX(occurred_at) AS last_occurred_at
      FROM visual_occurrences
      WHERE experience_id IN (${placeholders})
    `).get(...ids)
    return rowToExperience({
      ...row,
      occurrence_count: Number(summary?.occurrence_count ?? 0),
      last_occurred_at: summary?.last_occurred_at ?? row.occurred_at,
    })
  }

  async #fingerprintMessage(message, readAttachment) {
    const attachment = message?.attachment
    const width = positiveInteger(attachment?.width)
    const height = positiveInteger(attachment?.height)
    if (typeof readAttachment !== 'function') {
      return { sha256: null, phash: null, dhash: null, width, height, decoded: false }
    }
    let loaded
    try {
      loaded = normalizeAttachmentRead(await readAttachment(String(attachment?.id ?? '').trim(), message))
    } catch {
      loaded = null
    }
    if (!loaded) return { sha256: null, phash: null, dhash: null, width, height, decoded: false }
    const loadedAttachment = loaded.attachment ?? {}
    return fingerprintImage({
      bytes: loaded.bytes,
      width: width ?? positiveInteger(loadedAttachment.width),
      height: height ?? positiveInteger(loadedAttachment.height),
    })
  }

  #findDuplicateCandidate(fingerprint, { excludeExperienceId = null } = {}) {
    if (!fingerprint) return null
    const excluded = excludeExperienceId ? this.#canonicalId(excludeExperienceId) : null
    if (fingerprint.sha256) {
      const rows = this.db.prepare(`
        SELECT o.*, e.occurred_at AS root_occurred_at
        FROM visual_occurrences o
        JOIN visual_experiences e ON e.experience_id = o.experience_id
        WHERE o.sha256 = ?
        ORDER BY e.occurred_at ASC, e.experience_id ASC, o.occurred_at ASC, o.occurrence_id ASC
      `).all(fingerprint.sha256)
      for (const row of rows) {
        const canonical = this.#canonicalId(row.experience_id)
        if (canonical && canonical !== excluded) return { experienceId: canonical, duplicateKind: 'EXACT', phashDistance: 0, dhashDistance: 0, aspectRatioDelta: 0, occurrence: rowToOccurrence(row) }
      }
    }

    if (!fingerprint.phash || !fingerprint.dhash || aspectRatio(fingerprint.width, fingerprint.height) === null) return null
    const rows = this.db.prepare(`
      SELECT o.*, e.occurred_at AS root_occurred_at
      FROM visual_occurrences o
      JOIN visual_experiences e ON e.experience_id = o.experience_id
      WHERE o.phash IS NOT NULL AND o.dhash IS NOT NULL
      ORDER BY e.occurred_at ASC, e.experience_id ASC, o.occurred_at ASC, o.occurrence_id ASC
    `).all()
    for (const row of rows) {
      const canonical = this.#canonicalId(row.experience_id)
      if (!canonical || canonical === excluded) continue
      const comparison = isStrictNearDuplicate(fingerprint, row, {
        phashDistanceMax: PHASH_DISTANCE_MAX,
        dhashDistanceMax: DHASH_DISTANCE_MAX,
        aspectRatioDeltaMax: ASPECT_RATIO_DELTA_MAX,
      })
      if (comparison.match) return {
        experienceId: canonical,
        duplicateKind: 'PERCEPTUAL',
        phashDistance: comparison.phashDistance,
        dhashDistance: comparison.dhashDistance,
        aspectRatioDelta: comparison.aspectRatioDelta,
        occurrence: rowToOccurrence(row),
      }
    }
    return null
  }

  #insertExperience(message) {
    const sourceMessageId = String(message?.id ?? '').trim()
    const attachmentId = String(message?.attachment?.id ?? '').trim()
    if (message?.role !== 'user' || !sourceMessageId || !attachmentId) return { created: false, experienceId: null }
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
    return { created: inserted?.experience_id === experienceId, experienceId: inserted?.experience_id ?? null }
  }

  #insertOccurrence(message, experienceId, fingerprint, duplicateKind) {
    const occurrenceId = this.#newId('occurrence')
    const sourceMessageId = String(message.id ?? '').trim()
    const attachmentId = String(message.attachment?.id ?? '').trim()
    const occurredAt = timestamp(message.timestamp, this.now())
    this.db.prepare(`
      INSERT OR IGNORE INTO visual_occurrences(
        occurrence_id, experience_id, source_message_id, attachment_id, occurred_at, user_text,
        sha256, phash, dhash, width, height, duplicate_kind, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      occurrenceId,
      experienceId,
      sourceMessageId,
      attachmentId,
      occurredAt,
      cleanText(message.text),
      fingerprint?.sha256 ?? null,
      fingerprint?.phash ?? null,
      fingerprint?.dhash ?? null,
      fingerprint?.width ?? positiveInteger(message.attachment?.width),
      fingerprint?.height ?? positiveInteger(message.attachment?.height),
      duplicateKind,
      timestamp(this.now(), Date.now()),
    )
    const inserted = this.db.prepare('SELECT * FROM visual_occurrences WHERE source_message_id = ?').get(sourceMessageId)
    return {
      created: inserted?.occurrence_id === occurrenceId,
      occurrence: rowToOccurrence(inserted),
    }
  }

  #insertAlias(aliasExperienceId, canonicalExperienceId, reason) {
    const alias = String(aliasExperienceId ?? '').trim()
    const canonical = this.#canonicalId(canonicalExperienceId)
    if (!alias || !canonical || alias === canonical) return false
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO visual_experience_aliases(
        alias_experience_id, canonical_experience_id, reason, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(alias, canonical, String(reason ?? 'PERCEPTUAL'), timestamp(this.now(), Date.now()))
    return result.changes === 1
  }

  async #syncMessage(message, { archiveSequence = null, tokenizeText = null, readAttachment = null } = {}) {
    if (message?.role !== 'user' || !message?.attachment?.id) {
      return { created: false, createdExperience: false, createdOccurrence: false, experienceId: null, duplicateKind: null }
    }
    const sourceMessageId = String(message.id ?? '').trim()
    if (!sourceMessageId) return { created: false, createdExperience: false, createdOccurrence: false, experienceId: null, duplicateKind: null }

    const existingOccurrence = this.db.prepare('SELECT * FROM visual_occurrences WHERE source_message_id = ?').get(sourceMessageId)
    if (existingOccurrence) {
      return {
        created: false,
        createdExperience: false,
        createdOccurrence: false,
        experienceId: this.#canonicalId(existingOccurrence.experience_id),
        duplicateKind: 'SOURCE_MESSAGE',
        occurrenceId: existingOccurrence.occurrence_id,
      }
    }

    const fingerprint = await this.#fingerprintMessage(message, readAttachment)
    const oldRoot = this.db.prepare('SELECT experience_id FROM visual_experiences WHERE source_message_id = ?').get(sourceMessageId)
    let match = oldRoot
      ? { experienceId: this.#canonicalId(oldRoot.experience_id), duplicateKind: 'EXISTING_ROOT' }
      : this.#findDuplicateCandidate(fingerprint)
    if (!match && !fingerprint.sha256 && !fingerprint.phash && !fingerprint.dhash) {
      const sameAttachment = this.db.prepare('SELECT experience_id FROM visual_occurrences WHERE attachment_id = ? ORDER BY occurred_at ASC, occurrence_id ASC LIMIT 1').get(String(message.attachment.id).trim())
      if (sameAttachment) match = { experienceId: this.#canonicalId(sameAttachment.experience_id), duplicateKind: 'EXACT' }
    }

    let createdExperience = false
    if (!match) {
      const inserted = this.#insertExperience(message)
      if (!inserted.experienceId) return { created: false, createdExperience: false, createdOccurrence: false, experienceId: null, duplicateKind: null }
      match = { experienceId: inserted.experienceId, duplicateKind: 'NEW' }
      createdExperience = inserted.created
    }

    const insertedOccurrence = this.#insertOccurrence(message, match.experienceId, fingerprint, match.duplicateKind)
    if (insertedOccurrence.created && tokenizeText) {
      const userText = cleanText(message.text)
      const terms = await tokenizeText(userText, {
        boost: 3,
        sourceKind: 'user_text',
        sourceRef: sourceMessageId,
      })
      await this.indexTerms(match.experienceId, Array.isArray(terms) ? terms : [], {
        sourceKind: 'user_text',
        sourceRef: sourceMessageId,
      })
    }
    if (archiveSequence !== null) {
      const sequence = nonNegativeInteger(archiveSequence)
      if (sequence !== null && sequence > this.#cursor()) this.#writeCursor(sequence)
    }
    return {
      created: createdExperience,
      createdExperience,
      createdOccurrence: insertedOccurrence.created,
      experienceId: match.experienceId,
      duplicateKind: match.duplicateKind,
      occurrenceId: insertedOccurrence.occurrence?.occurrenceId ?? null,
      fingerprint,
    }
  }

  async syncFromArchive({ readBatch, readMaxSequence, tokenizeText = null, readAttachment = null }, { batchSize = 200 } = {}) {
    await this.initialize()
    if (typeof readBatch !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_READ_BATCH_INVALID')
    if (typeof readMaxSequence !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_READ_MAX_SEQUENCE_INVALID')
    if (tokenizeText !== null && typeof tokenizeText !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_TOKENIZER_INVALID')
    if (readAttachment !== null && typeof readAttachment !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_ATTACHMENT_READER_INVALID')

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
        const result = await this.#syncMessage(message, { tokenizeText, readAttachment })
        if (result.createdExperience) createdCount += 1
        if (!result.createdOccurrence) skippedCount += 1

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

  async syncMessage(message, { archiveSequence = null, tokenizeText = null, readAttachment = null } = {}) {
    await this.initialize()
    if (tokenizeText !== null && typeof tokenizeText !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_TOKENIZER_INVALID')
    if (readAttachment !== null && typeof readAttachment !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_ATTACHMENT_READER_INVALID')
    return this.#syncMessage(message, { archiveSequence, tokenizeText, readAttachment })
  }

  /**
   * Add an occurrence for every pre-dedup root, then add non-destructive alias
   * edges for exact/strict perceptual duplicates. The caller owns the copy or
   * production-review boundary; this method never deletes roots or assets.
   */
  async migrateHistorical({ readAttachment, tokenizeText = null } = {}) {
    await this.initialize()
    if (typeof readAttachment !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_ATTACHMENT_READER_INVALID')
    if (tokenizeText !== null && typeof tokenizeText !== 'function') throw new TypeError('PET_VISUAL_EXPERIENCE_TOKENIZER_INVALID')

    const rootsBefore = Number(this.db.prepare('SELECT COUNT(*) AS count FROM visual_experiences').get().count)
    const roots = this.db.prepare('SELECT * FROM visual_experiences ORDER BY occurred_at ASC, experience_id ASC').all()
    let occurrencesCreated = 0
    let aliasesCreated = 0
    let fingerprintFailures = 0
    const duplicateGroups = new Map()

    for (const root of roots) {
      const existingOccurrence = this.db.prepare('SELECT * FROM visual_occurrences WHERE source_message_id = ?').get(root.source_message_id)
      if (existingOccurrence) continue
      const message = {
        id: root.source_message_id,
        role: 'user',
        text: root.user_text,
        timestamp: root.occurred_at,
        attachment: {
          id: root.attachment_id,
          width: root.width ?? null,
          height: root.height ?? null,
        },
      }
      const fingerprint = await this.#fingerprintMessage(message, readAttachment)
      if (!fingerprint.sha256) fingerprintFailures += 1
      const occurrence = this.#insertOccurrence(message, root.experience_id, fingerprint, 'MIGRATION_INITIAL')
      if (occurrence.created) occurrencesCreated += 1
      if (occurrence.created && tokenizeText) {
        const terms = await tokenizeText(root.user_text, { boost: 3, sourceKind: 'user_text', sourceRef: root.source_message_id })
        await this.indexTerms(root.experience_id, Array.isArray(terms) ? terms : [], {
          sourceKind: 'user_text',
          sourceRef: root.source_message_id,
        })
      }

      const match = this.#findDuplicateCandidate(fingerprint, { excludeExperienceId: root.experience_id })
      if (!match) continue
      if (this.#insertAlias(root.experience_id, match.experienceId, match.duplicateKind)) aliasesCreated += 1
      const canonical = this.#canonicalId(root.experience_id)
      if (!duplicateGroups.has(canonical)) duplicateGroups.set(canonical, [])
      duplicateGroups.get(canonical).push({
        aliasExperienceId: root.experience_id,
        reason: match.duplicateKind,
        hashDistances: {
          phash: match.phashDistance,
          dhash: match.dhashDistance,
          aspectRatio: match.aspectRatioDelta,
        },
      })
    }

    const groups = new Map()
    const aliases = this.db.prepare('SELECT * FROM visual_experience_aliases ORDER BY canonical_experience_id ASC, alias_experience_id ASC').all()
    for (const alias of aliases) {
      if (!groups.has(alias.canonical_experience_id)) groups.set(alias.canonical_experience_id, [])
      groups.get(alias.canonical_experience_id).push({
        aliasExperienceId: alias.alias_experience_id,
        reason: alias.reason,
        hashDistances: duplicateGroups.get(alias.canonical_experience_id)?.find((item) => item.aliasExperienceId === alias.alias_experience_id)?.hashDistances ?? null,
      })
    }
    return {
      ok: true,
      rootsBefore,
      duplicateGroups: [...groups.entries()].map(([canonicalId, members]) => ({
        canonicalId,
        aliases: members,
      })),
      rootsAfterCanonicalView: await this.countExperiences(),
      aliasesCreated,
      occurrencesCreated,
      newRoot: 0,
      fingerprintFailures,
      modelCalls: 0,
      petMemoryWrites: 0,
      dreamRuns: 0,
    }
  }

  async indexTerms(experienceId, terms, { sourceKind, sourceRef } = {}) {
    await this.initialize()
    if (!TERM_SOURCE_KINDS.has(sourceKind)) throw new TypeError('PET_VISUAL_EXPERIENCE_TERM_SOURCE_INVALID')
    const ref = String(sourceRef ?? '').trim()
    if (!ref) throw new TypeError('PET_VISUAL_EXPERIENCE_TERM_SOURCE_REF_INVALID')
    if (!Array.isArray(terms)) return 0
    const canonicalExperienceId = this.#canonicalId(experienceId)
    if (!canonicalExperienceId) return 0

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
      upsert.run(canonicalExperienceId, sourceKind, ref, term, weight)
      count += 1
    }
    return count
  }

  async recordEvent({ experienceId, turnId = null, kind, occurredAt = this.now(), focus = null, summary = null, relatedExperienceId = null, evidence = 'inferred', terms = [], eventId = null } = {}) {
    await this.initialize()
    if (!EVENT_KINDS.has(kind)) throw new TypeError('PET_VISUAL_EXPERIENCE_EVENT_KIND_INVALID')
    if (!EVIDENCE_KINDS.has(evidence)) throw new TypeError('PET_VISUAL_EXPERIENCE_EVIDENCE_INVALID')
    if (kind === 'observation' && evidence !== 'inferred') throw new TypeError('PET_VISUAL_EXPERIENCE_OBSERVATION_EVIDENCE_INVALID')
    const experienceKey = this.#canonicalId(experienceId)
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
        relatedExperienceId === null || relatedExperienceId === undefined ? null : this.#canonicalId(relatedExperienceId),
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

  async resolveExperienceId(experienceId) {
    await this.initialize()
    return this.#canonicalId(experienceId)
  }

  async findExperienceById(experienceId) {
    await this.initialize()
    return this.#experienceWithSummary(experienceId)
  }

  async findExperienceByMessageId(sourceMessageId) {
    await this.initialize()
    const key = String(sourceMessageId ?? '').trim()
    const root = this.db.prepare('SELECT experience_id FROM visual_experiences WHERE source_message_id = ?').get(key)
    const occurrence = root ?? this.db.prepare('SELECT experience_id FROM visual_occurrences WHERE source_message_id = ?').get(key)
    return occurrence ? this.#experienceWithSummary(occurrence.experience_id) : null
  }

  async findExperienceByAttachmentId(attachmentId) {
    await this.initialize()
    const key = String(attachmentId ?? '').trim()
    const occurrence = this.db.prepare('SELECT experience_id FROM visual_occurrences WHERE attachment_id = ? ORDER BY occurred_at DESC, occurrence_id ASC LIMIT 1').get(key)
    const root = occurrence ?? this.db.prepare('SELECT experience_id FROM visual_experiences WHERE attachment_id = ? ORDER BY occurred_at DESC, experience_id ASC LIMIT 1').get(key)
    return root ? this.#experienceWithSummary(root.experience_id) : null
  }

  async findOccurrenceByAttachmentId(attachmentId) {
    await this.initialize()
    const row = this.db.prepare('SELECT * FROM visual_occurrences WHERE attachment_id = ? ORDER BY occurred_at DESC, occurrence_id ASC LIMIT 1').get(String(attachmentId ?? '').trim())
    if (!row) return null
    return { ...rowToOccurrence(row), experienceId: this.#canonicalId(row.experience_id) }
  }

  async occurrenceFor(experienceId, { limit = 100 } = {}) {
    await this.initialize()
    const ids = this.#experienceIds(experienceId)
    if (ids.length === 0) return []
    const count = boundedLimit(limit, 100, 500)
    if (count === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    return this.db.prepare(`
      SELECT * FROM visual_occurrences
      WHERE experience_id IN (${placeholders})
      ORDER BY occurred_at ASC, occurrence_id ASC
      LIMIT ?
    `).all(...ids, count).map((row) => ({ ...rowToOccurrence(row), experienceId: this.#canonicalId(row.experience_id) }))
  }

  async reopenAttachmentIdsFor(experienceId) {
    const occurrences = await this.occurrenceFor(experienceId, { limit: 500 })
    const ids = occurrences.sort((left, right) => right.occurredAt - left.occurredAt || left.occurrenceId.localeCompare(right.occurrenceId)).map((item) => item.attachmentId)
    const experience = await this.findExperienceById(experienceId)
    return [...new Set([...ids, experience?.attachmentId].filter(Boolean))]
  }

  async recentObservationsFor(experienceId, { limit = 3 } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 3, 100)
    if (count === 0) return []
    const ids = this.#experienceIds(experienceId)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    return this.db.prepare(`
      SELECT * FROM visual_events
      WHERE experience_id IN (${placeholders}) AND kind IN ('observation', 'comparison')
      ORDER BY occurred_at DESC, event_id DESC
      LIMIT ?
    `).all(...ids, count).map((row) => ({
      ...rowToEvent(row),
      experienceId: this.#canonicalId(row.experience_id),
      relatedExperienceId: row.related_experience_id ? this.#canonicalId(row.related_experience_id) : null,
    }))
  }

  async eventsFor(experienceId, { limit = 80 } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 80, 100)
    if (count === 0) return []
    const ids = this.#experienceIds(experienceId)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    return this.db.prepare(`
      SELECT * FROM visual_events
      WHERE experience_id IN (${placeholders})
      ORDER BY occurred_at ASC, event_id ASC
      LIMIT ?
    `).all(...ids, count).map((row) => ({
      ...rowToEvent(row),
      experienceId: this.#canonicalId(row.experience_id),
      relatedExperienceId: row.related_experience_id ? this.#canonicalId(row.related_experience_id) : null,
    }))
  }

  async termsFor(experienceId, { limit = 100 } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 100, 200)
    if (count === 0) return []
    const ids = this.#experienceIds(experienceId)
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      SELECT source_kind, source_ref, term, weight
      FROM visual_terms
      WHERE experience_id IN (${placeholders})
      ORDER BY weight DESC, term ASC
    `).all(...ids)
    const unique = new Map()
    for (const row of rows) {
      const key = `${row.source_kind}:${row.term}`
      const existing = unique.get(key)
      if (!existing || Number(row.weight) > existing.weight) {
        unique.set(key, {
          sourceKind: row.source_kind,
          sourceRef: row.source_ref,
          term: row.term,
          weight: Number(row.weight),
        })
      }
    }
    return [...unique.values()]
      .sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term))
      .slice(0, count)
  }

  async eventFlagsFor(experienceIds = []) {
    await this.initialize()
    const ids = [...new Set((Array.isArray(experienceIds) ? experienceIds : [])
      .map((value) => String(value ?? '').trim())
      .filter(Boolean))]
    if (ids.length === 0) return new Map()
    const canonicalIds = new Set(ids.map((id) => this.#canonicalId(id)).filter(Boolean))
    const rows = this.db.prepare('SELECT experience_id, kind FROM visual_events GROUP BY experience_id, kind').all()
    const flags = new Map()
    for (const row of rows) {
      const canonical = this.#canonicalId(row.experience_id)
      if (!canonicalIds.has(canonical)) continue
      if (!flags.has(canonical)) flags.set(canonical, new Set())
      flags.get(canonical).add(row.kind)
    }
    return flags
  }

  async listExperiences({ limit = 100, before = null, offset = 0 } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 100, 500)
    if (count === 0) return []
    const beforeValue = before === null || before === undefined ? null : Number(before)
    const pageOffset = boundedOffset(offset)
    const rows = this.db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM visual_occurrences o
          WHERE o.experience_id = e.experience_id
             OR o.experience_id IN (SELECT alias_experience_id FROM visual_experience_aliases WHERE canonical_experience_id = e.experience_id)
        ) AS occurrence_count,
        COALESCE((SELECT MAX(o.occurred_at) FROM visual_occurrences o
          WHERE o.experience_id = e.experience_id
             OR o.experience_id IN (SELECT alias_experience_id FROM visual_experience_aliases WHERE canonical_experience_id = e.experience_id)
        ), e.occurred_at) AS last_occurred_at
      FROM visual_experiences e
      WHERE NOT EXISTS (
        SELECT 1 FROM visual_experience_aliases a WHERE a.alias_experience_id = e.experience_id
      )
      ${beforeValue !== null && Number.isFinite(beforeValue) ? 'AND COALESCE((SELECT MAX(o.occurred_at) FROM visual_occurrences o WHERE o.experience_id = e.experience_id OR o.experience_id IN (SELECT alias_experience_id FROM visual_experience_aliases WHERE canonical_experience_id = e.experience_id)), e.occurred_at) < ?' : ''}
      ORDER BY last_occurred_at DESC, e.experience_id ASC
      LIMIT ? OFFSET ?
    `).all(...(beforeValue !== null && Number.isFinite(beforeValue) ? [beforeValue] : []), count, pageOffset)
    return rows.map(rowToExperience)
  }

  async countExperiences() {
    await this.initialize()
    return Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM visual_experiences e
      WHERE NOT EXISTS (SELECT 1 FROM visual_experience_aliases a WHERE a.alias_experience_id = e.experience_id)
    `).get().count)
  }

  async countRawRoots() {
    await this.initialize()
    return Number(this.db.prepare('SELECT COUNT(*) AS count FROM visual_experiences').get().count)
  }

  async searchByTerms(queryTerms, { limit = 10, minScore = 1, queryText = null } = {}) {
    await this.initialize()
    const count = boundedLimit(limit, 10, 100)
    if (count === 0 || !Array.isArray(queryTerms)) return []
    const terms = []
    const queryWeights = new Map()
    for (const entry of queryTerms) {
      const term = cleanTerm(entry?.term)
      const weight = Number(entry?.weight)
      if (term && !queryWeights.has(term)) {
        terms.push(term)
        queryWeights.set(term, Number.isFinite(weight) && weight > 0 ? weight : 1)
      } else if (term && Number.isFinite(weight) && weight > (queryWeights.get(term) ?? 0)) {
        queryWeights.set(term, weight)
      }
    }
    const exactPhrases = ownerExactPhrases(queryText)
    if (terms.length === 0 && exactPhrases.length === 0) return []
    const threshold = Number.isFinite(Number(minScore)) ? Number(minScore) : 1
    const grouped = new Map()
    const entryFor = (experienceId) => {
      const canonical = this.#canonicalId(experienceId)
      if (!canonical) return null
      let entry = grouped.get(canonical)
      if (!entry) {
        const root = this.#experienceRow(canonical)
        if (!root) return null
        entry = { row: { ...root, ownerTexts: [] }, matches: new Map() }
        grouped.set(canonical, entry)
      }
      return entry
    }
    const addTermRow = (row) => {
      const entry = entryFor(row.experience_id)
      if (!entry) return
      if (!row.term) return
      const key = `${row.source_kind}:${row.term}`
      const existing = entry.matches.get(key)
      if (!existing || row.weight > existing.weight) {
        entry.matches.set(key, {
          term: row.term,
          weight: row.weight,
          sourceKind: row.source_kind,
          sourceRef: row.source_ref,
        })
      }
    }
    const addOwnerText = (row) => {
      const entry = entryFor(row.experience_id)
      if (!entry || typeof row.user_text !== 'string') return
      const sourceRef = String(row.source_message_id ?? '').trim()
      if (!sourceRef || entry.row.ownerTexts.some((item) => item.sourceRef === sourceRef)) return
      entry.row.ownerTexts.push({ text: row.user_text, sourceRef })
    }
    if (terms.length > 0) {
      const placeholders = terms.map(() => '?').join(', ')
      const rows = this.db.prepare(`
        SELECT t.experience_id, t.term, t.source_kind, t.source_ref, t.weight
        FROM visual_terms t
        WHERE t.term IN (${placeholders})
      `).all(...terms)
      for (const row of rows) addTermRow(row)
    }
    if (exactPhrases.length > 0) {
      const rootQuery = this.db.prepare("SELECT * FROM visual_experiences WHERE user_text LIKE '%' || ? || '%'")
      const occurrenceQuery = this.db.prepare("SELECT * FROM visual_occurrences WHERE user_text LIKE '%' || ? || '%'")
      for (const phrase of exactPhrases) {
        for (const row of rootQuery.all(phrase)) addOwnerText({ ...row, source_message_id: row.source_message_id })
        for (const row of occurrenceQuery.all(phrase)) addOwnerText(row)
      }
    }
    for (const entry of grouped.values()) {
      const ids = this.#experienceIds(entry.row.experience_id)
      const placeholders = ids.map(() => '?').join(', ')
      const root = entry.row
      const occurrences = this.db.prepare(`
        SELECT source_message_id, attachment_id, user_text, occurred_at
        FROM visual_occurrences
        WHERE experience_id IN (${placeholders})
        ORDER BY occurred_at ASC, occurrence_id ASC
      `).all(...ids)
      const ownerTexts = [{ text: root.user_text, sourceRef: root.source_message_id }, ...occurrences.map((item) => ({ text: item.user_text, sourceRef: item.source_message_id }))]
      entry.row.ownerTexts = [...new Map(ownerTexts.map((item) => [item.sourceRef, item])).values()]
      entry.row.user_texts = entry.row.ownerTexts.map((item) => item.text)
      entry.row.attachment_ids = [...new Set(occurrences
        .slice()
        .sort((left, right) => right.occurred_at - left.occurred_at || left.source_message_id.localeCompare(right.source_message_id))
        .map((item) => item.attachment_id)
        .concat(root.attachment_id))]
      entry.row.last_occurred_at = occurrences.at(-1)?.occurred_at ?? root.occurred_at
    }
    return [...grouped.values()]
      .map(({ row, matches }) => {
        const scored = scoreCandidate(row, [...matches.values()], queryWeights, queryText)
        return {
          experienceId: row.experience_id,
          attachmentId: row.attachment_ids?.[0] ?? row.attachment_id,
          attachmentIds: row.attachment_ids ?? [row.attachment_id],
          sourceMessageId: row.source_message_id,
          userText: row.user_text,
          userTexts: row.user_texts ?? [row.user_text],
          occurredAt: row.occurred_at,
          lastOccurredAt: row.last_occurred_at ?? row.occurred_at,
          ...scored,
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
