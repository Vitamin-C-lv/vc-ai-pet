// Dream is driven by PetRuntime.tick().  This module deliberately owns only
// the trigger gate: source selection/checkpoint work belongs to the injected
// memory/engine contract, and Dream execution belongs to DreamEngine.

export const DREAM_MIN_NEW_MEMORIES = 8
export const DREAM_MIN_NEW_SOURCES = DREAM_MIN_NEW_MEMORIES
export const DREAM_OLDEST_SOURCE_AGE_MS = 72 * 60 * 60 * 1000
export const DREAM_MAX_UNPROCESSED_AGE_MS = DREAM_OLDEST_SOURCE_AGE_MS
export const DREAM_OWNER_BUSY_COOLDOWN_MS = 15 * 60 * 1000

export const REFLECTION_ALLOWED_STATES = Object.freeze([
  'idle',
  'rest',
  'curious',
  'sleepy',
  'sleep',
])
export const REFLECTION_MIN_INTERVAL_MS = 30 * 60 * 1000
export const REFLECTION_MIN_NEW_RAW_MEMORIES = 2
export const REFLECTION_MIN_NEW_MEMORIES = REFLECTION_MIN_NEW_RAW_MEMORIES
export const REFLECTION_OLDEST_UNREFLECTED_AGE_MS = 60 * 60 * 1000

export const DEEP_DREAM_MIN_SLEEP_MS = 15 * 60 * 1000
export const DEEP_DREAM_SLEEP_MIN_MS = DEEP_DREAM_MIN_SLEEP_MS
export const DEEP_DREAM_NIGHT_START_MINUTES = 22 * 60 + 30
export const DEEP_DREAM_NIGHT_END_MINUTES = 8 * 60
export const DEEP_DREAM_DAYTIME_AVAILABILITY_MS = 45 * 60 * 1000
export const DEEP_DREAM_MIN_BRAIN_AVAILABILITY_MS = DEEP_DREAM_DAYTIME_AVAILABILITY_MS
export const DEEP_DREAM_SUCCESS_COOLDOWN_MS = 30 * 60 * 1000

export const MICRO_REFLECTION_MIN_INTERVAL_MS = REFLECTION_MIN_INTERVAL_MS
export const MICRO_REFLECTION_MIN_NEW_RAW_MEMORIES = REFLECTION_MIN_NEW_RAW_MEMORIES
export const MICRO_REFLECTION_OLDEST_UNREFLECTED_AGE_MS = REFLECTION_OLDEST_UNREFLECTED_AGE_MS

const ELIGIBILITY_METHODS = Object.freeze([
  'shouldDream',
  'getDreamTriggerEligibility',
  'getTriggerEligibility',
  'getDreamEligibility',
  'checkDreamEligibility',
  'getEligibility',
  'checkEligibility',
  'isEligible',
  'isDreamDue',
  'isDue',
  'shouldRun',
  'hasEligibleWork',
  'hasEligibleDreamSources',
  'hasEligibleSources',
  'eligibility',
])

const REFLECTION_ELIGIBILITY_METHODS = Object.freeze([
  'shouldReflect',
  'shouldReflection',
  'getReflectionEligibility',
  'getMicroReflectionEligibility',
  'checkReflectionEligibility',
  'getReflectionDue',
  'isReflectionDue',
  'hasReflectionWork',
])

const REFLECTION_RUN_METHODS = Object.freeze([
  'runReflection',
  'runMicroReflection',
  'reflect',
  'run',
  'execute',
])

const REFLECTION_STATE_SET = new Set(REFLECTION_ALLOWED_STATES)

