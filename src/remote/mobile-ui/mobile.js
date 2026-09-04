let stateLabel
let sprite
let happiness
let energy
let connection
let messages
let form
let input
let sendButton
let imageButton
let imageInput
let imagePreview
let imageThumbnail
let removeImage
let imageStatus
let playView
let chatView
let petApp
let tabButtons = []

const MAX_LONG_EDGE = 1920
const THUMBNAIL_MAX_EDGE = 256
const IMAGE_QUALITY = 0.9
const MAX_IMAGE_DATA_URL_BYTES = 7 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const ACTIVE_TAB_STORAGE_KEY = 'vc-ai-pet-mobile-active-tab-v1'
const DEFAULT_ACTIVE_TAB = 'play'
const VALID_TABS = new Set(['play', 'chat'])
const KEYBOARD_OPEN_THRESHOLD = 120
const KEYBOARD_CLOSE_THRESHOLD = 72
let selectedImage = null
let imageProcessing = false
let pressTimer = null
let clickTimer = null
let keyboardOpen = false
let keyboardFrame = null
let keyboardViewportChanged = false
let viewportBaselineHeight = 0

function setOnline(online) { connection.classList.toggle('online', online); connection.setAttribute('aria-label', online ? '已同步' : '同步中') }
function number(value) { return `${Math.round(Number(value || 0) * 100)}%` }

function getViewportHeight() {
  const visualViewport = globalThis.visualViewport
  const heights = [visualViewport?.height, globalThis.innerHeight, document.documentElement.clientHeight]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  return heights.length ? Math.min(...heights) : 0
}

function setKeyboardOpen(open, height = getViewportHeight()) {
  if (!petApp) return
  keyboardOpen = open
  petApp.classList.toggle('keyboard-open', open)
  if (open) {
    petApp.style.height = `${Math.round(height)}px`
    petApp.style.minHeight = '0'
  } else {
    petApp.style.removeProperty('height')
    petApp.style.removeProperty('min-height')
  }
}

function syncKeyboardState(viewportChanged = false) {
  keyboardFrame = null
  const height = getViewportHeight()
  if (!height) return

  const focused = document.activeElement === input
  const mobileViewport = Number(globalThis.innerWidth || 0) <= 900
  if (!viewportBaselineHeight || (!keyboardOpen && !focused)) viewportBaselineHeight = height
  if (height > viewportBaselineHeight) viewportBaselineHeight = height

  const heightDelta = viewportBaselineHeight - height
  const threshold = keyboardOpen ? KEYBOARD_CLOSE_THRESHOLD : KEYBOARD_OPEN_THRESHOLD
  const viewportKeyboard = heightDelta >= threshold
  const focusKeyboard = mobileViewport && focused
  const shouldOpen = keyboardOpen
    ? viewportKeyboard || (focusKeyboard && !viewportChanged)
    : focused && (viewportKeyboard || focusKeyboard)
  setKeyboardOpen(shouldOpen, height)
}

function scheduleKeyboardState(viewportChanged = false) {
  if (viewportChanged) keyboardViewportChanged = true
  if (keyboardFrame !== null) return
  const update = () => {
    const changed = keyboardViewportChanged
    keyboardViewportChanged = false
    syncKeyboardState(changed)
  }
  if (typeof globalThis.requestAnimationFrame === 'function') {
    keyboardFrame = globalThis.requestAnimationFrame(update)
  } else {
    keyboardFrame = globalThis.setTimeout(update, 50)
  }
}

function bindKeyboardState() {
  const visualViewport = globalThis.visualViewport
  input.addEventListener('focus', () => scheduleKeyboardState())
  input.addEventListener('blur', () => {
    setKeyboardOpen(false)
    scheduleKeyboardState()
  })
  globalThis.addEventListener?.('resize', () => scheduleKeyboardState(true))
  globalThis.addEventListener?.('orientationchange', () => scheduleKeyboardState(true))
  globalThis.addEventListener?.('pageshow', () => scheduleKeyboardState())
  document.addEventListener('visibilitychange', () => scheduleKeyboardState())
  visualViewport?.addEventListener('resize', () => scheduleKeyboardState(true))
  visualViewport?.addEventListener('scroll', () => scheduleKeyboardState(true))
  scheduleKeyboardState()
}

function readStoredTab() {
  try {
    const storedTab = globalThis.localStorage?.getItem(ACTIVE_TAB_STORAGE_KEY)
    return VALID_TABS.has(storedTab) ? storedTab : DEFAULT_ACTIVE_TAB
  } catch {
    return DEFAULT_ACTIVE_TAB
  }
}

