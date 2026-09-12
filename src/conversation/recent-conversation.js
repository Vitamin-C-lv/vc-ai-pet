export const RECENT_CONVERSATION_DEFAULT_MAX_TURNS = 48
export const RECENT_CONVERSATION_MAX_TURNS_LIMIT = 48
export const RECENT_CONVERSATION_MAX_CHARS_PER_TURN = 1200

function cleanText(value, maxLength = RECENT_CONVERSATION_MAX_CHARS_PER_TURN) {
  return String(value ?? '').trim().slice(0, maxLength)
}

function validateMaxTurns(maxTurns) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > RECENT_CONVERSATION_MAX_TURNS_LIMIT) {
    throw new Error('PET_RECENT_CONVERSATION_MAX_TURNS_INVALID')
  }
  return maxTurns
}

function validateMaxChars(maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 0) {
    throw new Error('PET_RECENT_CONVERSATION_MAX_CHARS_INVALID')
  }
  return maxChars
}

function validateMaxCharsPerTurn(maxCharsPerTurn) {
  if (!Number.isInteger(maxCharsPerTurn) || maxCharsPerTurn < 1 || maxCharsPerTurn > RECENT_CONVERSATION_MAX_CHARS_PER_TURN) {
    throw new Error('PET_RECENT_CONVERSATION_MAX_CHARS_PER_TURN_INVALID')
  }
  return maxCharsPerTurn
}

function turnChars({ user, assistant }) {
  return user.length + assistant.length
}

function recentTurns(turns, { maxTurns, maxChars } = {}) {
  const selected = maxTurns === undefined ? turns : turns.slice(-maxTurns)
  if (maxChars === undefined || selected.length === 0) return selected

  let totalChars = selected.reduce((total, turn) => total + turnChars(turn), 0)
  let first = 0
  while (first < selected.length && totalChars > maxChars) {
    totalChars -= turnChars(selected[first])
    first += 1
  }
  return first === 0 ? selected : selected.slice(first)
}

// Fifty turns stays bounded: two 1200-character messages per turn are about
// 50 * 1200 * 2 = 120k characters in the absolute worst case. Real Chinese
// conversations are usually far below that ceiling, and messages() can tighten
// either dimension without changing the stored window.
export class RecentConversation {
  constructor({ maxTurns = RECENT_CONVERSATION_DEFAULT_MAX_TURNS, maxCharsPerTurn = RECENT_CONVERSATION_MAX_CHARS_PER_TURN } = {}) {
    this.maxTurns = validateMaxTurns(maxTurns)
    this.maxCharsPerTurn = validateMaxCharsPerTurn(maxCharsPerTurn)
    this.turns = []
  }

  append(userText, assistantText) {
    const user = cleanText(userText, this.maxCharsPerTurn)
    const assistant = cleanText(assistantText, this.maxCharsPerTurn)

    if (!user || !assistant) return false

    this.turns.push({ user, assistant })

    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns)
    }

    return true
  }

  messages(options = {}) {
    const { maxTurns, maxChars } = options
    if (maxTurns !== undefined) validateMaxTurns(maxTurns)
    if (maxChars !== undefined) validateMaxChars(maxChars)

    return recentTurns(this.turns, { maxTurns, maxChars }).flatMap(({ user, assistant }) => [
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ])
  }

  tokenBudgetSnapshot() {
    const turns = this.turns.length
    const messages = turns * 2
    const approxChars = this.turns.reduce((total, turn) => total + turnChars(turn), 0)
    // Chinese characters generally need more bytes/tokens than English words,
    // so chars / 2 is a conservative planning estimate for mixed chat text.
    const approxTokens = Math.ceil(approxChars / 2)
    return { turns, messages, approxChars, approxTokens }
  }

  snapshot({ limit } = {}) {
    if (limit === undefined) {
      return this.turns.map(({ user, assistant }) => ({ user, assistant }))
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('PET_RECENT_CONVERSATION_SNAPSHOT_LIMIT_INVALID')
    }
    const turns = limit === 0 ? [] : this.turns.slice(-limit)
    return turns.map(({ user, assistant }) => ({ user, assistant }))
  }

  clear() {
    this.turns.length = 0
  }

  get size() {
    return this.turns.length
  }
}
