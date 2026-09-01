function cleanText(value) {
  return String(value ?? '').trim().slice(0, 1200)
}

export class RecentConversation {
  constructor({ maxTurns = 12 } = {}) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) {
      throw new Error('PET_RECENT_CONVERSATION_MAX_TURNS_INVALID')
    }

    this.maxTurns = maxTurns
    this.turns = []
  }

  append(userText, assistantText) {
    const user = cleanText(userText)
    const assistant = cleanText(assistantText)

    if (!user || !assistant) return false

    this.turns.push({ user, assistant })

    if (this.turns.length > this.maxTurns) {
      this.turns.splice(0, this.turns.length - this.maxTurns)
    }

    return true
  }

  messages() {
    return this.turns.flatMap(({ user, assistant }) => [
      { role: 'user', content: user },
      { role: 'assistant', content: assistant },
    ])
  }

  snapshot() {
    return this.turns.map(({ user, assistant }) => ({ user, assistant }))
  }

  clear() {
    this.turns.length = 0
  }

  get size() {
    return this.turns.length
  }
}
