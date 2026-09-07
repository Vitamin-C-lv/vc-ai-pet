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
let houseView
let chatView
let appHeader
let petApp
let navigation
let currentScreen = 'home'
let composerController
let emojiController
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
const KEYBOARD_OPEN_THRESHOLD = 120
const KEYBOARD_CLOSE_THRESHOLD = 72
const SCREEN = globalThis.VcAiPetNavigation?.VC_SCREEN ?? Object.freeze({
  HOME: 'home',
  HOUSE: 'house',
  CHAT: 'chat',
  GALLERY: 'gallery',
  GALLERY_DETAIL: 'gallery-detail',
  DREAMS: 'dreams',
})
const VALID_SCREENS = new Set(Object.values(SCREEN))
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
    tab: currentScreen === SCREEN.CHAT ? 'chat' : 'play',
    screen: currentScreen,
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

let innerLifeView
let innerLifeNextOffset = null
let innerLifeLoading = false
let visualGalleryView
let visualGalleryDetailView
let visualGalleryNextOffset = null
let visualGalleryLoading = false
let visualGalleryDetailLoading = false

function formatInnerLifeTime(value) {
  if (value === null || !Number.isFinite(Number(value))) return '还没有'
  return new Date(Number(value)).toLocaleString('zh-CN', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function renderInnerLifeEntry(item) {
  const card = document.createElement('article')
  card.className = 'inner-life-card'
  const heading = document.createElement('div')
  heading.className = 'inner-life-card-heading'
  const type = document.createElement('strong')
  type.textContent = item.kind === 'dream' ? '🌙 一场梦境' : '💭 小思考'
  const time = document.createElement('time')
  time.dateTime = new Date(Number(item.at)).toISOString()
  time.textContent = formatInnerLifeTime(item.at)
  heading.append(type, time)
  const summary = document.createElement('p')
  summary.className = 'inner-life-summary'
  const insightCount = Number(item.insightCount ?? item.understandingCount ?? 0)
  summary.textContent = item.summary || (insightCount === 0 ? '这次没有形成新的理解。' : '这段回想暂不展示摘要。')
  const meta = document.createElement('p')
  meta.className = 'inner-life-meta'
  meta.textContent = `联想与理解 · ${insightCount} 条新理解`
  card.append(heading, summary, meta)

  if (insightCount > 0) {
    const toggle = document.createElement('button')
    toggle.className = 'inner-life-insight-toggle'
    toggle.type = 'button'
    toggle.textContent = '查看这次花花想明白了什么'
    const panel = document.createElement('div')
    panel.className = 'inner-life-insights'
    panel.hidden = true
    const insights = Array.isArray(item.insights) ? item.insights : []
    if (insights.length === 0) {
      const unavailable = document.createElement('p')
      unavailable.className = 'inner-life-insight-empty'
      unavailable.textContent = '这次留下了新的理解，但当前没有可展示的安全内容。'
      panel.append(unavailable)
    } else {
      insights.forEach((insight) => {
        if (typeof insight?.content !== 'string' || !insight.content) return
        const content = document.createElement('p')
        content.className = 'inner-life-insight'
        content.textContent = insight.content
        panel.append(content)
      })
    }
    toggle.setAttribute('aria-expanded', 'false')
    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden
      toggle.setAttribute('aria-expanded', String(!panel.hidden))
    })
    card.append(toggle, panel)
  }
  return card
}

async function loadInnerLife({ more = false } = {}) {
  if (innerLifeLoading) return
  innerLifeLoading = true
  const status = document.querySelector('#inner-life-status')
  const list = document.querySelector('#inner-life-list')
  const moreButton = document.querySelector('#inner-life-more')
  const refreshButton = document.querySelector('#inner-life-refresh')
  moreButton.disabled = true
  refreshButton.disabled = true
  status.textContent = '正在翻开花花的心事……'
  try {
    const offset = more ? innerLifeNextOffset : 0
    const { payload } = await fetchJsonDiagnostic(`/api/inner-life?offset=${offset ?? 0}`, { cache: 'no-store' }, { stage: 'inner-life' })
    if (!Array.isArray(payload?.items) || !payload?.stats) throw diagnosticError('INNER_LIFE_INVALID_RESPONSE', 'inner-life unavailable')
    document.querySelector('#dream-recent').textContent = String(payload.stats.recentDream)
    document.querySelector('#dream-total').textContent = String(payload.stats.totalDream)
    document.querySelector('#dream-latest').textContent = `最近梦境：${formatInnerLifeTime(payload.stats.lastDreamAt)}`
    if (!more) list.replaceChildren()
    payload.items.forEach(item => list.append(renderInnerLifeEntry(item)))
    innerLifeNextOffset = payload.nextOffset
    moreButton.hidden = innerLifeNextOffset === null
    status.textContent = list.children.length ? '' : '花花还没有留下梦境或回想，新的心事会慢慢出现在这里。'
  } catch {
    status.textContent = '暂时没能翻开心事，请稍后再试。'
  } finally {
    innerLifeLoading = false
    moreButton.disabled = false
    refreshButton.disabled = false
  }
}

