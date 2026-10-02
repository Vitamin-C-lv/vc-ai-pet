import { randomUUID } from 'node:crypto'
import { sanitizeSafeTraceText } from './pet-turn-events.js'

export const DEFAULT_PROACTIVE_SETTINGS = Object.freeze({
  enabled: true, maxPerDay: 3, quietStart: '22:00', quietEnd: '08:00', timeZone: 'Asia/Shanghai',
})
export const PROACTIVE_IDLE_MS = 2 * 60 * 60 * 1000
export const PROACTIVE_COOLDOWN_MS = 3 * 60 * 60 * 1000
const ATTEMPT_INTERVAL_MS = 30 * 60 * 1000
const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})
function localTime(now) {
  const p = Object.fromEntries(clock.formatToParts(new Date(now)).map(item => [item.type, item.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) }
}
function minutes(value) { const [h,m] = value.split(':').map(Number); return h * 60 + m }
function quiet(settings, now) {
  const time = localTime(now).minutes, start = minutes(settings.quietStart), end = minutes(settings.quietEnd)
  return start === end ? false : start < end ? time >= start && time < end : time >= start || time < end
}
function validSettings(raw) {
  const settings = Object.fromEntries(Object.entries(DEFAULT_PROACTIVE_SETTINGS)
    .map(([key, fallback]) => [key, Object.hasOwn(raw, key) ? raw[key] : fallback]))
  settings.timeZone = 'Asia/Shanghai'
  if (typeof settings.enabled !== 'boolean' || !Number.isInteger(settings.maxPerDay)
    || settings.maxPerDay < 1 || settings.maxPerDay > 10
    || ![settings.quietStart, settings.quietEnd].every(time => typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time))) {
    throw Object.assign(new Error('invalid proactive settings'), { code: 'PET_PROACTIVE_SETTINGS_INVALID' })
  }
  return settings
}

