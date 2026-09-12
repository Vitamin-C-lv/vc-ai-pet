import { detectExplicitMemoryRequest } from '../brain/memory-candidate.js'

export class ExplicitMemoryQueue {
  constructor({ now = () => Date.now(), maxEntries = 32 } = {}) {
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 32
    this.entries = []
    this.nextId = 1
  }

  enqueue({ userText, messageId = null, modelCandidate = null } = {}) {
    const text = String(userText ?? '').trim()
    if (!text) return null

    const droppedEntry = this.entries.find((entry) => entry.status === 'pending') ?? null
    const pendingCount = this.entries.reduce((count, entry) => count + (entry.status === 'pending' ? 1 : 0), 0)
    const dropped = pendingCount >= this.maxEntries ? droppedEntry : null
    if (dropped) {
      this.entries = this.entries.filter((entry) => entry !== dropped)
      dropped.status = 'dropped'
      dropped.droppedAt = this.now()
    }

    const id = messageId === null || messageId === undefined
      ? `explicit-${this.now()}-${this.nextId++}`
      : messageId
    const phrase = detectExplicitMemoryRequest(text).phrase
    const discardInfo = dropped
      ? { ...dropped, status: 'dropped' }
      : null
    const entry = {
      id,
      userText: text,
      messageId,
      modelCandidate,
      priority: 'HIGH',
      source: 'USER_EXPLICIT',
      phrase,
      status: 'pending',
      reason: null,
      enqueuedAt: this.now(),
      writtenAt: null,
      dropped: discardInfo,
      discarded: discardInfo,
    }
    this.entries.push(entry)
    return entry
  }

  listPending() {
    return this.entries.filter((entry) => entry.status === 'pending')
  }

  snapshot() {
    return this.entries.map((entry) => ({ ...entry }))
  }

  markWritten(id) {
    const entry = this.entries.find((item) => item.id === id)
    if (!entry) return null
    entry.status = 'written'
    entry.writtenAt = this.now()
    return entry
  }

  markRejected(id, reason) {
    const entry = this.entries.find((item) => item.id === id)
    if (!entry) return null
    entry.status = 'rejected'
    entry.reason = String(reason ?? 'rejected')
    entry.rejectedAt = this.now()
    return entry
  }

  drain() {
    const pending = this.listPending().map((entry) => ({ ...entry }))
    for (const entry of this.entries) {
      if (entry.status === 'pending') entry.status = 'drained'
    }
    return pending
  }

  get size() {
    return this.entries.reduce((count, entry) => count + (entry.status === 'pending' ? 1 : 0), 0)
  }
}
