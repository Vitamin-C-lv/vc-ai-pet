import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  HOUSEHOLD_SESSION_TTL_MS,
  IdentityStore,
  MAX_ACTIVE_SESSIONS_PER_PERSON,
  SESSION_TOUCH_INTERVAL_MS,
} from '../src/identity/identity-store.js'
import { LoginRateLimiter, resolveActorContext, startLanServer } from '../src/remote/lan-server.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sandboxRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-identity-auth-'))
let currentTime = 1_000_000
let dummyVerifications = 0
const store = new IdentityStore(sandboxRoot, {
  now: () => currentTime,
  onDummyPasswordVerification: () => { dummyVerifications += 1 },
})

function databaseRows(sql, ...values) {
  const db = new DatabaseSync(join(sandboxRoot, 'identity.sqlite'))
  try { return db.prepare(sql).all(...values) } finally { db.close() }
}

function jsonCall(port, method, path, body = null, headers = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const requestHeaders = { ...headers }
    if (body !== null) requestHeaders['content-type'] = 'application/json'
    const req = request({ host: '127.0.0.1', port, path, method, headers: requestHeaders }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolveCall({ status: res.statusCode, headers: res.headers, text, body: JSON.parse(text) }))
    })
    req.once('error', rejectCall)
    if (body !== null) req.write(JSON.stringify(body))
    req.end()
  })
}

function sessionTokenFromSetCookie(value) {
  const cookie = Array.isArray(value) ? value[0] : value
  const match = /^vc_ai_pet_session=([A-Za-z0-9_-]{43});/u.exec(String(cookie ?? ''))
  assert.ok(match, 'expected opaque vc_ai_pet_session cookie')
  return match[1]
}

