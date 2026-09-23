export const WakeSessionState = Object.freeze({
  IDLE: 'IDLE',
  WAKE_CANDIDATE: 'WAKE_CANDIDATE',
  LISTENING: 'LISTENING',
  THINKING: 'THINKING',
  SPEAKING: 'SPEAKING',
})

export class WakeSession {
  constructor({ now = () => Date.now(), followUpMs = 9000, maxIdleMs = 30_000, cooldownMs = 800, onStateChange = () => {} } = {}) {
    this.now = now
    this.followUpMs = followUpMs
    this.maxIdleMs = maxIdleMs
    this.cooldownMs = cooldownMs
    this.onStateChange = onStateChange
    this.state = WakeSessionState.IDLE
    this.listenUntil = 0
    this.lastActivity = this.now()
    this.speakingUntil = 0
    this.resumeListeningAfterSpeech = false
  }

  setState(state) {
    if (this.state === state) return
    const previous = this.state
    this.state = state
    this.onStateChange({ previous, state })
  }

  reset() {
    this.listenUntil = 0
    this.lastActivity = this.now()
    this.resumeListeningAfterSpeech = false
    this.setState(WakeSessionState.IDLE)
  }

  prepareWakeAcknowledgment() {
    if (this.state !== WakeSessionState.LISTENING) return false
    this.resumeListeningAfterSpeech = true
    return true
  }

  tick(at = this.now()) {
    if (this.state === WakeSessionState.LISTENING && at > this.listenUntil) this.reset()
    if (this.state !== WakeSessionState.IDLE && at - this.lastActivity > this.maxIdleMs) this.reset()
    if (this.state === WakeSessionState.SPEAKING && at >= this.speakingUntil) this.reset()
    return this.state
  }

  canListen(at = this.now()) {
    this.tick(at)
    return this.state === WakeSessionState.IDLE || this.state === WakeSessionState.LISTENING
  }

  beginCandidate(at = this.now()) {
    this.tick(at)
    if (this.state === WakeSessionState.SPEAKING || at < this.speakingUntil) return false
    this.lastActivity = at
    this.setState(WakeSessionState.WAKE_CANDIDATE)
    return true
  }

  acceptWake(query, at = this.now()) {
    this.tick(at)
    if (this.state !== WakeSessionState.WAKE_CANDIDATE && this.state !== WakeSessionState.IDLE) return { accepted: false, reason: 'session-busy' }
    this.lastActivity = at
    if (query) {
      this.setState(WakeSessionState.THINKING)
      return { accepted: true, kind: 'query', query }
    }
    this.listenUntil = at + this.followUpMs
    this.setState(WakeSessionState.LISTENING)
    return { accepted: true, kind: 'wake-only', query: '' }
  }

  acceptFollowUp(query, at = this.now()) {
    this.tick(at)
    if (this.state !== WakeSessionState.LISTENING || at > this.listenUntil) {
      this.reset()
      return { accepted: false, reason: 'follow-up-timeout' }
    }
    const value = String(query ?? '').trim()
    if (!value) return { accepted: false, reason: 'empty-follow-up' }
    this.lastActivity = at
    this.setState(WakeSessionState.THINKING)
    return { accepted: true, kind: 'follow-up', query: value }
  }

  markSpeaking(active, at = this.now()) {
    if (active) {
      this.lastActivity = at
      this.speakingUntil = at + this.maxIdleMs
      this.setState(WakeSessionState.SPEAKING)
      return
    }
    if (this.resumeListeningAfterSpeech) {
      this.resumeListeningAfterSpeech = false
      this.speakingUntil = at + this.cooldownMs
      this.listenUntil = at + this.followUpMs
      this.lastActivity = at
      this.setState(WakeSessionState.LISTENING)
      return
    }
    this.speakingUntil = at + this.cooldownMs
    this.reset()
    this.speakingUntil = at + this.cooldownMs
  }
}