function renderScreen(screen, params = {}) {
  const nextScreen = VALID_SCREENS.has(screen) ? screen : SCREEN.HOME
  currentScreen = nextScreen
  const views = [playView, houseView, chatView, innerLifeView, visualGalleryView, visualGalleryDetailView]
  views.filter(Boolean).forEach((view) => { view.hidden = true })
  const view = nextScreen === SCREEN.HOME ? playView
    : nextScreen === SCREEN.HOUSE ? houseView
      : nextScreen === SCREEN.CHAT ? chatView
        : nextScreen === SCREEN.DREAMS ? innerLifeView
          : nextScreen === SCREEN.GALLERY ? visualGalleryView
            : visualGalleryDetailView
  if (view) view.hidden = false
  if (appHeader) appHeader.hidden = nextScreen !== SCREEN.HOME
  petApp?.classList.toggle('chat-active', nextScreen === SCREEN.CHAT)
  if (petApp) petApp.dataset.screen = nextScreen
  const focusTarget = nextScreen === SCREEN.HOUSE ? '#house-back'
    : nextScreen === SCREEN.CHAT ? '#chat-home'
      : nextScreen === SCREEN.DREAMS ? '#inner-life-back'
        : nextScreen === SCREEN.GALLERY ? '#visual-gallery-back'
          : nextScreen === SCREEN.GALLERY_DETAIL ? '#visual-gallery-detail-back' : null
  if (focusTarget) document.querySelector(focusTarget)?.focus?.({ preventScroll: true })

  if (nextScreen === SCREEN.CHAT) {
    globalThis.requestAnimationFrame?.(() => scrollMessagesToBottom())
  } else if (nextScreen === SCREEN.DREAMS) {
    void loadInnerLife()
  } else if (nextScreen === SCREEN.GALLERY) {
    void loadGalleryList()
  } else if (nextScreen === SCREEN.GALLERY_DETAIL) {
    if (typeof params.experienceId === 'string' && params.experienceId) void loadGalleryDetail(params.experienceId)
    else document.querySelector('#visual-gallery-detail-status').textContent = '请先从图库选择一张照片。'
  }
}

function navigateTo(screen, params = {}) {
  navigation?.push(screen, params)
}

function navigateHome() {
  navigation?.home()
}

function navigateBack(fallback = SCREEN.HOME) {
  navigation?.back({ fallback })
}

function openInnerLife() {
  navigateTo(SCREEN.DREAMS)
}

function openHouse() {
  navigateTo(SCREEN.HOUSE)
}

function openGallery() {
  navigateTo(SCREEN.GALLERY)
}

function renderGalleryCard(item) {
  const card = document.createElement('button')
  card.className = 'visual-gallery-card'
  card.type = 'button'
  card.setAttribute('aria-label', `查看 ${formatInnerLifeTime(item.occurredAt)} 的照片`)
  if (typeof item.thumbnailUrl === 'string' && item.thumbnailUrl) {
    const image = document.createElement('img')
    image.className = 'visual-gallery-card-image'
    image.src = item.thumbnailUrl
    image.alt = '花花看过的照片'
    image.loading = 'lazy'
    card.append(image)
  } else {
    const placeholder = document.createElement('span')
    placeholder.className = 'visual-gallery-card-placeholder'
    placeholder.textContent = '照片暂不可用'
    card.append(placeholder)
  }
  const copy = document.createElement('span')
  copy.className = 'visual-gallery-card-copy'
  const date = document.createElement('span')
  date.className = 'visual-gallery-card-date'
  date.textContent = formatInnerLifeTime(item.occurredAt)
  const owner = document.createElement('span')
  owner.className = 'visual-gallery-card-owner'
  owner.textContent = item.ownerText || '主人没有留下文字。'
  const meta = document.createElement('span')
  meta.className = 'visual-gallery-card-meta'
  const markers = []
  if (item.hasObservation) markers.push('有视觉批注')
  if (item.hasComparison) markers.push('有对照')
  if (item.hasRevisit) markers.push('有复看')
  meta.textContent = markers.join(' · ') || '花花当时还没有留下视觉批注。'
  copy.append(date, owner, meta)
  card.append(copy)
  card.addEventListener('click', () => { void openGalleryDetail(item.experienceId) })
  return card
}

