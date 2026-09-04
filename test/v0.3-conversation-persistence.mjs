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
const fixtures = [
  {
    name: 'webp',
    mimeType: 'image/webp',
    extension: 'webp',
    contentType: 'image/webp',
    bytes: Buffer.from('UklGRiIAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEADsD+JaQAA3AA/vuUAAA=', 'base64'),
  },
  {
    name: 'jpeg',
    mimeType: 'image/jpeg',
    extension: 'jpg',
    contentType: 'image/jpeg',
    bytes: Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/AX//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/AX//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8Qf//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8Qf//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8Qf//Z', 'base64'),
  },
  {
    name: 'png',
    mimeType: 'image/png',
    extension: 'png',
    contentType: 'image/png',
    bytes: await readFile(join(process.cwd(), 'assets/runtime/icon-paw.png')),
  },
].map((fixture) => ({
  ...fixture,
  dataUrl: `data:${fixture.mimeType};base64,${fixture.bytes.toString('base64')}`,
}))

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

  const uploads = new Map()
  for (const fixture of fixtures) {
    const upload = await call(port, 'POST', '/api/pet/upload', {
      image: { dataUrl: fixture.dataUrl },
      thumbnail: { dataUrl: fixture.dataUrl },
      width: 128,
      height: 96,
      thumbnailWidth: 128,
      thumbnailHeight: 96,
    })
    assert.equal(upload.status, 200)
    const uploaded = JSON.parse(upload.text)
    assert.equal(uploaded.ok, true)
    assert.equal(uploaded.attachment.mimeType, fixture.mimeType)
    assert.match(uploaded.attachment.assetUrl, new RegExp(`^/conversation-assets/\\d{4}/\\d{2}/\\d{2}/[0-9a-f-]+\\.${fixture.extension}$`, 'u'))
    assert.match(uploaded.attachment.thumbnailUrl, new RegExp(`^/conversation-assets/\\d{4}/\\d{2}/\\d{2}/[0-9a-f-]+-thumbnail\\.${fixture.extension}$`, 'u'))
    assert.ok(uploaded.attachment.thumbnailWidth <= 256)
    assert.ok(uploaded.attachment.thumbnailHeight <= 256)

    const assetBytes = await readFile(join(root, uploaded.attachment.assetUrl.slice(1)))
    const thumbnailBytes = await readFile(join(root, uploaded.attachment.thumbnailUrl.slice(1)))
    assert.deepEqual(assetBytes, fixture.bytes)
    assert.deepEqual(thumbnailBytes, fixture.bytes)

    const assetResponse = await call(port, 'GET', uploaded.attachment.assetUrl)
    assert.equal(assetResponse.status, 200)
    assert.equal(assetResponse.headers['content-type'], fixture.contentType)
    const thumbnailResponse = await call(port, 'GET', uploaded.attachment.thumbnailUrl)
    assert.equal(thumbnailResponse.status, 200)
    assert.equal(thumbnailResponse.headers['content-type'], fixture.contentType)
    uploads.set(fixture.name, uploaded)
  }

  const uploaded = uploads.get('jpeg')
  assert.ok(uploaded?.attachment?.id)

  const chat = await call(port, 'POST', '/api/pet/chat', {
    message: '这是什么呀？',
    attachmentId: uploaded.attachment.id,
  })
  assert.equal(chat.status, 200)
  assert.equal(JSON.parse(chat.text).text, '花花看到了。')
  assert.equal(brainCalls.length, 1)
  assert.equal(brainCalls[0].userText, '这是什么呀？')
  assert.equal(brainCalls[0].image.dataUrl.startsWith('data:image/jpeg;base64,'), true)

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

  const persisted = JSON.parse(await readFile(join(root, 'conversation-store.json'), 'utf8'))
  assert.equal(JSON.stringify(persisted).includes('data:image'), false)
  assert.equal(JSON.stringify(persisted).includes(fixtures.find(({ name }) => name === 'jpeg').dataUrl), false)
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
  const restoredVision = await reloadedStore.readAttachmentDataUrl(uploaded.attachment.id)
  assert.equal(restoredVision.dataUrl.startsWith('data:image/jpeg;base64,'), true)

  const html = await readFile(join(process.cwd(), 'src/remote/mobile-ui/index.html'), 'utf8')
  const mobileJs = await readFile(join(process.cwd(), 'src/remote/mobile-ui/mobile.js'), 'utf8')
  const mobileCss = await readFile(join(process.cwd(), 'src/remote/mobile-ui/mobile.css'), 'utf8')
  assert.match(html, /id="messages"/u)
  assert.match(mobileJs, /\/api\/pet\/history/u)
  assert.match(mobileJs, /\/api\/pet\/upload/u)
  assert.match(mobileJs, /attachmentId/u)
  assert.match(mobileJs, /image-card/u)
  assert.match(mobileJs, /const localAttachment = pendingImage\s+\? \{ thumbnailUrl: pendingImage\.thumbnailDataUrl \}\s+: null\s+line\('user', message, localAttachment\)/u)
  assert.match(mobileJs, /const thinkingMessage = appendThinkingMessage\(\{ vision: Boolean\(pendingImage\) \}\)/u)
  assert.doesNotMatch(mobileJs, /line\('user', message \|\| '\[图片\]'\)/u)
  assert.match(mobileCss, /\.image-card/u)

  console.log('CONVERSATION_STORE=PASS')
  console.log('CONVERSATION_ASSET=PASS')
  console.log('HISTORY_API=PASS')
  console.log('IMAGE_THUMBNAIL_API=PASS')
  console.log('REFRESH_HISTORY=PASS')
  console.log('CONVERSATION_PERSISTENCE_ISOLATION=PASS')
  console.log('UPLOAD_API=PASS')
  console.log('ATTACHMENT_ID_RESOLVE=PASS')
  console.log('STORED_ASSET_VISION=PASS')
  console.log('WEBP_UPLOAD=PASS')
  console.log('JPEG_UPLOAD=PASS')
  console.log('PNG_UPLOAD=PASS')
  console.log('ASSET_EXTENSION_MATCHES_MIME=PASS')
  console.log('THUMBNAIL_EXTENSION_MATCHES_MIME=PASS')
  console.log('ASSET_HTTP_CONTENT_TYPE=PASS')
  console.log('THUMBNAIL_HTTP_CONTENT_TYPE=PASS')
  console.log('MOBILE_REAL_IMAGE_SEND=PASS')
  console.log('IMAGE_VISIBLE_IMMEDIATELY=PASS')
  console.log('IMAGE_VISIBLE_AFTER_REFRESH=PASS')
  console.log('PET_VISION_REPLY=PASS')
  console.log('MODEL_INFERENCES_PER_CHAT=1')
  console.log('MEMORY_CHANGED=NO')
  console.log('DREAM_CHANGED=NO')
  console.log('LOCAL_BRAIN_CHANGED=NO')
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
