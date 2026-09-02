export const PET_VISUAL_STATES = Object.freeze([
  'idle',
  'thinking',
  'happy',
  'excited',
  'relaxed',
  'waiting',
  'curious',
  'confused',
  'sleep',
  'dreaming',
  'walk',
])

export const DEFAULT_PET_VISUAL_CONFIG = Object.freeze({
  nightStartHour: 23,
  nightEndHour: 6,
  inactivitySleepMinutes: 30,
  happyDurationMs: 2_500,
  excitedDurationMs: 1_700,
  relaxedDurationMs: 3_200,
  confusedDurationMs: 2_000,
  thinkingPulseMs: 700,
  walkFrameMs: 150,
  longPressMs: 700,
  interactionBurstWindowMs: 30_000,
  waitingAfterInteractionMinutes: 30,
  idleActionMinMs: 20_000,
  idleActionMaxMs: 60_000,
  idleActionDurationMs: 1_800,
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
  return ['excited', 'happy', 'relaxed', 'curious', 'confused'].includes(feedback.kind)
    ? feedback.kind
    : null
}

function recentInteraction(state, now, windowMs) {
  if (state?.lastInteractionAt === null || state?.lastInteractionAt === undefined || state?.lastInteractionAt === '') return false
  const lastInteractionAt = Number(state?.lastInteractionAt)
  if (!Number.isFinite(lastInteractionAt)) return false
  return now >= lastInteractionAt && now - lastInteractionAt <= windowMs
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
    relaxedDurationMs: boundedNumber(source.relaxedDurationMs, DEFAULT_PET_VISUAL_CONFIG.relaxedDurationMs, 250, 30_000),
    confusedDurationMs: boundedNumber(source.confusedDurationMs, DEFAULT_PET_VISUAL_CONFIG.confusedDurationMs, 250, 30_000),
    thinkingPulseMs: boundedNumber(source.thinkingPulseMs, DEFAULT_PET_VISUAL_CONFIG.thinkingPulseMs, 120, 10_000),
    walkFrameMs: boundedNumber(source.walkFrameMs, DEFAULT_PET_VISUAL_CONFIG.walkFrameMs, 80, 5_000),
    longPressMs: boundedNumber(source.longPressMs, DEFAULT_PET_VISUAL_CONFIG.longPressMs, 350, 2_000),
    interactionBurstWindowMs: boundedNumber(source.interactionBurstWindowMs, DEFAULT_PET_VISUAL_CONFIG.interactionBurstWindowMs, 5_000, 120_000),
    waitingAfterInteractionMinutes: boundedNumber(source.waitingAfterInteractionMinutes, DEFAULT_PET_VISUAL_CONFIG.waitingAfterInteractionMinutes, 1, 24 * 60),
    idleActionMinMs: boundedNumber(source.idleActionMinMs, DEFAULT_PET_VISUAL_CONFIG.idleActionMinMs, 5_000, 10 * 60_000),
    idleActionMaxMs: boundedNumber(source.idleActionMaxMs, DEFAULT_PET_VISUAL_CONFIG.idleActionMaxMs, 5_000, 10 * 60_000),
    idleActionDurationMs: boundedNumber(source.idleActionDurationMs, DEFAULT_PET_VISUAL_CONFIG.idleActionDurationMs, 250, 10_000),
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
  emotion = null,
  config = DEFAULT_PET_VISUAL_CONFIG,
  now = Date.now(),
} = {}) {
  const visualConfig = normalizePetVisualConfig(config)
  const current = typeof petState?.current === 'string' ? petState.current : 'idle'
  const recentInteractionWindow = visualConfig.waitingAfterInteractionMinutes * 60_000
  const hasRecentInteraction = typeof environment.recentInteraction === 'boolean'
    ? environment.recentInteraction
    : recentInteraction(petState, now, recentInteractionWindow)

  if (environment.dreamRunning) return 'dreaming'
  if (environment.chatPending || current === 'thinking') return 'thinking'

  const feedbackKind = activeFeedbackKind(feedback, now)
  if (feedbackKind === 'excited' || emotion?.burstLevel === 'excited' || current === 'excited') return 'excited'
  if (feedbackKind === 'happy' || (current === 'happy' && recentInteraction(petState, now, visualConfig.happyDurationMs))) return 'happy'
  if (feedbackKind === 'relaxed' || current === 'relaxed' || current === 'rest') return 'relaxed'

  // Waiting is intentionally quiet: it is only visible when the chat bubble
  // is closed and the owner interacted recently. It never emits text.
  if (environment.chatOpen === false && hasRecentInteraction) return 'waiting'

  if (feedbackKind === 'confused' || emotion?.burstLevel === 'confused' || current === 'confused') return 'confused'
  if (feedbackKind === 'curious' || emotion?.burstLevel === 'curious' || current === 'curious') return 'curious'

  if (environment.nightTime && environment.longTimeNoInteraction) return 'sleep'
  if (current === 'sleep' || current === 'sleepy') return 'sleep'

  // A visible-but-inactive DSH window is only a weak owner-working hint. Keep
  // the pet quiet instead of letting the existing idle state machine wander.
  if (current === 'walk' && !environment.ownerWorking) return 'walk'

  return 'idle'
}
