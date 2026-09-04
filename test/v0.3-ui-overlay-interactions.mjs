import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { advanceState, createInitialState, interact } from '../src/core/pet-state-engine.js'
import {
  advanceEmotion,
  applyInteractionEmotion,
  chooseIdleAction,
  createEmotionState,
  setDreaming,
  syncAttachment,
  visualFeedbackForInteraction,
} from '../src/client/emotion-state.js'
import { frameDelayForVisualState, nextVisualFrame, spriteForAnimation } from '../src/client/pet-animation.js'
import { createPetEnvironment } from '../src/client/pet-environment.js'
import { DEFAULT_PET_VISUAL_CONFIG, normalizePetVisualConfig, resolvePetVisualState } from '../src/client/pet-visual-state.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const overlaySource = await readFile(join(root, 'src/client/pet-overlay.js'), 'utf8')
const css = await readFile(join(root, 'src/client/pet.css'), 'utf8')
const overlayBody = overlaySource
  .replace(/^import[^\n]*\n/gm, '')
  .replace('export function createPetOverlay', 'function createPetOverlay')
  .concat('\nglobalThis.__createPetOverlay = createPetOverlay\n')

function flatten(value) {
  if (Array.isArray(value)) return value.flatMap(flatten)
  return value === null || value === undefined || value === false ? [] : [value]
}

function findElement(node, predicate) {
  for (const value of flatten(node)) {
    if (typeof value !== 'object') continue
    if (predicate(value)) return value
    const nested = findElement(value.children, predicate)
    if (nested) return nested
  }
  return null
}

async function flushAsyncWork() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function createOverlayHarness(bridge) {
  const hooks = []
  let cursor = 0
  let nextTimerId = 0
  const timers = new Map()

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: flatten(children) }
    },
    useState(initialValue) {
      const index = cursor++
      if (!hooks[index]) {
        hooks[index] = {
          value: typeof initialValue === 'function' ? initialValue() : initialValue,
        }
      }
      const setValue = (nextValue) => {
        hooks[index].value = typeof nextValue === 'function'
          ? nextValue(hooks[index].value)
          : nextValue
      }
      return [hooks[index].value, setValue]
    },
    useRef(initialValue) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: { current: initialValue } }
      return hooks[index].value
    },
    // Effects are intentionally not mounted here: event-level behavior is
    // isolated from host polling/timers and can be deterministic in Node.
    useEffect() { cursor++ },
  }

  const context = {
    React,
    advanceState,
    createInitialState,
    interact,
    advanceEmotion,
    applyInteractionEmotion,
    chooseIdleAction,
    createEmotionState,
    setDreaming,
    syncAttachment,
    visualFeedbackForInteraction,
    createPetEnvironment,
    frameDelayForVisualState,
    nextVisualFrame,
    spriteForAnimation,
    DEFAULT_PET_VISUAL_CONFIG,
    normalizePetVisualConfig,
    resolvePetVisualState,
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout(callback, delay) {
      const id = ++nextTimerId
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    setInterval() { return 0 },
    clearInterval() {},
  }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(overlayBody, context, { filename: 'pet-overlay.js' })
  const Overlay = context.__createPetOverlay({ assetBaseUrl: '/vc-ai-pet/assets', bridge })

  return {
    render() {
      cursor = 0
      return Overlay()
    },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue
        timers.delete(id)
        timer.callback()
      }
    },
  }
}

function petHitbox(tree) {
  const hitbox = findElement(tree, (element) => element.props?.['aria-label'] === '李花花 AI pet')
  assert.ok(hitbox, 'pet hitbox is rendered')
  return hitbox
}

function chatToggle(tree) {
  const toggle = findElement(tree, (element) => element.props?.['aria-label'] === '和李花花说话')
  assert.ok(toggle, 'chat toggle is rendered')
  return toggle
}

{
  const calls = []
  const harness = createOverlayHarness({ interact: async (kind) => { calls.push(kind); return null } })
  let tree = harness.render()
  const hitbox = petHitbox(tree)
  hitbox.props.onPointerDown({ clientX: 100, clientY: 100, currentTarget: { setPointerCapture() {} } })
  hitbox.props.onPointerUp({})
  harness.runTimers(220)
  await flushAsyncWork()
  tree = harness.render()

  assert.deepEqual(calls, ['pet'])
  assert.equal(tree.props['data-pet-state'], 'happy')
  assert.equal(tree.props['data-pet-visual-state'], 'happy')
}

