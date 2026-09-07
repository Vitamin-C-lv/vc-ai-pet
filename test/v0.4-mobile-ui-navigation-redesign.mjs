import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.cwd()
const [html, mobileCss, redesignCss, mobileJs, navigationJs, emojiJs, composerJs, serverJs] = await Promise.all([
  readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile-redesign.css'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/navigation.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/emoji-drawer.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/chat-composer.js'), 'utf8'),
  readFile(join(root, 'src/remote/lan-server.js'), 'utf8'),
])

function htmlSection(id) {
  const start = html.indexOf(`id="${id}"`)
  assert.notEqual(start, -1, `${id} exists`)
  const end = html.indexOf('</section>', start)
  return html.slice(start, end === -1 ? html.length : end)
}

const home = htmlSection('play-view')
const chat = htmlSection('chat-view')
const iconNames = ['back', 'construction', 'gallery', 'home', 'mic', 'moon', 'plus', 'smile']

// CASE 1 / 7: Home keeps the pet experience, restores Dream, and exposes the
// two requested page actions without retaining the Home Gallery card.
assert.match(home, /id="inner-life-open"/u)
assert.match(home, /花花的梦境/u)
assert.match(home, /id="house-open"/u)
assert.match(home, /id="chat-open"/u)
assert.doesNotMatch(home, /visual-gallery-open|花花的图库/u)
assert.match(html, /id="house-view"[^>]*hidden/u)
assert.match(html, /正在施工中…/u)
assert.match(html, /花花正在慢慢布置自己的小窝/u)

