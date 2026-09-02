import { normalizePetVisualConfig } from './pet-visual-state.js'
import { spriteForVisualState } from './pet-sprite-map.js'

export function frameDelayForVisualState(visualState, config = {}) {
  const visualConfig = normalizePetVisualConfig(config)
  if (visualState === 'walk') return visualConfig.walkFrameMs
  if (visualState === 'thinking') return visualConfig.thinkingPulseMs
  if (visualState === 'happy' || visualState === 'excited') return 420
  if (visualState === 'sleep' || visualState === 'dreaming') return 2_400
  return 2_800
}

export function nextVisualFrame(frame) {
  return (Math.max(0, Math.trunc(Number(frame) || 0)) + 1) % 60
}

export function spriteForAnimation(visualState, frame) {
  return spriteForVisualState(visualState, frame)
}
