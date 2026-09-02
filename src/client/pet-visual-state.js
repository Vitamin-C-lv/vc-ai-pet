export const PET_VISUAL_STATES = Object.freeze([
  'idle',
  'happy',
  'thinking',
  'sleep',
  'dreaming',
  'excited',
  'walk',
])

export const DEFAULT_PET_VISUAL_CONFIG = Object.freeze({
  nightStartHour: 23,
  nightEndHour: 6,
  inactivitySleepMinutes: 30,
  happyDurationMs: 2_500,
  excitedDurationMs: 1_700,
  thinkingPulseMs: 700,
  walkFrameMs: 150,
  zzzEnabled: true,
  ambientMoveEnabled: true,
})

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function activeFeedbackKind(feedback, now) {
  if (!feedback || typeof feedback !== 'object') return null
  const until = Number(feedback.until)
  if (!Number.isFinite(until) || until <= now) return null
  return feedback.kind === 'excited' || feedback.kind === 'happy'
    ? feedback.kind
    : null
}

function recentInteraction(state, now, config) {
  if (state?.lastInteractionAt === null || state?.lastInteractionAt === undefined || state?.lastInteractionAt === '') return false
  const lastInteractionAt = Number(state?.lastInteractionAt)
  if (!Number.isFinite(lastInteractionAt)) return false
  return now >= lastInteractionAt && now - lastInteractionAt <= config.happyDurationMs
}

/**
 * Normalizes the small, UI-only configuration surface shared by the host and
 * browser overlay. It deliberately contains no brain, memory, or Dream gate
 * settings.
 */
export function normalizePetVisualConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {}

  return {
    nightStartHour: boundedNumber(source.nightStartHour, DEFAULT_PET_VISUAL_CONFIG.nightStartHour, 0, 23),
    nightEndHour: boundedNumber(source.nightEndHour, DEFAULT_PET_VISUAL_CONFIG.nightEndHour, 0, 23),
    inactivitySleepMinutes: boundedNumber(source.inactivitySleepMinutes, DEFAULT_PET_VISUAL_CONFIG.inactivitySleepMinutes, 1, 24 * 60),
    happyDurationMs: boundedNumber(source.happyDurationMs, DEFAULT_PET_VISUAL_CONFIG.happyDurationMs, 250, 30_000),
    excitedDurationMs: boundedNumber(source.excitedDurationMs, DEFAULT_PET_VISUAL_CONFIG.excitedDurationMs, 250, 30_000),
    thinkingPulseMs: boundedNumber(source.thinkingPulseMs, DEFAULT_PET_VISUAL_CONFIG.thinkingPulseMs, 120, 10_000),
    walkFrameMs: boundedNumber(source.walkFrameMs, DEFAULT_PET_VISUAL_CONFIG.walkFrameMs, 80, 5_000),
    zzzEnabled: boolean(source.zzzEnabled, DEFAULT_PET_VISUAL_CONFIG.zzzEnabled),
    ambientMoveEnabled: boolean(source.ambientMoveEnabled, DEFAULT_PET_VISUAL_CONFIG.ambientMoveEnabled),
  }
}

/**
 * Central visual-state priority. Environment flags are presentation-only;
 * this function never changes the persistent pet state or any brain input.
 */
export function resolvePetVisualState({
  petState = null,
  environment = {},
  feedback = null,
  config = DEFAULT_PET_VISUAL_CONFIG,
  now = Date.now(),
} = {}) {
  const visualConfig = normalizePetVisualConfig(config)
  const current = typeof petState?.current === 'string' ? petState.current : 'idle'

  if (environment.dreamRunning) return 'dreaming'
  if (environment.chatPending || current === 'thinking') return 'thinking'

  const feedbackKind = activeFeedbackKind(feedback, now)
  if (feedbackKind === 'excited' || current === 'excited') return 'excited'
  if (feedbackKind === 'happy' || (current === 'happy' && recentInteraction(petState, now, visualConfig))) return 'happy'

  if (environment.nightTime && environment.longTimeNoInteraction) return 'sleep'
  if (current === 'sleep' || current === 'sleepy') return 'sleep'

  // A visible-but-inactive DSH window is only a weak owner-working hint. Keep
  // the pet quiet instead of letting the existing idle state machine wander.
  if (current === 'walk' && !environment.ownerWorking) return 'walk'
  if (current === 'curious') return 'thinking'

  return 'idle'
}
