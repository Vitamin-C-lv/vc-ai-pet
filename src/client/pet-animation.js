import { normalizePetVisualConfig } from './pet-visual-state.js'
import { spriteForVisualState } from './pet-sprite-map.js'

export function frameDelayForVisualState(visualState, config = {}) {
  const visualConfig = normalizePetVisualConfig(config)
  if (visualState === 'walk') return visualConfig.walkFrameMs
  if (visualState === 'thinking') return visualConfig.thinkingPulseMs
  if (visualState === 'happy' || visualState === 'excited') return 420
  if (visualState === 'relaxed') return 900
  if (visualState === 'confused' || visualState === 'curious') return 760
  if (visualState === 'waiting') return 2_200
  if (visualState === 'sleep' || visualState === 'dreaming') return 2_400
  return 2_800
}

export function nextVisualFrame(frame) {
  return (Math.max(0, Math.trunc(Number(frame) || 0)) + 1) % 60
}

export function spriteForAnimation(visualState, frame, idleAction = null) {
  return spriteForVisualState(visualState, frame, idleAction)
}
