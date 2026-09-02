/**
 * Momentary, browser-only emotion telemetry.
 *
 * This module intentionally has no persistence, host bridge, model, memory,
 * or conversation imports. Callers keep the returned object in React state
 * (or another in-memory store) and may discard it at any time.
 */

export const EMOTION_KEYS = Object.freeze([
  'happiness',
  'energy',
  'curiosity',
  'comfort',
  'attachment',
])

export const DEFAULT_EMOTION_STATE = Object.freeze({
  happiness: 0.5,
  energy: 0.7,
  curiosity: 0.4,
  comfort: 0.6,
  attachment: 0.5,
})

export const INTERACTION_BURST_WINDOW_MS = 30_000
export const INTERACTION_BURST_LEVELS = Object.freeze({
  idle: 'idle',
  happy: 'happy',
  excited: 'excited',
  confused: 'confused',
})

export const IDLE_ACTIONS = Object.freeze([
  Object.freeze({ kind: 'blink', probability: 0.35 }),
  Object.freeze({ kind: 'tail_move', probability: 0.25 }),
  Object.freeze({ kind: 'stretch', probability: 0.15 }),
  Object.freeze({ kind: 'yawn', probability: 0.10 }),
  Object.freeze({ kind: 'look_around', probability: 0.10 }),
  Object.freeze({ kind: 'change_pose', probability: 0.05 }),
])

const INTERACTION_DELTAS = Object.freeze({
  pet: Object.freeze({ happiness: 0.02, comfort: 0.02, attachment: 0.005 }),
  play: Object.freeze({ happiness: 0.05, energy: -0.02, attachment: 0.01 }),
  'long-press': Object.freeze({ comfort: 0.08, happiness: 0.03 }),
  // Chat is a user action, but deliberately carries no numeric emotion delta.
  // The visual response is initiated before the host/model request starts.
  chat: Object.freeze({}),
})

const numeric = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const clampEmotion = (value) => Math.max(0, Math.min(1, numeric(value, 0)))

function validTimestamp(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function compactInteractionTimes(times, now, windowMs) {
  const current = validTimestamp(now) ?? Date.now()
  const window = Math.max(1, numeric(windowMs, INTERACTION_BURST_WINDOW_MS))
  return (Array.isArray(times) ? times : [])
    .map(validTimestamp)
    .filter((time) => time !== null && time <= current && current - time <= window)
}

export function createEmotionState(initial = {}, now = Date.now(), { windowMs = INTERACTION_BURST_WINDOW_MS } = {}) {
  const source = initial && typeof initial === 'object' ? initial : {}
  const timestamp = validTimestamp(now) ?? Date.now()
  const interactionTimes = compactInteractionTimes(source.interactionTimes, timestamp, windowMs)

  return {
    ...DEFAULT_EMOTION_STATE,
    ...Object.fromEntries(EMOTION_KEYS.map((key) => [key, clampEmotion(source[key] ?? DEFAULT_EMOTION_STATE[key])])),
    interactionTimes,
    burstCount: interactionTimes.length,
    burstLevel: burstLevelForCount(interactionTimes.length),
    lastInteractionAt: validTimestamp(source.lastInteractionAt),
    lastEvent: typeof source.lastEvent === 'string' ? source.lastEvent : null,
    lastEventAt: validTimestamp(source.lastEventAt),
    lastUpdatedAt: validTimestamp(source.lastUpdatedAt) ?? timestamp,
    dreaming: source.dreaming === true,
  }
}

export function burstLevelForCount(count) {
  const value = Math.max(0, Math.trunc(numeric(count, 0)))
  if (value > 15) return INTERACTION_BURST_LEVELS.confused
  if (value > 5) return INTERACTION_BURST_LEVELS.excited
  if (value > 0) return INTERACTION_BURST_LEVELS.happy
  return INTERACTION_BURST_LEVELS.idle
}

export function interactionBurstCount(state, now = Date.now(), windowMs = INTERACTION_BURST_WINDOW_MS) {
  return compactInteractionTimes(state?.interactionTimes, now, windowMs).length
}

export function interactionBurstLevel(state, now = Date.now(), windowMs = INTERACTION_BURST_WINDOW_MS) {
  return burstLevelForCount(interactionBurstCount(state, now, windowMs))
}

function applyDeltas(state, deltas, now) {
  const current = createEmotionState(state, now)
  const next = { ...current }
  for (const key of EMOTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(deltas, key)) next[key] = clampEmotion(current[key] + numeric(deltas[key], 0))
  }
  return next
}

