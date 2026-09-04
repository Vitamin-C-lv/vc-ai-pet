import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-conversation-persistence-'))
const webpBytes = Buffer.from('RIFFfakeWEBPasset', 'ascii')
const image = `data:image/webp;base64,${webpBytes.toString('base64')}`
const thumbnail = `data:image/webp;base64,${Buffer.from('RIFFfakeWEBPthumb', 'ascii').toString('base64')}`

function call(port, method, path, body = undefined) {
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
      res.on('end', () => resolveCall({ status: res.statusCode, headers: res.headers, text }))
    })
    req.once('error', rejectCall)
    if (encoded !== null) req.write(encoded)
    req.end()
  })
}

let runtime = null
let server = null
try {
  runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()

  const memoryLevels = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
  const memoryBefore = JSON.stringify(memoryLevels.flatMap((level) => runtime.memory.db.list(level, {})))
  const dreamBefore = JSON.stringify({
    dream: runtime.memory.dreamWindow(),
    reflection: runtime.memory.reflectionWindow(),
  })
  const brainCalls = []
  runtime.brain = {
    async reply(requestData) {
      brainCalls.push(requestData)
      return { ok: true, text: '花花看到了。', rawMemoryCandidate: null }
    },
  }
  runtime.memoryGate = { consider: () => ({ status: 'skipped', reason: 'persistence-test' }) }

  server = await (await import('../src/remote/lan-server.js')).startLanServer({
    runtime,
    assetRoot: join(process.cwd(), 'assets/runtime'),
    port: 0,
    logger: { info() {} },
  })
  const { port } = server.address()

  const upload = await call(port, 'POST', '/api/pet/upload', {
    image: { dataUrl: image },
    thumbnail: { dataUrl: thumbnail },
    width: 128,
    height: 96,
  })
  assert.equal(upload.status, 200)
  const uploaded = JSON.parse(upload.text)
  assert.equal(uploaded.ok, true)
  assert.match(uploaded.attachment.assetUrl, /^\/conversation-assets\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+\.webp$/u)
  assert.match(uploaded.attachment.thumbnailUrl, /^\/conversation-assets\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]+-thumbnail\.webp$/u)
  assert.ok(uploaded.attachment.thumbnailWidth <= 256)
  assert.ok(uploaded.attachment.thumbnailHeight <= 256)

  const chat = await call(port, 'POST', '/api/pet/chat', {
    message: '这是什么呀？',
    attachmentId: uploaded.attachment.id,
  })
  assert.equal(chat.status, 200)
  assert.equal(JSON.parse(chat.text).text, '花花看到了。')
  assert.equal(brainCalls.length, 1)
  assert.equal(brainCalls[0].userText, '这是什么呀？')
  assert.equal(brainCalls[0].image.dataUrl.startsWith('data:image/webp;base64,'), true)

  const historyResponse = await call(port, 'GET', '/api/pet/history')
  assert.equal(historyResponse.status, 200)
  const history = JSON.parse(historyResponse.text).messages
  assert.equal(history.length, 2)
  assert.deepEqual(history.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '这是什么呀？' },
    { role: 'assistant', text: '花花看到了。' },
  ])
  assert.equal(history[0].attachment.id, uploaded.attachment.id)
  assert.equal(history[0].attachment.thumbnailUrl, uploaded.attachment.thumbnailUrl)

  const thumbnailResponse = await call(port, 'GET', uploaded.attachment.thumbnailUrl)
  assert.equal(thumbnailResponse.status, 200)
  assert.equal(thumbnailResponse.headers['content-type'], 'image/webp')

  const persisted = JSON.parse(await readFile(join(root, 'conversation-store.json'), 'utf8'))
  assert.equal(JSON.stringify(persisted).includes('data:image'), false)
  assert.equal(JSON.stringify(persisted).includes(image), false)
  assert.equal(existsSync(join(root, uploaded.attachment.thumbnailUrl.slice(1))), true)
  assert.equal(JSON.stringify(memoryLevels.flatMap((level) => runtime.memory.db.list(level, {}))), memoryBefore)
  assert.equal(JSON.stringify({
    dream: runtime.memory.dreamWindow(),
    reflection: runtime.memory.reflectionWindow(),
  }), dreamBefore)

  server.close()
  await once(server, 'close')
  server = null
  runtime.close()
  runtime = null

  const reloadedStore = new ConversationStore(root)
  await reloadedStore.initialize()
  const reloadedHistory = await reloadedStore.history()
  assert.equal(reloadedHistory.length, 2)
  assert.equal(reloadedHistory[0].attachment.thumbnailUrl, uploaded.attachment.thumbnailUrl)
  assert.equal(existsSync(join(root, reloadedHistory[0].attachment.thumbnailUrl.slice(1))), true)
  assert.equal(reloadedHistory[1].text, '花花看到了。')

  const html = await readFile(join(process.cwd(), 'src/remote/mobile-ui/index.html'), 'utf8')
  const mobileJs = await readFile(join(process.cwd(), 'src/remote/mobile-ui/mobile.js'), 'utf8')
  const mobileCss = await readFile(join(process.cwd(), 'src/remote/mobile-ui/mobile.css'), 'utf8')
  assert.match(html, /id="messages"/u)
  assert.match(mobileJs, /\/api\/pet\/history/u)
  assert.match(mobileJs, /\/api\/pet\/upload/u)
  assert.match(mobileJs, /attachmentId/u)
  assert.match(mobileJs, /image-card/u)
  assert.doesNotMatch(mobileJs, /line\('user', message \|\| '\[图片\]'\)/u)
  assert.match(mobileCss, /\.image-card/u)

  console.log('CONVERSATION_STORE=PASS')
  console.log('CONVERSATION_ASSET=PASS')
  console.log('HISTORY_API=PASS')
  console.log('IMAGE_THUMBNAIL_API=PASS')
  console.log('REFRESH_HISTORY=PASS')
  console.log('CONVERSATION_PERSISTENCE_ISOLATION=PASS')
  console.log('conversation persistence: PASS')
  console.log('memory: UNCHANGED')
  console.log('dream: UNCHANGED')
  console.log('local brain: UNCHANGED')
} finally {
  if (server) {
    server.close()
    await once(server, 'close')
  }
  runtime?.close()
  await rm(root, { recursive: true, force: true })
  assert.equal(existsSync(root), false)
}

console.log('FINAL_STATUS=VC_AI_PET_CONVERSATION_PERSISTENCE_PASS')
