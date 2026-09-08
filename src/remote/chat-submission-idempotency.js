import { createHash } from 'node:crypto'

export const DEFAULT_SUBMISSION_IDEMPOTENCY_MAX_ENTRIES = 256
export const SERVER_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000
export const DEFAULT_SUBMISSION_IDEMPOTENCY_TTL_MS = SERVER_IDEMPOTENCY_TTL_MS

function conflictError() {
  const error = new Error('submission id payload conflict')
  error.code = 'SUBMISSION_ID_CONFLICT'
  error.statusCode = 409
  return error
}

function normalizeSubmissionId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,80}$/iu.test(value)) {
    const error = new Error('submission id invalid')
    error.code = 'SUBMISSION_ID_INVALID'
    error.statusCode = 400
    throw error
  }
  return value
}

export function submissionPayloadFingerprint({ message = '', attachmentId = null } = {}) {
  const payload = JSON.stringify({
    message: String(message),
    attachmentId: attachmentId === null || attachmentId === undefined ? null : String(attachmentId),
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export class ChatSubmissionIdempotency {
  constructor({
    maxEntries = DEFAULT_SUBMISSION_IDEMPOTENCY_MAX_ENTRIES,
    ttlMs = DEFAULT_SUBMISSION_IDEMPOTENCY_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('SUBMISSION_IDEMPOTENCY_MAX_ENTRIES_INVALID')
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new TypeError('SUBMISSION_IDEMPOTENCY_TTL_INVALID')
    if (typeof now !== 'function') throw new TypeError('SUBMISSION_IDEMPOTENCY_CLOCK_INVALID')
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.now = now
    this.entries = new Map()
  }

  cleanup(now = this.now()) {
    for (const [submissionId, entry] of this.entries) {
      if (now - entry.createdAt >= this.ttlMs) this.entries.delete(submissionId)
    }
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value)
    return this.entries.size
  }

  start({ submissionId, message, attachmentId = null, createTurn } = {}) {
    if (typeof createTurn !== 'function') throw new TypeError('SUBMISSION_IDEMPOTENCY_CREATE_TURN_INVALID')
    const id = normalizeSubmissionId(submissionId)
    const now = this.now()
    this.cleanup(now)
    const fingerprint = submissionPayloadFingerprint({ message, attachmentId })
    const existing = this.entries.get(id)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw conflictError()
      existing.lastSeenAt = now
      this.entries.delete(id)
      this.entries.set(id, existing)
      return { turnId: existing.turnId, idempotentReplay: true }
    }

    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value)
    const started = createTurn()
    if (!started?.turnId) {
      const error = new Error('turn id missing')
      error.code = 'SUBMISSION_TURN_ID_MISSING'
      throw error
    }
    this.entries.set(id, {
      submissionId: id,
      turnId: started.turnId,
      fingerprint,
      createdAt: now,
      lastSeenAt: now,
    })
    return { turnId: started.turnId, idempotentReplay: false }
  }

  lookup({ submissionId, message, attachmentId = null } = {}) {
    const id = normalizeSubmissionId(submissionId)
    const now = this.now()
    this.cleanup(now)
    const fingerprint = submissionPayloadFingerprint({ message, attachmentId })
    const existing = this.entries.get(id)
    if (!existing) return null
    if (existing.fingerprint !== fingerprint) throw conflictError()
    existing.lastSeenAt = now
    this.entries.delete(id)
    this.entries.set(id, existing)
    return { turnId: existing.turnId, idempotentReplay: true }
  }

  size() {
    this.cleanup()
    return this.entries.size
  }

  get(submissionId) {
    const id = normalizeSubmissionId(submissionId)
    this.cleanup()
    const entry = this.entries.get(id)
    return entry ? { ...entry } : null
  }
}

export function createChatSubmissionIdempotency(options = {}) {
  return new ChatSubmissionIdempotency(options)
}
