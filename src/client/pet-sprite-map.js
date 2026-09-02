import { SPRITES } from './sprite-catalog.js'

export const PET_SPRITE_MAP = Object.freeze({
  idle: Object.freeze([SPRITES.idle, SPRITES['idle-3q'], SPRITES.blink]),
  happy: Object.freeze([SPRITES.playbow, SPRITES.jump]),
  thinking: Object.freeze([SPRITES.curious, SPRITES.surprised]),
  sleep: Object.freeze([SPRITES['sleep-curled'], SPRITES['sleep-side']]),
  dreaming: Object.freeze([SPRITES['sleep-curled'], SPRITES['sleep-side']]),
  excited: Object.freeze([SPRITES.jump, SPRITES.playbow]),
  walk: Object.freeze([
    'walk-right-1.png',
    'walk-right-2.png',
    'walk-right-3.png',
    'walk-right-4.png',
    'walk-right-5.png',
    'walk-right-6.png',
  ]),
})

export function spriteForVisualState(visualState, frame = 0) {
  const frames = PET_SPRITE_MAP[visualState] ?? PET_SPRITE_MAP.idle
  const index = Math.abs(Math.trunc(Number(frame) || 0)) % frames.length
  return frames[index]
}

export function spriteFramesForVisualState(visualState) {
  return PET_SPRITE_MAP[visualState] ?? PET_SPRITE_MAP.idle
}