export class ProactiveMessages {
  constructor({ runtime, now = () => Date.now() }) {
    this.runtime = runtime
    this.now = now
    this.settings = { ...DEFAULT_PROACTIVE_SETTINGS }
    this.inFlight = false
    this.lastAttemptAt = 0
    this.waiters = new Set()
    this.closed = false
  }
  async initialize() {
    const saved = await this.runtime.sandbox.readJson('runtime', 'proactive-settings.json', null)
    this.settings = validSettings(saved ?? {})
    const schedule = await this.runtime.sandbox.readJson('runtime', 'proactive-schedule.json', {})
    this.lastAttemptAt = schedule.lastAttemptAt ?? 0
    return this
  }
  getSettings() { return { ...this.settings } }
  isQuiet(now = this.now()) { return quiet(this.settings, now) }
  async setSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw Object.assign(new Error('invalid proactive settings'), { code: 'PET_PROACTIVE_SETTINGS_INVALID' })
    }
    this.settings = validSettings({ ...this.settings, ...patch })
    await this.runtime.sandbox.writeJson('runtime', 'proactive-settings.json', this.settings)
    return this.getSettings()
  }
  busy() {
    const runtime = this.runtime
    return runtime.chatInFlight > 0 || [...(runtime.turnManager?.turns?.values() ?? [])].some(turn => turn.status === 'running')
      || runtime.dreamEngine?.isInFlight?.() || runtime.reflectionEngine?.isInFlight?.()
  }
  async maybeSend(now = this.now()) {
    const skipped = reason => ({ status: 'skipped', reason })
    if (!this.settings.enabled) return skipped('disabled')
    if (this.closed) return skipped('closed')
    if (this.inFlight || this.busy()) return skipped('busy')
    if (quiet(this.settings, now)) return skipped('quiet-hours')
    if (this.runtime.snapshot()?.current === 'sleep') return skipped('asleep')
    if (now - this.lastAttemptAt < ATTEMPT_INTERVAL_MS) return skipped('attempt-cooldown')
    this.inFlight = true
    try {
      const history = await this.runtime.conversationStore.proactiveEligibilityHistory()
      const day = localTime(now).day
      if (history.messages.filter(message => localTime(message.timestamp).day === day).length >= this.settings.maxPerDay) return skipped('daily-cap')
      if (history.messages[0] && now - history.messages[0].timestamp < PROACTIVE_COOLDOWN_MS) return skipped('message-cooldown')
      const ownerAt = Math.max(history.lastOwnerAt ?? this.runtime.state?.bornAt ?? now, this.runtime.state?.lastInteractionAt ?? 0)
      if (now - ownerAt < PROACTIVE_IDLE_MS) return skipped('owner-recently-active')
      if (typeof this.runtime.brain?.proactiveMessage !== 'function') return skipped('brain-unavailable')
      this.lastAttemptAt = now
      await this.runtime.sandbox.writeJson('runtime', 'proactive-schedule.json', { lastAttemptAt: now })
      const recent = (await this.runtime.conversationStore.list(24))
        .filter(message => ['dialogue', 'final', 'proactive'].includes(message.kind ?? 'dialogue') && !message.attachment)
        .slice(-8).map(message => ({ role: message.role, content: message.text.slice(0, 400) }))
      const turnId = randomUUID()
      const run = () => this.runtime.brain.proactiveMessage({ identity: this.runtime.identitySnapshot(),
        state: this.runtime.snapshot(), recentMessages: recent,
        recentProactiveMessages: history.messages.slice(0, 5).map(message => message.text), idleMs: now - ownerAt, now })
      const result = this.runtime.reasoningDebugStore ? await this.runtime.reasoningDebugStore.run(turnId, run) : await run()
      if (result?.send !== true) return skipped('model-declined')
      if (this.closed) return skipped('owner-became-active')
      const latest = await this.runtime.conversationStore.proactiveEligibilityHistory()
      if (latest.lastOwnerSequence !== history.lastOwnerSequence
        || (this.runtime.state?.lastInteractionAt ?? 0) > ownerAt || this.busy()
        || this.closed || !this.settings.enabled || quiet(this.settings, this.now())) return skipped('owner-became-active')
      const text = sanitizeSafeTraceText(result.text, 300)
      if (!text || latest.messages.some(message => message.text === text)) return skipped('empty-or-repeated')
      const message = await this.publish({ text, turnId, timestamp: this.now(), reasoning: result.reasoning })
      return { status: 'sent', message }
    } catch (error) {
      this.runtime.logger?.warn?.(`vc-ai-pet: proactive attempt failed code=${String(error?.code ?? 'UNKNOWN').slice(0,80)}`)
      return { status: 'skipped', reason: 'generation-failed' }
    } finally { this.inFlight = false }
  }
  async publish({ text, turnId = randomUUID(), timestamp = this.now(), reasoning = null, proactiveTest = false }) {
    const message = await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'proactive', text, turnId, timestamp, reasoning, proactiveTest })
    for (const wake of [...this.waiters]) wake()
    return { id: message.id, text: message.text, timestamp: message.timestamp, turnId }
  }
  async sendTest() {
    return this.publish({ text: '汪！花花来敲敲门啦～这是给主人试一试的消息提醒。', proactiveTest: true })
  }
  async inbox(after = 0, { latest = false, wait = 0, signal } = {}) {
    let result = await this.runtime.conversationStore.proactiveInbox(after, { latest })
    if (latest || result.messages.length || result.cursor !== after || !wait || signal?.aborted) return result
    await new Promise(resolve => {
      let timer
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); signal?.removeEventListener('abort', wake); resolve() }
      this.waiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
      timer = setTimeout(wake, wait * 1000)
      timer.unref?.()
      // Close the read/subscribe gap with one durable read.
      void this.runtime.conversationStore.proactiveInbox(after).then(inbox => { if (inbox.messages.length) wake() }, wake)
    })
    return this.closed ? result : this.runtime.conversationStore.proactiveInbox(after)
  }
  close() { this.closed = true; for (const wake of [...this.waiters]) wake() }
}