async function loadGalleryList({ more = false } = {}) {
  if (visualGalleryLoading) return
  visualGalleryLoading = true
  const status = document.querySelector('#visual-gallery-status')
  const grid = document.querySelector('#visual-gallery-grid')
  const moreButton = document.querySelector('#visual-gallery-more')
  const refreshButton = document.querySelector('#visual-gallery-refresh')
  moreButton.disabled = true
  refreshButton.disabled = true
  status.textContent = '正在翻看和花花一起看过的照片……'
  try {
    const offset = more ? visualGalleryNextOffset : 0
    const { payload } = await fetchJsonDiagnostic(`/api/visual-gallery?limit=24&offset=${offset ?? 0}`, { cache: 'no-store' }, { stage: 'visual-gallery-list' })
    if (!Array.isArray(payload?.items) || !Number.isFinite(Number(payload?.count))) throw diagnosticError('VISUAL_GALLERY_INVALID_RESPONSE', 'visual gallery unavailable')
    if (!more) grid.replaceChildren()
    payload.items.forEach((item) => grid.append(renderGalleryCard(item)))
    visualGalleryNextOffset = payload.nextOffset
    moreButton.hidden = visualGalleryNextOffset === null
    status.textContent = grid.children.length ? '' : '花花还没有找到一起看过的照片。'
  } catch {
    status.textContent = '暂时没能打开图库，请稍后再试。'
  } finally {
    visualGalleryLoading = false
    moreButton.disabled = false
    refreshButton.disabled = false
  }
}

function galleryEventLabel(event) {
  if (event.kind === 'observation') return '花花的观察 · INFERRED'
  if (event.kind === 'comparison') return '花花做了对照 · INFERRED'
  if (event.kind === 'revisit') return '花花又看了看'
  return '花花查看了这张照片'
}

function renderGalleryEvent(event) {
  const article = document.createElement('article')
  article.className = 'visual-gallery-event'
  const heading = document.createElement('div')
  heading.className = 'visual-gallery-event-heading'
  const kind = document.createElement('strong')
  kind.textContent = galleryEventLabel(event)
  const time = document.createElement('time')
  time.dateTime = new Date(Number(event.occurredAt)).toISOString()
  time.textContent = formatInnerLifeTime(event.occurredAt)
  heading.append(kind, time)
  article.append(heading)
  if (typeof event.summary === 'string' && event.summary) {
    const summary = document.createElement('p')
    summary.textContent = event.summary
    article.append(summary)
  }
  if (typeof event.relatedExperienceId === 'string' && event.relatedExperienceId) {
    const related = document.createElement('button')
    related.className = 'visual-gallery-event-link'
    related.type = 'button'
    related.textContent = '查看相关照片'
    related.addEventListener('click', () => { void openGalleryDetail(event.relatedExperienceId) })
    article.append(related)
  }
  return article
}

function renderGalleryTerms(terms) {
  const list = document.querySelector('#visual-gallery-term-list')
  list.replaceChildren()
  if (!Array.isArray(terms) || terms.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'visual-gallery-empty'
    empty.textContent = '暂时没有足够的检索线索。'
    list.append(empty)
    return
  }
  terms.forEach((term) => {
    const item = document.createElement('span')
    item.className = 'visual-gallery-term'
    const label = document.createElement('span')
    label.textContent = term.term
    const source = document.createElement('small')
    source.textContent = term.sourceKind === 'observation' ? '视觉' : '主人'
    item.append(label, source)
    list.append(item)
  })
}

