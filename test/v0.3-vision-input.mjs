import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalBrain } from '../src/brain/local-brain.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { normalizeVisionImage, VISION_ONLY_MESSAGE } from '../src/brain/vision-input.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { startLanServer } from '../src/remote/lan-server.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const jpeg = 'data:image/jpeg;base64,ZmFrZS1qcGVn'
const png = 'data:image/png;base64,ZmFrZS1wbmc='
const webp = 'data:image/webp;base64,ZmFrZS13ZWJw'

assert.deepEqual(normalizeVisionImage({ dataUrl: jpeg }), { dataUrl: jpeg })
assert.deepEqual(normalizeVisionImage({ dataUrl: png }), { dataUrl: png })
assert.deepEqual(normalizeVisionImage({ dataUrl: webp }), { dataUrl: webp })
for (const invalid of [
  { dataUrl: 'data:image/gif;base64,R0lGODlh' },
  { dataUrl: 'http://example.test/pet.png' },
  { dataUrl: 'file:///tmp/pet.png' },
  { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
  { dataUrl: 'data:image/png;base64,not base64' },
  [jpeg],
  { dataUrl: jpeg, path: '/tmp/pet.png' },
]) assert.throws(() => normalizeVisionImage(invalid), /invalid image/u)

{
  const requests = []
  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory: {
      recall: () => [],
      stableIdentityContext: () => [],
    },
    client: {
      chat: async (requestData) => {
        requests.push(requestData)
        return {
          payload: {
            choices: [{
              message: {
                role: 'assistant',
                content: JSON.stringify({ reply: '我看到啦。', memory: null }),
              },
            }],
          },
        }
      },
    },
  })

  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: { mood: .8, energy: .8, boredom: .1, sleepiness: .1, attachment: .8 },
    userText: '花花你看这是什么？',
    image: { dataUrl: webp },
  })

  assert.equal(result.ok, true)
  assert.equal(requests.length, 1)
  const current = requests[0].messages.at(-1)
  assert.equal(current.role, 'user')
  assert.deepEqual(current.content, [
    { type: 'text', text: '花花你看这是什么？' },
    { type: 'image_url', image_url: { url: webp } },
  ])
}

{
  const calls = []
  const runtime = new PetRuntime({ sandboxRoot: join(root, '.vision-input-test-unused') })
  runtime.identity = LI_HUAHUA_IDENTITY
  runtime.state = { mood: .8, energy: .8, boredom: .1, sleepiness: .1, attachment: .8 }
  runtime.memoryGate = {
    consider: (userText, candidate) => {
      calls.push({ userText, candidate })
      return { status: 'skipped', reason: 'model-skip' }
    },
  }
  runtime.brain = {
    reply: async (requestData) => {
      calls.push({ requestData })
      return { ok: true, text: '看到了。', rawMemoryCandidate: null }
    },
  }

  await runtime.chat('这是什么？', { dataUrl: jpeg })
  const recentWithText = runtime.conversation.snapshot()
  assert.equal(recentWithText[0].user, '[主人发送了一张图片] 这是什么？')
  assert.doesNotMatch(JSON.stringify(recentWithText), /data:image|ZmFrZS/u)
  assert.equal(calls[0].requestData.userText, '这是什么？')

  await runtime.chat('', { dataUrl: png })
  const recentImageOnly = runtime.conversation.snapshot()
  assert.equal(recentImageOnly.at(-1).user, '[主人发送了一张图片]')
  assert.equal(calls.at(-1).requestData.userText, VISION_ONLY_MESSAGE)
  assert.equal(calls.filter((call) => call.requestData).length, 2)
  assert.equal(calls.filter((call) => call.userText).length, 0)
  assert.doesNotMatch(JSON.stringify(recentImageOnly), /data:image|ZmFrZS/u)
  runtime.close()
}

const calls = []
const runtime = {
  snapshot: () => ({ current: 'idle' }),
  presentationSnapshot: () => ({ visualState: 'idle', emotion: { happiness: .8, energy: .6 }, dream: false, sprite: 'idle-front.png' }),
  async interact() { return this.snapshot() },
  async chat(message, image) {
    calls.push({ message, image })
    return { ok: true, unavailable: false, text: '汪：看到了。' }
  },
}
const server = await startLanServer({ runtime, assetRoot: join(root, 'assets/runtime'), port: 0, logger: { info() {} } })
const { port } = server.address()

function call(method, path, body) {
  return new Promise((resolveCall, rejectCall) => {
    const encoded = body === undefined ? null : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: encoded === null ? undefined : { 'content-type': 'application/json' },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolveCall({ status: res.statusCode, text }))
    })
    req.once('error', rejectCall)
    if (encoded !== null) req.write(encoded)
    req.end()
  })
}

try {
  assert.equal((await call('POST', '/api/pet/chat', { message: '请看看', image: { dataUrl: jpeg } })).status, 200)
  assert.deepEqual(calls.at(-1), { message: '请看看', image: { dataUrl: jpeg } })
  assert.equal((await call('POST', '/api/pet/chat', { message: '', image: { dataUrl: png } })).status, 200)
  assert.equal((await call('POST', '/api/pet/chat', { message: 'webp', image: { dataUrl: webp } })).status, 200)
  assert.equal((await call('POST', '/api/pet/chat', { message: 'gif', image: { dataUrl: 'data:image/gif;base64,R0lGODlh' } })).status, 400)
  assert.equal((await call('POST', '/api/pet/chat', { message: 'remote', image: { dataUrl: 'http://example.test/pet.png' } })).status, 400)
  assert.equal((await call('POST', '/api/pet/chat', { message: 'two', image: [{ dataUrl: jpeg }, { dataUrl: png }] })).status, 400)
  assert.equal((await call('POST', '/api/pet/chat', { message: 'two', images: [{ dataUrl: jpeg }, { dataUrl: png }] })).status, 400)
  assert.equal((await call('POST', '/api/pet/chat', { message: 'text only' })).status, 200)

  const oversized = `data:image/jpeg;base64,${'A'.repeat(7 * 1024 * 1024)}`
  assert.equal((await call('POST', '/api/pet/chat', { message: 'large', image: { dataUrl: oversized } })).status, 400)
} finally {
  server.close()
  await once(server, 'close')
}

const html = await readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8')
const mobileJs = await readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8')
assert.match(html, /type="file"/u)
assert.match(html, /accept="image\/jpeg,image\/png,image\/webp"/u)
assert.match(html, /image-preview/u)
assert.match(mobileJs, /createImageBitmap/u)
assert.match(mobileJs, /MAX_LONG_EDGE = 1920/u)
assert.match(mobileJs, /toDataURL\('image\/webp', IMAGE_QUALITY\)/u)
assert.match(mobileJs, /toDataURL\('image\/jpeg', IMAGE_QUALITY\)/u)
assert.match(mobileJs, /clearImageSelection/u)

console.log('VISION_TEXT_CHAT_REGRESSION=PASS')
console.log('VISION_JPEG_TEXT=PASS')
console.log('VISION_PNG_IMAGE_ONLY=PASS')
console.log('VISION_WEBP=PASS')
console.log('VISION_INVALID_MIME=PASS')
console.log('VISION_SINGLE_IMAGE=PASS')
console.log('VISION_OVERSIZE_REJECT=PASS')
console.log('IMAGE_BYTES_IN_RECENT_CONVERSATION=0')
console.log('IMAGE_BYTES_IN_PET_MEMORY=0')
console.log('MODEL_INFERENCES_PER_VISION_CHAT=1')
console.log('MOBILE_IMAGE_PICKER=PASS')
