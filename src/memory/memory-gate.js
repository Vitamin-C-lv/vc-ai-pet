import {
  containsSensitiveMemoryText,
  createExplicitMemoryFallbackCandidate,
  userExplicitlyRequestsMemory,
  userOptedOutOfMemory,
  validateMemoryCandidate,
} from '../brain/memory-candidate.js'

const EXPLICIT_FALLBACK_REASONS = new Set(['model-skip', 'content-invalid', 'evidence-invalid'])

export class MemoryGate {
  constructor({ memory }) {
    this.memory = memory
  }

  consider(userText, rawCandidate) {
    if (userOptedOutOfMemory(userText)) {
      return { status: 'skipped', reason: 'user-opt-out' }
    }

    if (containsSensitiveMemoryText(userText)) {
      return { status: 'skipped', reason: 'memory-sensitive-reject' }
    }

    const checked = validateMemoryCandidate(rawCandidate, userText)
    const fallback = userExplicitlyRequestsMemory(userText) && EXPLICIT_FALLBACK_REASONS.has(checked.reason)
      ? createExplicitMemoryFallbackCandidate(userText)
      : null
    const candidate = checked.accepted ? checked.candidate : fallback

    if (!candidate) {
      return { status: 'skipped', reason: checked.reason }
    }

    const duplicate = this.memory.findEquivalentMemory(candidate.content)
    if (duplicate) {
      return {
        status: 'duplicate',
        reason: 'equivalent-memory-exists',
        level: duplicate.level,
        id: duplicate.id,
      }
    }

    const row = this.memory.rememberCandidate(candidate)
    return {
      status: 'written',
      reason: 'accepted',
      level: candidate.level,
      id: row?.id ?? null,
    }
  }
}