function renderGalleryDebug(debug) {
  const content = document.querySelector('#visual-gallery-debug-content')
  content.replaceChildren()
  const fields = [
    ['experienceId', debug?.experienceId],
    ['sourceMessageId', debug?.sourceMessageId],
    ['attachmentId', debug?.attachmentId],
    ['rawRoot', debug?.rawRoot ? `${debug.rawRoot.sourceMessageId} / ${debug.rawRoot.attachmentId}` : null],
    ['inspectionCount', debug?.inspectionCount],
    ['lastInspectedAt', debug?.lastInspectedAt ? formatInnerLifeTime(debug.lastInspectedAt) : '—'],
    ['eventCount', debug?.eventCount],
  ]
  const dl = document.createElement('dl')
  fields.forEach(([label, value]) => {
    const term = document.createElement('dt')
    term.textContent = label
    const description = document.createElement('dd')
    description.textContent = value === null || value === undefined ? '—' : String(value)
    dl.append(term, description)
  })
  content.append(dl)
  const events = document.createElement('p')
  events.textContent = `event metadata: ${Array.isArray(debug?.eventMetadata) ? debug.eventMetadata.map((event) => `${event.kind}/${event.evidence}/${event.eventId}`).join(' · ') || '—' : '—'}`
  content.append(events)
  const terms = document.createElement('p')
  terms.textContent = `terms: ${Array.isArray(debug?.terms) ? debug.terms.map((term) => `${term.sourceKind}/${term.term}/${term.weight}`).join(' · ') || '—' : '—'}`
  content.append(terms)
}

function renderGalleryDetail(payload) {
  const image = document.querySelector('#visual-gallery-original')
  if (typeof payload?.originalUrl === 'string' && payload.originalUrl) {
    image.src = payload.originalUrl
    image.removeAttribute('hidden')
  } else {
    image.removeAttribute('src')
    image.setAttribute('hidden', '')
  }
  document.querySelector('#visual-gallery-date').textContent = formatInnerLifeTime(payload?.occurredAt)
  document.querySelector('#visual-gallery-owner-text').textContent = payload?.ownerText || '主人当时没有留下文字。'
  document.querySelector('#visual-gallery-owner-provenance').textContent = payload?.ownerTextProvenance === 'raw' ? '原话 · RAW' : '主人文字'
  const eventList = document.querySelector('#visual-gallery-event-list')
  eventList.replaceChildren()
  if (!Array.isArray(payload?.visualEvents) || payload.visualEvents.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'visual-gallery-empty'
    empty.textContent = '花花当时还没有留下视觉批注。'
    eventList.append(empty)
  } else {
    payload.visualEvents.forEach((event) => eventList.append(renderGalleryEvent(event)))
  }
  renderGalleryTerms(payload?.visualTerms)
  renderGalleryDebug(payload?.debug)
}

async function loadGalleryDetail(experienceId) {
  if (typeof experienceId !== 'string' || !experienceId || visualGalleryDetailLoading) return
  visualGalleryDetailLoading = true
  const status = document.querySelector('#visual-gallery-detail-status')
  status.textContent = '正在打开这段视觉经历……'
  try {
    const { payload } = await fetchJsonDiagnostic(`/api/visual-gallery/${encodeURIComponent(experienceId)}`, { cache: 'no-store' }, { stage: 'visual-gallery-detail' })
    if (!payload?.experienceId || !Array.isArray(payload.visualEvents) || !Array.isArray(payload.visualTerms)) throw diagnosticError('VISUAL_GALLERY_DETAIL_INVALID_RESPONSE', 'visual gallery detail unavailable')
    renderGalleryDetail(payload)
    status.textContent = ''
    document.querySelector('#visual-gallery-detail-back').focus({ preventScroll: true })
  } catch {
    status.textContent = '暂时没能打开这张照片，请稍后再试。'
  } finally {
    visualGalleryDetailLoading = false
  }
}

