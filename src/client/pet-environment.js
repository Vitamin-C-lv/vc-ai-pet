import { normalizePetVisualConfig } from './pet-visual-state.js'

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function defaultVisibility() {
  return globalThis.document?.visibilityState ?? 'visible'
}

export function isNightTime(now = Date.now(), config = {}) {
  const visualConfig = normalizePetVisualConfig(config)
  const hour = new Date(now).getHours()
  const { nightStartHour: start, nightEndHour: end } = visualConfig

  if (start === end) return false
  return start > end
    ? hour >= start || hour < end
    : hour >= start && hour < end
}

/**
 * Safe, read-only presence labels. The detector deliberately reads only the
 * clock, public pet timestamps, in-memory request flags, and page visibility.
 * It never observes window titles, document contents, clipboard, or files.
 */
export function createPetEnvironment({
  petState = null,
  chatPending = false,
  dreamRunning = false,
  visibilityState = defaultVisibility(),
  config = {},
  now = Date.now(),
} = {}) {
  const visualConfig = normalizePetVisualConfig(config)
  const lastInteractionAt = timestamp(petState?.lastInteractionAt)
    ?? timestamp(petState?.bornAt)
    ?? now
  const inactiveForMs = Math.max(0, now - lastInteractionAt)
  const longTimeNoInteraction = inactiveForMs >= visualConfig.inactivitySleepMinutes * 60_000
  const nightTime = isNightTime(now, visualConfig)

  return {
    nightTime,
    longTimeNoInteraction,
    chatPending: Boolean(chatPending),
    dreamRunning: Boolean(dreamRunning),
    ownerWorking: Boolean(!nightTime && longTimeNoInteraction && visibilityState === 'visible'),
  }
}
