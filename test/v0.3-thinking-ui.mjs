import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const [html, mobileJs, mobileCss, overlay, petCss] = await Promise.all([
  readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8'),
  readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8'),
  readFile(join(root, 'src/client/pet-overlay.js'), 'utf8'),
  readFile(join(root, 'src/client/pet.css'), 'utf8'),
])

assert.match(html, /id="messages"/u)
assert.match(mobileJs, /function appendThinkingMessage/u)
assert.match(mobileJs, /className = 'message pet-line thinking-message'/u)
assert.match(mobileJs, /className = 'message-bubble thinking-bubble'/u)
assert.match(mobileJs, /setAttribute\('role', 'status'\)/u)
assert.match(mobileJs, /setAttribute\('aria-live', 'polite'\)/u)
assert.match(mobileJs, /vision \? '花花认真看看' : '花花想一想'/u)
assert.match(mobileJs, /const thinkingMessage = appendThinkingMessage\(\{ vision: Boolean\(pendingImage\) \}\)/u)
assert.match(mobileJs, /removeThinkingMessage\(thinkingMessage\)/u)
assert.match(mobileJs, /line\('pet', result\.text, null, result\.reasoning\)/u)
assert.match(mobileJs, /className = 'thinking-meta'/u)
assert.match(mobileJs, /meta\.textContent = `🐾 \$\{durationText\}`/u)

const submitBody = mobileJs.slice(mobileJs.indexOf("form.addEventListener('submit'"))
assert.ok(submitBody.indexOf("line('user', message, localAttachment)") < submitBody.indexOf('appendThinkingMessage'))
assert.ok(submitBody.indexOf('appendThinkingMessage') < submitBody.indexOf("fetchJsonDiagnostic('/api/pet/chat'"))
assert.match(submitBody, /catch \{\s+removeThinkingMessage\(thinkingMessage\)/su)

assert.match(mobileCss, /\.thinking-bubble\s*\{[^}]*max-width:\s*min\(210px,\s*100%\)/su)
assert.match(mobileCss, /\.thinking-dots span:nth-child\(2\)\s*\{\s*animation-delay:\s*160ms/su)
assert.match(mobileCss, /\.thinking-dots span:nth-child\(3\)\s*\{\s*animation-delay:\s*320ms/su)
assert.match(mobileCss, /@keyframes thinking-dot-bounce/su)
assert.match(mobileCss, /translateY\(-4px\)/u)
assert.match(mobileCss, /@media \(prefers-reduced-motion: reduce\)/u)

assert.match(overlay, /className: 'vc-pet-chat-thinking'/u)
assert.match(overlay, /role: 'status'/u)
assert.match(overlay, /'aria-live': 'polite'/u)
assert.match(overlay, /className: 'vc-pet-chat-thinking-mark'/u)
assert.match(overlay, /className: 'vc-pet-chat-thinking-dots'/u)
assert.match(overlay, /appendChat\('pet', result\.text, result\.reasoning\)/u)
assert.match(overlay, /vc-pet-chat-thinking-meta/u)
assert.match(petCss, /\.vc-pet-chat-thinking\s*\{[^}]*max-width:\s*210px/su)
assert.match(petCss, /animation-delay:\s*160ms/u)
assert.match(petCss, /animation-delay:\s*320ms/u)
assert.match(petCss, /@media \(prefers-reduced-motion: reduce\)/u)

const formatSource = mobileJs.slice(
  mobileJs.indexOf('function formatThinkingDuration'),
  mobileJs.indexOf('function renderMessage'),
)
const formatContext = {}
vm.createContext(formatContext)
vm.runInContext(`${formatSource}\nglobalThis.formatThinkingDuration = formatThinkingDuration`, formatContext)
assert.equal(formatContext.formatThinkingDuration(800), '思考了 0.8 秒')
assert.equal(formatContext.formatThinkingDuration(2784), '思考了 2.8 秒')
assert.equal(formatContext.formatThinkingDuration(72_384), '思考了 1分12秒')

assert.doesNotMatch(mobileJs, /AI正在推理|reasoning low|spinner|chain-of-thought/u)
assert.doesNotMatch(overlay, /AI正在推理|reasoning low|spinner|chain-of-thought/u)

console.log('THINKING_INDICATOR=PASS')
console.log('THINKING_ANIMATION=PASS')
console.log('THINKING_DURATION_FORMAT=PASS')
console.log('THINKING_ACCESSIBILITY=PASS')
console.log('MOBILE_THINKING_UI=PASS')
console.log('DESKTOP_THINKING_UI=PASS')