// CASE 2 / 3: Chat owns its persistent header and has no legacy footer.
assert.match(chat, /class="chat-header"/u)
assert.match(chat, /id="chat-home"/u)
assert.match(chat, /id="chat-gallery"/u)
assert.match(chat, />李花花</u)
assert.match(chat, /id="messages"/u)
assert.doesNotMatch(chat, /bottom-nav|data-tab|玩耍.*聊天/u)
assert.doesNotMatch(html, /id="bottom-nav"|data-tab="/u)

// CASE 4 / 5 / 6: Every nested content surface has Back + Home controls.
for (const id of ['inner-life-view', 'visual-gallery-view', 'visual-gallery-detail-view', 'house-view']) {
  const section = htmlSection(id)
  assert.match(section, /class="subpage-header"/u)
  assert.match(section, /vc-icon-back/u)
  assert.match(section, /vc-icon-home/u)
}
assert.match(html, /id="visual-gallery-back"/u)
assert.match(html, /id="visual-gallery-detail-back"/u)
assert.match(html, /id="inner-life-back"/u)

// CASE 8 / 9 / 10 / 11 / 12 / 13: Composer structure and controller contract.
assert.match(chat, /id="mic-button"[^>]*语音输入（暂未开放）/u)
assert.match(chat, /<textarea id="chat-input"/u)
assert.match(chat, /id="emoji-button"/u)
assert.match(chat, /id="emoji-drawer"/u)
assert.match(chat, /id="send-button"[^>]*data-mode="add"/u)
assert.match(composerJs, /actionButton\.dataset\.mode = canSend \? 'send' : 'add'/u)
assert.match(composerJs, /actionButton\.textContent = canSend \? '发送' : '\+'/u)
assert.match(composerJs, /compositionstart/u)
assert.match(composerJs, /compositionend/u)
assert.match(composerJs, /event.isComposing|event.keyCode === 229/u)
assert.match(composerJs, /语音输入后续开放/u)
assert.match(emojiJs, /DEFAULT_EMOJI/u)
assert.match(emojiJs, /insertEmoji/u)
assert.match(emojiJs, /registerStickerProvider/u)

// CASE 14: Mobile viewport/safe-area layout is encoded in the redesign CSS.
assert.match(redesignCss, /position:\s*sticky/u)
assert.match(redesignCss, /env\(safe-area-inset-top\)/u)
assert.match(redesignCss, /env\(safe-area-inset-bottom\)/u)
assert.match(redesignCss, /max-height:\s*132px/u)
assert.match(redesignCss, /@media\s*\(max-width:\s*380px\)/u)
assert.match(mobileCss, /\.messages\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto/su)

// CASE 15 / 16: Existing visual rendering and API paths stay in the existing
// mobile controller; the new helpers are UI-only.
assert.match(mobileJs, /MAX_VISUAL_INSPECTIONS_PER_TURN|visualInspectionCount|VISUAL_ACTIVITY_TYPES/u)
assert.match(mobileJs, /media_ref/u)
assert.match(mobileJs, /\/api\/pet\/upload/u)
assert.match(mobileJs, /\/api\/pet\/chat\/start/u)
assert.match(mobileJs, /function\s+submitComposer/u)
assert.match(mobileJs, /openExistingImagePicker:\s*async\s*\(\)\s*=>\s*imageButton\.click\(\)/u)
assert.match(mobileJs, /sendExistingText:\s*\(message\)\s*=>\s*submitComposer\(message\)/u)
assert.doesNotMatch(mobileJs, /history\.back\s*\(/u)
assert.doesNotMatch(navigationJs, /fetch\s*\(/u)
assert.doesNotMatch(emojiJs, /fetch\s*\(/u)
assert.doesNotMatch(composerJs, /fetch\s*\(/u)
assert.match(serverJs, /'\.svg':\s*'image\/svg\+xml'/u)
for (const iconName of iconNames) {
  const icon = await readFile(join(root, 'src/remote/mobile-ui/icons', iconName + '.svg'), 'utf8')
  assert.match(icon, /^<svg\b/u, iconName + '.svg is a static mobile asset')
}

// Exercise the framework-agnostic navigation helper without a browser. This
// covers the actual logical stack and deterministic deep-link fallbacks.
const navigationContext = {}
vm.createContext(navigationContext)
vm.runInContext(navigationJs, navigationContext, { filename: 'navigation.js' })
let current = navigationContext.VcAiPetNavigation.VC_SCREEN.HOME
const transitions = []
const router = navigationContext.VcAiPetNavigation.createVcNavigation({
  getScreen: () => current,
  goToScreen: (screen) => { current = screen; transitions.push(screen) },
})
router.push('chat')
router.push('gallery')
router.back({ fallback: 'home' })
assert.equal(current, 'chat')
router.home()
assert.equal(current, 'home')
current = 'gallery-detail'
router.back({ fallback: 'gallery' })
assert.equal(current, 'gallery')
assert.deepEqual(transitions, ['chat', 'gallery', 'chat', 'home', 'gallery'])

const emojiContext = {}
vm.createContext(emojiContext)
vm.runInContext(emojiJs, emojiContext, { filename: 'emoji-drawer.js' })
const registry = emojiContext.VcAiPetEmoji.createEmojiRegistry()
assert.equal(registry.get('emoji').length, 36)
const textarea = {
  value: '你好',
  selectionStart: 2,
  selectionEnd: 2,
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end },
  focus() {},
  dispatchEvent() {},
}
emojiContext.VcAiPetEmoji.insertEmoji(textarea, '🐾')
assert.equal(textarea.value, '你好🐾')
assert.equal(textarea.selectionStart, 4)

console.log('HOME_DREAM_ENTRY=PASS')
console.log('HOME_GALLERY_ENTRY_REMOVED=PASS')
console.log('HOUSE_PLACEHOLDER=PASS')
console.log('CHAT_STICKY_HEADER_AND_NO_LEGACY_NAV=PASS')
console.log('NESTED_BACK_HOME_CONTROLS=PASS')
console.log('COMPOSER_ADD_SEND_STATE=PASS')
console.log('EMOJI_DRAWER_PROVIDER_AND_INSERT=PASS')
console.log('MIC_NO_PERMISSION_OR_BACKEND=PASS')
console.log('CHINESE_IME_COMPOSITION_GUARD=PASS')
console.log('MOBILE_SAFE_AREA_LAYOUT=PASS')
console.log('EXISTING_IMAGE_SEND_PATH=PASS')
console.log('VISUAL_AND_API_REGRESSION_BOUNDARY=PASS')
console.log('ICON_ASSETS=PASS')
console.log('NAVIGATION_STACK_AND_DEEP_LINK_FALLBACK=PASS')