const RUN_METHODS = Object.freeze([
  'run',
  'runDream',
  'execute',
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isChatBusy(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
  if (!isRecord(value)) return false

  return isChatBusy(value.inFlight) || isChatBusy(value.count) || isChatBusy(value.value)
}

function parseTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime()
    return Number.isFinite(timestamp) ? timestamp : null
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return numeric

    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizeTime(value, fallback) {
  const candidate = value === undefined ? fallback() : value
  const timestamp = parseTimestamp(candidate)

  if (timestamp === null) {
    throw new TypeError('PET_DREAM_SCHEDULER_CLOCK_INVALID')
  }

  return timestamp
}

function resolveMethod(target, names) {
  if (!target) return null

  for (const name of names) {
    if (typeof target[name] === 'function') {
      return { owner: target, method: target[name] }
    }
  }

  return null
}

function resolveContract(explicit, targets, names, explicitNames = names) {
  if (typeof explicit === 'function') {
    return { owner: null, method: explicit }
  }

  if (isRecord(explicit)) {
    const explicitMethod = resolveMethod(explicit, explicitNames)
    if (explicitMethod) return explicitMethod
  }

  for (const target of targets) {
    const method = resolveMethod(target, names)
    if (method) return method
  }

  return null
}

function resolveEligibility(explicit, engine, memory) {
  if (typeof explicit === 'function') {
    return { owner: null, method: explicit }
  }

  if (isRecord(explicit)) {
    const explicitMethod = resolveMethod(explicit, ['check', 'get', 'evaluate', 'isDue', 'shouldRun'])
    if (explicitMethod) return explicitMethod
  }

  return (
    resolveMethod(engine, ELIGIBILITY_METHODS) ??
    resolveMethod(memory, ELIGIBILITY_METHODS)
  )
}

function resolveRunner(explicit, engine) {
  if (typeof explicit === 'function') {
    return { owner: null, method: explicit }
  }

  if (isRecord(explicit)) {
    const explicitMethod = resolveMethod(explicit, RUN_METHODS)
    if (explicitMethod) return explicitMethod
  }

  if (typeof engine === 'function') return { owner: null, method: engine }
  return resolveMethod(engine, RUN_METHODS)
}

function normalizeEligibility(value) {
  if (typeof value === 'boolean') return { eligible: value }

  if (!isRecord(value)) {
    throw new TypeError('PET_DREAM_SCHEDULER_ELIGIBILITY_RESULT_INVALID')
  }

  const flag = ['eligible', 'due', 'shouldRun', 'ready']
    .map((key) => value[key])
    .find((candidate) => typeof candidate === 'boolean')

  if (typeof flag !== 'boolean') {
    if (value.status === 'due' || value.status === 'eligible') {
      return { ...value, eligible: true }
    }

    if (value.status === 'not-due' || value.status === 'ineligible') {
      return { ...value, eligible: false }
    }

    throw new TypeError('PET_DREAM_SCHEDULER_ELIGIBILITY_RESULT_INVALID')
  }

  return { ...value, eligible: flag }
}

function compactEligibility(value) {
  if (!isRecord(value)) return {}

  const result = {}
  for (const key of [
    'sourceCount',
    'rawSourceCount',
    'newSourceCount',
    'oldestCreatedAt',
    'oldestUnreflectedAt',
    'checkpoint',
    'reason',
  ]) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  return result
}

function compactAvailability(value) {
  if (!isRecord(value)) return {}

  const result = {}
  for (const key of ['reason', 'sample']) {
    if (value[key] !== undefined) result[key] = value[key]
  }
  return result
}

function skipped(reason, extra = {}) {
  return {
    status: 'skipped',
    schedulerStatus: 'skipped',
    due: false,
    reason,
    ...extra,
  }
}

function gateSkipped(gate, reason, extra = {}) {
  return skipped(reason, { schedulerGate: gate, ...extra })
}

function started(runResult, gate, force) {
  if (isRecord(runResult)) {
    return {
      ...runResult,
      schedulerStatus: 'started',
      schedulerGate: gate,
      schedulerDue: true,
      force,
    }
  }

  return {
    status: 'started',
    schedulerStatus: 'started',
    schedulerGate: gate,
    schedulerDue: true,
    force,
    result: runResult,
  }
}

function runSucceeded(value) {
  if (value === false) return false
  if (!isRecord(value)) return true
  if (value.ok === false || value.unavailable === true || value.success === false) return false

  return ![
    'skipped',
    'deferred-owner-busy',
    'failed',
    'error',
    'unavailable',
  ].includes(value.status)
}

function localMinutes(timestamp, timeZone = null) {
  if (!timeZone) {
    const date = new Date(timestamp)
    return date.getHours() * 60 + date.getMinutes()
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  const hour = Number(parts.find(({ type }) => type === 'hour')?.value)
  const minute = Number(parts.find(({ type }) => type === 'minute')?.value)

  if (![hour, minute].every(Number.isFinite)) {
    throw new Error('PET_DREAM_SCHEDULER_LOCAL_TIME_INVALID')
  }

  return hour * 60 + minute
}

function isNight(timestamp, timeZone) {
  const minutes = localMinutes(timestamp, timeZone)
  return minutes >= DEEP_DREAM_NIGHT_START_MINUTES || minutes < DEEP_DREAM_NIGHT_END_MINUTES
}

function sleepSinceFromState(state) {
  if (!isRecord(state)) return null

  for (const key of ['sleepSince', 'sleep_since', 'sleepStartedAt', 'sleep_started_at']) {
    const timestamp = parseTimestamp(state[key])
    if (timestamp !== null) return timestamp
  }

  return null
}

/**
 * Owns the RAM-only automatic Dream trigger gate.
 *
 * The eligibility provider must perform the 8-new-or-72-hour check.  Its
 * canonical signature is:
 *
 *   ({ now, minNewMemories, oldestSourceAgeMs, maxUnprocessedAgeMs })
 *     -> { eligible, sourceCount?, oldestCreatedAt?, reason? }
 *
 * The engine runner's canonical signature is:
 *
 *   ({ force }) -> Promise<result>
 *
 * `engine` may implement both contracts.  The optional `eligibility` and
 * `run` arguments allow Root to inject adapters without making this module
 * know about PetMemory or DreamEngine internals.
 */
export class DreamScheduler {
  constructor({
    engine = null,
    memory = null,
    brain = null,
    eligibility = null,
    run = null,
    reflectionEngine = null,
    microReflectionEngine = null,
    reflectionMemory = null,
    reflectionEligibility = null,
    microReflectionEligibility = null,
    deepDreamEligibility = null,
    reflectionRun = null,
    microReflectionRun = null,
    now = null,
    clock = null,
    timeZone = null,
    ownerBusyCooldownMs = null,
    cooldownMs = null,
    reflectionMinIntervalMs = null,
    reflectionIntervalMs = null,
    deepDreamSuccessCooldownMs = null,
    deepDreamCooldownMs = null,
    availableSince = null,
    sleepSince = null,
    lastReflectionAt = null,
  } = {}) {
    this.engine = engine
    this.memory = memory
    this.brain = brain
    this.eligibility = eligibility
    this.run = run
    this.reflectionEngine = reflectionEngine ?? microReflectionEngine
    this.reflectionMemory = reflectionMemory
    this.reflectionEligibility = reflectionEligibility ?? microReflectionEligibility
    this.deepDreamEligibility = deepDreamEligibility
    this.reflectionRun = reflectionRun ?? microReflectionRun
    this.clock = typeof now === 'function'
      ? now
      : typeof clock === 'function'
        ? clock
        : () => Date.now()
    this.timeZone = timeZone

    const requestedCooldown = ownerBusyCooldownMs ?? cooldownMs
    this.ownerBusyCooldownMs = Number.isFinite(Number(requestedCooldown))
      ? Math.max(DREAM_OWNER_BUSY_COOLDOWN_MS, Number(requestedCooldown))
      : DREAM_OWNER_BUSY_COOLDOWN_MS

    const requestedReflectionInterval = reflectionMinIntervalMs ?? reflectionIntervalMs
    this.reflectionMinIntervalMs = Number.isFinite(Number(requestedReflectionInterval))
      ? Math.max(REFLECTION_MIN_INTERVAL_MS, Number(requestedReflectionInterval))
      : REFLECTION_MIN_INTERVAL_MS

    const requestedDeepCooldown = deepDreamSuccessCooldownMs ?? deepDreamCooldownMs
    this.deepDreamSuccessCooldownMs = Number.isFinite(Number(requestedDeepCooldown))
      ? Math.max(DEEP_DREAM_SUCCESS_COOLDOWN_MS, Number(requestedDeepCooldown))
      : DEEP_DREAM_SUCCESS_COOLDOWN_MS

    // These fields are intentionally not persisted.  PetRuntime owns the
    // durable state; scheduler cooldown is only a local anti-probe debounce.
    this.inFlight = false
    this.reflectionInFlight = false
    this.nextAttemptAt = null
    this.deepDreamNextAttemptAt = null
    this.lastReflectionAt = parseTimestamp(lastReflectionAt)
    this.availableSince = parseTimestamp(availableSince)
    this.sleepSince = parseTimestamp(sleepSince)
    this.lastObservedState = null
  }

  get dreamInFlight() {
    return this.inFlight
  }

  get deepDreamInFlight() {
    return this.inFlight
  }

  get reflectionBusy() {
    return this.reflectionInFlight
  }

  getNextAttemptAt() {
    return this.nextAttemptAt
  }

  getDeepDreamNextAttemptAt() {
    return this.deepDreamNextAttemptAt
  }

  getReflectionLastRunAt() {
    return this.lastReflectionAt
  }

  observeState({ state = null, now = undefined } = {}) {
    const timestamp = normalizeTime(now, this.clock)
    const current = typeof state === 'string' ? state : state?.current
    const observedSleepSince = this.#observeSleep(state, current, timestamp)

    return {
      current,
      sleepSince: observedSleepSince,
      availableSince: this.availableSince,
    }
  }

  async maybeRun({
    state = null,
    chatInFlight = 0,
    dreamInFlight = false,
    reflectionInFlight = false,
    force = false,
    now = undefined,
  } = {}) {
    const forced = force === true

    if (this.inFlight || isChatBusy(dreamInFlight)) {
      return skipped('dream-in-flight')
    }

    if (this.reflectionInFlight || isChatBusy(reflectionInFlight)) {
      return skipped('reflection-in-flight')
    }

    if (isChatBusy(chatInFlight)) {
      return skipped('chat-in-flight')
    }

    const current = typeof state === 'string' ? state : state?.current
    if (!forced && current !== 'sleep') {
      return skipped('not-sleep')
    }

    const timestamp = normalizeTime(now, this.clock)

    // A force run deliberately does not bypass the owner-busy cooldown.  It
    // skips only the sleep/threshold eligibility gates, as specified.
    if (this.nextAttemptAt !== null && timestamp < this.nextAttemptAt) {
      return skipped('owner-busy-cooldown', {
        nextAttemptAt: this.nextAttemptAt,
      })
    }

    if (this.deepDreamNextAttemptAt !== null && timestamp < this.deepDreamNextAttemptAt) {
      return skipped('deep-dream-cooldown', {
        nextAttemptAt: this.deepDreamNextAttemptAt,
      })
    }

    // Set this before any await, including the eligibility provider, so two
    // tick() calls cannot both pass the gate and launch Dream.
    this.inFlight = true

    try {
      let eligibilityResult = { eligible: true, forced: true }

      if (!forced) {
        const eligibility = resolveEligibility(this.eligibility, this.engine, this.memory)
        if (!eligibility) {
          throw new Error('PET_DREAM_SCHEDULER_ELIGIBILITY_CONTRACT_MISSING')
        }

        eligibilityResult = normalizeEligibility(await eligibility.method.call(eligibility.owner, {
          now: timestamp,
          minNewMemories: DREAM_MIN_NEW_MEMORIES,
          oldestSourceAgeMs: DREAM_OLDEST_SOURCE_AGE_MS,
          maxUnprocessedAgeMs: DREAM_MAX_UNPROCESSED_AGE_MS,
        }))

        if (!eligibilityResult.eligible) {
          return skipped(eligibilityResult.reason ?? 'eligibility-threshold-not-met', {
            ...compactEligibility(eligibilityResult),
          })
        }
      }

      const availability = await this.#checkAvailability(timestamp)
      if (!availability.available) {
        // If the caller did not supply a logical test time, take the clock
        // again after the asynchronous probe so the cooldown starts at the
        // actual busy observation, not at an earlier tick timestamp.
        const busyAt = now === undefined
          ? normalizeTime(undefined, this.clock)
          : timestamp
        this.nextAttemptAt = Math.max(timestamp, busyAt) + this.ownerBusyCooldownMs
        return {
          status: 'deferred-owner-busy',
          schedulerStatus: 'deferred-owner-busy',
          due: false,
          reason: availability.reason ?? 'owner-busy',
          nextAttemptAt: this.nextAttemptAt,
          ...compactAvailability(availability),
        }
      }

      // A successful resource probe clears only this RAM debounce.  The
      // durable Dream checkpoint remains exclusively under DreamEngine.
      this.nextAttemptAt = null

      const runner = resolveRunner(this.run, this.engine)
      if (!runner) throw new Error('PET_DREAM_SCHEDULER_RUN_CONTRACT_MISSING')

      const runResult = await runner.method.call(runner.owner, { force: forced })

      if (runSucceeded(runResult)) {
        this.deepDreamNextAttemptAt = this.#completionTime(timestamp, now) + this.deepDreamSuccessCooldownMs
      }

      if (isRecord(runResult)) {
        return {
          ...runResult,
          schedulerStatus: 'started',
          schedulerDue: true,
          force: forced,
        }
      }

      return {
        status: 'started',
        schedulerStatus: 'started',
        schedulerDue: true,
        force: forced,
        result: runResult,
      }
    } finally {
      this.inFlight = false
    }
  }

  async runNow(options = {}) {
    return this.maybeRun({ ...options, force: true })
  }

  async forceRun(options = {}) {
    return this.runNow(options)
  }

  /**
   * Strict Deep Dream gate used by the new Root integration. The legacy
   * maybeRun()/runNow() methods above intentionally retain their old trigger
   * policy for existing callers and tests.
   */
  async maybeRunDeepDream({
    state = null,
    chatInFlight = 0,
    dreamInFlight = false,
    deepDreamInFlight = false,
    reflectionInFlight = false,
    force = false,
    sleepSince = undefined,
    availableSince = undefined,
    now = undefined,
  } = {}) {
    const forced = force === true

    if (this.inFlight || isChatBusy(dreamInFlight) || isChatBusy(deepDreamInFlight)) {
      return gateSkipped('deep-dream', 'dream-in-flight')
    }

    if (this.reflectionInFlight || isChatBusy(reflectionInFlight)) {
      return gateSkipped('deep-dream', 'reflection-in-flight')
    }

    if (isChatBusy(chatInFlight)) {
      return gateSkipped('deep-dream', 'chat-in-flight')
    }

    const timestamp = normalizeTime(now, this.clock)

    if (this.nextAttemptAt !== null && timestamp < this.nextAttemptAt) {
      return gateSkipped('deep-dream', 'owner-busy-cooldown', {
        nextAttemptAt: this.nextAttemptAt,
      })
    }

    if (this.deepDreamNextAttemptAt !== null && timestamp < this.deepDreamNextAttemptAt) {
      return gateSkipped('deep-dream', 'deep-dream-cooldown', {
        nextAttemptAt: this.deepDreamNextAttemptAt,
      })
    }

    // Set before every await, including eligibility, to close the race
    // between two ticks entering the same gate.
    this.inFlight = true

    try {
      if (sleepSince !== undefined) this.sleepSince = parseTimestamp(sleepSince)
      if (availableSince !== undefined) this.availableSince = parseTimestamp(availableSince)

      const current = typeof state === 'string' ? state : state?.current
      const observedSleepSince = this.#observeSleep(state, current, timestamp)

      if (!forced && current !== 'sleep') {
        return gateSkipped('deep-dream', 'not-sleep')
      }

      if (
        !forced &&
        (observedSleepSince === null || timestamp - observedSleepSince < DEEP_DREAM_MIN_SLEEP_MS)
      ) {
        return gateSkipped('deep-dream', 'sleep-duration-not-met', {
          sleepSince: observedSleepSince,
        })
      }

      let eligibilityResult = { eligible: true, forced: true }
      if (!forced) {
        const eligibility = resolveContract(
          this.deepDreamEligibility ?? this.eligibility,
          [this.engine, this.memory],
          ELIGIBILITY_METHODS,
          ['check', 'get', 'evaluate', 'isDue', 'shouldRun'],
        )
        if (!eligibility) throw new Error('PET_DREAM_SCHEDULER_ELIGIBILITY_CONTRACT_MISSING')

        eligibilityResult = normalizeEligibility(await eligibility.method.call(eligibility.owner, {
          now: timestamp,
          minNewMemories: DREAM_MIN_NEW_MEMORIES,
          oldestSourceAgeMs: DREAM_OLDEST_SOURCE_AGE_MS,
          maxUnprocessedAgeMs: DREAM_MAX_UNPROCESSED_AGE_MS,
        }))

        if (!eligibilityResult.eligible) {
          return gateSkipped('deep-dream', eligibilityResult.reason ?? 'eligibility-threshold-not-met', {
            ...compactEligibility(eligibilityResult),
          })
        }
      }

      const availability = await this.#checkAvailability(timestamp)
      if (!availability.available) {
        return this.#deferOwnerBusy('deep-dream', timestamp, now, availability)
      }

      // A daytime nap is allowed only after 45 minutes of continuously
      // observed availability. Night runs need the successful probe above,
      // but not this daytime streak.
      if (!forced && !isNight(timestamp, this.timeZone)) {
        const availableFor = this.availableSince === null
          ? 0
          : Math.max(0, timestamp - this.availableSince)

        if (availableFor < DEEP_DREAM_DAYTIME_AVAILABILITY_MS) {
          return gateSkipped('deep-dream', 'daytime-availability-not-met', {
            availableSince: this.availableSince,
          })
        }
      }

      this.nextAttemptAt = null
      const runner = resolveRunner(this.run, this.engine)
      if (!runner) throw new Error('PET_DREAM_SCHEDULER_RUN_CONTRACT_MISSING')

      const runResult = await runner.method.call(runner.owner, { force: forced })
      if (runSucceeded(runResult)) {
        this.deepDreamNextAttemptAt = this.#completionTime(timestamp, now) + this.deepDreamSuccessCooldownMs
      }

      return started(runResult, 'deep-dream', forced)
    } finally {
      this.inFlight = false
    }
  }

  async runDeepDreamNow(options = {}) {
    return this.maybeRunDeepDream({ ...options, force: true })
  }

  async forceDeepDream(options = {}) {
    return this.runDeepDreamNow(options)
  }

  /**
   * Independent Micro Reflection gate. Its source/age decision is delegated
   * to reflectionEligibility or the reflection engine/memory adapter.
   */
  async maybeRunReflection({
    state = null,
    chatInFlight = 0,
    reflectionInFlight = false,
    deepDreamInFlight = false,
    dreamInFlight = false,
    force = false,
    now = undefined,
  } = {}) {
    const forced = force === true

    if (this.reflectionInFlight || isChatBusy(reflectionInFlight)) {
      return gateSkipped('reflection', 'reflection-in-flight')
    }

    if (this.inFlight || isChatBusy(deepDreamInFlight) || isChatBusy(dreamInFlight)) {
      return gateSkipped('reflection', 'dream-in-flight')
    }

    if (isChatBusy(chatInFlight)) {
      return gateSkipped('reflection', 'chat-in-flight')
    }

    const current = typeof state === 'string' ? state : state?.current
    if (!forced && !REFLECTION_STATE_SET.has(current)) {
      return gateSkipped('reflection', 'reflection-state-not-allowed')
    }

    const timestamp = normalizeTime(now, this.clock)

    if (this.nextAttemptAt !== null && timestamp < this.nextAttemptAt) {
      return gateSkipped('reflection', 'owner-busy-cooldown', {
        nextAttemptAt: this.nextAttemptAt,
      })
    }

    if (
      this.lastReflectionAt !== null &&
      timestamp - this.lastReflectionAt < this.reflectionMinIntervalMs
    ) {
      return gateSkipped('reflection', 'reflection-min-interval', {
        nextAttemptAt: this.lastReflectionAt + this.reflectionMinIntervalMs,
      })
    }

    this.reflectionInFlight = true

    try {
      let eligibilityResult = { eligible: true, forced: true }
      if (!forced) {
        const eligibility = resolveContract(
          this.reflectionEligibility,
          [this.reflectionEngine, this.reflectionMemory, this.engine, this.memory],
          REFLECTION_ELIGIBILITY_METHODS,
          ['check', 'get', 'evaluate', 'isDue', 'shouldRun'],
        )
        if (!eligibility) throw new Error('PET_REFLECTION_SCHEDULER_ELIGIBILITY_CONTRACT_MISSING')

        eligibilityResult = normalizeEligibility(await eligibility.method.call(eligibility.owner, {
          now: timestamp,
          minNewMemories: REFLECTION_MIN_NEW_RAW_MEMORIES,
          minNewRawMemories: REFLECTION_MIN_NEW_RAW_MEMORIES,
          oldestUnreflectedAgeMs: REFLECTION_OLDEST_UNREFLECTED_AGE_MS,
        }))

        if (!eligibilityResult.eligible) {
          return gateSkipped('reflection', eligibilityResult.reason ?? 'reflection-threshold-not-met', {
            ...compactEligibility(eligibilityResult),
          })
        }
      }

      const availability = await this.#checkAvailability(timestamp)
      if (!availability.available) {
        return this.#deferOwnerBusy('reflection', timestamp, now, availability)
      }

      this.nextAttemptAt = null
      const runner = resolveContract(
        this.reflectionRun,
        [this.reflectionEngine],
        REFLECTION_RUN_METHODS,
        REFLECTION_RUN_METHODS,
      )
      if (!runner) throw new Error('PET_REFLECTION_SCHEDULER_RUN_CONTRACT_MISSING')

      const runResult = await runner.method.call(runner.owner, { force: forced })
      if (runSucceeded(runResult)) {
        this.lastReflectionAt = this.#completionTime(timestamp, now)
      }

      return started(runResult, 'reflection', forced)
    } finally {
      this.reflectionInFlight = false
    }
  }

  async runReflectionNow(options = {}) {
    return this.maybeRunReflection({ ...options, force: true })
  }

  async forceReflection(options = {}) {
    return this.runReflectionNow(options)
  }

  async #checkAvailability(timestamp) {
    if (!this.brain || typeof this.brain.checkAvailability !== 'function') {
      this.availableSince = null
      return { available: false, reason: 'brain-availability-contract-missing' }
    }

    try {
      const value = await this.brain.checkAvailability()
      const availability = value === true
        ? { available: true }
        : value === false
          ? { available: false, reason: 'owner-busy' }
          : isRecord(value)
            ? {
                ...value,
                available: value.available === true,
                reason: value.reason ?? (value.available === true ? 'available' : 'owner-busy'),
              }
            : { available: false, reason: 'owner-busy' }

      if (!availability.available) {
        // This is the only transition that clears the daytime nap streak.
        this.availableSince = null
      } else if (this.availableSince === null || timestamp < this.availableSince) {
        this.availableSince = timestamp
      }

      return availability
    } catch {
      // Availability is a fail-closed resource gate.  Do not start Dream if
      // the shared Local Brain cannot prove that it is available.
      this.availableSince = null
    }

    return { available: false, reason: 'owner-busy' }
  }

  #deferOwnerBusy(gate, timestamp, suppliedNow, availability) {
    this.availableSince = null

    const busyAt = suppliedNow === undefined
      ? Math.max(timestamp, normalizeTime(undefined, this.clock))
      : timestamp
    const candidate = busyAt + this.ownerBusyCooldownMs
    this.nextAttemptAt = this.nextAttemptAt === null
      ? candidate
      : Math.max(this.nextAttemptAt, candidate)

    return {
      status: 'deferred-owner-busy',
      schedulerStatus: 'deferred-owner-busy',
      schedulerGate: gate,
      due: false,
      reason: availability.reason ?? 'owner-busy',
      nextAttemptAt: this.nextAttemptAt,
      ...compactAvailability(availability),
    }
  }

  #completionTime(timestamp, suppliedNow) {
    if (suppliedNow !== undefined) return timestamp
    return Math.max(timestamp, normalizeTime(undefined, this.clock))
  }

  #observeSleep(state, current, timestamp) {
    if (current !== 'sleep') {
      this.sleepSince = null
      this.lastObservedState = current
      return null
    }

    const suppliedSleepSince = sleepSinceFromState(state)
    if (suppliedSleepSince !== null) {
      this.sleepSince = suppliedSleepSince
    } else if (
      this.sleepSince === null ||
      this.lastObservedState !== 'sleep' ||
      timestamp < this.sleepSince
    ) {
      // Root can omit sleepSince if it calls observeState/ticks throughout a
      // sleep episode; the scheduler then tracks the start in RAM.
      this.sleepSince = timestamp
    }

    this.lastObservedState = current
    return this.sleepSince
  }
}
