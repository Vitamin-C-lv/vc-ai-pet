// System and transport copy must never be attributed to the pet.
//
// The real mobile.js runs in a VM against a queryable DOM stub, so the render
// assertions inspect the element tree that mobile.js actually builds. The
// visual contract - centred, speakerless, visually distinct from a pet bubble -
// is pinned on the CSS rules that style it.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const [mobileJs, mobileCss, submissionJs, diagnosticsJs, composerJs] = await Promise.all([
  readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/submission-state.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/diagnostics.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/chat-composer.js'), 'utf8'),
])

// ---------------------------------------------------------------- DOM stub ---
function matchesSelector(element, selector) {
  const classes = String(element.className ?? '').split(/\s+/u).filter(Boolean)
  const [base, ...exclusions] = selector.split(':not(')
  if (!classes.includes(base.replace(/^\./u, ''))) return false
  return exclusions.every((excluded) => !classes.includes(excluded.replace(/\)$/u, '').replace(/^\./u, '')))
}

function findMatches(node, selector, found = []) {
  for (const child of node.childNodes) {
    if (matchesSelector(child, selector)) found.push(child)
    findMatches(child, selector, found)
  }
  return found
}

function createElement(tagName) {
  const element = {
    tagName: String(tagName).toUpperCase(),
    childNodes: [],
    parentNode: null,
    className: '',
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    style: {},
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      contains: (name) => String(element.className).split(/\s+/u).includes(name),
      add: (name) => { element.className = `${element.className} ${name}`.trim() },
      remove() {},
      toggle() {},
    },
    append(...nodes) {
      for (const node of nodes) {
        if (node && typeof node === 'object') {
          node.parentNode = element
          element.childNodes.push(node)
        }
      }
    },
    appendChild(node) { element.append(node); return node },
    removeChild(node) {
      element.childNodes = element.childNodes.filter((child) => child !== node)
      return node
    },
    replaceChildren(...nodes) { element.childNodes = []; element.append(...nodes) },
    remove() { if (element.parentNode) element.parentNode.removeChild(element) },
    setAttribute(name, value) { element[name] = value },
    removeAttribute() {},
    getAttribute: () => null,
    querySelector: (selector) => findMatches(element, selector)[0] ?? null,
    querySelectorAll: (selector) => findMatches(element, selector),
    closest: () => null,
    matches: (selector) => matchesSelector(element, selector),
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    click() {},
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
  }
  return element
}

const messages = createElement('div')
messages.className = 'messages'
const petGreeting = createElement('article')
petGreeting.className = 'message pet-line'
const greetingBubble = createElement('div')
greetingBubble.className = 'message-bubble'
const greetingLabel = createElement('div')
greetingLabel.className = 'message-label'
greetingLabel.textContent = '李花花'
const greetingText = createElement('p')
greetingText.className = 'message-text'
greetingText.textContent = '汪，在呀。'
greetingBubble.append(greetingLabel, greetingText)
petGreeting.append(greetingBubble)
messages.append(petGreeting)

const documentSelectors = new Map([['#messages', messages]])
const documentStub = {
  readyState: 'complete',
  visibilityState: 'visible',
  body: createElement('body'),
  documentElement: createElement('html'),
  createElement,
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  querySelector(selector) {
    if (!documentSelectors.has(selector)) documentSelectors.set(selector, createElement('div'))
    return documentSelectors.get(selector)
  },
  querySelectorAll: () => [],
  addEventListener() {},
}
documentStub.getElementById = documentStub.querySelector

