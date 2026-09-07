import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { PetTurnEvents } from '../src/runtime/pet-turn-events.js'
import { VisualWorkingSession } from '../src/vision/visual-working-session.js'

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.className = ''
    this.textContent = ''
  }

  append(...nodes) { this.children.push(...nodes) }
  appendChild(node) { this.children.push(node); return node }
  replaceChildren(...nodes) { this.children = nodes }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  removeAttribute(name) { this.attributes.delete(name) }
  addEventListener() {}
  remove() {}
  querySelector() { return null }
  get src() { return this.attributes.get('src') ?? '' }
  set src(value) { this.attributes.set('src', String(value)) }
  get classList() {
    return {
      add: (...names) => {
        const existing = new Set(this.className.split(/\s+/u).filter(Boolean))
        names.forEach((name) => existing.add(name))
        this.className = [...existing].join(' ')
      },
      toggle() {},
    }
  }
  get outerHTML() {
    const attributes = [...this.attributes.entries()].map(([name, value]) => ` ${name}="${value}"`).join('')
    const classAttribute = this.className ? ` class="${this.className}"` : ''
    const content = this.textContent || this.children.map((child) => child.outerHTML ?? child.textContent ?? '').join('')
    return `<${this.tagName.toLowerCase()}${classAttribute}${attributes}>${content}</${this.tagName.toLowerCase()}>`
  }
}

function countImages(node) {
  return (node.tagName === 'IMG' ? 1 : 0) + node.children.reduce((count, child) => count + countImages(child), 0)
}

function findText(node) {
  return [node.textContent, ...node.children.flatMap((child) => findText(child))].filter(Boolean).join(' ')
}

const mobileSource = await readFile(join(process.cwd(), 'src/remote/mobile-ui/mobile.js'), 'utf8')
const messages = new FakeElement('div')
const document = {
  createElement: (tagName) => new FakeElement(tagName),
  querySelector: (selector) => selector === '#messages' ? messages : null,
  documentElement: { clientHeight: 800 },
  visibilityState: 'visible',
}
const context = {
  Date, JSON, Math, Set, Map, URL, Error, TypeError, TextEncoder,
  document, location: { origin: 'http://localhost' }, navigator: { onLine: true },
  innerWidth: 390, innerHeight: 800, fetch: async () => {},
  addEventListener() {}, setTimeout, clearTimeout,
}
context.globalThis = context
vm.createContext(context)
vm.runInContext(
  mobileSource.replace(
    /startApp\(\)\s*$/u,
    'messages = document.querySelector(\'#messages\'); globalThis.__renderHistory = renderHistory; globalThis.__renderTurnEvent = renderTurnEvent; globalThis.__createVisualPresentationState = createVisualPresentationState',
  ),
  context,
  { filename: 'mobile.js' },
)

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-presentation-cleanup-'))
const store = new ConversationStore(root, {
  idFactory: (() => { let n = 0; return () => `message-${++n}` })(),
})
await store.initialize()
const image = 'data:image/png;base64,QUFB'

async function saveAttachment() {
  return store.saveAttachment({
    image: { dataUrl: image },
    thumbnail: { dataUrl: image },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
  })
}

function renderHistory(history) {
  context.__renderHistory(history)
  return { html: messages.outerHTML, text: findText(messages), imageCount: countImages(messages) }
}

// Historical replay: a legacy activity row may still carry an attachment in
// persisted state, but only media_ref owns the visible historical image.
const historicalAttachment = await saveAttachment()
const historicalTurn = 'turn-historical-presentation'
await store.appendMessage({ role: 'user', text: '你记得无花果吗', turnId: historicalTurn })
await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_recall', sourceAttachmentId: historicalAttachment.id, turnId: historicalTurn, text: '🐾 花花想起以前好像见过……' })
await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_selected', relation: 'recalled', sourceAttachmentId: historicalAttachment.id, turnId: historicalTurn, text: '↩️ 花花翻到以前的一张照片' })
await store.appendMessage({ role: 'assistant', kind: 'media_ref', activityType: 'visual_image', relation: 'recalled', sourceAttachmentId: historicalAttachment.id, turnId: historicalTurn, text: '花花重新看看这张', attachment: historicalAttachment })
await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_observation', relation: 'recalled', turnId: historicalTurn, text: '看到：1788110095163 internal observation dump' })
await store.appendMessage({ role: 'assistant', kind: 'final', turnId: historicalTurn, text: '我记得这盆无花果。' })
const historicalHistory = await store.history(50)
const historicalActivityRows = historicalHistory.filter((message) => message.turnId === historicalTurn && message.kind === 'activity')
const historicalMediaRows = historicalHistory.filter((message) => message.turnId === historicalTurn && message.kind === 'media_ref')
assert.equal(historicalActivityRows.every((message) => message.attachment === null), true)
assert.equal(historicalMediaRows.length, 1)
assert.equal(historicalMediaRows[0].attachment.id, historicalAttachment.id)