function persistActiveTab(tab) {
  try { globalThis.localStorage?.setItem(ACTIVE_TAB_STORAGE_KEY, tab) } catch {
    // Private browsing and disabled storage must not prevent the app from starting.
  }
}

function setActiveTab(tab, { persist = true } = {}) {
  const activeTab = VALID_TABS.has(tab) ? tab : DEFAULT_ACTIVE_TAB
  if (playView) playView.hidden = activeTab !== 'play'
  if (chatView) chatView.hidden = activeTab !== 'chat'
  tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === activeTab
    button.classList.toggle('active', isActive)
    button.setAttribute('aria-selected', String(isActive))
  })
  if (persist) persistActiveTab(activeTab)
  return activeTab
}

function restoreActiveTab() {
  return setActiveTab(readStoredTab(), { persist: false })
}

function scrollMessagesToBottom() {
  if (!messages) return
  messages.scrollTop = messages.scrollHeight
}

function formatThinkingDuration(durationMs) {
  const milliseconds = Number(durationMs)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return ''
  if (milliseconds < 1000) return `思考了 ${(milliseconds / 1000).toFixed(1)} 秒`

  const totalSeconds = Math.floor(milliseconds / 1000)
  if (totalSeconds < 60) return `思考了 ${(milliseconds / 1000).toFixed(1)} 秒`
  return `思考了 ${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`
}

function renderMessage({ role, text = '', attachment = null, reasoning = null } = {}) {
  const node = document.createElement('article')
  node.className = `message ${role === 'user' ? 'user-line' : 'pet-line'}`
  const bubble = document.createElement('div')
  bubble.className = 'message-bubble'

  const label = document.createElement('div')
  label.className = 'message-label'
  label.textContent = role === 'user' ? '主人' : '李花花'
  bubble.append(label)

  const cleanText = String(text ?? '').trim()
  if (cleanText) {
    const textNode = document.createElement('p')
    textNode.className = 'message-text'
    textNode.textContent = cleanText
    bubble.append(textNode)
  }

  const thumbnailUrl = typeof attachment?.thumbnailUrl === 'string' ? attachment.thumbnailUrl : ''
  if (thumbnailUrl) {
    const card = document.createElement('div')
    card.className = 'image-card'
    const image = document.createElement('img')
    image.src = thumbnailUrl
    image.alt = role === 'user' ? '主人发送的图片' : '花花回复中的图片'
    image.loading = 'lazy'
    image.decoding = 'async'
    card.append(image)
    bubble.append(card)
  }

  node.append(bubble)
  const durationText = role === 'pet' ? formatThinkingDuration(reasoning?.durationMs) : ''
  if (durationText) {
    const meta = document.createElement('div')
    meta.className = 'thinking-meta'
    meta.textContent = `🐾 ${durationText}`
    node.append(meta)
  }
  messages.append(node)
  return node
}

function line(role, text, attachment = null, reasoning = null) {
  return renderMessage({ role, text, attachment, reasoning })
}

function appendThinkingMessage({ vision = false } = {}) {
  const node = document.createElement('article')
  node.className = 'message pet-line thinking-message'
  node.setAttribute('role', 'status')
  node.setAttribute('aria-live', 'polite')

  const bubble = document.createElement('div')
  bubble.className = 'message-bubble thinking-bubble'

  const mark = document.createElement('span')
  mark.className = 'thinking-mark'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = '🐾'

  const copy = document.createElement('span')
  copy.className = 'thinking-copy'
  copy.textContent = vision ? '花花认真看看' : '花花想一想'

  const dots = document.createElement('span')
  dots.className = 'thinking-dots'
  dots.setAttribute('aria-hidden', 'true')
  for (let index = 0; index < 3; index += 1) dots.append(document.createElement('span'))

  bubble.append(mark, copy, dots)
  node.append(bubble)
  messages.append(node)
  return node
}

function removeThinkingMessage(node) {
  if (!node) return
  if (node.parentNode) node.parentNode.removeChild(node)
  else node.remove?.()
}

function renderHistory(history) {
  messages.replaceChildren()
  if (!history.length) {
    line('pet', '汪，在呀。')
    return
  }
  history.forEach((message) => renderMessage(message))
}

function updateSendButton() {
  sendButton.disabled = imageProcessing || (!input.value.trim() && !selectedImage)
}

function clearImageSelection({ clearStatus = true } = {}) {
  selectedImage = null
  imageThumbnail.removeAttribute('src')
  imagePreview.hidden = true
  imageInput.value = ''
  if (clearStatus) imageStatus.textContent = ''
  updateSendButton()
}

function decodeWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('image decode failed'))
    }
    image.src = objectUrl
  })
}

async function decodeImage(file) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file)
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() }
    } catch {
      // Some mobile browsers expose createImageBitmap but cannot decode every
      // supported file type; fall through to the native Image decoder.
    }
  }
  return decodeWithImageElement(file)
}

function exportCanvas(canvas) {
  let dataUrl = canvas.toDataURL('image/webp', IMAGE_QUALITY)
  if (!dataUrl.startsWith('data:image/webp;base64,')) dataUrl = canvas.toDataURL('image/jpeg', IMAGE_QUALITY)
  if (!/^data:image\/(?:jpeg|webp);base64,/u.test(dataUrl)) throw new Error('image export failed')
  return dataUrl
}

async function normalizeImage(file) {
  if (!file || !ALLOWED_IMAGE_TYPES.has(file.type)) throw new Error('unsupported image type')
  const decoded = await decodeImage(file)
  try {
    if (!decoded.width || !decoded.height) throw new Error('invalid image dimensions')
    const scale = Math.min(1, MAX_LONG_EDGE / Math.max(decoded.width, decoded.height))
    const width = Math.max(1, Math.round(decoded.width * scale))
    const height = Math.max(1, Math.round(decoded.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    context.drawImage(decoded.source, 0, 0, width, height)

    const dataUrl = exportCanvas(canvas)
    if (new TextEncoder().encode(dataUrl).byteLength > MAX_IMAGE_DATA_URL_BYTES) throw new Error('image too large')

    const thumbnailScale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(decoded.width, decoded.height))
    const thumbnailWidth = Math.max(1, Math.round(decoded.width * thumbnailScale))
    const thumbnailHeight = Math.max(1, Math.round(decoded.height * thumbnailScale))
    const thumbnailCanvas = document.createElement('canvas')
    thumbnailCanvas.width = thumbnailWidth
    thumbnailCanvas.height = thumbnailHeight
    const thumbnailContext = thumbnailCanvas.getContext('2d')
    if (!thumbnailContext) throw new Error('canvas unavailable')
    thumbnailContext.drawImage(decoded.source, 0, 0, thumbnailWidth, thumbnailHeight)

    return {
      dataUrl,
      thumbnailDataUrl: exportCanvas(thumbnailCanvas),
      width,
      height,
      thumbnailWidth,
      thumbnailHeight,
    }
  } finally {
    decoded.close?.()
  }
}

async function chooseImage() {
  const file = imageInput.files?.[0]
  if (!file) return
  clearImageSelection({ clearStatus: false })
  imageProcessing = true
  imageButton.disabled = true
  imageStatus.textContent = '图片处理中……'
  updateSendButton()
  try {
    selectedImage = await normalizeImage(file)
    imageThumbnail.src = selectedImage.thumbnailDataUrl
    imagePreview.hidden = false
    imageStatus.textContent = '已选择一张图片'
  } catch {
    clearImageSelection({ clearStatus: false })
    imageStatus.textContent = '这张图片花花暂时看不了，再换一张试试吧。'
  } finally {
    imageProcessing = false
    imageButton.disabled = false
    updateSendButton()
  }
}

async function refresh() {
  try {
    const response = await fetch('/api/pet/state', { cache: 'no-store' })
    if (!response.ok) throw new Error('state unavailable')
    const state = await response.json()
    stateLabel.textContent = `当前状态：${state.visualState || 'idle'}`
    happiness.textContent = number(state.emotion?.happiness)
    energy.textContent = number(state.emotion?.energy)
    if (state.sprite) sprite.src = `/assets/${state.sprite}`
    setOnline(true)
  } catch { setOnline(false) }
}

async function loadHistory() {
  try {
    const response = await fetch('/api/pet/history', { cache: 'no-store' })
    if (!response.ok) throw new Error('history unavailable')
    const payload = await response.json()
    const history = Array.isArray(payload) ? payload : payload?.messages
    if (!Array.isArray(history)) throw new Error('invalid history')
    renderHistory(history)
    const chatWasHidden = chatView?.hidden
    if (chatWasHidden) chatView.hidden = false
    scrollMessagesToBottom()
    if (chatWasHidden) chatView.hidden = true
    setOnline(true)
  } catch { setOnline(false) }
}

async function uploadImage(image) {
  const response = await fetch('/api/pet/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      image: { dataUrl: image.dataUrl },
      thumbnail: { dataUrl: image.thumbnailDataUrl },
      width: image.width,
      height: image.height,
      thumbnailWidth: image.thumbnailWidth,
      thumbnailHeight: image.thumbnailHeight,
    }),
  })
  const result = await response.json()
  if (!response.ok || !result?.attachment?.id) throw new Error(result?.error || 'image upload unavailable')
  return result.attachment
}