// The transport is driven per case so both the success and the failure path of
// a real submission can be exercised.
const transport = { respond: async () => { throw new Error('offline fixture') } }
const context = {
  console,
  document: documentStub,
  location: { href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
  navigator: { userAgent: 'system-notice-fixture' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  fetch: (...args) => transport.respond(...args),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
  WebSocket: class {},
  Image: class {},
  URL,
  URLSearchParams,
  AbortController,
  crypto: globalThis.crypto,
}
context.window = context
context.globalThis = context
context.self = context
vm.createContext(context)
vm.runInContext(submissionJs, context, { filename: 'submission-state.js' })
vm.runInContext(diagnosticsJs, context, { filename: 'diagnostics.js' })
vm.runInContext(composerJs, context, { filename: 'chat-composer.js' })
vm.runInContext(mobileJs, context, { filename: 'mobile.js' })

const noticeOf = () => messages.querySelector('.notice-line')
const petOf = () => messages.querySelector('.pet-line:not(.thinking-message)')
const noticeText = () => noticeOf()?.querySelector('.message-text')?.textContent ?? null

// ------------------------------------------------------------------ CASE A ---
// The pet's own line still carries the pet's name; system copy never does.
assert.equal(messages.childNodes.length, 1, 'fixture holds the pet greeting only')
assert.equal(petOf().querySelector('.message-label').textContent, '李花花', 'pet dialogue keeps its speaker label')
assert.equal(noticeOf(), null, 'a fresh chat has no system line')

// ------------------------------------------------------------------ CASE B ---
// The expired-send recovery line is the regression the owner reported.
context.showSubmissionStatus('之前未完成的发送已经过期。', { variant: 'error' })
const expired = noticeOf()
assert.ok(expired, 'expired-send copy renders as a notice line')
assert.equal(expired.className.includes('notice-line'), true, 'notice line class is applied')
assert.equal(expired.className.includes('notice-error'), true, 'expired send is marked as an error')
assert.equal(expired.className.includes('pet-line'), false, 'notice is never a pet line')
assert.equal(expired.querySelectorAll('.message-label').length, 0, 'no speaker label is attached to the system line')
assert.equal(noticeText(), '之前未完成的发送已经过期。', 'the copy is unchanged')
assert.equal(petOf().querySelector('.message-label').textContent, '李花花', 'the pet line is untouched next to it')
assert.equal(expired.querySelectorAll('.thinking-meta').length, 0, 'a system line never carries a pet reasoning duration')

// Only one system line is ever visible: a new status replaces the previous one.
context.showSubmissionStatus('这条消息没有完成；如需重试，请重新发送。', { variant: 'error' })
assert.equal(messages.querySelectorAll('.notice-line').length, 1, 'system status replaces itself instead of stacking')
assert.equal(noticeText(), '这条消息没有完成；如需重试，请重新发送。')
assert.equal(messages.childNodes.length, 2, 'the pet greeting survives system copy')

// ------------------------------------------------------------------ CASE C ---
// A real failed send: the transport refuses the turn, so the system - not the
// pet - reports it, and the draft is handed back for retry.
context.clearSubmissionStatus()
const chatInput = documentStub.querySelector('#chat-input')
chatInput.value = '这条消息发不出去'
// A capacity refusal is a safe pre-accept failure: the server never took the
// turn, so the system reports it and hands the draft back.
transport.respond = async () => ({
  ok: false,
  status: 503,
  headers: { get: () => null },
  json: async () => ({ error: 'turn-capacity', code: 'turn-capacity' }),
})
await context.submitComposer('这条消息发不出去')
assert.equal(messages.querySelectorAll('.notice-line').length, 1, 'the failed send reports exactly one system line')
assert.equal(petOf().querySelector('.message-label').textContent, '李花花', 'the pet line is still just the greeting')
const failed = noticeOf()
assert.ok(failed, 'a failed send renders a system line')
assert.equal(noticeText(), '这条消息没有发出去，可以重新发送。', 'failed send uses system copy')
assert.equal(failed.className.includes('notice-error'), true, 'failed send is an error line')
assert.equal(failed.querySelectorAll('.message-label').length, 0, 'failed send has no speaker label')
assert.equal(failed.className.includes('pet-line'), false, 'failed send is not pet dialogue')
assert.equal(messages.textContent.includes('花花脑袋刚刚卡了一下'), false, 'the pet no longer speaks system failures')
assert.equal(chatInput.value, '这条消息发不出去', 'the draft is restored for an explicit retry')

// ------------------------------------------------------------------ CASE D ---
// Every system copy path funnels through the same speakerless line, and the
// resume variant keeps its action.
const samples = [
  ['发送状态冲突，请刷新后重试。', { variant: 'error' }, false],
  ['消息可能已经交给花花了，正在确认……', { variant: 'error' }, false],
  ['消息已经交给花花了，但连接暂时中断。', { resume: true, variant: 'error' }, true],
  ['这条消息没有完成；如需重试，请重新发送。', { variant: 'error' }, false],
  ['上次图片还没有完成上传，请重新选择图片。', { variant: 'error' }, false],
  ['上一条消息还在确认中，请稍候。', { variant: 'error' }, false],
  ['之前未完成的发送已经过期。', { variant: 'error' }, false],
]
for (const [text, options, expectResume] of samples) {
  context.showSubmissionStatus(text, options)
  const node = noticeOf()
  assert.ok(node, `renders a notice line: ${text}`)
  assert.equal(noticeText(), text, `copy rendered verbatim: ${text}`)
  assert.equal(node.querySelectorAll('.message-label').length, 0, `no speaker label for: ${text}`)
  assert.equal(node.className.includes('pet-line'), false, `never a pet line: ${text}`)
  assert.equal(Boolean(node.querySelector('.submission-resume-button')), expectResume, `resume action state for: ${text}`)
}

// ------------------------------------------------------------------ CASE E ---
// Routing contract: no pet-voiced system channel is left, and the pet lines
// that remain are model or greeting copy.
assert.match(mobileJs, /submissionStatusNode = renderMessage\(\{ role: 'notice', text, variant \}\)/u, 'submission status renders through the notice role')
assert.doesNotMatch(mobileJs, /submissionStatusNode = line\(/u, 'submission status never renders through a speaker line')
assert.doesNotMatch(mobileJs, /showSubmissionStatus\([^)]*line\(/u, 'no system status path goes back to a speaker line')
assert.doesNotMatch(mobileJs, /花花脑袋刚刚卡了一下/u, 'the pet no longer voices send failures')
assert.match(mobileJs, /line\('pet', '汪，在呀。'\)/u, 'the empty-history greeting stays with the pet')
assert.match(mobileJs, /event\?\.type === 'assistant_message'\) return line\('pet'/u, 'model replies stay with the pet')
assert.match(mobileJs, /variant === 'error' \? ' notice-error' : ''/u, 'errors use the error variant')

// The CSS contract: centred, speakerless, and visually distinct from the pet
// bubble it used to borrow, with a separate error treatment.
const noticeRule = mobileCss.match(/\.message\.notice-line\s*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
assert.match(noticeRule, /justify-content:\s*center;/u, 'system line is centred')
assert.match(noticeRule, /flex-direction:\s*row;/u, 'system line is not a speech-bubble column')
const noticeBubbleRule = mobileCss.match(/\.notice-line\s*\.message-bubble\s*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
assert.match(noticeBubbleRule, /border:\s*0;/u, 'system line drops the pet bubble border')
assert.match(noticeBubbleRule, /text-align:\s*center;/u, 'system copy is centred')
assert.match(noticeBubbleRule, /border-radius:\s*999px;/u, 'system line reads as a notice chip')
const errorRule = mobileCss.match(/\.notice-line\.notice-error\s*\.message-bubble\s*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
assert.ok(errorRule, 'errors have their own notice treatment')
const background = (rule) => rule.match(/background:\s*([^;]+);/u)?.[1]
const petBubbleRule = mobileCss.match(/\.message-bubble,\n\.messages > p\.pet-line\s*\{([\s\S]*?)\n\}/u)?.[1] ?? ''
assert.notEqual(background(errorRule), background(noticeBubbleRule), 'error notices differ from plain notices')
assert.notEqual(background(noticeBubbleRule), background(petBubbleRule), 'notice background differs from the pet bubble')

console.log('CASE_A_PET_LINE_KEEPS_ITS_SPEAKER=PASS')
console.log('CASE_B_EXPIRED_SEND_IS_SPEAKERLESS_NOTICE=PASS')
console.log('CASE_C_FAILED_SEND_IS_SYSTEM_COPY=PASS')
console.log(`CASE_D_SYSTEM_COPY_PATHS=${samples.length}`)
console.log('CASE_E_PET_VOICE_SURFACES_UNCHANGED=PASS')
console.log('NOTICE_SPEAKER_LABEL=NONE')
console.log('NOTICE_RENDERS_AS_PET_LINE=NO')
console.log('SYSTEM_COPY_ATTRIBUTED_TO_PET=NO')
console.log('NOTICE_ERROR_VARIANT=YES')