// Recreate pre-fix persisted rows to prove the UI boundary also protects
// already-written production history.
const legacyHistoricalHistory = historicalHistory.map((message) => message.turnId === historicalTurn && message.kind === 'activity'
  ? { ...message, attachment: store.publicAttachment(historicalAttachment) }
  : message)
const historicalRendered = renderHistory(legacyHistoricalHistory)
assert.equal(historicalRendered.imageCount, 1)
assert.match(historicalRendered.text, /↩️ 花花翻到以前的一张照片/u)
assert.match(historicalRendered.text, /👀 花花重新看了看/u)
assert.doesNotMatch(historicalRendered.text, /花花想起以前好像见过/u)
assert.doesNotMatch(historicalRendered.text, /1788110095163/u)
assert.doesNotMatch(historicalRendered.text, /internal observation dump/u)
console.log('ROOT_CAUSE_DUPLICATE_IMAGE=ACTIVITY_SOURCE_ATTACHMENT_AUTOMATICALLY_RENDERED')
console.log('HISTORICAL_ACTIVITY_ATTACHMENT_OWNERSHIP=PASS')
console.log('LONG_TERM_ATTACHMENT_VISIBLE_COUNT=' + historicalRendered.imageCount)
console.log('LONG_TERM_VISIBLE_ACTIVITY_STEPS=2')
console.log('FULL_OBSERVATION_VISIBLE=NO')
console.log('TIMESTAMP_METADATA_LEAK_FIXED=PASS')

// Ordinary current image: the owner message owns the first image; the
// assistant visual stage remains observable but does not copy the image.
const currentAttachment = await saveAttachment()
const currentTurn = 'turn-current-presentation'
await store.appendMessage({ role: 'user', text: '看看这张', attachment: currentAttachment, turnId: currentTurn })
await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_selected', relation: 'current', sourceAttachmentId: currentAttachment.id, turnId: currentTurn, text: '内部 current selected 1788110095163' })
await store.appendMessage({ role: 'assistant', kind: 'media_ref', activityType: 'visual_image', relation: 'current', sourceAttachmentId: currentAttachment.id, turnId: currentTurn, attachment: currentAttachment })
await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_observation', relation: 'current', turnId: currentTurn, text: '看到：内部 request-id 1788110095163' })
await store.appendMessage({ role: 'assistant', kind: 'final', turnId: currentTurn, text: '第一条。' })
await store.appendMessage({ role: 'assistant', kind: 'final', turnId: currentTurn, text: '第二条。' })
await store.appendMessage({ role: 'assistant', kind: 'final', turnId: currentTurn, text: '第三条不应默认拆出。' })
const currentRendered = renderHistory((await store.history(50)).filter((message) => message.turnId === currentTurn))
assert.equal(currentRendered.imageCount, 1)
assert.match(currentRendered.text, /👀 花花仔细看了看/u)
assert.doesNotMatch(currentRendered.text, /看到：/u)
assert.match(currentRendered.text, /第一条。/u)
assert.match(currentRendered.text, /第二条。/u)
assert.doesNotMatch(currentRendered.text, /第三条不应默认拆出/u)
console.log('CURRENT_IMAGE_DUPLICATE_RENDER=NO')
console.log('CURRENT_FINAL_MAX_BUBBLES=2')

