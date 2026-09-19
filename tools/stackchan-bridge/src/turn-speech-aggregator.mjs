export class TurnSpeechAggregator {
  constructor({ pending = new Map(), spoken = new Set(), maxSpoken = 256 } = {}) {
    this.pending = pending
    this.spoken = spoken
    this.maxSpoken = maxSpoken
  }

  ingest(event) {
    if (!event || typeof event.turnId !== 'string') return null
    if (event.type === 'assistant_message' && typeof event.payload?.text === 'string') {
      const messages = this.pending.get(event.turnId) ?? new Map()
      messages.set(Number(event.seq), event.payload.text)
      this.pending.set(event.turnId, messages)
      return null
    }
    if (event.type === 'turn_failed') {
      this.pending.delete(event.turnId)
      return null
    }
    if (event.type !== 'turn_completed') return null
    const messages = this.pending.get(event.turnId)
    this.pending.delete(event.turnId)
    if (this.spoken.has(event.turnId) || !messages) return null
    this.spoken.add(event.turnId)
    while (this.spoken.size > this.maxSpoken) this.spoken.delete(this.spoken.values().next().value)
    return [...messages.entries()]
      .sort((left, right) => left[0] - right[0])
      .map((entry) => entry[1])
      .join('\n')
      .trim() || null
  }
}
