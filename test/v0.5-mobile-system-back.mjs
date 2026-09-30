import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const navigationJs = await readFile('src/remote/mobile-ui/navigation.js', 'utf8')
const mobileJs = await readFile('src/remote/mobile-ui/mobile.js', 'utf8')
const context = {}
vm.createContext(context)
vm.runInContext(navigationJs, context)
let current = 'home'
let params
let direction
const router = context.VcAiPetNavigation.createVcNavigation({
  getScreen: () => current,
  goToScreen: (screen, nextParams, motion) => {
    current = screen
    params = nextParams
    direction = motion.direction
  },
})
assert.equal(router.back(), false, 'Home lets Android put the task in the background')
router.push('chat')
router.push('gallery')
router.push('gallery-detail', { experienceId: 'photo-1' })
assert.equal(direction, 'forward')
router.push('dreams')
router.back()
assert.equal(current, 'gallery-detail')
assert.equal(params.experienceId, 'photo-1', 'Back restores the selected photo')
assert.equal(direction, 'back')
router.back()
assert.equal(current, 'gallery')
router.back()
assert.equal(current, 'chat')
router.back()
assert.equal(current, 'home')
assert.equal(router.back(), false)

// Execute the actual mobile Back handler with transient UI state.
const handler = mobileJs.slice(mobileJs.indexOf('function handleSystemBack()'), mobileJs.indexOf('globalThis.VcAiPetApp'))
const calls = []
const input = { blur() { calls.push('blur'); state.document.activeElement = null } }
let emojiOpen = true
const state = {
  diagnosticsPanel: { hidden: false },
  closeDiagnosticsPanel() { calls.push('diagnostics'); state.diagnosticsPanel.hidden = true },
  keyboardOpen: true,
  document: { activeElement: input },
  input,
  setKeyboardOpen(open) { calls.push('keyboard'); state.keyboardOpen = open },
  emojiController: { isOpen: () => emojiOpen, close() { calls.push('emoji'); emojiOpen = false } },
  currentScreen: 'gallery-detail',
  SCREEN: context.VcAiPetNavigation.VC_SCREEN,
  navigateBack(fallback) { calls.push(fallback); return true },
}
vm.createContext(state)
vm.runInContext(handler, state)
assert.equal(state.handleSystemBack(), true)
assert.deepEqual(calls, ['diagnostics'])
calls.length = 0
assert.equal(state.handleSystemBack(), true)
assert.deepEqual(calls, ['blur', 'keyboard'])
// Android may hide IME itself while preserving HTML input focus.
state.document.activeElement = input
calls.length = 0
assert.equal(state.handleSystemBack(), true)
assert.deepEqual(calls, ['emoji'])
calls.length = 0
assert.equal(state.handleSystemBack(), true)
assert.deepEqual(calls, ['gallery'])
state.navigateBack = () => false
assert.equal(state.handleSystemBack(), false)

const pageBack = mobileJs.slice(mobileJs.indexOf('function navigateBack('), mobileJs.indexOf('// Called by the Android'))
state.currentScreen = 'gallery'
state.navigateHome = () => calls.push('home')
state.navigation = { back: () => { throw new Error('Gallery should return straight home') } }
vm.runInContext(pageBack, state)
calls.length = 0
assert.equal(state.handleSystemBack(), true)
assert.deepEqual(calls, ['home'])
console.log('SYSTEM_BACK_TRANSIENT_UI_AND_PAGE_STACK=PASS')
console.log('PHOTO_PARAMS_RESTORED_AND_MOTION_DIRECTION=PASS')