// Distinct A/B references remain visible, while a real A -> B -> A revisit
// remains observable because the ownership unit is an inspection stage, not a
// global URL/attachment de-duplication rule.
const comparisonA = await saveAttachment()
const comparisonB = await saveAttachment()
const comparisonTurn = 'turn-comparison-presentation'
await store.appendMessage({ role: 'user', text: '找不同', attachment: comparisonA, turnId: comparisonTurn })
async function appendVisualStage({ relation, attachment, text = '' }) {
  await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_selected', relation, sourceAttachmentId: attachment.id, turnId: comparisonTurn, text: text || relation })
  await store.appendMessage({ role: 'assistant', kind: 'media_ref', activityType: 'visual_image', relation, sourceAttachmentId: attachment.id, turnId: comparisonTurn, attachment })
}
await appendVisualStage({ relation: 'current', attachment: comparisonA })
await appendVisualStage({ relation: 'previous', attachment: comparisonB })
const comparisonHistory = () => store.history(50).then((history) => history.filter((message) => message.turnId === comparisonTurn))
const beforeRevisit = renderHistory(await comparisonHistory())
assert.equal(beforeRevisit.imageCount, 2)
await appendVisualStage({ relation: 'current', attachment: comparisonA, text: '🔎 revisit' })
const afterRevisit = renderHistory(await comparisonHistory())
assert.equal(afterRevisit.imageCount, 3)
const imageAPath = store.publicAttachment(comparisonA).thumbnailUrl
assert.equal((afterRevisit.html.match(new RegExp(imageAPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')) ?? []).length, 2)
console.log('MULTI_VISUAL_DISTINCT_IMAGES=PASS')
console.log('A_B_A_REVISIT=PASS')

// Live event projection keeps the same ownership rules and never displays
// event metadata/captions as raw prose.
messages.replaceChildren()
const liveState = context.__createVisualPresentationState({ currentAttachmentId: currentAttachment.id })
context.__renderTurnEvent({ type: 'turn_started', payload: { mode: 'visual' } }, liveState)
context.__renderTurnEvent({ type: 'visual_selected', payload: { relation: 'current', comparison: false, caption: '1788110095163 internal' } }, liveState)
context.__renderTurnEvent({ type: 'visual_image', payload: { relation: 'current', sourceAttachmentId: currentAttachment.id, attachment: store.publicAttachment(currentAttachment), caption: 'internal request id' } }, liveState)
context.__renderTurnEvent({ type: 'visual_observation', payload: { relation: 'current', summary: '1788110095163 internal observation' } }, liveState)
assert.equal(countImages(messages), 0)
assert.match(findText(messages), /👀 花花仔细看了看/u)
assert.doesNotMatch(findText(messages), /1788110095163/u)
console.log('LIVE_CURRENT_IMAGE_OWNERSHIP=PASS')

// The lower-level visual stage still reopens the original asset and calls the
// Local Brain once; only its public presentation result is bounded to two
// ordinary replies.
let reopenCount = 0
let brainInspectionCount = 0
const events = new PetTurnEvents({ turnId: 'turn-reopen-proof' })
const ordinarySession = new VisualWorkingSession({
  turnId: 'turn-reopen-proof',
  userText: '看看这张',
  candidatePool: [{ visualId: 'V0', attachmentId: 'attachment-current', relation: 'current' }],
  conversationStore: {
    async readAttachmentDataUrl() {
      reopenCount += 1
      return { dataUrl: image, attachment: { id: 'attachment-current', thumbnailUrl: '/conversation-assets/attachment-current/thumb.webp' } }
    },
    publicAttachment(value) { return value },
    async appendMessage() {},
  },
  brain: {
    async visualStep() {
      brainInspectionCount += 1
      return { ok: true, observation: '普通观察', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['第一条', '第二条', '第三条'] }
    },
  },
  emit: (type, payload) => events.emit(type, payload),
})
const ordinaryResult = await ordinarySession.run('V0')
assert.equal(reopenCount, 1)
assert.equal(brainInspectionCount, 1)
assert.equal(ordinaryResult.final.replyMessages.length, 2)
console.log('ORIGINAL_IMAGE_REOPEN=PASS')
console.log('LOCAL_BRAIN_REINSPECTION=PASS')
console.log('ORDINARY_FINAL_MAX_BUBBLES=2')

await rm(root, { recursive: true, force: true })
console.log('VISUAL_PRESENTATION_CLEANUP=PASS')
