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
let diagnosticsPanel
let diagnosticsOutput
let diagnosticsStatus
let diagnosticsCopyFallback
let diagnosticsCopyButton
let diagnosticsClearButton
let diagnosticsCloseButton

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
let connectionTapCount = 0
let connectionTapTimer = null

const diagnostics = globalThis.VcAiPetDiagnostics?.createFrontendDiagnostics?.({
  context: () => ({
    tab: chatView?.hidden === false ? 'chat' : 'play',
    online: globalThis.navigator?.onLine,
    visibility: document.visibilityState,
    viewportWidth: globalThis.innerWidth,
    viewportHeight: globalThis.innerHeight,
    pathname: globalThis.location?.pathname,
  }),
}) ?? {
  record() {},
  clear() {},
  list: () => [],
  exportText: () => 'VC_AI_PET_FRONTEND_DIAGNOSTICS\nSCHEMA=1',
  async fetchJsonDiagnostic(url, options) {
    const response = await globalThis.fetch(url, options)
    const payload = await response.json()
    if (!response.ok) throw new Error('request failed')
    return { response, payload, requestId: null, durationMs: null }
  },
}

function setOnline(online) { connection.classList.toggle('online', online); connection.setAttribute('aria-label', online ? '已同步' : '同步中') }
function number(value) { return `${Math.round(Number(value || 0) * 100)}%` }

function recordDiagnostic(input) {
  diagnostics.record(input)
}

function imageDiagnosticDetails(image = {}) {
  return {
    hadImage: true,
    mime: image.mime,
    width: image.width,
    height: image.height,
    inputBytes: image.inputBytes,
    imageBytes: image.imageBytes,
  }
}

function imagePrepDetails(file = {}) {
  return {
    hadImage: true,
    mime: file?.type,
    inputBytes: file?.size,
  }
}

function diagnosticError(code, message) {
  const error = new Error(message)
  error.code = code
  error.diagnosticLogged = true
  return error
}

async function fetchJsonDiagnostic(url, options, requestContext) {
  return diagnostics.fetchJsonDiagnostic(url, options, requestContext)
}

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

function renderMessage({ role, kind = 'dialogue', text = '', attachment = null, reasoning = null } = {}) {
  const node = document.createElement('article')
  const userMessage = role === 'user'
  const petMessage = role === 'pet' || role === 'assistant'
  node.className = `message ${userMessage ? 'user-line' : 'pet-line'}${kind === 'media_ref' ? ' media-ref-line' : kind === 'activity' ? ' activity-line' : ''}`
  const bubble = document.createElement('div')
  bubble.className = 'message-bubble'

  const label = document.createElement('div')
  label.className = 'message-label'
  label.textContent = userMessage ? '主人' : '李花花'
  bubble.append(label)

  const cleanText = String(text ?? '').trim()
  if (cleanText) {
    const textNode = document.createElement('p')
    textNode.className = 'message-text'
    textNode.textContent = cleanText
    bubble.append(textNode)
  }

  const thumbnailUrl = typeof attachment?.thumbnailUrl === 'string' ? attachment.thumbnailUrl : ''
  const localPreviewUrl = userMessage && /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/iu.test(thumbnailUrl) ? thumbnailUrl : ''
  if (thumbnailUrl && (localPreviewUrl || isSameOriginAssetUrl(thumbnailUrl))) {
    const card = document.createElement('div')
    card.className = 'image-card'
    const image = document.createElement('img')
    image.src = thumbnailUrl
    image.alt = userMessage ? '主人发送的图片' : '花花回看的图片'
    image.loading = 'lazy'
    image.decoding = 'async'
    image.addEventListener('error', () => recordDiagnostic({ level: 'error', stage: 'image-load', code: 'IMAGE_LOAD_FAILURE', details: { hadImage: true, mime: attachment?.mimeType } }))
    card.append(image)
    bubble.append(card)
  }

  node.append(bubble)
  const durationText = petMessage ? formatThinkingDuration(reasoning?.durationMs) : ''
  if (durationText) {
    const meta = document.createElement('div')
    meta.className = 'thinking-meta'
    meta.textContent = `🐾 ${durationText}`
    node.append(meta)
  }
  messages.append(node)
  return node
}

