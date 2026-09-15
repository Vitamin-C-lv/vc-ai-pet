const MAPPINGS = Object.freeze({
  idle: ['idle', 'blink', 'idle', false, false],
  waiting: ['idle', 'blink', 'idle', false, false],
  relaxed: ['relaxed', 'stretch', 'idle', false, false],
  happy: ['happy', 'bounce', 'wag', false, false],
  excited: ['happy', 'bounce', 'wag', false, false],
  thinking: ['thinking', 'thinking', 'look', false, true],
  curious: ['curious', 'look', 'look', false, false],
  confused: ['confused', 'look', 'look', false, false],
  sleep: ['sleep', 'zzz', 'sleep', true, false],
  dreaming: ['dreaming', 'dream', 'sleep', true, false],
})

function normalizedEmotion(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

function isoTimestamp(value) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return new Date().toISOString()
}

function nonNegativeAge(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null
}

function offlinePresentation() {
  return {
    visualState: 'offline',
    emotion: { happiness: null, energy: null },
    dream: false,
    sleeping: false,
    thinking: false,
    speaking: false,
    avatar: 'lihuahua-default',
    expression: 'offline',
    animation: 'offline',
    actionCue: 'idle',
    speechText: null,
  }
}

export function mapPetStateToBodyContract(petState, {
  reachable = true,
  observedAt = new Date().toISOString(),
  stateAgeMs = 0,
} = {}) {
  const hasState = petState !== null && typeof petState === 'object' && !Array.isArray(petState)
  const isOnline = hasState
  let presentation = offlinePresentation()

  if (hasState) {
    const sourceVisualState = typeof petState.visualState === 'string' ? petState.visualState : 'unknown'
    const dream = petState.dream === true || sourceVisualState === 'dreaming'
    const mapping = dream
      ? MAPPINGS.dreaming
      : MAPPINGS[sourceVisualState] ?? MAPPINGS.idle
    const [expression, animation, actionCue, mappedSleeping, thinking] = mapping

    presentation = {
      visualState: sourceVisualState,
      emotion: {
        happiness: normalizedEmotion(petState.emotion?.happiness),
        energy: normalizedEmotion(petState.emotion?.energy),
      },
      dream,
      sleeping: mappedSleeping,
      thinking,
      speaking: false,
      avatar: 'lihuahua-default',
      expression,
      animation,
      actionCue,
      speechText: null,
    }
  }

  return {
    schemaVersion: 1,
    online: isOnline,
    reachable: isOnline && reachable === true,
    observedAt: isoTimestamp(observedAt),
    pet: { name: '李花花' },
    presentation,
    source: {
      kind: 'vc-ai-pet',
      stateAgeMs: isOnline ? nonNegativeAge(stateAgeMs) : null,
    },
  }
}