function openGalleryDetail(experienceId) {
  if (typeof experienceId !== 'string' || !experienceId) return
  navigateTo(SCREEN.GALLERY_DETAIL, { experienceId })
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

const VISUAL_ACTIVITY_TYPES = new Set(['visual_recall', 'visual_selected', 'visual_observation', 'visual_compare'])

function visualRelation(value) {
  return value === 'current' ? 'current' : value === 'recalled' ? 'recalled' : 'previous'
}

function createVisualPresentationState({ currentAttachmentId = null } = {}) {
  return {
    mode: 'text',
    currentAttachmentId: typeof currentAttachmentId === 'string' ? currentAttachmentId : null,
    recalled: false,
    comparison: false,
    currentActivityShown: false,
    recalledActivityShown: false,
    previousActivityShown: false,
    observationShown: false,
    mediaImageCounts: new Map(),
    finalCount: 0,
  }
}

function visualActivityCopy(type, relation) {
  if (type === 'visual_selected') {
    if (relation === 'current') return '👀 花花仔细看了看'
    if (relation === 'recalled') return '↩️ 花花翻到以前的一张照片'
    return '↩️ 花花再回头看看前一张'
  }
  if (type === 'visual_observation') return relation === 'current' ? '👀 花花仔细看了看' : '👀 花花重新看了看'
  if (type === 'visual_compare') return '🔎 花花对照了这几张'
  return ''
}

function visualSourceRelation(source, state) {
  if (source?.relation) return visualRelation(source.relation)
  if (source?.sourceAttachmentId && state?.currentAttachmentId && source.sourceAttachmentId === state.currentAttachmentId) return 'current'
  return 'previous'
}

function renderVisualActivity({ type, source = {}, state }) {
  state.mode = 'visual'
  if (type === 'visual_recall') {
    state.recalled = true
    return null
  }
  if (!VISUAL_ACTIVITY_TYPES.has(type)) return null
  const relation = visualSourceRelation(source, state)
  if (source.comparison === true || type === 'visual_compare') state.comparison = true
  if (relation === 'recalled') state.recalled = true

  if (type === 'visual_selected') {
    if (relation === 'current') {
      if (state.currentActivityShown) return null
      state.currentActivityShown = true
    } else if (relation === 'recalled') {
      if (state.recalledActivityShown) return null
      state.recalledActivityShown = true
    } else {
      if (state.recalled && !state.comparison) return null
      if (state.previousActivityShown) return null
      state.previousActivityShown = true
    }
    return renderMessage({ role: 'assistant', kind: 'activity', text: visualActivityCopy(type, relation) })
  }

  if (type === 'visual_compare' || state.comparison || state.observationShown) return null
  if (relation === 'current' && state.currentActivityShown) return null
  state.observationShown = true
  return renderMessage({ role: 'assistant', kind: 'activity', text: visualActivityCopy(type, relation) })
}

function shouldSkipFirstCurrentMedia(sourceAttachmentId, state, count) {
  return Boolean(sourceAttachmentId && state.currentAttachmentId && sourceAttachmentId === state.currentAttachmentId && count === 0)
}

function renderMessage({ role, kind = 'dialogue', text = '', attachment = null, reasoning = null, showAttachment = true } = {}) {
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

  const canRenderAttachment = showAttachment && (userMessage || kind === 'media_ref')
  const thumbnailUrl = canRenderAttachment && typeof attachment?.thumbnailUrl === 'string' ? attachment.thumbnailUrl : ''
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

const TURN_EVENT_TYPES = new Set(['turn_started', 'thinking', 'visual_recall', 'visual_selected', 'visual_image', 'visual_observation', 'visual_compare', 'memory_recall', 'assistant_message', 'turn_completed', 'turn_failed'])

function renderTurnEvent(event, state = null) {
  const presentation = state ?? createVisualPresentationState()
  const payload = event?.payload ?? {}
  if (event?.type === 'turn_started') {
    presentation.mode = payload.mode === 'visual' ? 'visual' : 'text'
    return null
  }
  if (event?.type === 'thinking' || event?.type === 'turn_failed') return null
  if (event?.type === 'visual_recall') return renderVisualActivity({ type: event.type, source: payload, state: presentation })
  if (event?.type === 'visual_selected') {
    removeThinkingMessage(document.querySelector('.thinking-message'))
    const node = renderVisualActivity({ type: event.type, source: payload, state: presentation })
    if (node && payload.relation === 'recalled') node.classList.add('vm-recalled')
    return node
  }
  if (event?.type === 'visual_image') {
    removeThinkingMessage(document.querySelector('.thinking-message'))
    presentation.mode = 'visual'
    const sourceAttachmentId = typeof payload.sourceAttachmentId === 'string' ? payload.sourceAttachmentId : ''
    const count = presentation.mediaImageCounts.get(sourceAttachmentId) ?? 0
    presentation.mediaImageCounts.set(sourceAttachmentId, count + 1)
    if (shouldSkipFirstCurrentMedia(sourceAttachmentId, presentation, count)) return null
    return renderMessage({ role: 'assistant', kind: 'media_ref', text: '', attachment: payload.attachment })
  }
  if (event?.type === 'visual_observation' || event?.type === 'visual_compare') return renderVisualActivity({ type: event.type, source: payload, state: presentation })
  if (event?.type === 'memory_recall') {
    if (presentation.mode === 'visual') return null
    return renderMessage({ role: 'assistant', kind: 'activity', text: `${payload.provenance === 'inferred' ? '💭 联想到：' : '🧠 想起：'}${payload.summary ?? ''}` })
  }
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
  const visualTurnKeys = new Set()
  const recalledTurnKeys = new Set()
  const comparisonTurnKeys = new Set()
  const turnKeyFor = (message, index) => message?.turnId || `message-${index}`
  history.forEach((message, index) => {
    const key = turnKeyFor(message, index)
    if (message?.kind === 'media_ref' || VISUAL_ACTIVITY_TYPES.has(message?.activityType)) visualTurnKeys.add(key)
    if (message?.activityType === 'visual_recall') recalledTurnKeys.add(key)
    if (message?.activityType === 'visual_compare') comparisonTurnKeys.add(key)
  })
  const presentations = new Map()
  const presentationFor = (message, index) => {
    const key = turnKeyFor(message, index)
    let state = presentations.get(key)
    if (!state) {
      state = createVisualPresentationState()
      state.mode = visualTurnKeys.has(key) ? 'visual' : 'text'
      state.recalled = recalledTurnKeys.has(key)
      state.comparison = comparisonTurnKeys.has(key)
      presentations.set(key, state)
    }
    return state
  }

  history.forEach((message, index) => {
    const state = presentationFor(message, index)
    if (message?.role === 'user' && message.attachment?.id) state.currentAttachmentId = message.attachment.id

    if (message.kind === 'activity' && VISUAL_ACTIVITY_TYPES.has(message.activityType)) {
      renderVisualActivity({ type: message.activityType, source: message, state })
      return
    }
    if (message.kind === 'activity' && message.activityType === 'memory_recall' && state.mode === 'visual') return
    if (message.kind === 'media_ref') {
      state.mode = 'visual'
      const sourceAttachmentId = typeof message.sourceAttachmentId === 'string' ? message.sourceAttachmentId : message.attachment?.id
      const count = state.mediaImageCounts.get(sourceAttachmentId) ?? 0
      state.mediaImageCounts.set(sourceAttachmentId, count + 1)
      if (shouldSkipFirstCurrentMedia(sourceAttachmentId, state, count)) return
      renderMessage({ ...message, role: 'assistant', text: '', attachment: message.attachment })
      return
    }
    if (message.kind === 'final' && state.mode === 'visual') {
      const finalLimit = state.recalled ? 1 : 2
      state.finalCount += 1
      if (state.finalCount > finalLimit) return
    }
    renderMessage(message)
  })
}

function updateSendButton() {
  if (composerController) {
    composerController.sync()
    return
  }
  const hasText = input.value.trim().length > 0
  const canSend = hasText || Boolean(selectedImage)
  sendButton.dataset.mode = canSend ? 'send' : 'add'
  sendButton.textContent = canSend ? '发送' : '+'
  sendButton.disabled = imageProcessing
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
    if (currentScreen === SCREEN.CHAT) scrollMessagesToBottom()
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
  const presentation = createVisualPresentationState({ currentAttachmentId: attachment?.id })
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
      renderTurnEvent(event, presentation)
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

async function submitComposer(message = input.value.trim()) {
  if (imageProcessing) return
  const pendingImage = selectedImage
  if (!message && !pendingImage) return

  const restoreInputFocus = document.activeElement === input
  input.value = ''
  input.readOnly = true
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
    clearImageSelection()
    if (restoreInputFocus && currentScreen === SCREEN.CHAT) input.focus({ preventScroll: true })
    updateSendButton()
    void refresh()
  }
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
  houseView = document.querySelector('#house-view')
  chatView = document.querySelector('#chat-view')
  appHeader = document.querySelector('#app-header')
  innerLifeView = document.querySelector('#inner-life-view')
  visualGalleryView = document.querySelector('#visual-gallery-view')
  visualGalleryDetailView = document.querySelector('#visual-gallery-detail-view')

  navigation = globalThis.VcAiPetNavigation?.createVcNavigation?.({
    getScreen: () => currentScreen,
    goToScreen: renderScreen,
  }) ?? (() => {
    const stack = []
    return {
      push(screen, params = {}) {
        if (currentScreen !== screen) stack.push(currentScreen)
        renderScreen(screen, params)
      },
      home() {
        stack.length = 0
        renderScreen(SCREEN.HOME)
      },
      back({ fallback = SCREEN.HOME } = {}) {
        renderScreen(stack.pop() || fallback)
      },
    }
  })()

  document.querySelector('#inner-life-open')?.addEventListener('click', openInnerLife)
  document.querySelector('#house-open')?.addEventListener('click', openHouse)
  document.querySelector('#chat-open')?.addEventListener('click', () => navigateTo(SCREEN.CHAT))
  document.querySelector('#house-back')?.addEventListener('click', () => navigateBack(SCREEN.HOME))
  document.querySelector('#house-home')?.addEventListener('click', navigateHome)
  document.querySelector('#inner-life-back')?.addEventListener('click', () => navigateBack(SCREEN.HOME))
  document.querySelector('#inner-life-home')?.addEventListener('click', navigateHome)
  document.querySelector('#inner-life-refresh')?.addEventListener('click', () => { void loadInnerLife() })
  document.querySelector('#inner-life-more')?.addEventListener('click', () => { void loadInnerLife({ more: true }) })
  document.querySelector('#visual-gallery-back')?.addEventListener('click', () => navigateBack(SCREEN.HOME))
  document.querySelector('#visual-gallery-home')?.addEventListener('click', navigateHome)
  document.querySelector('#visual-gallery-refresh')?.addEventListener('click', () => { void loadGalleryList() })
  document.querySelector('#visual-gallery-more')?.addEventListener('click', () => { void loadGalleryList({ more: true }) })
  document.querySelector('#visual-gallery-detail-back')?.addEventListener('click', () => navigateBack(SCREEN.GALLERY))
  document.querySelector('#visual-gallery-detail-home')?.addEventListener('click', navigateHome)
  document.querySelector('#chat-home')?.addEventListener('click', navigateHome)
  document.querySelector('#chat-gallery')?.addEventListener('click', openGallery)
  petApp = document.querySelector('.pet-app')
  diagnosticsPanel = document.querySelector('#diagnostics-panel')
  diagnosticsOutput = document.querySelector('#diagnostics-output')
  diagnosticsStatus = document.querySelector('#diagnostics-status')
  diagnosticsCopyFallback = document.querySelector('#diagnostics-copy-fallback')
  diagnosticsCopyButton = document.querySelector('#diagnostics-copy')
  diagnosticsClearButton = document.querySelector('#diagnostics-clear')
  diagnosticsCloseButton = document.querySelector('#diagnostics-close')

  document.querySelector('#pet-button').addEventListener('click', () => action('click'))
  document.querySelector('#play-button').addEventListener('click', () => action('double_click'))
  document.querySelector('#long-button').addEventListener('click', () => action('long_press'))
  imageButton.addEventListener('click', () => imageInput.click())
  imageInput.addEventListener('change', () => { void chooseImage() })
  removeImage.addEventListener('click', () => clearImageSelection())
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

  let emojiAtBottom = false
  emojiController = globalThis.VcAiPetEmoji?.wireEmojiDrawer?.({
    drawer: document.querySelector('#emoji-drawer'),
    input,
    button: document.querySelector('#emoji-button'),
    onToggle: (open) => {
      if (open) {
        emojiAtBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 32
      }
      if (emojiAtBottom) globalThis.requestAnimationFrame?.(() => scrollMessagesToBottom())
    },
  })
  composerController = globalThis.VcAiPetComposer?.wireVcComposer?.({
    form,
    input,
    micButton: document.querySelector('#mic-button'),
    emojiButton: document.querySelector('#emoji-button'),
    actionButton: sendButton,
    emojiController,
    openExistingImagePicker: async () => imageButton.click(),
    sendExistingText: (message) => submitComposer(message),
    hasPendingImage: () => Boolean(selectedImage),
    isBusy: () => imageProcessing,
    showToast: (message) => {
      imageStatus.textContent = message
      globalThis.setTimeout(() => {
        if (imageStatus.textContent === message) imageStatus.textContent = ''
      }, 1_800)
    },
  })
  renderScreen(SCREEN.HOME)
}

function startApp() {
  bindDom()
  installDiagnosticHooks()
  bindKeyboardState()
  updateSendButton()
  recordDiagnostic({ level: 'info', stage: 'app', code: 'APP_BOOT' })
  refresh()
  loadHistory()
  setInterval(refresh, 1500)
}

startApp()