await store.initialize()
try {
  assert.equal(databaseRows('SELECT COUNT(*) AS count FROM sessions')[0].count, 0)
  assert.equal(databaseRows('SELECT COUNT(*) AS count FROM guest_devices')[0].count, 0)
  assert.equal(databaseRows("SELECT COUNT(*) AS count FROM people WHERE account_type = 'guest'")[0].count, 0)
  assert.equal(databaseRows('SELECT COUNT(*) AS count FROM schema_migrations WHERE migration_id = ?', 'identity.001')[0].count, 1)

  const mom = await store.createHouseholdPerson({ username: 'Mom', displayName: '妈妈', password: 'correct horse battery staple' })
  const dad = await store.createHouseholdPerson({ username: 'Dad', displayName: '爸爸', password: 'another correct password' })
  const rate = await store.createHouseholdPerson({ username: 'RateUser', displayName: '限流测试', password: 'rate limit password' })
  const disabled = await store.createHouseholdPerson({ username: 'Disabled', displayName: '停用测试', password: 'disabled password' })

  const first = await store.createSession(mom.personId)
  const second = await store.createSession(mom.personId)
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/u)
  assert.notEqual(first.token, second.token)
  assert.equal(first.session.expiresAt - first.session.createdAt, HOUSEHOLD_SESSION_TTL_MS)
  const identityBytes = await readFile(join(sandboxRoot, 'identity.sqlite'))
  assert.equal(identityBytes.includes(Buffer.from(first.token, 'ascii')), false)
  const sessionHashes = databaseRows('SELECT session_id_hash FROM sessions WHERE person_id = ?', mom.personId)
  assert.notDeepEqual(Buffer.from(sessionHashes[0].session_id_hash), Buffer.from(sessionHashes[1].session_id_hash))

  const valid = await store.resolveSession(first.token)
  assert.equal(valid.person.personId, mom.personId)
  assert.notEqual(valid.sessionId, first.token)
  assert.match(valid.sessionId, /^session_[a-f0-9]{64}$/u)
  assert.equal(await store.resolveSession('not-a-session-token'), null)
  assert.equal(await store.resolveSession('a'.repeat(43)), null)

  const beforeTouch = valid.lastSeenAt
  currentTime += SESSION_TOUCH_INTERVAL_MS - 1
  assert.equal((await store.resolveSession(first.token)).lastSeenAt, beforeTouch)
  currentTime += 1
  assert.equal((await store.resolveSession(first.token)).lastSeenAt, currentTime)

  const expiring = await store.createSession(dad.personId, { ttlMs: 10 })
  currentTime += 10
  assert.equal(await store.resolveSession(expiring.token), null)
  assert.ok(await store.purgeExpiredSessions() >= 1)

  const revocable = await store.createSession(dad.personId)
  assert.equal(await store.revokeSession(revocable.token), true)
  assert.equal(await store.revokeSession(revocable.token), false)
  assert.equal(await store.resolveSession(revocable.token), null)
  const revokeForPerson = await store.createSession(dad.personId)
  assert.equal(await store.revokeSessionsForPerson(dad.personId), 1)
  assert.equal(await store.resolveSession(revokeForPerson.token), null)

  const disabledSession = await store.createSession(disabled.personId)
  await store.disablePerson(disabled.personId)
  assert.equal(await store.resolveSession(disabledSession.token), null)
  assert.deepEqual(await store.verifyHouseholdLogin({ username: 'not-present', password: 'wrong password' }), { ok: false })
  assert.deepEqual(await store.verifyHouseholdLogin({ username: disabled.username, password: 'disabled password' }), { ok: false })
  assert.equal(dummyVerifications, 2)

  const cappedTokens = []
  for (let index = 0; index <= MAX_ACTIVE_SESSIONS_PER_PERSON; index += 1) {
    currentTime += 1
    cappedTokens.push((await store.createSession(dad.personId)).token)
  }
  assert.equal(await store.resolveSession(cappedTokens[0]), null)
  assert.ok(await store.resolveSession(cappedTokens.at(-1)))
  assert.equal(databaseRows('SELECT COUNT(*) AS count FROM sessions WHERE person_id = ? AND revoked_at IS NULL AND expires_at > ?', dad.personId, currentTime)[0].count, MAX_ACTIVE_SESSIONS_PER_PERSON)

  const standaloneLimiter = new LoginRateLimiter({ now: () => currentTime, maxFailures: 2, maxKeys: 2 })
  standaloneLimiter.recordFailure('a')
  standaloneLimiter.recordFailure('a')
  assert.equal(standaloneLimiter.isLimited('a'), true)
  standaloneLimiter.recordSuccess('a')
  assert.equal(standaloneLimiter.isLimited('a'), false)
  standaloneLimiter.recordFailure('b')
  standaloneLimiter.recordFailure('c')
  standaloneLimiter.recordFailure('d')
  assert.equal(standaloneLimiter.size, 2)

  const calls = []
  const runtime = {
    snapshot: () => ({ current: 'idle' }),
    presentationSnapshot: () => ({ visualState: 'idle', emotion: { happiness: .8, energy: .6 }, dream: false, sprite: 'idle-front.png' }),
    async interact() { return this.snapshot() },
    async chat(message) { return { ok: true, text: `汪：${message}` } },
    startChatTurn(input) { calls.push(input); return { turnId: 'identity-auth-turn' } },
    pollChatTurn() { return null },
  }
  const logs = []
  const server = await startLanServer({
    runtime,
    assetRoot: join(root, 'assets/runtime'),
    port: 0,
    identityStore: store,
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  })
  const { port } = server.address()
  try {
    const anonymous = await jsonCall(port, 'GET', '/api/auth/me')
    assert.deepEqual(anonymous.body, { authenticated: false, actor: null, person: null })
    assert.equal((await jsonCall(port, 'GET', '/api/pet/state')).status, 200)
    assert.equal((await jsonCall(port, 'POST', '/api/pet/chat/start', { message: '无需登录仍可聊天' })).status, 202)
    assert.deepEqual(calls[0], { userText: '无需登录仍可聊天', image: null, attachment: null, attachmentId: null })

    const crossOrigin = await jsonCall(port, 'POST', '/api/auth/login', { username: mom.username, password: 'correct horse battery staple' }, { origin: 'https://evil.example' })
    assert.deepEqual({ status: crossOrigin.status, body: crossOrigin.body }, { status: 403, body: { error: 'untrusted-origin' } })

    const wrong = await jsonCall(port, 'POST', '/api/auth/login', { username: mom.username, password: 'wrong password' })
    const unknown = await jsonCall(port, 'POST', '/api/auth/login', { username: 'nobody', password: 'wrong password' })
    const disabledLogin = await jsonCall(port, 'POST', '/api/auth/login', { username: disabled.username, password: 'disabled password' })
    assert.deepEqual(wrong.body, { error: 'invalid-credentials' })
    assert.equal(unknown.status, 401)
    assert.deepEqual(unknown.body, { error: 'invalid-credentials' })
    assert.equal(disabledLogin.status, 401)
    assert.deepEqual(disabledLogin.body, { error: 'invalid-credentials' })

    const login = await jsonCall(port, 'POST', '/api/auth/login', { username: mom.username, password: 'correct horse battery staple' })
    assert.equal(login.status, 200)
    assert.equal(login.body.ok, true)
    assert.equal(login.body.person.personId, mom.personId)
    const firstCookie = String(Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie'])
    const firstToken = sessionTokenFromSetCookie(login.headers['set-cookie'])
    assert.match(firstCookie, /; HttpOnly; SameSite=Strict(?:;|$)/u)
    assert.match(firstCookie, /; Path=\//u)
    assert.match(firstCookie, new RegExp(`Max-Age=${HOUSEHOLD_SESSION_TTL_MS / 1000}`))
    assert.equal(/(?:^|; )Secure(?:;|$)/u.test(firstCookie), false)

    const context = await resolveActorContext({ headers: { cookie: firstCookie } }, store)
    assert.ok(context)
    assert.equal(context.actorId, mom.personId)
    assert.equal(context.actorType, 'household')
    assert.equal(context.authenticated, true)
    assert.equal(Object.isFrozen(context), true)
    assert.throws(() => { context.displayName = '篡改' }, TypeError)
    assert.equal(await resolveActorContext({ headers: {} }, store), null)

    const me = await jsonCall(port, 'GET', '/api/auth/me', null, { cookie: firstCookie })
    assert.equal(me.status, 200)
    assert.equal(me.body.authenticated, true)
    assert.equal(me.body.actor.actorId, mom.personId)
    assert.equal(me.body.actor.sessionId, undefined)
    assert.equal(me.body.person.passwordHash, undefined)

    const relogin = await jsonCall(port, 'POST', '/api/auth/login', { username: mom.username, password: 'correct horse battery staple' }, { cookie: firstCookie })
    const secondToken = sessionTokenFromSetCookie(relogin.headers['set-cookie'])
    assert.notEqual(firstToken, secondToken)
    assert.equal(await store.resolveSession(firstToken), null)

    const logout = await jsonCall(port, 'POST', '/api/auth/logout', {}, { cookie: `vc_ai_pet_session=${secondToken}` })
    assert.deepEqual({ status: logout.status, body: logout.body }, { status: 200, body: { ok: true } })
    assert.match(String(Array.isArray(logout.headers['set-cookie']) ? logout.headers['set-cookie'][0] : logout.headers['set-cookie']), /Max-Age=0/u)
    assert.equal(await store.resolveSession(secondToken), null)
    assert.equal((await jsonCall(port, 'POST', '/api/auth/logout', {})).status, 200)

    for (let index = 0; index < 4; index += 1) assert.equal((await jsonCall(port, 'POST', '/api/auth/login', { username: rate.username, password: 'wrong password' })).status, 401)
    assert.equal((await jsonCall(port, 'POST', '/api/auth/login', { username: rate.username, password: 'rate limit password' })).status, 200)
    for (let index = 0; index < 5; index += 1) assert.equal((await jsonCall(port, 'POST', '/api/auth/login', { username: rate.username, password: 'wrong password' })).status, 401)
    assert.deepEqual((await jsonCall(port, 'POST', '/api/auth/login', { username: rate.username, password: 'wrong password' })).body, { error: 'too-many-attempts' })
    assert.equal((await jsonCall(port, 'POST', '/api/auth/login', { username: rate.username, password: 'wrong password' })).status, 429)

    assert.equal(logs.join('\n').includes(firstToken), false)
    assert.equal(databaseRows('SELECT COUNT(*) AS count FROM guest_devices')[0].count, 0)
  } finally {
    server.close()
    await once(server, 'close')
  }

  console.log('SESSION_TOKEN_OPAQUE=PASS')
  console.log('RAW_SESSION_TOKEN_STORED=NO')
  console.log('SESSION_LIFECYCLE=PASS')
  console.log('UNKNOWN_USERNAME_HASH_WORK_PERFORMED=YES')
  console.log('LOGIN_ROUTE=PASS')
  console.log('LOGOUT_ROUTE=PASS')
  console.log('ME_ROUTE=PASS')
  console.log('ACTOR_CONTEXT=PASS')
  console.log('RATE_LIMIT=PASS')
  console.log('EXISTING_PET_ROUTES_AUTH_ENFORCED=NO')
  console.log('GUEST_IMPLEMENTED=NO')
} finally {
  store.close()
  await rm(sandboxRoot, { recursive: true, force: true })
}
