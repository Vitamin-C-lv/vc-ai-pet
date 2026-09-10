import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const source = await readFile(join(root, 'src/remote/mobile-ui/home-sprite-animations.js'), 'utf8')
const queued = []
let nextTimer = 0
const context = {
  setTimeout(callback, delay) {
    const task = { id: ++nextTimer, callback, delay, cleared: false }
    queued.push(task)
    return task.id
  },
  clearTimeout(id) {
    const task = queued.find((item) => item.id === id)
    if (task) task.cleared = true
  },
}
vm.createContext(context)
vm.runInContext(source, context, { filename: 'home-sprite-animations.js' })

for (const [state, animation] of Object.entries(context.VcAiPetHomeSpriteAnimations.HOME_SPRITE_ANIMATIONS)) {
  assert.equal(animation.frames.length, animation.durations.length, `${state} has one duration per frame`)
  assert.ok(animation.frames.length >= 4 && animation.frames.length <= 8, `${state} stays within the lightweight frame budget`)
  for (const frame of animation.frames) {
    await access(join(root, 'assets/runtime', frame.split('/').at(-1)))
  }
}

function fakeImage() {
  const listeners = new Map()
  return {
    src: '',
    currentSrc: '',
    addEventListener(type, callback) { listeners.set(type, callback) },
    trigger(type) { listeners.get(type)?.() },
    getAttribute() { return this.src },
  }
}

const image = fakeImage()
const errors = []
const animator = context.VcAiPetHomeSpriteAnimations.createHomeSpriteAnimator({
  image,
  reducedMotion: () => false,
  setTimer: context.setTimeout,
  clearTimer: context.clearTimeout,
  onFrameError: (error) => errors.push(error),
})

animator.setPresentation('idle', 'idle-front.png')
const first = image.src
const pendingAfterFirst = queued.filter((task) => !task.cleared).length
animator.setPresentation('idle', 'idle-3q.png')
assert.equal(image.src, first, 'same-state refresh keeps current animation frame')
assert.equal(queued.filter((task) => !task.cleared).length, pendingAfterFirst, 'same-state refresh does not start another loop')

animator.setPresentation('relaxed', 'rest-awake.png')
assert.match(image.src, /home-relaxed-01\.png$/u)
const stale = queued.find((task) => task.cleared)
stale.callback()
assert.match(image.src, /home-relaxed-01\.png$/u, 'cancelled state timer cannot overwrite the new state')

animator.setPresentation('happy', 'playbow.png')
animator.setPresentation('relaxed', 'rest-awake.png')
animator.setPresentation('happy', 'playbow.png')
assert.match(image.src, /home-happy-01\.png$/u, 'rapid A-to-B-to-A keeps the last returned visual state')

animator.setPresentation('unknown-state', 'idle-front.png')
assert.match(image.src, /idle-front\.png$/u, 'missing manifest uses backend sprite fallback')

animator.setPresentation('idle', 'idle-front.png')
image.currentSrc = image.src
image.trigger('error')
assert.match(image.src, /idle-front\.png$/u, 'frame error immediately falls back to backend sprite')
assert.equal(errors.length, 1)

const reducedImage = fakeImage()
const reduced = context.VcAiPetHomeSpriteAnimations.createHomeSpriteAnimator({
  image: reducedImage,
  reducedMotion: () => true,
  setTimer: context.setTimeout,
  clearTimer: context.clearTimeout,
})
reduced.setPresentation('relaxed', 'rest-awake.png')
assert.match(reducedImage.src, /rest-awake\.png$/u, 'reduced motion uses the canonical fallback frame')

animator.setPresentation('idle', 'idle-front.png')
animator.setActive(false)
assert.equal(animator.debug().running, false, 'leaving Home pauses the frame loop')
animator.setActive(true)
assert.equal(animator.debug().running, true, 'returning Home resumes the current state loop')

console.log('SAME_STATE_REFRESH_NO_RESTART=PASS')
console.log('STATE_TRANSITION_NO_STALE_TIMER=PASS')
console.log('INTERACTION_STATE_TRANSITION=PASS')
console.log('RAPID_STATE_A_B_A_NO_STALE_OVERWRITE=PASS')
console.log('SPRITE_FALLBACK=PASS')
console.log('REDUCED_MOTION=PASS')
console.log('HOME_NAVIGATION_PAUSE_RESUME=PASS')
