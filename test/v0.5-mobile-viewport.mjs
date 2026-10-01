import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile('src/remote/mobile-ui/mobile.js', 'utf8')
const keyboardFunctions = source.slice(source.indexOf('function getViewportHeight()'), source.indexOf('let innerLifeView'))
const viewport = new EventTarget()
Object.assign(viewport, { height: 852, offsetTop: 0 })
const input = new EventTarget()
const document = new EventTarget()
Object.assign(document, { activeElement: null, documentElement: { clientHeight: 852 } })
const classes = new Set()
const properties = new Map()
const petApp = {
  style: { setProperty(name, value) { properties.set(name, value) } },
  classList: { toggle(name, on) { on ? classes.add(name) : classes.delete(name) } },
}
const frames = []
const windowEvents = new EventTarget()
const context = {
  petApp, input, document, visualViewport: viewport,
  innerHeight: 852, innerWidth: 393,
  keyboardOpen: false, keyboardFrame: null, keyboardViewportChanged: false,
  viewportBaselineHeight: 0, KEYBOARD_OPEN_THRESHOLD: 120, KEYBOARD_CLOSE_THRESHOLD: 72,
  homeSpriteAnimator: null,
  addEventListener: windowEvents.addEventListener.bind(windowEvents),
  requestAnimationFrame(callback) { frames.push(callback); return frames.length },
}
vm.createContext(context)
vm.runInContext(keyboardFunctions, context)
const flush = () => { while (frames.length) frames.shift()() }
context.bindKeyboardState()
flush()
assert.equal(petApp.style.height, '852px')

document.activeElement = input
input.dispatchEvent(new Event('focus'))
flush()
assert.equal(context.keyboardOpen, true)

// A focus pan is not a keyboard dismissal, even before its resize arrives.
viewport.offsetTop = 180
viewport.dispatchEvent(new Event('scroll'))
flush()
assert.equal(context.keyboardOpen, true, 'scroll-only keeps the focused keyboard state')
assert.equal(petApp.style.top, '180px', 'the shell follows the visible viewport origin')

viewport.height = 480
viewport.offsetTop = 110
viewport.dispatchEvent(new Event('resize'))
flush()
assert.equal(context.keyboardOpen, true)
assert.equal(petApp.style.height, '480px', 'the composer stays above the IME')
assert.equal(petApp.style.top, '110px')
assert.equal(properties.get('--app-viewport-height'), '480px')
assert.equal(document.activeElement, input, 'a resize never dismisses the keyboard by blurring')

viewport.offsetTop = 160
viewport.dispatchEvent(new Event('scroll'))
flush()
assert.equal(petApp.style.top, '160px')
assert.equal(petApp.style.height, '480px')

// Sending blurs before the keyboard animation completes: do not expand early.
document.activeElement = null
input.dispatchEvent(new Event('blur'))
flush()
assert.equal(context.keyboardOpen, false)
assert.equal(petApp.style.height, '480px')
viewport.height = 852
viewport.offsetTop = 0
viewport.dispatchEvent(new Event('resize'))
flush()
assert.equal(petApp.style.height, '852px')
assert.equal(petApp.style.top, '0px')

// Android Back can hide the IME while retaining HTML input focus.
document.activeElement = input
input.dispatchEvent(new Event('focus'))
viewport.height = 480
viewport.dispatchEvent(new Event('resize'))
flush()
viewport.height = 852
viewport.dispatchEvent(new Event('resize'))
flush()
assert.equal(context.keyboardOpen, false, 'IME dismissal does not consume another page Back')
assert.equal(document.activeElement, input)
console.log('IME_SCROLL_PAN_RESIZE_AND_DISMISSAL=PASS')
