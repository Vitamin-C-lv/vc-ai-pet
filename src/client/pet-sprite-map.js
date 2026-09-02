import { SPRITES } from './sprite-catalog.js'

export const PET_SPRITE_MAP = Object.freeze({
  idle: Object.freeze([SPRITES.idle, SPRITES['idle-3q'], SPRITES.blink]),
  happy: Object.freeze([SPRITES.playbow, SPRITES.jump]),
  thinking: Object.freeze([SPRITES.curious, SPRITES.surprised]),
  excited: Object.freeze([SPRITES.jump, SPRITES.playbow]),
  relaxed: Object.freeze([SPRITES['rest-curled'], SPRITES['rest-awake'], SPRITES.stretch]),
  waiting: Object.freeze([SPRITES.sit, SPRITES['idle-3q'], SPRITES.blink]),
  curious: Object.freeze([SPRITES.curious, SPRITES['idle-3q'], SPRITES.surprised]),
  confused: Object.freeze([SPRITES.curious, SPRITES.surprised, SPRITES['idle-3q']]),
  sleep: Object.freeze([SPRITES['sleep-curled'], SPRITES['sleep-side']]),
  dreaming: Object.freeze([SPRITES['sleep-curled'], SPRITES['sleep-side']]),
  walk: Object.freeze([
    'walk-right-1.png',
    'walk-right-2.png',
    'walk-right-3.png',
    'walk-right-4.png',
    'walk-right-5.png',
    'walk-right-6.png',
  ]),
})

const IDLE_ACTION_SPRITES = Object.freeze({
  blink: SPRITES.blink,
  stretch: SPRITES.stretch,
  yawn: SPRITES.sleepy,
  look_around: SPRITES['idle-3q'],
  change_pose: SPRITES.sit,
})

export function spriteForVisualState(visualState, frame = 0, idleAction = null) {
  if (visualState === 'idle' && IDLE_ACTION_SPRITES[idleAction]) return IDLE_ACTION_SPRITES[idleAction]
  const frames = PET_SPRITE_MAP[visualState] ?? PET_SPRITE_MAP.idle
  const index = Math.abs(Math.trunc(Number(frame) || 0)) % frames.length
  return frames[index]
}

export function spriteFramesForVisualState(visualState) {
  return PET_SPRITE_MAP[visualState] ?? PET_SPRITE_MAP.idle
}
