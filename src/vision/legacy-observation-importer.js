import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'

export const LEGACY_OBSERVATION_ACTIVITY_TYPES = Object.freeze(['visual_observation', 'visual_compare'])
export const LEGACY_OBSERVATION_CURSOR_KEY = 'legacy_observation_sequence'

const LEGACY_ACTIVITY_TYPE_SET = new Set(LEGACY_OBSERVATION_ACTIVITY_TYPES)
const TRACE_PREFIX_PATTERN = /^\s*(?:(?:👀\s*)?看到：|(?:🔎\s*)?对照：)\s*/u
const VISUAL_ID_PATTERN = /V\s*(\d+)/giu
const CURRENT_VISUAL_PATTERN = /当前图片|第一张|这张/u

function sequenceOf(row, fallback = 0) {
  const sequence = Number(row?.archiveSequence)
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : fallback
}

function stripTracePrefix(value) {
  return String(value ?? '').replace(TRACE_PREFIX_PATTERN, '').trim()
}

function summaryForRow(row) {
  return stripTracePrefix(row?.text)
}

function attachmentIdsForTurn(turnMessages) {
  const rows = (Array.isArray(turnMessages) ? turnMessages : [])
    .map((row, index) => ({ row, index }))
    .sort((left, right) => sequenceOf(left.row, left.index) - sequenceOf(right.row, right.index) || left.index - right.index)

  const mediaReferences = []
  const mediaSeen = new Set()
  for (const { row } of rows) {
    if (row?.kind !== 'media_ref') continue
    const attachmentId = String(row.sourceAttachmentId ?? '').trim()
    if (attachmentId && !mediaSeen.has(attachmentId)) {
      mediaSeen.add(attachmentId)
      mediaReferences.push(attachmentId)
    }
  }
  if (mediaReferences.length > 0) return mediaReferences

  const userAttachments = []
  const userSeen = new Set()
  for (const { row } of rows) {
    const attachmentId = row?.role === 'user' ? String(row.attachment?.id ?? '').trim() : ''
    if (attachmentId && !userSeen.has(attachmentId)) {
      userSeen.add(attachmentId)
      userAttachments.push(attachmentId)
    }
  }
  return userAttachments
}

function activitySummary(turnMessages) {
  const rows = (Array.isArray(turnMessages) ? turnMessages : [])
    .filter((row) => row?.role === 'assistant' && LEGACY_ACTIVITY_TYPE_SET.has(row.activityType))
    .sort((left, right) => sequenceOf(left) - sequenceOf(right))
  return rows.length === 1 ? summaryForRow(rows[0]) : rows.map(summaryForRow).filter(Boolean).join(' ')
}

export function observationVisualIdRef(summary) {
  const text = stripTracePrefix(summary)
  const visualIds = new Set()
  for (const match of text.matchAll(VISUAL_ID_PATTERN)) visualIds.add(Number(match[1]))
  if (visualIds.size > 1) return { kind: 'ambiguous' }
  if (visualIds.size === 1) return { kind: 'explicit', index: [...visualIds][0] }
  if (CURRENT_VISUAL_PATTERN.test(text)) return { kind: 'current', index: 0 }
  return null
}

