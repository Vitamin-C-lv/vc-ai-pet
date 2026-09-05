import {
  containsSensitiveMemoryText,
  createExplicitMemoryFallbackCandidate,
  userExplicitlyRequestsMemory,
  userOptedOutOfMemory,
  validateMemoryCandidate,
} from '../brain/memory-candidate.js'
import { containsNonAssertion } from './current-belief.js'

const EXPLICIT_FALLBACK_REASONS = new Set(['model-skip', 'content-invalid', 'evidence-invalid'])

export class MemoryGate {
  constructor({ memory }) {
    this.memory = memory
  }

  consider(userText, rawCandidate, { messageId = null } = {}) {
    if (userOptedOutOfMemory(userText)) {
      return { status: 'skipped', reason: 'user-opt-out' }
    }

    if (containsSensitiveMemoryText(userText)) {
      return { status: 'skipped', reason: 'memory-sensitive-reject' }
    }
    if (containsNonAssertion(userText)) return { status: 'skipped', reason: 'not-owner-assertion' }

    const checked = validateMemoryCandidate(rawCandidate, userText)
    const fallback = userExplicitlyRequestsMemory(userText) && EXPLICIT_FALLBACK_REASONS.has(checked.reason)
      ? createExplicitMemoryFallbackCandidate(userText)
      : null
    const proposed = checked.accepted ? checked.candidate : fallback
    // The model may summarize a statement incorrectly despite quoting valid
    // evidence. Store the verified quote as content; never bless that summary
    // as a new raw fact. Existing rows remain unchanged.
    const candidate = proposed ? { ...proposed, content: `主人说：${proposed.evidence}` } : null

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

    const row = this.memory.rememberCandidate({ ...candidate, ...(messageId ? { messageId } : {}) })
    return {
      status: 'written',
      reason: 'accepted',
      level: candidate.level,
      id: row?.id ?? null,
    }
  }
}