/** Apply one user-originated interaction and update only the RAM telemetry. */
export function applyInteractionEmotion(
  state,
  kind = 'pet',
  { now = Date.now(), windowMs = INTERACTION_BURST_WINDOW_MS } = {},
) {
  const current = createEmotionState(state, now, { windowMs })
  const timestamp = validTimestamp(now) ?? Date.now()
  const interactionTimes = compactInteractionTimes(current.interactionTimes, timestamp, windowMs)
  interactionTimes.push(timestamp)
  const next = applyDeltas(current, INTERACTION_DELTAS[kind] ?? INTERACTION_DELTAS.pet, timestamp)
  next.interactionTimes = interactionTimes
  next.burstCount = interactionTimes.length
  next.burstLevel = burstLevelForCount(next.burstCount)
  next.lastInteractionAt = timestamp
  next.lastEvent = kind
  next.lastEventAt = timestamp
  next.lastUpdatedAt = timestamp
  return next
}

/** A tiny time-only drift keeps the layer alive without becoming personality. */
export function advanceEmotion(state, now = Date.now(), { windowMs = INTERACTION_BURST_WINDOW_MS } = {}) {
  const current = createEmotionState(state, now, { windowMs })
  const timestamp = validTimestamp(now) ?? Date.now()
  const previous = validTimestamp(current.lastUpdatedAt) ?? timestamp
  const minutes = Math.max(0, Math.min((timestamp - previous) / 60_000, 240))
  if (minutes <= 0) return current

  const next = applyDeltas(current, {
    happiness: -minutes * 0.00035,
    comfort: -minutes * 0.00015,
    energy: -minutes * 0.0002,
    curiosity: minutes * 0.0001,
  }, timestamp)
  next.interactionTimes = compactInteractionTimes(current.interactionTimes, timestamp, windowMs)
  next.burstCount = next.interactionTimes.length
  next.burstLevel = burstLevelForCount(next.burstCount)
  next.lastUpdatedAt = timestamp
  return next
}

/** Keep the existing persistent attachment as a read-only initial/refresh hint. */
export function syncAttachment(state, attachment, now = Date.now()) {
  const current = createEmotionState(state, now)
  const value = Number(attachment)
  if (!Number.isFinite(value)) return current
  if (Math.abs(current.attachment - clampEmotion(value)) < 0.000001) return current
  return { ...current, attachment: clampEmotion(value), lastUpdatedAt: validTimestamp(now) ?? Date.now() }
}

/** Dream is a presentation source; this flag never changes persistent state. */
export function setDreaming(state, dreaming, now = Date.now()) {
  const current = createEmotionState(state, now)
  const value = dreaming === true
  return value === current.dreaming
    ? current
    : { ...current, dreaming: value, lastUpdatedAt: validTimestamp(now) ?? Date.now() }
}

/** Return the configured weighted action for a random sample in [0, 1). */
export function chooseIdleAction(random = Math.random()) {
  const sample = Math.max(0, Math.min(0.999999, numeric(random, 0)))
  let cursor = 0
  for (const action of IDLE_ACTIONS) {
    cursor += action.probability
    if (sample < cursor) return action.kind
  }
  return IDLE_ACTIONS[IDLE_ACTIONS.length - 1].kind
}

/** Map interaction semantics to a short-lived visual feedback state. */
export function visualFeedbackForInteraction(
  state,
  kind = 'pet',
  now = Date.now(),
  windowMs = INTERACTION_BURST_WINDOW_MS,
) {
  const burst = interactionBurstLevel(state, now, windowMs)
  if (burst === INTERACTION_BURST_LEVELS.confused) return 'confused'
  if (kind === 'long-press') return 'relaxed'
  if (kind === 'play' || burst === INTERACTION_BURST_LEVELS.excited) return 'excited'
  return 'happy'
}