export function resolveObservationAttachment(turnMessages) {
  const attachments = attachmentIdsForTurn(turnMessages)
  if (attachments.length === 0) return null
  if (attachments.length === 1) return { attachmentId: attachments[0], visualIdIndex: 0 }

  const reference = observationVisualIdRef(activitySummary(turnMessages))
  if (reference?.kind === 'current') return { attachmentId: attachments[0], visualIdIndex: 0 }
  if (reference?.kind === 'explicit' && reference.index >= 0 && reference.index < attachments.length) {
    return { attachmentId: attachments[reference.index], visualIdIndex: reference.index }
  }
  return null
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

export async function importLegacyObservations({ store, readBatch, readMaxSequence, tokenizeText, now = () => Date.now() } = {}) {
  if (!store || typeof store.getSyncState !== 'function' || typeof store.setSyncState !== 'function') throw new TypeError('PET_LEGACY_OBSERVATION_STORE_INVALID')
  if (typeof store.findExperienceByAttachmentId !== 'function' || typeof store.recordEvent !== 'function') throw new TypeError('PET_LEGACY_OBSERVATION_STORE_API_INVALID')
  if (typeof readBatch !== 'function') throw new TypeError('PET_LEGACY_OBSERVATION_READ_BATCH_INVALID')
  if (typeof readMaxSequence !== 'function') throw new TypeError('PET_LEGACY_OBSERVATION_READ_MAX_SEQUENCE_INVALID')
  if (typeof tokenizeText !== 'function') throw new TypeError('PET_LEGACY_OBSERVATION_TOKENIZER_INVALID')
  if (typeof now !== 'function') throw new TypeError('PET_LEGACY_OBSERVATION_CLOCK_INVALID')

  const cursorBefore = nonNegativeInteger(await store.getSyncState(LEGACY_OBSERVATION_CURSOR_KEY))
  const maxSequence = nonNegativeInteger(await readMaxSequence())
  let cursor = cursorBefore
  const pages = []
  const allRows = []

  while (cursor < maxSequence) {
    const page = await readBatch(cursor, 200)
    if (!Array.isArray(page) || page.length === 0) break
    const rows = page
      .filter((row) => {
        const sequence = sequenceOf(row)
        return sequence > cursorBefore && sequence <= maxSequence
      })
      .sort((left, right) => sequenceOf(left) - sequenceOf(right))
    if (rows.length === 0) break
    const pageCursor = Math.max(...rows.map((row) => sequenceOf(row)))
    pages.push({ rows, cursor: pageCursor })
    allRows.push(...rows)
    if (pageCursor <= cursor) break
    cursor = pageCursor
  }

  const rowsByTurn = new Map()
  for (const row of allRows) {
    const turnKey = row?.turnId ?? ''
    const turnRows = rowsByTurn.get(turnKey) ?? []
    turnRows.push(row)
    rowsByTurn.set(turnKey, turnRows)
  }

  let total = 0
  let mapped = 0
  let skippedAmbiguous = 0
  let skippedNoAttachment = 0
  let skippedNoExperience = 0

  for (const page of pages) {
    for (const row of page.rows) {
      if (row?.role !== 'assistant' || !LEGACY_ACTIVITY_TYPE_SET.has(row.activityType)) continue
      total += 1
      const turnRows = rowsByTurn.get(row.turnId ?? '') ?? [row]
      const resolved = resolveObservationAttachment(turnRows)
      if (!resolved) {
        if (attachmentIdsForTurn(turnRows).length === 0) skippedNoAttachment += 1
        else skippedAmbiguous += 1
        continue
      }

      const experience = await store.findExperienceByAttachmentId(resolved.attachmentId)
      if (!experience?.experienceId) {
        skippedNoExperience += 1
        continue
      }

      const summary = sanitizeSafeTraceText(stripTracePrefix(row.text), 180)
      if (!summary) continue
      const terms = await tokenizeText(summary, { boost: 1 })
      await store.recordEvent({
        experienceId: experience.experienceId,
        turnId: row.turnId ?? null,
        kind: 'observation',
        occurredAt: row.timestamp,
        summary,
        focus: null,
        evidence: 'inferred',
        eventId: `legacy-${String(row.id ?? '').trim()}`,
        terms: Array.isArray(terms) ? terms : [],
      })
      mapped += 1
    }
    await store.setSyncState(LEGACY_OBSERVATION_CURSOR_KEY, page.cursor)
  }

  const cursorAfter = nonNegativeInteger(await store.getSyncState(LEGACY_OBSERVATION_CURSOR_KEY), cursorBefore)
  return {
    total,
    mapped,
    skippedAmbiguous,
    skippedNoAttachment,
    skippedNoExperience,
    cursorBefore,
    cursorAfter,
    modelCalls: 0,
    petMemoryWrites: 0,
    dreamRuns: 0,
  }
}
