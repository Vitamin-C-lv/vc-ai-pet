/**
 * A bounded, public-only event feed for the embodied bridge.
 *
 * PetTurnEvents sanitizes every payload before this feed sees it. The feed
 * adds a process-local cursor so a bridge can resume without reading private
 * conversation or Memory storage.
 */
export class PetTurnEventFeed {
  constructor({ maxEvents = 512 } = {}) {
    if (!Number.isInteger(maxEvents) || maxEvents < 16) throw new TypeError('PET_TURN_FEED_MAX_INVALID')
    this.maxEvents = maxEvents
    this.cursor = 0
    this.events = []
  }

  publish(event) {
    if (!event || typeof event !== 'object') return null
    const item = Object.freeze({ cursor: ++this.cursor, ...event })
    this.events.push(item)
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents)
    return item
  }

  after(after = 0) {
    const cursor = Number.isInteger(Number(after)) ? Math.max(0, Number(after)) : 0
    const first = this.events[0]?.cursor ?? this.cursor + 1
    return {
      cursor: this.cursor,
      gap: cursor > 0 && cursor < first - 1,
      events: this.events.filter((event) => event.cursor > cursor).map((event) => ({ ...event })),
    }
  }
}
