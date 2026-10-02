import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationStore } from '../src/conversation/conversation-store.js'
import { ChatSubmissionIdempotency, SERVER_IDEMPOTENCY_TTL_MS } from '../src/remote/chat-submission-idempotency.js'
import { startLanServer } from '../src/remote/lan-server.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-chat-receipt-'))
const assetRoot = join(process.cwd(), 'assets/runtime')
let startCount = 0

function createRuntime(conversationStore) {
  return {
    conversationStore,
    startChatTurn() {
      return { turnId: `turn-receipt-${++startCount}` }
    },
    pollChatTurn() { return null },
  }
}

async function startServer(conversationStore) {
  return startLanServer({
    runtime: createRuntime(conversationStore),
    conversationStore,
    assetRoot,
    port: 0,
    logger: { info() {}, warn() {} },
  })
}

async function call(port, method, path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function stopServer(server) {
  if (!server) return
  server.close()
  await once(server, 'close')
}

let store = new ConversationStore(root)
await store.initialize()
let server = await startServer(store)

try {
  const accepted = await call(server.address().port, 'POST', '/api/pet/chat/start', {
    submissionId: 'persisted-hunger-turn',
    message: '黑莓好像饿了',
  })
  assert.equal(accepted.status, 202)
  assert.equal(accepted.body.idempotentReplay, false)
  assert.equal(startCount, 1)

  await store.appendMessage({
    role: 'user', text: '黑莓好像饿了', turnId: accepted.body.turnId,
  })
  await store.appendMessage({
    role: 'assistant', text: '我来看看。', turnId: accepted.body.turnId,
    reasoning: { effort: 'low', durationMs: 12 },
  })
} finally {
  await stopServer(server)
  store.close()
}

store = new ConversationStore(root)
await store.initialize()
server = await startServer(store)

try {
  const replay = await call(server.address().port, 'POST', '/api/pet/chat/start', {
    submissionId: 'persisted-hunger-turn',
    message: '黑莓好像饿了',
  })
  assert.equal(replay.status, 202)
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal(replay.body.turnId, 'turn-receipt-1')
  assert.equal(startCount, 1)

  const conflict = await call(server.address().port, 'POST', '/api/pet/chat/start', {
    submissionId: 'persisted-hunger-turn',
    message: '另一条消息',
  })
  assert.equal(conflict.status, 409)
  assert.deepEqual(conflict.body, { error: 'SUBMISSION_ID_CONFLICT' })
  assert.equal(startCount, 1)

  const recovered = await call(server.address().port, 'GET', `/api/pet/chat/turn/${replay.body.turnId}?after=0`)
  assert.equal(recovered.status, 200)
  assert.deepEqual(recovered.body, {
    ok: true,
    turnId: 'turn-receipt-1',
    status: 'done',
    events: [],
    lastSeq: 0,
    result: { ok: true },
    historyRecovered: true,
  })

  const missingReceipt = await call(server.address().port, 'GET', '/api/pet/chat/turn/unknown-turn?after=0')
  assert.equal(missingReceipt.status, 404)
} finally {
  await stopServer(server)
  store.close()
}

store = new ConversationStore(root)
await store.initialize()
server = await startServer(store)

try {
  const interrupted = await call(server.address().port, 'POST', '/api/pet/chat/start', {
    submissionId: 'persisted-interrupted-turn',
    message: '这条在重启前没有完成',
  })
  assert.equal(interrupted.status, 202)
  assert.equal(startCount, 2)
} finally {
  await stopServer(server)
  store.close()
}

store = new ConversationStore(root)
await store.initialize()
server = await startServer(store)

try {
  const replay = await call(server.address().port, 'POST', '/api/pet/chat/start', {
    submissionId: 'persisted-interrupted-turn',
    message: '这条在重启前没有完成',
  })
  assert.equal(replay.status, 202)
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal(replay.body.turnId, interruptedTurnId(store, 'persisted-interrupted-turn'))
  assert.equal(startCount, 2)

  const recovered = await call(server.address().port, 'GET', `/api/pet/chat/turn/${replay.body.turnId}?after=4`)
  assert.equal(recovered.status, 200)
  assert.equal(recovered.body.status, 'error')
  assert.equal(recovered.body.events.length, 1)
  assert.equal(recovered.body.events[0].seq, 5)
  assert.equal(recovered.body.events[0].type, 'turn_failed')
  assert.equal(recovered.body.events[0].payload.code, 'TURN_INTERRUPTED')
  assert.equal(recovered.body.lastSeq, 5)

  const noTtl = new ChatSubmissionIdempotency({
    conversationStore: store,
    now: () => Date.now() + SERVER_IDEMPOTENCY_TTL_MS * 2,
  }).lookup({
    submissionId: 'persisted-interrupted-turn',
    message: '这条在重启前没有完成',
  })
  assert.equal(noTtl.turnId, replay.body.turnId)
} finally {
  await stopServer(server)
  store.close()
  await (await import('node:fs/promises')).rm(root, { recursive: true, force: true })
}

function interruptedTurnId(conversationStore, submissionId) {
  return conversationStore.chatSubmissionReceipt(submissionId)?.turnId
}

console.log('DURABLE_SUBMISSION_REPLAY_AFTER_RESTART=PASS')
console.log('DURABLE_SUBMISSION_PAYLOAD_CONFLICT=PASS')
console.log('ARCHIVED_TURN_HISTORY_RECOVERY=PASS')
console.log('INTERRUPTED_TURN_IS_EXPLICIT_AND_NOT_RESTARTED=PASS')
console.log('DURABLE_RECEIPTS_IGNORE_RAM_TTL=PASS')
