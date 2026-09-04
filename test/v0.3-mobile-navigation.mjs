import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const html = await readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8')
const css = await readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8')
const js = await readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8')

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(css)?.[1] ?? ''
}

function htmlSection(id) {
  const start = html.indexOf(`id="${id}"`)
  assert.notEqual(start, -1, `${id} exists`)
  const end = html.indexOf('</section>', start)
  return html.slice(start, end === -1 ? html.length : end)
}

const requiredIds = [
  'pet-sprite', 'pet-button', 'play-button', 'long-button', 'messages', 'chat-form',
  'image-button', 'image-input', 'chat-input', 'send-button', 'image-preview',
  'image-thumbnail', 'remove-image', 'image-status', 'connection',
]
for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`, 'u'))
assert.match(html, /<main class="pet-app">/u)
assert.match(html, /<header class="app-header">/u)
assert.match(html, /<div class="view-host">/u)
assert.match(html, /id="play-view"[^>]*class="[^"]*app-view[^"]*play-view/u)
assert.match(html, /id="chat-view"[^>]*class="[^"]*app-view[^"]*chat-view[^>]*hidden/u)
assert.match(html, /<nav[^>]*id="bottom-nav"[^>]*class="[^"]*bottom-nav/u)
assert.equal((html.match(/id="connection"/gu) ?? []).length, 1)
const tabs = [...html.matchAll(/data-tab="([^"]+)"/gu)].map((match) => match[1])
assert.deepEqual(tabs, ['play', 'chat'])

const chatView = htmlSection('chat-view')
const playView = htmlSection('play-view')
assert.match(playView, /id="pet-sprite"/u)
assert.match(playView, /id="pet-button"/u)
assert.match(playView, /id="play-button"/u)
assert.match(playView, /id="long-button"/u)
assert.match(chatView, /id="messages"/u)
assert.match(chatView, /id="chat-form"/u)
assert.match(chatView, /id="image-preview"/u)
assert.ok(html.indexOf('id="bottom-nav"') > html.indexOf('</section>', html.indexOf('id="chat-view"')))

const body = cssBlock('body')
const viewHost = cssBlock('.view-host')
const views = cssBlock('.app-view')
const hiddenView = cssBlock('.app-view[hidden]')
const messages = cssBlock('.messages')
const chatViewCss = /#chat-view,\s*\.chat-view\s*\{([^}]*)\}/su.exec(css)?.[1] ?? ''
const composer = cssBlock('#chat-form')
const bottomNav = /#bottom-nav,\s*\.bottom-nav\s*\{([^}]*)\}/su.exec(css)?.[1] ?? ''
assert.match(body, /overflow:\s*hidden/u)
assert.match(css, /\.pet-app,\s*\.pet-page\s*\{[^}]*height:\s*100dvh[^}]*min-height:\s*100svh[^}]*display:\s*flex/su)
assert.match(css, /\.header-brand\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*gap:\s*8px/su)
assert.match(viewHost, /flex:\s*1/u)
assert.match(viewHost, /min-height:\s*0/u)
assert.match(views, /min-height:\s*0/u)
assert.match(views, /display:\s*flex/u)
assert.match(views, /flex-direction:\s*column/u)
assert.match(hiddenView, /display:\s*none/u)
assert.match(messages, /flex:\s*1/u)
assert.match(messages, /min-height:\s*0/u)
assert.match(messages, /overflow-y:\s*auto/u)
assert.doesNotMatch(messages, /max-height/u)
assert.match(chatViewCss, /overflow:\s*hidden/u)
assert.match(css, /#play-view,\s*\.play-view\s*\{[^}]*overflow:\s*hidden/su)
assert.doesNotMatch(css, /#play-view[^}]*overflow-y:\s*auto/su)
assert.match(composer, /border-top/u)
assert.match(bottomNav, /height:\s*calc\(58px\s*\+\s*env\(safe-area-inset-bottom\)\)/u)
assert.match(css, /\.image-preview\[hidden\]\s*\{\s*display:\s*none/u)
assert.match(css, /@media\s*\(max-height:\s*620px\)/u)

assert.match(js, /vc-ai-pet-mobile-active-tab-v1/u)
assert.match(js, /function\s+setActiveTab\s*\(/u)
assert.match(js, /dataset\.tab/u)
assert.match(js, /aria-selected/u)
assert.match(js, /localStorage/u)
assert.match(js, /restoreActiveTab|readStoredTab/u)
assert.match(js, /function\s+scrollMessagesToBottom\s*\(/u)
assert.match(js, /scrollMessagesToBottom\(\)/u)
assert.match(js, /\/api\/pet\/history/u)
assert.match(js, /\/api\/pet\/upload/u)
assert.match(js, /attachmentId/u)
assert.match(js, /pointerdown/u)
assert.match(js, /dblclick/u)
assert.match(js, /long_press/u)

const setActiveStart = js.indexOf('function setActiveTab')
assert.notEqual(setActiveStart, -1)
const setActiveEnd = js.indexOf('\n}', setActiveStart)
const setActiveBody = js.slice(setActiveStart, setActiveEnd === -1 ? js.length : setActiveEnd)
assert.doesNotMatch(setActiveBody, /fetch\s*\(/u)
assert.doesNotMatch(setActiveBody, /loadHistory\s*\(/u)
assert.doesNotMatch(setActiveBody, /refresh\s*\(/u)

const startup = [
  'updateSendButton()',
  'refresh()',
  'loadHistory()',
].map((token) => js.indexOf(token))
assert.ok(startup.every((index) => index >= 0))
assert.ok(startup[0] < startup[1] && startup[1] < startup[2])

console.log('PLAY_VIEW_EXISTS=PASS')
console.log('CHAT_VIEW_EXISTS=PASS')
console.log('BOTTOM_NAV_EXISTS=PASS')
console.log('BODY_SCROLL_LOCK=PASS')
console.log('APP_HEIGHT_100DVH=PASS')
console.log('ACTIVE_VIEW_FLEX=PASS')
console.log('MESSAGES_FLEX_SCROLL=PASS')
console.log('MESSAGES_MAX_HEIGHT_REMOVED=PASS')
console.log('CHAT_COMPOSER_IN_CHAT_VIEW=PASS')
console.log('BOTTOM_NAV_OUTSIDE_CHAT_VIEW=PASS')
console.log('BOTTOM_NAV_OUTSIDE_PLAY_VIEW=PASS')
console.log('PLAY_CHAT_MUTUALLY_EXCLUSIVE=PASS')
console.log('TAB_LOCAL_STORAGE=PASS')
console.log('TAB_SWITCH_NO_NETWORK_RELOAD=PASS')
console.log('VC_AI_PET_V0_3_MOBILE_APP_SHELL=PASS')
