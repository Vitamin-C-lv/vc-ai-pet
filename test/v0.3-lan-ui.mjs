import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import {
  actionToInteractionKind,
  isAllowedLanAddress,
  isPrivateIPv4,
  startLanServer,
} from '../src/remote/lan-server.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeSandbox = await mkdtemp(join(tmpdir(), 'vc-ai-pet-lan-runtime-'))
const sharedRuntime = new PetRuntime({ sandboxRoot: runtimeSandbox })
await sharedRuntime.initialize()
try {
  const actionAt = Date.now()
  await sharedRuntime.interact('long-press', actionAt)
  const presentation = sharedRuntime.presentationSnapshot({}, actionAt + 1)
  assert.equal(presentation.visualState, 'relaxed')
  assert.ok(presentation.emotion.happiness > .5)
} finally {
  sharedRuntime.close()
  await rm(runtimeSandbox, { recursive: true, force: true })
}

const calls = []
const runtime = {
  snapshot: () => ({ current: 'idle', lifetimeInteractions: calls.length }),
  presentationSnapshot: () => ({ visualState: calls.at(-1) === 'long-press' ? 'relaxed' : 'idle', emotion: { happiness: .8, energy: .6 }, dream: false, sprite: 'idle-front.png' }),
  async interact(kind) { calls.push(kind); return this.snapshot() },
  async chat(message) { return { ok: true, unavailable: false, text: `汪：${message}` } },
}
const logs = []
const server = await startLanServer({ runtime, assetRoot: join(root, 'assets/runtime'), port: 0, logger: { info: (line) => logs.push(line) } })
const { port, address } = server.address()
assert.equal(address, '0.0.0.0')

function call(method, path, body = null) {
  return new Promise((resolveCall, rejectCall) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: body ? { 'content-type': 'application/json' } : undefined }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolveCall({ status: res.statusCode, headers: res.headers, text }))
    })
    req.once('error', rejectCall)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

try {
  assert.deepEqual(logs.slice(0, 2), ['VC_AI_PET_LAN_UI', 'LOCAL_ONLY=true'])
  assert.match(logs[2], /^URL=http:\/\//)
  assert.equal(isPrivateIPv4('192.168.1.4'), true)
  assert.equal(isPrivateIPv4('172.31.5.4'), true)
  assert.equal(isPrivateIPv4('172.32.5.4'), false)
  assert.equal(isAllowedLanAddress('::ffff:10.0.0.3'), true)
  assert.equal(isAllowedLanAddress('8.8.8.8'), false)
  assert.equal(isAllowedLanAddress('2001:4860:4860::8888'), false)
  assert.equal(actionToInteractionKind('click', { current: 'sleep' }), 'wake')
  assert.equal(actionToInteractionKind('double_click'), 'play')
  assert.equal(actionToInteractionKind('long_press'), 'long-press')

  const page = await call('GET', '/')
  assert.equal(page.status, 200)
  assert.match(page.text, /李花花/)

  const state = await call('GET', '/api/pet/state')
  assert.equal(state.status, 200)
  assert.deepEqual(JSON.parse(state.text), { visualState: 'idle', emotion: { happiness: .8, energy: .6 }, dream: false, sprite: 'idle-front.png' })

  for (const [action, expected] of [['click', 'pet'], ['double_click', 'play'], ['long_press', 'long-press']]) {
    const result = await call('POST', '/api/pet/action', { action })
    assert.equal(result.status, 200)
    assert.equal(calls.at(-1), expected)
  }
  assert.equal((await call('POST', '/api/pet/action', { action: 'invalid' })).status, 400)

  const chat = await call('POST', '/api/pet/chat', { message: '你好花花' })
  assert.equal(chat.status, 200)
  assert.equal(JSON.parse(chat.text).text, '汪：你好花花')
} finally {
  server.close()
  await once(server, 'close')
}

console.log('LAN_SERVER_START=PASS')
console.log('STATE_API=PASS')
console.log('ACTION_API=PASS')
console.log('CHAT_API=PASS')
console.log('LOCAL_ONLY=PASS')