function isSameOriginAssetUrl(value) {
  try {
    const url = new URL(value, globalThis.location?.origin)
    return url.origin === globalThis.location?.origin && url.pathname.startsWith('/conversation-assets/') && !url.search && !url.hash
  } catch { return false }
}

function line(role, text, attachment = null, reasoning = null) {
  return renderMessage({ role, text, attachment, reasoning })
}

const TURN_EVENT_TYPES = new Set(['turn_started', 'thinking', 'visual_selected', 'visual_image', 'visual_observation', 'visual_compare', 'memory_recall', 'assistant_message', 'turn_completed', 'turn_failed'])

function renderTurnEvent(event) {
  const payload = event?.payload ?? {}
  if (event?.type === 'turn_started' || event?.type === 'thinking' || event?.type === 'turn_failed') return null
  if (event?.type === 'visual_selected') {
    removeThinkingMessage(document.querySelector('.thinking-message'))
    return renderMessage({ role: 'assistant', kind: 'activity', text: payload.caption })
  }
  if (event?.type === 'visual_image') {
    removeThinkingMessage(document.querySelector('.thinking-message'))
    return renderMessage({ role: 'assistant', kind: 'media_ref', text: payload.caption, attachment: payload.attachment })
  }
  if (event?.type === 'visual_observation') return renderMessage({ role: 'assistant', kind: 'activity', text: `👀 看到：${payload.summary ?? ''}` })
  if (event?.type === 'visual_compare') return renderMessage({ role: 'assistant', kind: 'activity', text: `🔎 对照：${payload.summary ?? ''}` })
  if (event?.type === 'memory_recall') return renderMessage({ role: 'assistant', kind: 'activity', text: `${payload.provenance === 'inferred' ? '💭 联想到：' : '🧠 想起：'}${payload.summary ?? ''}` })
  if (event?.type === 'assistant_message') return line('pet', payload.text, null, payload.reasoning)
  if (event?.type === 'turn_completed') {
    removeThinkingMessage(document.querySelector('.thinking-message'))
    const node = document.createElement('article')
    node.className = 'message pet-line turn-completed'
    const meta = document.createElement('div')
    meta.className = 'thinking-meta'
    meta.textContent = `🐾 ${formatThinkingDuration(payload.reasoning?.durationMs ?? payload.durationMs)}`
    node.append(meta); messages.append(node); return node
  }
  return null
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
  history.forEach((message) => {
    if (message.kind === 'activity') renderMessage({ ...message, role: 'assistant' })
    else if (message.kind === 'media_ref') renderMessage({ ...message, role: 'assistant' })
    else renderMessage(message)
  })
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
    const normalized = await normalizeImage(file)
    selectedImage = {
      ...normalized,
      mime: file.type,
      inputBytes: Number(file.size),
      imageBytes: new TextEncoder().encode(normalized.dataUrl).byteLength,
    }
    imageThumbnail.src = selectedImage.thumbnailDataUrl
    imagePreview.hidden = false
    imageStatus.textContent = '已选择一张图片'
  } catch (error) {
    recordDiagnostic({
      level: 'error', stage: 'image-prep', code: 'IMAGE_PREP_FAILURE', message: error?.message,
      details: imagePrepDetails(file),
    })
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
    const { payload: state } = await fetchJsonDiagnostic('/api/pet/state', { cache: 'no-store' }, { stage: 'state' })
    stateLabel.textContent = `当前状态：${state.visualState || 'idle'}`
    happiness.textContent = number(state.emotion?.happiness)
    energy.textContent = number(state.emotion?.energy)
    if (state.sprite) sprite.src = `/assets/${state.sprite}`
    setOnline(true)
  } catch { setOnline(false) }
}

