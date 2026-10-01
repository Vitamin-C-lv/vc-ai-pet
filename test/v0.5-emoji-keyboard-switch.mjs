import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile('src/remote/mobile-ui/emoji-drawer.js', 'utf8')

function createElement() {
  const listeners = new Map()
  const attributes = new Map()
  const element = {
    value: '',
    maxLength: -1,
    selectionStart: 0,
    selectionEnd: 0,
    focused: false,
    focusCalls: 0,
    blurCalls: 0,
    dataset: {},
    hidden: false,
    children: [],
    addEventListener(type, listener) {
      const handlers = listeners.get(type) ?? []
      handlers.push(listener)
      listeners.set(type, handlers)
    },
    dispatch(type, event = {}) {
      const payload = { type, target: element, ...event }
      for (const listener of listeners.get(type) ?? []) listener(payload)
    },
    dispatchEvent(event) {
      element.dispatch(event.type, event)
      return true
    },
    setAttribute(name, value) { attributes.set(name, String(value)) },
    getAttribute(name) { return attributes.get(name) ?? null },
    setSelectionRange(start, end) {
      element.selectionStart = start
      element.selectionEnd = end
    },
    focus() {
      element.focusCalls += 1
      element.focused = true
      element.dispatch('focus')
    },
    blur() {
      element.blurCalls += 1
      element.focused = false
      element.dispatch('blur')
    },
    replaceChildren(...children) { element.children = children },
    append(...children) { element.children.push(...children) },
  }
  return element
}

const context = {
  Event: class Event {
    constructor(type) { this.type = type }
  },
  document: { createElement: () => createElement() },
}
vm.createContext(context)
vm.runInContext(source, context, { filename: 'emoji-drawer.js' })

const drawer = createElement()
const grid = createElement()
drawer.querySelector = () => grid
const input = createElement()
const button = createElement()
const toggles = []
const inputEvents = []
input.addEventListener('input', () => inputEvents.push('input'))
const controller = context.VcAiPetEmoji.wireEmojiDrawer({
  drawer,
  input,
  button,
  onToggle: (open) => toggles.push(open),
})

assert.equal(controller.isOpen(), false)
assert.equal(drawer.hidden, true)
assert.equal(button.getAttribute('aria-expanded'), 'false')
assert.match(grid.children[0].getAttribute('aria-label'), /^插入/u)

input.focus()
button.dispatch('click')
assert.equal(controller.isOpen(), true)
assert.equal(drawer.hidden, false)
assert.equal(button.getAttribute('aria-expanded'), 'true')
assert.equal(input.focused, false, 'opening the drawer dismisses the keyboard')
const focusCallsBeforeInsert = input.focusCalls

input.value = '你们好'
input.selectionStart = 1
input.selectionEnd = 2
const option = grid.children[0]
grid.dispatch('click', { target: { closest: () => option } })
assert.equal(input.value, `你${option.dataset.emoji}好`)
assert.equal(input.selectionStart, 1 + option.dataset.emoji.length)
assert.equal(input.selectionEnd, input.selectionStart)
assert.equal(input.focusCalls, focusCallsBeforeInsert, 'emoji selection does not reopen the keyboard')
assert.equal(input.focused, false)
assert.equal(controller.isOpen(), true, 'selecting an emoji keeps the drawer open')
assert.deepEqual(inputEvents, ['input'])

button.dispatch('click')
assert.equal(controller.isOpen(), false, 'button toggles the drawer closed')
controller.open()
input.focus()
assert.equal(input.focused, true, 'the user can switch to the keyboard')
assert.equal(controller.isOpen(), false, 'focusing the textarea closes the emoji drawer')
assert.deepEqual(toggles, [false, true, false, true, false])

input.value = 'abcd'
input.maxLength = 5
input.selectionStart = 1
input.selectionEnd = 3
assert.equal(context.VcAiPetEmoji.insertEmoji(input, '🐾'), true)
assert.equal(input.value, 'a🐾d')
input.value = 'abcde'
input.selectionStart = input.selectionEnd = 5
assert.equal(context.VcAiPetEmoji.insertEmoji(input, '🐾'), false)
assert.equal(input.value, 'abcde')

console.log('EMOJI_DRAWER_KEYBOARD_SWITCH=PASS')
console.log('EMOJI_SELECTION_AND_MAXLENGTH=PASS')
