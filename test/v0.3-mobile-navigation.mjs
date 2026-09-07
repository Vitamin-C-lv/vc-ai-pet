import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const html = await readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8')
const css = await readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8')
const redesignCss = await readFile(join(root, 'src/remote/mobile-ui/mobile-redesign.css'), 'utf8')
const js = await readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8')

function htmlSection(id) {
  const start = html.indexOf(`id="${id}"`)
  assert.notEqual(start, -1, `${id} exists`)
  const end = html.indexOf('</section>', start)
  return html.slice(start, end === -1 ? html.length : end)
}

const requiredIds = [
  'pet-sprite', 'pet-button', 'play-button', 'long-button', 'messages', 'chat-form',
  'image-button', 'image-input', 'chat-input', 'send-button', 'image-preview',
  'image-thumbnail', 'remove-image', 'image-status', 'connection', 'house-open',
  'chat-open', 'house-view', 'chat-home', 'chat-gallery',
  'mic-button', 'emoji-button', 'emoji-drawer',
]
for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`, 'u'))
assert.match(html, /<main class="pet-app">/u)
assert.match(html, /<header id="app-header" class="app-header">/u)
assert.match(html, /<div class="view-host">/u)
assert.match(html, /id="play-view"[^>]*class="[^"]*app-view[^"]*play-view/u)
assert.match(html, /id="chat-view"[^>]*class="[^"]*app-view[^"]*chat-view[^>]*hidden/u)
assert.doesNotMatch(html, /id="bottom-nav"|data-tab="/u)
assert.equal((html.match(/id="connection"/gu) ?? []).length, 1)

const chatView = htmlSection('chat-view')
const playView = htmlSection('play-view')
assert.match(playView, /id="pet-sprite"/u)
assert.match(playView, /id="pet-button"/u)
assert.match(playView, /id="play-button"/u)
assert.match(playView, /id="long-button"/u)
assert.match(playView, /id="inner-life-open"/u)
assert.match(playView, /id="house-open"/u)
assert.match(playView, /id="chat-open"/u)
assert.doesNotMatch(playView, /visual-gallery-open|花花的图库/u)
assert.match(chatView, /id="messages"/u)
assert.match(chatView, /id="chat-form"/u)
assert.match(chatView, /id="image-preview"/u)
assert.match(chatView, /id="chat-home"/u)
assert.match(chatView, /id="chat-gallery"/u)
assert.doesNotMatch(chatView, /bottom-nav|data-tab|玩耍.*聊天/u)

const body = css.match(/body\s*\{([^}]*)\}/u)?.[1] ?? ''
const viewHost = css.match(/\.view-host\s*\{([^}]*)\}/u)?.[1] ?? ''
const views = css.match(/\.app-view\s*\{([^}]*)\}/u)?.[1] ?? ''
const hiddenView = css.match(/\.app-view\[hidden\]\s*\{([^}]*)\}/u)?.[1] ?? ''
const messages = css.match(/\.messages\s*\{([^}]*)\}/u)?.[1] ?? ''
assert.match(body, /overflow:\s*hidden/u)
assert.match(css, /\.pet-app,\s*\.pet-page\s*\{[^}]*height:\s*100dvh[^}]*min-height:\s*100svh[^}]*display:\s*flex/su)
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
assert.match(redesignCss, /\.chat-header[^}]*position:\s*sticky|\.subpage-header,\s*\.chat-header\s*\{[^}]*position:\s*sticky/su)
assert.match(redesignCss, /#chat-form\s*\{[^}]*display:\s*grid[^}]*grid-template-columns/su)
assert.match(redesignCss, /\.chat-composer-wrap\s*\{[^}]*position:\s*sticky/su)
assert.match(redesignCss, /env\(safe-area-inset-bottom\)/u)
assert.match(redesignCss, /\.emoji-drawer\[data-open="true"\]/u)

assert.match(js, /function\s+renderScreen\s*\(/u)
assert.match(js, /function\s+navigateHome\s*\(/u)
assert.match(js, /function\s+navigateBack\s*\(/u)
assert.match(js, /\/api\/pet\/history/u)
assert.match(js, /\/api\/pet\/upload/u)
assert.match(js, /attachmentId/u)
assert.match(js, /pointerdown/u)
assert.match(js, /dblclick/u)
assert.match(js, /long_press/u)
assert.doesNotMatch(js, /history\.back\s*\(/u)

console.log('HOME_AND_NESTED_VIEWS=PASS')
console.log('CHAT_HEADER_AND_BOTTOM_NAV_CONTRACT=PASS')
console.log('BODY_SCROLL_LOCK=PASS')
console.log('APP_HEIGHT_100DVH=PASS')
console.log('ACTIVE_VIEW_FLEX=PASS')
console.log('MESSAGES_FLEX_SCROLL=PASS')
console.log('CHAT_COMPOSER_STICKY_SAFE_AREA=PASS')
console.log('NAVIGATION_NO_BROWSER_HISTORY=PASS')
console.log('VC_AI_PET_V0_4_MOBILE_APP_SHELL=PASS')