async function loadHistory() {
  try {
    const { payload } = await fetchJsonDiagnostic('/api/pet/history', { cache: 'no-store' }, { stage: 'history' })
    const history = Array.isArray(payload) ? payload : payload?.messages
    if (!Array.isArray(history)) {
      recordDiagnostic({ level: 'error', stage: 'history', code: 'HISTORY_INVALID_RESPONSE' })
      throw diagnosticError('HISTORY_INVALID_RESPONSE', 'invalid history')
    }
    renderHistory(history)
    const chatWasHidden = chatView?.hidden
    if (chatWasHidden) chatView.hidden = false
    scrollMessagesToBottom()
    if (chatWasHidden) chatView.hidden = true
    setOnline(true)
  } catch { setOnline(false) }
}

async function uploadImage(image) {
  const { payload: result } = await fetchJsonDiagnostic('/api/pet/upload', {
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
  }, { stage: 'upload', ...imageDiagnosticDetails(image) })
  if (!result?.attachment?.id) {
    recordDiagnostic({ level: 'error', stage: 'upload', code: 'UPLOAD_INVALID_RESPONSE', details: imageDiagnosticDetails(image) })
    throw diagnosticError('UPLOAD_INVALID_RESPONSE', 'image upload unavailable')
  }
  return result.attachment
}

