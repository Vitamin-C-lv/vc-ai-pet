import { createTurnId, PetTurnEvents } from './pet-turn-events.js'

function failureDiagnosticFields(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return {}
  const fields = {}
  if (typeof diagnostic.stage === 'string') fields.errorStage = diagnostic.stage
  if (Number.isInteger(diagnostic.inspectionOrdinal)) fields.inspectionOrdinal = diagnostic.inspectionOrdinal
  for (const [source, target, max] of [
    ['currentVisualId', 'currentVisualId', 16],
    ['nextVisualId', 'nextVisualId', 16],
    ['attachmentId', 'attachmentId', 80],
  ]) {
    if (typeof diagnostic[source] === 'string' && diagnostic[source].trim()) fields[target] = diagnostic[source].trim().slice(0, max)
  }
  return fields
}

export class PetTurnManager {
  constructor({ maxTurns = 32, ttlMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 32) throw new TypeError('PET_TURN_MANAGER_MAX_INVALID')
    if (!Number.isInteger(ttlMs) || ttlMs < 1) throw new TypeError('PET_TURN_MANAGER_TTL_INVALID')
    if (typeof now !== 'function') throw new TypeError('PET_TURN_MANAGER_CLOCK_INVALID')
    this.maxTurns = maxTurns
    this.ttlMs = ttlMs
    this.now = now
    this.turns = new Map()
  }

  start(run) {
    if (typeof run !== 'function') throw new TypeError('PET_TURN_MANAGER_RUN_INVALID')
    this.cleanup()
    while (this.turns.size >= this.maxTurns) {
      const evictable = [...this.turns.values()]
        .filter((turn) => turn.status !== 'running')
        .sort((left, right) => (left.terminalAt ?? left.createdAt) - (right.terminalAt ?? right.createdAt))[0]
      if (!evictable) {
        const error = new Error('PET_TURN_MANAGER_CAPACITY')
        error.code = 'PET_TURN_MANAGER_CAPACITY'
        throw error
      }
      this.turns.delete(evictable.turnId)
    }
    const turnId = createTurnId()
    const events = new PetTurnEvents({ turnId, now: this.now })
    const turn = { turnId, events, status: 'running', result: null, error: null, createdAt: this.now(), terminalAt: null }
    this.turns.set(turnId, turn)
    void Promise.resolve().then(() => run({ turnId, emit: (type, payload) => events.emit(type, payload) }))
      .then((result) => {
        if (result?.ok === false) {
          turn.status = 'error'
          turn.terminalAt = this.now()
          turn.error = {
            code: String(result.reason ?? 'TURN_FAILED'),
            requestId: result.requestId ?? null,
            retryable: result.unavailable === true,
            visualInspectionCount: result.inspections?.length ?? 0,
            ...failureDiagnosticFields(result.diagnostic),
          }
          if (!events.terminal) events.emit('turn_failed', turn.error)
          return
        }
        turn.status = 'done'; turn.result = result; turn.terminalAt = this.now()
      })
      .catch((error) => {
        turn.status = 'error'
        turn.terminalAt = this.now()
        turn.error = { code: String(error?.code ?? 'TURN_FAILED'), requestId: error?.requestId ?? null, retryable: error?.retryable === true }
        if (!events.terminal) events.emit('turn_failed', turn.error)
      })
    return { turnId }
  }

  poll(turnId, after = 0) {
    this.cleanup()
    const turn = this.turns.get(String(turnId))
    if (!turn) return null
    return { ok: true, turnId: turn.turnId, status: turn.status, events: turn.events.after(after), lastSeq: turn.events.lastSeq, result: turn.status === 'done' ? turn.result : null }
  }

  cleanup() {
    const cutoff = this.now() - this.ttlMs
    for (const [id, turn] of this.turns) {
      const expiryBase = turn.status === 'running' ? null : (turn.terminalAt ?? turn.createdAt)
      if (expiryBase !== null && expiryBase <= cutoff) this.turns.delete(id)
    }
    while (this.turns.size > this.maxTurns) {
      const evictable = [...this.turns.values()]
        .filter((turn) => turn.status !== 'running')
        .sort((left, right) => (left.terminalAt ?? left.createdAt) - (right.terminalAt ?? right.createdAt))[0]
      if (!evictable) break
      this.turns.delete(evictable.turnId)
    }
  }
}
