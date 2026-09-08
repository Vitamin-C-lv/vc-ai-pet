import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'
import { GENERIC_RECALL_TERMS } from '../vision/visual-keywords.js'

const DEFAULT_LIMIT = 24
const MAX_LIMIT = 40
const MAX_EVENTS = 80
const MAX_TERMS = 16

function pageLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(number)))
}

function pageOffset(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(10_000, Math.floor(number)))
}

function ownerText(value, maxLength = 1200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function safeEventText(value, maxLength) {
  const text = sanitizeSafeTraceText(value, maxLength)
  return text || null
}

function eventFlags(flags = new Set()) {
  return {
    hasObservation: flags.has('observation'),
    hasComparison: flags.has('comparison'),
    hasRevisit: flags.has('revisit'),
  }
}

function publicAttachment(conversationStore, attachment) {
  if (!attachment) return null
  try {
    return typeof conversationStore?.publicAttachment === 'function'
      ? conversationStore.publicAttachment(attachment)
      : attachment
  } catch {
    return null
  }
}

async function attachmentFor(conversationStore, attachmentId) {
  if (typeof conversationStore?.attachment !== 'function') return null
  try {
    return publicAttachment(conversationStore, await conversationStore.attachment(attachmentId))
  } catch {
    return null
  }
}

function listItem(experience, attachment, flags) {
  return {
    experienceId: experience.experienceId,
    sourceMessageId: experience.sourceMessageId,
    attachmentId: experience.attachmentId,
    thumbnailUrl: attachment?.thumbnailUrl ?? null,
    occurredAt: experience.occurredAt,
    lastOccurredAt: experience.lastOccurredAt ?? experience.occurredAt,
    occurrenceCount: Number(experience.occurrenceCount ?? 0),
    ownerText: ownerText(experience.userText, 140),
    ownerTextProvenance: 'raw',
    inspectionCount: Number(experience.inspectionCount ?? 0),
    lastInspectedAt: experience.lastInspectedAt ?? null,
    ...eventFlags(flags),
  }
}

async function attachmentForExperience(store, conversationStore, experience) {
  const ids = typeof store?.reopenAttachmentIdsFor === 'function'
    ? await store.reopenAttachmentIdsFor(experience.experienceId)
    : [experience.attachmentId]
  for (const attachmentId of ids) {
    const attachment = await attachmentFor(conversationStore, attachmentId)
    if (attachment) return { attachment, attachmentId }
  }
  return { attachment: null, attachmentId: experience.attachmentId }
}

function safeTerm(entry) {
  const term = typeof entry?.term === 'string' ? entry.term.trim() : ''
  if ([...term].length < 2 || term.length > 64 || GENERIC_RECALL_TERMS.has(term)) return null
  const safe = sanitizeSafeTraceText(term, 64)
  if (!safe) return null
  const sourceKind = entry.sourceKind === 'observation' ? 'observation' : entry.sourceKind === 'user_text' ? 'user_text' : null
  if (!sourceKind) return null
  const weight = Number(entry.weight)
  return { sourceKind, term: safe, weight: Number.isFinite(weight) ? weight : 0 }
}

function publicTerms(entries) {
  const unique = new Map()
  for (const entry of Array.isArray(entries) ? entries : []) {
    const term = safeTerm(entry)
    if (!term) continue
    const key = `${term.sourceKind}:${term.term}`
    const existing = unique.get(key)
    if (!existing || term.weight > existing.weight) unique.set(key, term)
  }
  const ranked = [...unique.values()].sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term))
  const userTerms = ranked.filter((term) => term.sourceKind === 'user_text').slice(0, MAX_TERMS / 2)
  const observationTerms = ranked.filter((term) => term.sourceKind === 'observation').slice(0, MAX_TERMS / 2)
  return [...userTerms, ...observationTerms]
    .sort((left, right) => right.weight - left.weight || left.term.localeCompare(right.term))
    .slice(0, MAX_TERMS)
}

function publicEvent(event, exactRelatedIds) {
  const relatedExperienceId = typeof event.relatedExperienceId === 'string' && exactRelatedIds.has(event.relatedExperienceId)
    ? event.relatedExperienceId
    : null
  const evidence = event.kind === 'observation' || event.kind === 'comparison'
    ? 'inferred'
    : event.evidence === 'raw' ? 'raw' : 'inferred'
  return {
    eventId: event.eventId,
    experienceId: event.experienceId,
    turnId: event.turnId ?? null,
    kind: event.kind,
    occurredAt: event.occurredAt,
    focus: safeEventText(event.focus, 120),
    summary: safeEventText(event.summary, 300),
    relatedExperienceId,
    evidence,
  }
}

async function exactRelatedIds(store, experienceId, events) {
  const related = [...new Set((Array.isArray(events) ? events : [])
    .map((event) => event?.relatedExperienceId)
    .filter((value) => typeof value === 'string' && value && value !== experienceId))]
  const found = await Promise.all(related.map(async (id) => {
    try {
      if (typeof store.resolveExperienceId === 'function') return await store.resolveExperienceId(id)
      return await store.findExperienceById(id) ? id : null
    } catch {
      return null
    }
  }))
  return new Set([experienceId, ...found.filter(Boolean)])
}

