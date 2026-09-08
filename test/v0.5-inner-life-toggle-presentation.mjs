import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const css = await readFile(new URL('../src/remote/mobile-ui/mobile.css', import.meta.url), 'utf8')
const mobile = await readFile(new URL('../src/remote/mobile-ui/mobile.js', import.meta.url), 'utf8')

const toggle = css.match(/\.inner-life-insight-toggle \{([\s\S]*?)\n\}/)?.[1] ?? ''
const active = css.match(/\.inner-life-insight-toggle:active \{([\s\S]*?)\n\}/)?.[1] ?? ''
const focusVisible = css.match(/\.inner-life-insight-toggle:focus-visible \{([\s\S]*?)\n\}/)?.[1] ?? ''

assert.match(toggle, /background:\s*transparent;/)
assert.match(toggle, /min-height:\s*0;/)
assert.match(toggle, /border-radius:\s*0;/)
assert.match(toggle, /transform:\s*none;/)
assert.match(toggle, /-webkit-tap-highlight-color:\s*transparent;/)
assert.match(active, /background:\s*transparent;/)
assert.match(active, /transform:\s*none;/)
assert.match(active, /box-shadow:\s*none;/)
assert.match(focusVisible, /outline:\s*2px solid/)
assert.match(focusVisible, /outline-offset:\s*3px;/)
assert.match(mobile, /panel\.hidden = !panel\.hidden/)
assert.match(mobile, /toggle\.setAttribute\('aria-expanded', String\(!panel\.hidden\)\)/)

console.log('INNER_LIFE_TOGGLE_BACKGROUND=transparent')
console.log('INNER_LIFE_TOGGLE_ACTIVE_BACKGROUND=transparent')
console.log('INNER_LIFE_TOGGLE_ACTIVE_TRANSFORM=none')
console.log('INNER_LIFE_TOGGLE_MIN_HEIGHT=0')
console.log('INNER_LIFE_TOGGLE_TAP_HIGHLIGHT=transparent')
console.log('INNER_LIFE_TOGGLE_FOCUS_VISIBLE_PRESENT=YES')
console.log('INNER_LIFE_TOGGLE_JS_BEHAVIOR=UNCHANGED')
