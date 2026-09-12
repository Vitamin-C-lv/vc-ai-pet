import {
  containsSensitiveMemoryText,
  formatMemoryContent,
  highPriorityMemoryCandidate,
  userOptedOutOfMemory,
  validateMemoryCandidate,
} from '../brain/memory-candidate.js'
import { containsNonAssertion } from './current-belief.js'

/**
 * Metadata carried by the explicit path. It is deliberately kept out of the
 * candidate object so the candidate keeps its frozen shape (existing tests and
 * callers depend on it); the runtime queue attaches the same values to its
 * entries, which is where prompt-level priority is actually read.
 */
export const EXPLICIT_MEMORY_PRIORITY = 'HIGH'
export const EXPLICIT_MEMORY_SOURCE = 'USER_EXPLICIT'

export class MemoryGate {
  constructor({ memory }) {
    this.memory = memory
  }

  /**
   * @param {string} userText
   * @param {object|null} rawCandidate the model's own proposal
   * @param {{ messageId?: string|null, explicitFallback?: object|null }} [options]
   *   `explicitFallback` is supplied by the runtime while an explicit instruction
   *   is still in force. A follow-up sentence ("我们家的猫叫黑莓") carries no
   *   keyword of its own, so it cannot be re-detected here — yet it must still be
   *   written, or the pet forgets what it was just told. Validation is NOT
   *   bypassed: the fallback goes through the same equivalence, sensitive-text
   *   and opt-out checks as a model candidate.
   */
  consider(userText, rawCandidate, { messageId = null, explicitFallback = null } = {}) {
    if (userOptedOutOfMemory(userText)) {
      return { status: 'skipped', reason: 'user-opt-out' }
    }

    if (containsSensitiveMemoryText(userText)) {
      return { status: 'skipped', reason: 'memory-sensitive-reject' }
    }
    if (containsNonAssertion(userText)) return { status: 'skipped', reason: 'not-owner-assertion' }

    const checked = validateMemoryCandidate(rawCandidate, userText)
    const fallbackCandidate = !checked.accepted
      ? (explicitFallback ?? highPriorityMemoryCandidate(userText, { modelCandidate: rawCandidate }))
      : null
    const checkedFallback = fallbackCandidate
      ? validateMemoryCandidate({ remember: true, ...fallbackCandidate }, userText)
      : null
    const fallback = checkedFallback?.accepted ? fallbackCandidate : null
    const proposed = checked.accepted ? checked.candidate : fallback
    // The model may summarize a statement incorrectly despite quoting valid
    // evidence. Store the verified quote as content; never bless that summary
    // as a new raw fact. Existing rows remain unchanged.
    const candidate = proposed
      ? {
          ...proposed,
          content: formatMemoryContent({
            evidence: proposed.evidence,
            content: proposed.content,
            explicitContent: fallback ? proposed.content : '',
          }),
        }
      : null

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
      ...(fallback
        ? { priority: EXPLICIT_MEMORY_PRIORITY, source: EXPLICIT_MEMORY_SOURCE, explicit: true }
        : {}),
    }
  }
}