async function action(action) {
  try {
    await fetchJsonDiagnostic('/api/pet/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }, { stage: 'action' })
    sprite.classList.add('active'); setTimeout(() => sprite.classList.remove('active'), 240)
    await refresh()
  } catch { setOnline(false) }
}

function waitForTurnPoll() {
  return new Promise((resolve) => setTimeout(resolve, 300))
}

async function runTurnProgress({ message, pendingImage, attachment, thinkingMessage }) {
  const turnContext = {
    stage: 'turn-start',
    hadImage: Boolean(pendingImage),
    attachmentId: attachment?.id,
    ...(pendingImage ? imageDiagnosticDetails(pendingImage) : {}),
  }
  let started
  try {
    started = await fetchJsonDiagnostic('/api/pet/chat/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ...(attachment ? { attachmentId: attachment.id } : {}) }),
    }, turnContext)
  } catch (error) {
    if (![404, 405].includes(Number(error?.httpStatus))) throw error
    const legacy = await fetchJsonDiagnostic('/api/pet/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, ...(attachment ? { attachmentId: attachment.id } : {}) }),
    }, { ...turnContext, stage: 'chat' })
    removeThinkingMessage(thinkingMessage)
    const replies = Array.isArray(legacy.payload?.replyMessages) && legacy.payload.replyMessages.length ? legacy.payload.replyMessages : [legacy.payload?.text]
    replies.filter(Boolean).forEach((text, index) => line('pet', text, null, index === replies.length - 1 ? legacy.payload?.reasoning : null))
    return
  }
  const turnId = typeof started.payload?.turnId === 'string' ? started.payload.turnId : ''
  if (!turnId) {
    recordDiagnostic({ level: 'error', stage: 'turn-start', code: 'TURN_START_INVALID_RESPONSE', details: turnContext })
    throw diagnosticError('TURN_START_INVALID_RESPONSE', 'turn unavailable')
  }
  let after = 0
  let completed = false
  const seen = new Set()
  let assistantRendered = false
  const deadline = Date.now() + 15 * 60 * 1000
  while (!completed) {
    const poll = await fetchJsonDiagnostic(`/api/pet/chat/turn/${encodeURIComponent(turnId)}?after=${after}`, {}, { stage: 'turn-poll', turnId, hadImage: Boolean(pendingImage), attachmentId: attachment?.id })
    const payload = poll.payload
    const events = Array.isArray(payload?.events) ? payload.events : []
    const validStatus = ['running', 'done', 'error'].includes(payload?.status)
    const lastSeq = Number(payload?.lastSeq)
    if (payload?.ok !== true || payload.turnId !== turnId || !validStatus || !Number.isInteger(lastSeq) || lastSeq < after || lastSeq !== after + events.length) {
      recordDiagnostic({ level: 'error', stage: 'turn-poll', code: 'TURN_POLL_INVALID_RESPONSE', details: { turnId, visualInspectionCount: events.length } })
      throw diagnosticError('TURN_POLL_INVALID_RESPONSE', 'turn poll unavailable')
    }
    let expectedSeq = after + 1
    for (const event of events) {
      if (!TURN_EVENT_TYPES.has(event?.type)) {
        recordDiagnostic({ level: 'error', stage: 'turn-poll', code: 'TURN_EVENT_UNKNOWN', details: { turnId } })
        throw diagnosticError('TURN_EVENT_UNKNOWN', 'turn event unavailable')
      }
      if (!Number.isInteger(event?.seq) || event.seq !== expectedSeq || event.turnId !== turnId || seen.has(event.seq) || event.seq > lastSeq) {
        recordDiagnostic({ level: 'error', stage: 'turn-poll', code: 'TURN_EVENT_INVALID', details: { turnId } })
        throw diagnosticError('TURN_EVENT_INVALID', 'turn event unavailable')
      }
      seen.add(event.seq)
      expectedSeq += 1
      if (event.type === 'assistant_message') assistantRendered = true
      renderTurnEvent(event)
      scrollMessagesToBottom()
    }
    after = lastSeq
    if (payload?.status === 'done') {
      completed = true
      if (!assistantRendered) {
        const replies = Array.isArray(payload.result?.replyMessages) && payload.result.replyMessages.length ? payload.result.replyMessages : [payload.result?.text]
        replies.filter(Boolean).forEach((text) => line('pet', text))
      }
    } else if (payload?.status === 'error') {
      const failure = events.find((event) => event.type === 'turn_failed')?.payload ?? {}
      recordDiagnostic({ level: 'error', stage: 'turn-poll', code: failure.code ?? 'TURN_FAILED', requestId: failure.requestId, details: { turnId, retryable: failure.retryable, visualInspectionCount: failure.visualInspectionCount } })
      throw diagnosticError('TURN_FAILED', 'turn failed')
    } else if (Date.now() < deadline) {
      await waitForTurnPoll()
    } else {
      recordDiagnostic({ level: 'error', stage: 'turn-poll', code: 'TURN_POLL_TIMEOUT', details: { turnId, visualInspectionCount: seen.size } })
      throw diagnosticError('TURN_POLL_TIMEOUT', 'turn poll timeout')
    }
  }
  removeThinkingMessage(thinkingMessage)
}

function renderDiagnosticsPanel() {
  if (!diagnosticsOutput) return
  const events = diagnostics.list()
  diagnosticsOutput.textContent = events.length ? diagnostics.exportText() : '暂无诊断记录。'
  if (diagnosticsCopyFallback) diagnosticsCopyFallback.hidden = true
}

function openDiagnosticsPanel() {
  if (!diagnosticsPanel) return
  renderDiagnosticsPanel()
  diagnosticsStatus.textContent = ''
  diagnosticsPanel.hidden = false
  diagnosticsCloseButton?.focus({ preventScroll: true })
}

function closeDiagnosticsPanel() {
  if (!diagnosticsPanel) return
  diagnosticsPanel.hidden = true
  connection?.focus?.({ preventScroll: true })
}

async function copyDiagnostics() {
  const text = diagnostics.exportText()
  try {
    await globalThis.navigator?.clipboard?.writeText?.(text)
    diagnosticsStatus.textContent = '诊断记录已复制。'
  } catch {
    if (!diagnosticsCopyFallback) return
    diagnosticsCopyFallback.hidden = false
    diagnosticsCopyFallback.value = text
    diagnosticsCopyFallback.focus({ preventScroll: true })
    diagnosticsCopyFallback.select()
    diagnosticsStatus.textContent = '请手动复制下面的诊断记录。'
  }
}

