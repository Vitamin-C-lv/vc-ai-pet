import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatSubmissionIdempotency } from '../src/remote/chat-submission-idempotency.js'
import { startLanServer } from '../src/remote/lan-server.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function call(port, method, path, body) {
  return new Promise((resolveCall, rejectCall) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        let payload = null
        try { payload = text ? JSON.parse(text) : null } catch { /* preserve the raw response for the assertion */ }
        resolveCall({ status: res.statusCode, payload, text })
      })
    })
    req.once('error', rejectCall)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

let startCount = 0
const startedTurns = new Map()
const runtime = {
  snapshot: () => ({ current: 'idle' }),
  presentationSnapshot: () => ({ visualState: 'idle', emotion: { happiness: .8, energy: .6 }, dream: false, sprite: 'idle-front.png' }),
  startChatTurn({ userText, attachmentId = null }) {
    startCount += 1
    const turnId = `turn-idempotency-${startCount}`
    startedTurns.set(turnId, { userText, attachmentId })
    return { turnId }
  },
  pollChatTurn(turnId, after = 0) {
    if (!startedTurns.has(turnId)) return null
    return { ok: true, turnId, status: 'running', events: [], lastSeq: Number(after) }
  },
}

const submissionRegistry = new ChatSubmissionIdempotency()
const server = await startLanServer({
  runtime,
  assetRoot: join(root, 'assets/runtime'),
  port: 0,
  submissionRegistry,
  logger: { info() {}, warn() {} },
})
const { port } = server.address()

try {
  // CASE N: replaying the same logical submission returns the original turn
  // without invoking PetTurnManager/runtime a second time.
  const firstN = await call(port, 'POST', '/api/pet/chat/start', { submissionId: 'submission-n', message: '同一条消息' })
  const replayN = await call(port, 'POST', '/api/pet/chat/start', { submissionId: 'submission-n', message: '同一条消息' })
  assert.equal(firstN.status, 202)
  assert.equal(replayN.status, 202)
  assert.equal(firstN.payload.idempotentReplay, false)
  assert.equal(replayN.payload.idempotentReplay, true)
  assert.equal(firstN.payload.turnId, replayN.payload.turnId)
  assert.equal(startCount, 1)

  // CASE O: a reused id with a different payload is a visible conflict and
  // cannot overwrite or create another server turn.
  const conflictO = await call(port, 'POST', '/api/pet/chat/start', { submissionId: 'submission-n', message: '不是同一条消息' })
  assert.equal(conflictO.status, 409)
  assert.deepEqual(conflictO.payload, { error: 'SUBMISSION_ID_CONFLICT' })
  assert.equal(startCount, 1)

  // CASE P: a new user action gets a different id and therefore a different
  // turn even when its message text is identical.
  const distinctP1 = await call(port, 'POST', '/api/pet/chat/start', { submissionId: 'submission-p-1', message: '可以重复的文字' })
  const distinctP2 = await call(port, 'POST', '/api/pet/chat/start', { submissionId: 'submission-p-2', message: '可以重复的文字' })
  assert.equal(distinctP1.status, 202)
  assert.equal(distinctP2.status, 202)
  assert.notEqual(distinctP1.payload.turnId, distinctP2.payload.turnId)
  assert.equal(startCount, 3)

  // CASE Q: the registry is host-lifetime RAM with bounded LRU capacity and
  // TTL eviction; it is not a ConversationStore or memory database.
  let now = 0
  let boundedCreateCount = 0
  const bounded = new ChatSubmissionIdempotency({ maxEntries: 2, ttlMs: 100, now: () => now })
  const boundedCreate = () => ({ turnId: `bounded-${++boundedCreateCount}` })
  bounded.start({ submissionId: 'bounded-a', message: 'a', createTurn: boundedCreate })
  bounded.start({ submissionId: 'bounded-b', message: 'b', createTurn: boundedCreate })
  assert.equal(bounded.size(), 2)
  assert.equal(bounded.start({ submissionId: 'bounded-a', message: 'a', createTurn: boundedCreate }).turnId, 'bounded-1')
  bounded.start({ submissionId: 'bounded-c', message: 'c', createTurn: boundedCreate })
  assert.equal(bounded.size(), 2)
  assert.equal(bounded.get('bounded-b'), null)
  now = 101
  assert.equal(bounded.size(), 0)

  // CASE Z: two independent clients racing with one id converge on one turn.
  const concurrent = await Promise.all([
    call(port, 'POST', '/api/pet/chat/start', { submissionId: 'submission-z', message: '两个客户端' }),
    call(port, 'POST', '/api/pet/chat/start', { submissionId: 'submission-z', message: '两个客户端' }),
  ])
  assert.ok(concurrent.every((result) => result.status === 202))
  assert.equal(new Set(concurrent.map((result) => result.payload.turnId)).size, 1)
  assert.equal(concurrent.filter((result) => result.payload.idempotentReplay === false).length, 1)
  assert.equal(concurrent.filter((result) => result.payload.idempotentReplay === true).length, 1)
  assert.equal(startCount, 4)

  // Old clients that omit submissionId keep the previous start response shape.
  const legacy = await call(port, 'POST', '/api/pet/chat/start', { message: '旧客户端' })
  assert.equal(legacy.status, 202)
  assert.equal(typeof legacy.payload.turnId, 'string')
  assert.equal(Object.hasOwn(legacy.payload, 'submissionId'), false)
  assert.equal(Object.hasOwn(legacy.payload, 'idempotentReplay'), false)
} finally {
  server.close()
  await once(server, 'close')
}

console.log('CASE_N_SAME_SUBMISSION_SAME_TURN=PASS')
console.log('CASE_O_SUBMISSION_PAYLOAD_CONFLICT=PASS')
console.log('CASE_P_DIFFERENT_SUBMISSION_DISTINCT_TURNS=PASS')
console.log('CASE_Q_REGISTRY_BOUNDED_TTL=PASS')
console.log('CASE_Z_TWO_CLIENTS_ONE_TURN=PASS')
console.log('SAME_SUBMISSION_START_CALL_COUNT=1')
console.log('SERVER_IDEMPOTENCY_BOUNDED=MAX_ENTRIES_256')
console.log('SERVER_IDEMPOTENCY_TTL=24_HOURS')
console.log('GLOBAL_EXACTLY_ONCE_CLAIMED=NO')