{
  const calls = []
  const harness = createOverlayHarness({ interact: async (kind) => { calls.push(kind); return null } })
  let tree = harness.render()
  const hitbox = petHitbox(tree)
  hitbox.props.onPointerDown({ clientX: 100, clientY: 100, currentTarget: { setPointerCapture() {} } })
  hitbox.props.onPointerUp({})
  hitbox.props.onDoubleClick({})
  harness.runTimers(220)
  await flushAsyncWork()
  tree = harness.render()

  assert.deepEqual(calls, ['play'])
  assert.equal(tree.props['data-pet-visual-state'], 'excited')
}

{
  const calls = []
  const harness = createOverlayHarness({ interact: async (kind) => { calls.push(kind); return null } })
  let tree = harness.render()
  const hitbox = petHitbox(tree)
  hitbox.props.onPointerDown({ clientX: 100, clientY: 100, currentTarget: { setPointerCapture() {} } })
  harness.runTimers(700)
  await flushAsyncWork()
  tree = harness.render()
  assert.deepEqual(calls, ['long-press'])
  assert.equal(tree.props['data-pet-visual-state'], 'relaxed')
  hitbox.props.onPointerUp({})
  harness.runTimers(220)
  await flushAsyncWork()
  assert.deepEqual(calls, ['long-press'])
}

{
  const calls = []
  const harness = createOverlayHarness({ interact: async (kind) => { calls.push(kind); return null } })
  let tree = harness.render()
  const hitbox = petHitbox(tree)
  hitbox.props.onPointerDown({ clientX: 40, clientY: 50, currentTarget: { setPointerCapture() {} } })
  hitbox.props.onPointerMove({ clientX: 63, clientY: 79 })
  hitbox.props.onPointerUp({})
  await flushAsyncWork()
  tree = harness.render()

  assert.deepEqual(calls, [])
  assert.equal(tree.props.style?.transform, 'translate(23px,29px)')
}

{
  let resolveChat
  const harness = createOverlayHarness({
    chat: () => new Promise((resolve) => { resolveChat = resolve }),
  })
  let tree = harness.render()
  chatToggle(tree).props.onClick()
  tree = harness.render()
  const input = findElement(tree, (element) => element.props?.['aria-label'] === '和李花花说句话')
  const form = findElement(tree, (element) => element.type === 'form')
  assert.ok(input && form, 'chat controls open without touching the pet hitbox')

  input.props.onChange({ target: { value: '花花在吗？' } })
  tree = harness.render()
  findElement(tree, (element) => element.type === 'form').props.onSubmit({ preventDefault() {} })
  await flushAsyncWork()
  tree = harness.render()
  assert.equal(tree.props['data-pet-visual-state'], 'thinking')
  const thinking = findElement(tree, (element) => element.props?.className === 'vc-pet-chat-thinking')
  assert.ok(thinking, 'desktop chat shows a temporary thinking bubble')
  assert.equal(thinking.props.role, 'status')

  resolveChat({ ok: true, text: '在呀！', reasoning: { effort: 'low', durationMs: 2784 } })
  await flushAsyncWork()
  tree = harness.render()
  assert.equal(tree.props['data-pet-visual-state'], 'happy')
  const durationMeta = findElement(tree, (element) => element.props?.className === 'vc-pet-chat-thinking-meta')
  assert.ok(durationMeta, 'desktop chat shows thinking duration metadata')
}

assert.match(css, /\.vc-pet-chat-toggle\s*\{[^}]*z-index:\s*5/s)
assert.match(css, /\.vc-pet-chat-bubble\s*\{[^}]*z-index:\s*5/s)
assert.match(css, /\.vc-pet-visual-relaxed\s+\.vc-pet-sprite/)
assert.match(css, /\.vc-pet-visual-waiting\s+\.vc-pet-sprite/)
assert.match(css, /\.vc-pet-confused-mark\s*\{/)
assert.match(css, /\.vc-pet-dream-bubble\s*\{/)
assert.match(css, /\.vc-pet-dream-star\s*\{/)

console.log('VC_AI_PET_V0_3_UI_OVERLAY_INTERACTIONS=PASS')
