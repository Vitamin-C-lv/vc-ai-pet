import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const [html, mobileCss, redesignCss, mobileJs, navigationJs, emojiJs, composerJs] = await Promise.all([
  readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile-redesign.css'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/navigation.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/emoji-drawer.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/chat-composer.js'), 'utf8'),
])

function createElement({ value = '', scrollHeight = 44, maxLength = -1 } = {}) {
  const listeners = new Map()
  const attributes = new Map()
  const element = {
    value,
    scrollHeight,
    maxLength,
    selectionStart: value.length,
    selectionEnd: value.length,
    style: {},
    dataset: {},
    hidden: false,
    disabled: false,
    readOnly: false,
    type: '',
    textContent: '',
    children: [],
    addEventListener(type, listener) {
      const handlers = listeners.get(type) ?? []
      handlers.push(listener)
      listeners.set(type, handlers)
    },
    dispatch(type, event = {}) {
      const payload = {
        type,
        target: element,
        preventDefault() { payload.defaultPrevented = true },
        ...event,
      }
      for (const listener of listeners.get(type) ?? []) listener(payload)
      return payload
    },
    dispatchEvent(event) {
      element.dispatch(event.type, event)
      return true
    },
    setAttribute(name, valueToSet) { attributes.set(name, String(valueToSet)) },
    getAttribute(name) { return attributes.get(name) ?? null },
    setSelectionRange(start, end) {
      element.selectionStart = start
      element.selectionEnd = end
    },
    focus() { element.focused = true },
    replaceChildren(...nodes) { element.children = nodes },
    append(...nodes) { element.children.push(...nodes) },
  }
  return element
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function section(id) {
  const start = html.indexOf(`id="${id}"`)
  assert.notEqual(start, -1, `${id} exists`)
  const end = html.indexOf('</section>', start)
  return html.slice(start, end === -1 ? html.length : end)
}

// CASE A / B / C / M: the existing shell contracts remain in place while the
// new fixture exercises the helper behavior below.
const home = section('play-view')
const chat = section('chat-view')
assert.match(home, /id="inner-life-open"/u)
assert.match(home, /id="house-open"/u)
assert.match(home, /id="chat-open"/u)
assert.doesNotMatch(home, /visual-gallery-open|花花的图库/u)
assert.match(chat, /class="chat-header"/u)
assert.match(chat, /id="chat-home"/u)
assert.match(chat, /id="chat-gallery"/u)
assert.match(chat, /id="image-button"[^>]*composer-add-button/u)
assert.match(chat, /id="send-button"[^>]*hidden/u)
assert.doesNotMatch(chat, /bottom-nav|data-tab/u)
assert.ok(redesignCss.includes('#chat-view,\n.chat-view'), 'chat view override keeps ID specificity')
assert.ok(redesignCss.includes('padding: 0'), 'chat view has no outer padding')
assert.ok(redesignCss.includes('background: var(--vc-bg)'), 'chat header keeps the warm page background')
assert.ok(redesignCss.includes('box-shadow: none'), 'chat header has no card shadow')
assert.ok(redesignCss.includes('position: sticky'), 'chat header remains sticky')
assert.ok(redesignCss.includes('env(safe-area-inset-top)'), 'chat header keeps top safe area')
assert.ok(redesignCss.includes('env(safe-area-inset-bottom)'), 'composer keeps bottom safe area')
assert.ok(redesignCss.includes('grid-template-columns: var(--vc-touch) minmax(0, 1fr) var(--vc-touch)'), 'chat title uses equal side tracks')
assert.ok(redesignCss.includes('#chat-form {\n  display: flex'), 'composer uses a stable inline row')
assert.ok(redesignCss.includes('.composer-action-button[hidden]'), 'send placeholder keeps its slot')
assert.ok(redesignCss.includes('visibility: hidden'), 'empty send is visually hidden')
assert.ok(mobileCss.includes('#chat-view,\n.chat-view'), 'baseline chat padding owner is covered')
assert.ok(mobileCss.includes('padding: 6px 12px 8px'), 'baseline chat padding is known')
assert.ok(mobileJs.includes('composerController?.sync?.()'), 'Chat re-entry syncs the composer')
assert.match(mobileJs, /scheduleComposerTextareaHeight/u)
assert.match(mobileJs, /\/api\/pet\/upload/u)
assert.match(mobileJs, /\/api\/pet\/chat\/start/u)
assert.match(mobileJs, /media_ref/u)
assert.doesNotMatch(navigationJs, /fetch\s*\(/u)
assert.doesNotMatch(composerJs, /fetch\s*\(/u)
assert.doesNotMatch(emojiJs, /fetch\s*\(/u)

// CASE D / E: navigation keeps params and deterministic fallback behavior.
const navigationContext = {}
vm.createContext(navigationContext)
vm.runInContext(navigationJs, navigationContext, { filename: 'navigation.js' })
let currentScreen = 'home'
const transitions = []
const router = navigationContext.VcAiPetNavigation.createVcNavigation({
  getScreen: () => currentScreen,
  goToScreen: (screen, params) => {
    currentScreen = screen
    transitions.push({ screen, params })
  },
})
router.push('chat')
router.push('gallery')
router.push('gallery-detail', { experienceId: 'experience-1' })
assert.deepEqual(transitions.at(-1), { screen: 'gallery-detail', params: { experienceId: 'experience-1' } })
router.back({ fallback: 'gallery' })
assert.equal(currentScreen, 'gallery')
router.home()
assert.equal(currentScreen, 'home')
currentScreen = 'gallery-detail'
router.back()
assert.equal(currentScreen, 'gallery')

// Build the real composer helper with a small DOM substitute. This fixture is
// deliberately network-free and does not construct PetRuntime or any store.
const composerContext = {}
vm.createContext(composerContext)
vm.runInContext(composerJs, composerContext, { filename: 'chat-composer.js' })
const composer = composerContext.VcAiPetComposer
const textarea = createElement({ scrollHeight: 44, maxLength: 500 })
const form = createElement()
const micButton = createElement()
const addButton = createElement()
const sendButton = createElement()
let pendingImage = false
let pickerCalls = 0
let toastMessage = ''
const sent = []
let nextSendFailure = false
let holdSend = false
let releaseSend = null
let sendGate = null

async function sendExistingText(message) {
  sent.push({ message, hadAttachment: pendingImage })
  if (nextSendFailure) {
    nextSendFailure = false
    throw new Error('fixture send failure')
  }
  if (holdSend) await sendGate
  textarea.value = ''
  textarea.scrollHeight = 44
  pendingImage = false
}

const controller = composer.wireVcComposer({
  form,
  input: textarea,
  micButton,
  addButton,
  sendButton,
  openExistingImagePicker: async () => { pickerCalls += 1 },
  sendExistingText,
  hasPendingImage: () => pendingImage,
  showToast: (message) => { toastMessage = message },
})

// CASE F: empty state keeps Plus visible and only opens the existing picker.
assert.equal(addButton.hidden, false)
assert.equal(sendButton.hidden, true)
addButton.dispatch('click')
await tick()
assert.equal(pickerCalls, 1)
assert.equal(sent.length, 0)

// CASE G: text state exposes Send and trims only at the send boundary.
textarea.value = '  你好花花  '
textarea.scrollHeight = 82
textarea.dispatch('input')
assert.equal(addButton.hidden, false)
assert.equal(sendButton.hidden, false)
assert.equal(textarea.style.height, '82px')
await controller.submit()
assert.deepEqual(sent.at(-1), { message: '你好花花', hadAttachment: false })
assert.equal(textarea.style.height, '44px')
assert.equal(sendButton.hidden, true)

// CASE H: image-only and both orderings reuse the one send callback while
// retaining the draft/attachment pair in either order.
pendingImage = true
textarea.value = ''
textarea.scrollHeight = 72
textarea.dispatch('input')
assert.equal(sendButton.hidden, false)
await controller.submit()
assert.deepEqual(sent.at(-1), { message: '', hadAttachment: true })

textarea.value = '文字先写'
textarea.scrollHeight = 78
textarea.dispatch('input')
addButton.dispatch('click')
await tick()
pendingImage = true
controller.sync()
assert.equal(textarea.value, '文字先写')
assert.equal(pendingImage, true)
await controller.submit()
assert.deepEqual(sent.at(-1), { message: '文字先写', hadAttachment: true })

pendingImage = true
textarea.value = '图片先选'
textarea.scrollHeight = 86
textarea.dispatch('input')
controller.sync()
assert.equal(textarea.value, '图片先选')
assert.equal(pendingImage, true)
await controller.submit()
assert.deepEqual(sent.at(-1), { message: '图片先选', hadAttachment: true })

// CASE I: form and button sending paths share the composition guard.
textarea.value = '拼音中'
textarea.scrollHeight = 70
textarea.dispatch('input')
textarea.dispatch('compositionstart')
form.dispatch('submit', { keyCode: 229 })
sendButton.dispatch('click')
await tick()
assert.equal(sent.at(-1).message, '图片先选')
textarea.dispatch('compositionend')
form.dispatch('submit')
await tick()
assert.deepEqual(sent.at(-1), { message: '拼音中', hadAttachment: false })

// CASE J: emoji replaces the caret selection, emits input, and honors the
// textarea maxlength without producing a partial surrogate pair.
const emojiEvents = []
textarea.value = '你好'
textarea.selectionStart = 1
textarea.selectionEnd = 1
textarea.scrollHeight = 74
textarea.addEventListener('input', () => emojiEvents.push('input'))
const emojiContext = {
  Event: class Event {
    constructor(type) { this.type = type }
  },
  document: {
    createElement: () => createElement(),
  },
}
vm.createContext(emojiContext)
vm.runInContext(emojiJs, emojiContext, { filename: 'emoji-drawer.js' })
assert.equal(emojiContext.VcAiPetEmoji.insertEmoji(textarea, '🐾'), true)
assert.equal(textarea.value, '你🐾好')
assert.equal(textarea.selectionStart, 3)
assert.equal(emojiEvents.length, 1)
assert.equal(textarea.style.height, '74px')

const emojiDrawer = createElement()
const emojiGrid = createElement()
emojiDrawer.querySelector = () => emojiGrid
const emojiButton = createElement()
const toggleStates = []
const emojiDrawerController = emojiContext.VcAiPetEmoji.wireEmojiDrawer({
  drawer: emojiDrawer,
  input: textarea,
  button: emojiButton,
  onToggle: (open) => toggleStates.push(open),
})
assert.equal(emojiDrawer.hidden, true)
assert.equal(emojiButton.getAttribute('aria-expanded'), 'false')
assert.equal(emojiDrawerController.isOpen(), false)
emojiButton.dispatch('click')
assert.equal(emojiDrawer.hidden, false)
assert.equal(emojiDrawer.dataset.open, 'true')
assert.equal(emojiButton.getAttribute('aria-expanded'), 'true')
const drawerOption = emojiGrid.children[0]
textarea.value = '甲乙'
textarea.selectionStart = 1
textarea.selectionEnd = 1
emojiGrid.dispatch('click', { target: { closest: () => drawerOption } })
assert.equal(textarea.value, `甲${drawerOption.dataset.emoji}乙`)
emojiDrawerController.close()
assert.equal(emojiDrawer.hidden, true)
assert.deepEqual(toggleStates, [false, true, false])

textarea.value = 'x'.repeat(500)
textarea.selectionStart = 500
textarea.selectionEnd = 500
assert.equal(emojiContext.VcAiPetEmoji.insertEmoji(textarea, '🐾'), false)
assert.equal(textarea.value.length, 500)

// CASE K: mic remains presentation-only.
micButton.dispatch('click')
assert.equal(toastMessage, '语音输入后续开放')

// CASE L: single-flight, rejection recovery, and the height clamp are real
// helper behavior rather than only source-string assertions.
textarea.value = 'x'.repeat(20)
textarea.scrollHeight = 240
textarea.dispatch('input')
assert.equal(textarea.style.height, '132px')
assert.equal(textarea.style.overflowY, 'auto')
textarea.value = ''
textarea.scrollHeight = 44
textarea.dispatch('input')
assert.equal(textarea.style.height, '44px')
assert.equal(textarea.style.overflowY, 'hidden')

textarea.value = '慢发送'
textarea.scrollHeight = 76
textarea.dispatch('input')
holdSend = true
sendGate = new Promise((resolve) => { releaseSend = resolve })
const inFlight = controller.submit()
await tick()
const countBeforeSecondSubmit = sent.length
assert.equal(sendButton.disabled, true)
await controller.submit()
assert.equal(sent.length, countBeforeSecondSubmit)
releaseSend()
await inFlight
holdSend = false

textarea.value = '失败后保留的草稿'
textarea.scrollHeight = 80
textarea.dispatch('input')
nextSendFailure = true
await assert.rejects(() => controller.submit(), /fixture send failure/u)
assert.equal(textarea.value, '失败后保留的草稿')

// CASE M: no helper acquired a backend; the real mobile controller still owns
// upload/chat/visual rendering and the navigation helper owns route changes.
assert.match(mobileJs, /VISUAL_ACTIVITY_TYPES|MAX_VISUAL_INSPECTIONS_PER_TURN/u)
assert.match(mobileJs, /function\s+submitComposer/u)
assert.match(mobileJs, /attachmentId/u)
assert.ok(mobileJs.includes('const draftText = input.value'), 'submit captures the original draft')
assert.ok(mobileJs.includes('onCompleted: (state)'), 'submission cleanup has a completed-state callback')
assert.ok(mobileJs.includes('restoreImageSelection(state.pendingImage)'), 'failed image sends restore the attachment')
assert.match(composerJs, /sendExistingText/u)
assert.match(emojiJs, /registerStickerProvider/u)

console.log('A_HOME_AND_NESTED_NAVIGATION=PASS')
console.log('B_CHAT_HEADER_AND_ACTIONS=PASS')
console.log('C_NESTED_BACK_HOME_CONTROLS=PASS')
console.log('D_NAVIGATION_PARAMS=PASS')
console.log('E_NAVIGATION_FALLBACKS=PASS')
console.log('F_EMPTY_PLUS_OPENS_EXISTING_PICKER=PASS')
console.log('G_TEXT_SEND_TRIMS_ONCE=PASS')
console.log('H_IMAGE_AND_MIXED_SEND_ORDER=PASS')
console.log('I_IME_GUARD=PASS')
console.log('J_EMOJI_SELECTION_AUTOSIZE=PASS')
console.log('K_MIC_PRESENTATION_ONLY=PASS')
console.log('L_SINGLE_FLIGHT_AND_HEIGHT_CLAMP=PASS')
console.log('M_BACKEND_OWNERSHIP_AND_VISUAL_PATHS=PASS')
console.log('TEXTAREA_AUTOGROW=PASS')
console.log('TEXTAREA_AUTOSHRINK=PASS')
console.log('TEXTAREA_RESET_AFTER_SEND=PASS')
console.log('TEXTAREA_MAX_HEIGHT=132')
console.log('PLUS_ALWAYS_VISIBLE=PASS')
console.log('SEND_VISIBLE_EMPTY=PASS')
console.log('SEND_VISIBLE_TEXT=PASS')
console.log('SEND_VISIBLE_IMAGE=PASS')
console.log('SEND_VISIBLE_TEXT_AND_IMAGE=PASS')
console.log('TEXT_THEN_IMAGE=PASS')
console.log('IMAGE_THEN_TEXT=PASS')
console.log('TEXT_DRAFT_PRESERVED=PASS')
console.log('ATTACHMENT_PRESERVED=PASS')
console.log('EMOJI_INSERT_AUTOSIZE=PASS')
console.log('IME_GUARD=PASS')
console.log('CHAT_HEADER_WHITE_FRAME_REMOVED=PASS')
console.log('CHAT_HEADER_TITLE_CENTERED=PASS')
console.log('CHAT_HEADER_STICKY=PASS')
console.log('SAFE_AREA=PASS')
