import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { startLanServer } from '../src/remote/lan-server.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-message-headpat-'))
const assetRoot = join(process.cwd(), 'assets/runtime')
let store = null
let server = null
let reloadedStore = null
let reloadedServer = null
let emptyServer = null

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
      res.on('end', () => resolveCall({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.once('error', rejectCall)
    if (encoded !== null) req.write(encoded)
    req.end()
  })
}

async function closeServer(value) {
  if (!value) return
  value.close()
  await once(value, 'close')
}

try {
  store = new ConversationStore(root)
  await store.initialize()

  const dialogue = await store.appendMessage({ id: 'headpat-dialogue', role: 'assistant', text: '摸摸头也很喜欢。' })
  const final = await store.appendMessage({ id: 'headpat-final', role: 'assistant', kind: 'final', text: '今天的回答。' })
  const proactive = await store.appendMessage({ id: 'headpat-proactive', role: 'assistant', kind: 'proactive', text: '记得喝水哦。' })
  const user = await store.appendMessage({ id: 'headpat-user', role: 'user', text: '摸摸头' })
  const activity = await store.appendMessage({ id: 'headpat-activity', role: 'assistant', kind: 'activity', text: '正在思考。' })
  const noText = await store.appendMessage({ id: 'headpat-empty', role: 'assistant', text: '   ' })

  const iconBytes = await readFile(join(assetRoot, 'icon-paw.png'))
  const iconDataUrl = `data:image/png;base64,${iconBytes.toString('base64')}`
  const attachment = await store.saveAttachment({ image: iconDataUrl, thumbnail: iconDataUrl, requireThumbnail: true })
  const mediaRef = await store.appendMessage({
    id: 'headpat-media', role: 'assistant', kind: 'media_ref', text: '图片记录。', sourceAttachmentId: attachment.id,
  })

  const rawBefore = await store.rawHistory()
  server = await startLanServer({
    runtime: { conversationStore: store },
    assetRoot,
    conversationStore: store,
    port: 0,
    logger: { info() {}, warn() {} },
  })
  const port = server.address().port

  for (const message of [dialogue, final, proactive]) {
    const liked = await call(port, 'POST', `/api/pet/messages/${message.id}/headpat`, { liked: true })
    assert.equal(liked.status, 200)
    assert.deepEqual(liked.body, { ok: true, feedback: { headpat: true } })
    assert.deepEqual((await call(port, 'POST', `/api/pet/messages/${message.id}/headpat`, { liked: true })).body, liked.body)
  }

  const unliked = await call(port, 'POST', `/api/pet/messages/${dialogue.id}/headpat`, { liked: false })
  assert.equal(unliked.status, 200)
  assert.deepEqual(unliked.body, { ok: true, feedback: { headpat: false } })
  assert.deepEqual((await call(port, 'POST', `/api/pet/messages/${dialogue.id}/headpat`, { liked: false })).body, unliked.body)
  assert.deepEqual((await call(port, 'POST', `/api/pet/messages/${dialogue.id}/headpat`, { liked: true })).body, {
    ok: true, feedback: { headpat: true },
  })

  assert.equal((await call(port, 'POST', `/api/pet/messages/${dialogue.id}/headpat`, { liked: 'yes' })).status, 400)
  assert.equal((await call(port, 'POST', '/api/pet/messages/missing/headpat', { liked: true })).status, 404)
  for (const message of [user, activity, mediaRef, noText]) {
    assert.equal((await call(port, 'POST', `/api/pet/messages/${message.id}/headpat`, { liked: true })).status, 400)
  }

  const historyResponse = await call(port, 'GET', '/api/pet/history')
  assert.equal(historyResponse.status, 200)
  const history = new Map(historyResponse.body.messages.map((message) => [message.id, message]))
  for (const message of [dialogue, final, proactive]) assert.deepEqual(history.get(message.id).feedback, { headpat: true })
  for (const message of [user, activity, mediaRef, noText]) assert.deepEqual(history.get(message.id).feedback, { headpat: false })
  assert.deepEqual(await store.rawHistory(), rawBefore)

  await closeServer(server)
  server = null
  store.close()
  store = null

  reloadedStore = new ConversationStore(root)
  await reloadedStore.initialize()
  reloadedServer = await startLanServer({
    runtime: { conversationStore: reloadedStore },
    assetRoot,
    conversationStore: reloadedStore,
    port: 0,
    logger: { info() {}, warn() {} },
  })
  const restoredHistory = await call(reloadedServer.address().port, 'GET', '/api/pet/history')
  assert.equal(restoredHistory.status, 200)
  const restored = new Map(restoredHistory.body.messages.map((message) => [message.id, message]))
  for (const message of [dialogue, final, proactive]) assert.deepEqual(restored.get(message.id).feedback, { headpat: true })
  assert.deepEqual(await reloadedStore.rawHistory(), rawBefore)

  emptyServer = await startLanServer({
    runtime: {},
    assetRoot,
    conversationStore: null,
    port: 0,
    logger: { info() {}, warn() {} },
  })
  const unavailable = await call(emptyServer.address().port, 'POST', '/api/pet/messages/headpat-dialogue/headpat', { liked: true })
  assert.equal(unavailable.status, 503)

  console.log('MESSAGE_HEADPAT_ALLOWED_KINDS=PASS')
  console.log('MESSAGE_HEADPAT_REJECTS_INELIGIBLE=PASS')
  console.log('MESSAGE_HEADPAT_IDEMPOTENT_TOGGLE=PASS')
  console.log('MESSAGE_HEADPAT_HISTORY=PASS')
  console.log('MESSAGE_HEADPAT_RESTART_PERSISTENCE=PASS')
  console.log('MESSAGE_HEADPAT_RAW_ARCHIVE_UNCHANGED=PASS')
  console.log('MESSAGE_HEADPAT_STORE_UNAVAILABLE=PASS')
} finally {
  await closeServer(emptyServer)
  await closeServer(reloadedServer)
  await closeServer(server)
  reloadedStore?.close()
  store?.close()
  await rm(root, { recursive: true, force: true })
}

console.log('FINAL_STATUS=VC_AI_PET_MESSAGE_HEADPAT_PASS')
