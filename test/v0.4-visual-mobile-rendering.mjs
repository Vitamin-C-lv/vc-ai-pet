import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const source = await readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8')
const css = await readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8')

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.attributes = new Map()
    this.className = ''
    this.textContent = ''
    this.classList = { add: (...names) => names.forEach((name) => { this.className = `${this.className} ${name}`.trim() }), toggle() {} }
  }
  append(...nodes) { this.children.push(...nodes) }
  appendChild(node) { this.children.push(node); return node }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  addEventListener() {}
  removeAttribute(name) { this.attributes.delete(name) }
  querySelector(selector) { return selector === '.message-text' ? this.children.find((child) => child.className === 'message-text') ?? null : null }
  get src() { return this.attributes.get('src') ?? '' }
  set src(value) { this.attributes.set('src', String(value)) }
  get outerHTML() {
    const attributes = [...this.attributes.entries()].map(([name, value]) => ` ${name}="${value}"`).join('')
    const classAttribute = this.className ? ` class="${this.className}"` : ''
    const content = this.textContent || this.children.map((child) => child.outerHTML ?? child.textContent ?? '').join('')
    return `<${this.tagName.toLowerCase()}${classAttribute}${attributes}>${content}</${this.tagName.toLowerCase()}>`
  }
}

const messages = new FakeElement('div')
const document = {
  createElement: (tagName) => new FakeElement(tagName),
  querySelector: (selector) => selector === '#messages' ? messages : null,
  documentElement: { clientHeight: 800 },
  visibilityState: 'visible',
}
let fetchCalls = 0
let xhrCalls = 0
class FakeXMLHttpRequest { constructor() { xhrCalls += 1 } }
const context = {
  Date, JSON, Math, Set, Map, URL, Error, TypeError, TextEncoder,
  document, location: { origin: 'http://localhost' }, navigator: { onLine: true },
  innerWidth: 390, innerHeight: 800, fetch: async () => { fetchCalls += 1 }, XMLHttpRequest: FakeXMLHttpRequest,
  addEventListener() {}, setTimeout, clearTimeout,
}
context.globalThis = context
vm.createContext(context)
vm.runInContext(source.replace(/startApp\(\)\s*$/u, 'messages = document.querySelector(\'#messages\'); globalThis.__renderTurnEvent = renderTurnEvent'), context, { filename: 'mobile.js' })

const events = [
  { type: 'turn_started', payload: { mode: 'visual' } },
  { type: 'thinking', payload: { reasoning_content: '我先推理一下：system prompt' } },
  { type: 'visual_recall', payload: { sourceAttachmentId: 'attachment-old', caption: '🐾 花花想起以前好像见过……', rawPrompt: 'system prompt' } },
  { type: 'visual_selected', payload: { relation: 'recalled', caption: '↩️ 花花翻到以前的一张照片' } },
  { type: 'visual_image', payload: { caption: '历史照片', attachment: { thumbnailUrl: '/conversation-assets/attachment-old/thumb.webp' } } },
  { type: 'visual_observation', payload: { summary: '👀 花花重新看了看' } },
  { type: 'assistant_message', payload: { text: '我记得这盆植物了。', reasoning_content: '不要显示这段 CoT' } },
  { type: 'turn_completed', payload: {} },
]
for (const event of events) context.__renderTurnEvent(event)

assert.equal(fetchCalls, 0, 'rendering recall must not fetch or XHR')
assert.equal(xhrCalls, 0, 'rendering recall must not construct XHR')
assert.equal(messages.children.length, 6)
const rendered = messages.outerHTML
assert.match(rendered, /vm-recall/u)
assert.match(rendered, /花花想起以前好像见过/u)
assert.match(rendered, /花花翻到以前的一张照片/u)
assert.match(rendered, /conversation-assets\/attachment-old\/thumb\.webp/u)
assert.match(rendered, /👀 花花重新看了看/u)
assert.match(rendered, /我记得这盆植物了/u)
assert.doesNotMatch(rendered, /我先推理一下：system prompt/u)
assert.doesNotMatch(rendered, /不要显示这段 CoT/u)
assert.match(css, /\.vm-recall\s+\.message-bubble/u)

messages.children.length = 0
context.__renderTurnEvent({ type: 'visual_observation', payload: { summary: '一盆绿叶植物' } })
assert.match(messages.outerHTML, /👀 看到：一盆绿叶植物/u)

messages.children.length = 0
context.__renderTurnEvent({ type: 'visual_selected', payload: { relation: 'previous', caption: '↩️ 上一张照片' } })
assert.match(messages.outerHTML, /上一张照片/u)

console.log('VISUAL_RECALL_DOM=PASS')
console.log('VISUAL_RECALL_NO_NETWORK=PASS')
console.log('VISUAL_RECALL_SAFE_TRACE=PASS')
console.log('VISUAL_SELECTED_RELATIONS=PASS')
console.log('VISUAL_MOBILE_RENDERING=PASS')
