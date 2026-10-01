import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const [script, css] = await Promise.all([
  readFile(join(root, 'src/remote/mobile-ui/thinking-indicator.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/thinking-indicator.css'), 'utf8'),
])

function createNode() {
  return {
    className: '',
    hidden: false,
    textContent: '',
    children: [],
    attributes: new Map(),
    append(...nodes) { this.children.push(...nodes) },
    setAttribute(name, value) { this.attributes.set(name, String(value)) },
    getAttribute(name) { return this.attributes.get(name) ?? null },
  }
}

const container = createNode()
const context = { document: { createElement: () => createNode() } }
vm.createContext(context)
vm.runInContext(script, context, { filename: 'thinking-indicator.js' })

const controller = context.VcAiPetThinkingIndicator.create({ container })
const [indicator] = container.children
const [paw, label, dots] = indicator.children
assert.equal(container.children.length, 1, 'create adds only one footer status node')
assert.equal(indicator.hidden, true, 'indicator starts hidden')
assert.equal(indicator.getAttribute('role'), 'status')
assert.equal(indicator.getAttribute('aria-live'), 'polite')
assert.equal(dots.children.length, 3, 'the indicator has three animated dots')
assert.match(css, /\.thinking-indicator\[hidden\]\s*\{\s*display:\s*none\s*!important;/u, 'hidden state collapses from layout')
assert.doesNotMatch(css.match(/\.thinking-indicator\[hidden\]\s*\{([^}]*)\}/u)?.[1] ?? '', /min-height|padding|visibility/u)
assert.equal(paw.getAttribute('aria-hidden'), 'true')
assert.equal(dots.getAttribute('aria-hidden'), 'true')

controller.start()
assert.equal(indicator.hidden, false)
assert.equal(controller.isActive(), true)
assert.equal(label.textContent, '花花想一想')
controller.start({ vision: true })
assert.equal(container.children.length, 1, 'repeated starts reuse the same status node')
assert.equal(indicator, container.children[0])
assert.equal(label.textContent, '花花认真看看', 'restarting updates the mode copy')
controller.setStage('正在回忆图库')
assert.equal(label.textContent, '正在回忆图库')
controller.setStage()
assert.equal(label.textContent, '花花认真看看', 'empty stage restores the current mode copy')

controller.stop()
assert.equal(indicator.hidden, true, 'stop removes the footer from layout')
assert.equal(controller.isActive(), false)
controller.start()
assert.equal(indicator, container.children[0], 'a later turn reuses the footer node')
assert.equal(label.textContent, '花花想一想')
controller.stop()

assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u)
assert.match(css, /\.thinking-indicator__paw,[\s\n]*\.thinking-indicator__dot\s*\{\s*animation:\s*none;/u)

console.log('THINKING_INDICATOR_LIFECYCLE=PASS')