function requireStore(runtime) {
  const store = runtime?.visualExperience
  if (!store || typeof store.listExperiences !== 'function' || typeof store.findExperienceById !== 'function') {
    throw Object.assign(new Error('visual gallery unavailable'), { code: 'VISUAL_GALLERY_UNAVAILABLE' })
  }
  return store
}

export async function readVisualGallery(runtime, { limit = DEFAULT_LIMIT, offset = 0 } = {}) {
  const store = requireStore(runtime)
  const conversationStore = runtime?.conversationStore
  const size = pageLimit(limit)
  const start = pageOffset(offset)
  const experiences = await store.listExperiences({ limit: size + 1, offset: start })
  const page = experiences.slice(0, size)
  const ids = page.map((item) => item.experienceId)
  const flags = typeof store.eventFlagsFor === 'function' ? await store.eventFlagsFor(ids) : new Map()
  const items = await Promise.all(page.map(async (experience) => {
    const selected = await attachmentForExperience(store, conversationStore, experience)
    return listItem({ ...experience, attachmentId: selected.attachmentId }, selected.attachment, flags.get(experience.experienceId) ?? new Set())
  }))
  const count = typeof store.countExperiences === 'function' ? await store.countExperiences() : items.length
  return {
    count: Number(count),
    limit: size,
    offset: start,
    items,
    nextOffset: experiences.length > size ? start + size : null,
  }
}

export async function readVisualGalleryDetail(runtime, experienceId) {
  const store = requireStore(runtime)
  const id = String(experienceId ?? '').trim()
  const canonicalId = typeof store.resolveExperienceId === 'function' ? await store.resolveExperienceId(id) : id
  const experience = await store.findExperienceById(canonicalId)
  if (!experience) return null

  const conversationStore = runtime?.conversationStore
  const selectedAttachment = await attachmentForExperience(store, conversationStore, experience)
  const storedOccurrences = typeof store.occurrenceFor === 'function' ? await store.occurrenceFor(canonicalId, { limit: 500 }) : []
  const occurrences = storedOccurrences.map((occurrence) => ({
    occurredAt: occurrence.occurredAt,
    userText: ownerText(occurrence.userText),
    attachmentId: occurrence.attachmentId,
    sourceMessageId: occurrence.sourceMessageId,
  }))
  const storedEvents = typeof store.eventsFor === 'function' ? await store.eventsFor(canonicalId, { limit: MAX_EVENTS }) : []
  const relatedIds = await exactRelatedIds(store, canonicalId, storedEvents)
  const visualEvents = storedEvents.map((event) => publicEvent(event, relatedIds))
  const rawTerms = typeof store.termsFor === 'function' ? await store.termsFor(id, { limit: 100 }) : []
  const visualTerms = publicTerms(rawTerms)
  const flags = typeof store.eventFlagsFor === 'function'
    ? (await store.eventFlagsFor([canonicalId])).get(canonicalId) ?? new Set()
    : new Set(visualEvents.map((event) => event.kind))
  const eventMetadata = visualEvents.map((event) => ({
    eventId: event.eventId,
    turnId: event.turnId,
    kind: event.kind,
    occurredAt: event.occurredAt,
    evidence: event.evidence,
    relatedExperienceId: event.relatedExperienceId,
  }))

  return {
    experienceId: canonicalId,
    sourceMessageId: experience.sourceMessageId,
    attachmentId: experience.attachmentId,
    occurredAt: experience.occurredAt,
    ownerText: ownerText(experience.userText),
    ownerTextProvenance: 'raw',
    originalUrl: selectedAttachment.attachment?.assetUrl ?? null,
    thumbnailUrl: selectedAttachment.attachment?.thumbnailUrl ?? null,
    occurrenceCount: Number(experience.occurrenceCount ?? occurrences.length),
    lastOccurredAt: experience.lastOccurredAt ?? experience.occurredAt,
    occurrences,
    inspectionCount: Number(experience.inspectionCount ?? 0),
    lastInspectedAt: experience.lastInspectedAt ?? null,
    ...eventFlags(flags),
    visualEvents,
    visualTerms,
    debug: {
      experienceId: experience.experienceId,
      sourceMessageId: experience.sourceMessageId,
      attachmentId: experience.attachmentId,
      rawRoot: {
        sourceMessageId: experience.sourceMessageId,
        attachmentId: experience.attachmentId,
      },
      inspectionCount: Number(experience.inspectionCount ?? 0),
      lastInspectedAt: experience.lastInspectedAt ?? null,
      eventCount: visualEvents.length,
      occurrenceCount: Number(experience.occurrenceCount ?? occurrences.length),
      lastOccurredAt: experience.lastOccurredAt ?? experience.occurredAt,
      occurrences,
      eventMetadata,
      terms: visualTerms.map(({ sourceKind, term, weight }) => ({ sourceKind, term, weight })),
    },
  }
}
