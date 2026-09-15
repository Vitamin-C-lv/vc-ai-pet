import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createStackChanBridgeServer } from '../src/server.mjs'
import { mapPetStateToBodyContract } from '../src/contract.mjs'

async function start(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  if (!server?.listening) return
  server.close()
  await once(server, 'close')
}

async function request(url, path = '/v1/body/state', method = 'GET') {
  const response = await fetch(new URL(path, url), { method })
  return { status: response.status, body: await response.json(), bytes: Number(response.headers.get('content-length') ?? 0) }
}

function validState(visualState = 'relaxed') {
  return { visualState, emotion: { happiness: 0.6, energy: 0.4 }, dream: false, sprite: 'stretch.png' }
}

async function withBridge(upstreamHandler, run, { now = () => Date.now(), timeoutMs = 150, maxAgeMs = 10_000 } = {}) {
  let postCount = 0
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'GET') postCount += 1
    await upstreamHandler(req, res)
  })
  const upstreamUrl = new URL('/api/pet/state', await start(upstream))
  const bridge = createStackChanBridgeServer({
    upstreamUrl,
    upstreamTimeoutMs: timeoutMs,
    stateMaxAgeMs: maxAgeMs,
    now,
    mapPetStateToBodyContract,
  })
  const bridgeUrl = await start(bridge)
  try {
    await run({ bridgeUrl, upstream, getPostCount: () => postCount })
  } finally {
    await close(bridge)
    await close(upstream)
  }
}

await withBridge(async (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(validState()))
}, async ({ bridgeUrl, getPostCount }) => {
  const health = await request(bridgeUrl, '/healthz')
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)

  const result = await request(bridgeUrl)
  assert.equal(result.status, 200)
  assert.equal(result.body.presentation.expression, 'relaxed')
  assert.equal(result.body.reachable, true)
  assert.ok(JSON.stringify(result.body).length < 4096)
  assert.equal(getPostCount(), 0)
})

await withBridge(async (_req, res) => {
  res.writeHead(500).end('failed')
}, async ({ bridgeUrl }) => {
  const result = await request(bridgeUrl)
  assert.equal(result.status, 200)
  assert.equal(result.body.online, false)
  assert.equal(result.body.presentation.expression, 'offline')
})

await withBridge(async (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end('{bad json')
}, async ({ bridgeUrl }) => {
  const result = await request(bridgeUrl)
  assert.equal(result.body.online, false)
  assert.equal(result.body.reachable, false)
})

await withBridge(async (_req, res) => {
  await new Promise((resolve) => setTimeout(resolve, 300))
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(validState()))
}, async ({ bridgeUrl }) => {
  const result = await request(bridgeUrl)
  assert.equal(result.body.presentation.expression, 'offline')
}, { timeoutMs: 25 })

let currentTime = Date.parse('2026-09-15T00:00:00.000Z')
let upstreamFail = false
await withBridge(async (_req, res) => {
  if (upstreamFail) {
    res.writeHead(503).end('unavailable')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(validState('happy')))
}, async ({ bridgeUrl }) => {
  assert.equal((await request(bridgeUrl)).body.reachable, true)
  upstreamFail = true
  currentTime += 3000
  const result = await request(bridgeUrl)
  assert.equal(result.body.online, true)
  assert.equal(result.body.reachable, false)
  assert.equal(result.body.presentation.expression, 'happy')
  assert.equal(result.body.source.stateAgeMs, 3000)
}, { now: () => currentTime })

currentTime = Date.parse('2026-09-15T00:00:00.000Z')
upstreamFail = false
await withBridge(async (_req, res) => {
  if (upstreamFail) {
    res.writeHead(503).end('unavailable')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(validState('thinking')))
}, async ({ bridgeUrl }) => {
  await request(bridgeUrl)
  upstreamFail = true
  currentTime += 10_001
  const result = await request(bridgeUrl)
  assert.equal(result.body.online, false)
  assert.equal(result.body.presentation.expression, 'offline')
}, { now: () => currentTime })

const reservation = createServer()
const refusedUrl = new URL('/api/pet/state', await start(reservation))
await close(reservation)
const refusedBridge = createStackChanBridgeServer({ upstreamUrl: refusedUrl, mapPetStateToBodyContract })
const refusedBridgeUrl = await start(refusedBridge)
try {
  const result = await request(refusedBridgeUrl)
  assert.equal(result.body.online, false)
  assert.equal(result.body.presentation.expression, 'offline')
  assert.equal((await request(refusedBridgeUrl, '/not-supported')).status, 404)
  assert.equal((await request(refusedBridgeUrl, '/v1/body/state', 'POST')).status, 405)
} finally {
  await close(refusedBridge)
}

console.log('BRIDGE_FAKE_UPSTREAM_TEST=PASS')