function connectionDiagnosticTap() {
  connectionTapCount += 1
  if (connectionTapTimer) clearTimeout(connectionTapTimer)
  connectionTapTimer = setTimeout(() => { connectionTapCount = 0 }, 1_200)
  if (connectionTapCount < 5) return
  connectionTapCount = 0
  clearTimeout(connectionTapTimer)
  openDiagnosticsPanel()
}

function sourceBasename(value) {
  if (typeof value !== 'string') return null
  return value.split(/[?#]/u)[0].split('/').filter(Boolean).at(-1)?.slice(0, 120) ?? null
}

function installDiagnosticHooks() {
  globalThis.addEventListener?.('online', () => {
    recordDiagnostic({ level: 'info', stage: 'network', code: 'ONLINE' })
    void refresh()
  })
  globalThis.addEventListener?.('offline', () => {
    recordDiagnostic({ level: 'warn', stage: 'network', code: 'OFFLINE' })
    setOnline(false)
  })
  globalThis.addEventListener?.('error', (event) => {
    const error = event?.error
    recordDiagnostic({
      level: 'error', stage: 'runtime', code: 'UNHANDLED_ERROR', message: error?.message,
      details: {
        errorName: typeof error?.name === 'string' ? error.name : null,
        source: sourceBasename(event?.filename), line: event?.lineno, column: event?.colno,
      },
    })
  })
  globalThis.addEventListener?.('unhandledrejection', (event) => {
    const reason = event?.reason
    recordDiagnostic({
      level: 'error', stage: 'runtime', code: 'UNHANDLED_REJECTION',
      message: typeof reason === 'string' ? reason : reason?.message,
      details: { errorName: typeof reason?.name === 'string' ? reason.name : null },
    })
  })
  imageThumbnail?.addEventListener('error', () => {
    recordDiagnostic({ level: 'error', stage: 'image-load', code: 'IMAGE_LOAD_FAILURE', details: imageDiagnosticDetails(selectedImage ?? {}) })
  })
  sprite?.addEventListener('error', () => {
    recordDiagnostic({ level: 'error', stage: 'image-load', code: 'IMAGE_LOAD_FAILURE' })
  })
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
  diagnosticsPanel = document.querySelector('#diagnostics-panel')
  diagnosticsOutput = document.querySelector('#diagnostics-output')
  diagnosticsStatus = document.querySelector('#diagnostics-status')
  diagnosticsCopyFallback = document.querySelector('#diagnostics-copy-fallback')
  diagnosticsCopyButton = document.querySelector('#diagnostics-copy')
  diagnosticsClearButton = document.querySelector('#diagnostics-clear')
  diagnosticsCloseButton = document.querySelector('#diagnostics-close')

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
  connection.addEventListener('click', connectionDiagnosticTap)
  diagnosticsCloseButton.addEventListener('click', closeDiagnosticsPanel)
  diagnosticsCopyButton.addEventListener('click', () => { void copyDiagnostics() })
  diagnosticsClearButton.addEventListener('click', () => {
    if (globalThis.confirm?.('清空诊断记录？') === false) return
    diagnostics.clear()
    diagnosticsStatus.textContent = '诊断记录已清空。'
    renderDiagnosticsPanel()
  })

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
      await runTurnProgress({ message, pendingImage, attachment, thinkingMessage })
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
  installDiagnosticHooks()
  bindKeyboardState()
  restoreActiveTab()
  updateSendButton()
  recordDiagnostic({ level: 'info', stage: 'app', code: 'APP_BOOT' })
  refresh()
  loadHistory()
  setInterval(refresh, 1500)
}

startApp()