async function action(action) {
  try {
    const response = await fetch('/api/pet/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
    if (!response.ok) throw new Error('action unavailable')
    sprite.classList.add('active'); setTimeout(() => sprite.classList.remove('active'), 240)
    await refresh()
  } catch { setOnline(false) }
}

function bindDom() {
  stateLabel = document.querySelector('#state-label')
  sprite = document.querySelector('#pet-sprite')
  happiness = document.querySelector('#happiness')
  energy = document.querySelector('#energy')
  connection = document.querySelector('#connection')
  messages = document.querySelector('#messages')
  form = document.querySelector('#chat-form')
  input = document.querySelector('#chat-input')
  sendButton = document.querySelector('#send-button')
  imageButton = document.querySelector('#image-button')
  imageInput = document.querySelector('#image-input')
  imagePreview = document.querySelector('#image-preview')
  imageThumbnail = document.querySelector('#image-thumbnail')
  removeImage = document.querySelector('#remove-image')
  imageStatus = document.querySelector('#image-status')
  playView = document.querySelector('#play-view')
  chatView = document.querySelector('#chat-view')
  petApp = document.querySelector('.pet-app')
  tabButtons = [...document.querySelectorAll('#bottom-nav .nav-item')]

  tabButtons.forEach((button) => {
    button.addEventListener('click', () => setActiveTab(button.dataset.tab))
  })

  document.querySelector('#pet-button').addEventListener('click', () => action('click'))
  document.querySelector('#play-button').addEventListener('click', () => action('double_click'))
  document.querySelector('#long-button').addEventListener('click', () => action('long_press'))
  imageButton.addEventListener('click', () => imageInput.click())
  imageInput.addEventListener('change', () => { void chooseImage() })
  removeImage.addEventListener('click', () => clearImageSelection())
  input.addEventListener('input', updateSendButton)

  sprite.addEventListener('pointerdown', () => { pressTimer = setTimeout(() => { pressTimer = null; action('long_press') }, 700) })
  sprite.addEventListener('pointerup', () => {
    if (!pressTimer) return
    clearTimeout(pressTimer); pressTimer = null
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = setTimeout(() => { clickTimer = null; action('click') }, 220)
  })
  sprite.addEventListener('pointercancel', () => { if (pressTimer) clearTimeout(pressTimer); pressTimer = null })
  sprite.addEventListener('dblclick', () => {
    if (pressTimer) clearTimeout(pressTimer); pressTimer = null
    if (clickTimer) clearTimeout(clickTimer); clickTimer = null
    action('double_click')
  })

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (imageProcessing) return
    const message = input.value.trim()
    const pendingImage = selectedImage
    if (!message && !pendingImage) return

    const restoreInputFocus = document.activeElement === input
    input.value = ''
    input.readOnly = true
    imageButton.disabled = true
    sendButton.disabled = true
    const localAttachment = pendingImage
      ? { thumbnailUrl: pendingImage.thumbnailDataUrl }
      : null
    line('user', message, localAttachment)
    const thinkingMessage = appendThinkingMessage({ vision: Boolean(pendingImage) })
    scrollMessagesToBottom()
    try {
      const attachment = pendingImage ? await uploadImage(pendingImage) : null
      const body = { message }
      if (attachment) body.attachmentId = attachment.id
      const response = await fetch('/api/pet/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json()
      if (!response.ok) throw new Error(result?.error || 'chat unavailable')
      removeThinkingMessage(thinkingMessage)
      if (result?.ok) line('pet', result.text, null, result.reasoning)
      else line('pet', result?.petLine || '花花脑袋刚刚卡了一下……')
      scrollMessagesToBottom()
    } catch {
      removeThinkingMessage(thinkingMessage)
      line('pet', '花花脑袋刚刚卡了一下……')
      scrollMessagesToBottom()
      setOnline(false)
    } finally {
      input.readOnly = false
      imageButton.disabled = false
      clearImageSelection()
      if (restoreInputFocus && !chatView.hidden) input.focus({ preventScroll: true })
      updateSendButton()
      refresh()
    }
  })
}

function startApp() {
  bindDom()
  bindKeyboardState()
  restoreActiveTab()
  updateSendButton()
  refresh()
  loadHistory()
  setInterval(refresh, 1500)
}

startApp()
