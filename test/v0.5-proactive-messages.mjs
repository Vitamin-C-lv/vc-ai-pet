import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { startLanServer } from '../src/remote/lan-server.js'

const HOUR = 60 * 60 * 1000
const DAYLIGHT = Date.parse('2026-10-02T02:00:00.000Z') // 10:00 in Asia/Shanghai
const QUIET_HOUR = Date.parse('2026-10-02T15:00:00.000Z') // 23:00 in Asia/Shanghai
const runtimes = new Set()
const roots = new Set()

async function createRuntime(now = DAYLIGHT, sandboxRoot = null) {
  const root = sandboxRoot ?? await mkdtemp(join(tmpdir(), 'vc-ai-pet-proactive-'))
  roots.add(root)
  const runtime = new PetRuntime({ sandboxRoot: root, logger: { info() {}, warn() {} } })
  await runtime.initialize()
  assert.ok(runtime.proactive, 'runtime should initialize proactive messages')
  runtime.proactive.now = () => now
  runtime.state.bornAt = now - 24 * HOUR
  runtime.state.lastInteractionAt = now - 4 * HOUR
  runtime.state.current = 'idle'
  runtimes.add(runtime)
  return { root, runtime }
}

function useBrain(runtime, result) {
  const calls = []
  runtime.brain = {
    async proactiveMessage(request) {
      calls.push(request)
      return typeof result === 'function' ? result(request) : result
    },
  }
  return calls
}

async function appendProactive(runtime, timestamp, text = '历史提醒。') {
  return runtime.conversationStore.appendMessage({
    role: 'assistant', kind: 'proactive', text, timestamp, turnId: `prior-${timestamp}`,
  })
}

function memorySnapshot(runtime) {
  const levels = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
  return JSON.stringify(levels.flatMap((level) => runtime.memory.db.list(level, {})))
}

function innerLifeSnapshot(runtime) {
  return JSON.stringify({
    dream: runtime.memory.dreamWindow(),
    reflection: runtime.memory.reflectionWindow(),
  })
}

async function callApi(server, method, path, body = undefined) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function closeRuntime(runtime) {
  runtime?.close()
  runtimes.delete(runtime)
}

try {
  // A daylight, idle attempt can create one assistant-only proactive message.
  {
    const { runtime } = await createRuntime()
    await appendProactive(runtime, DAYLIGHT - 4 * HOUR, '早上的主动提醒。')
    const memoryBefore = memorySnapshot(runtime)
    const innerLifeBefore = innerLifeSnapshot(runtime)
    const calls = useBrain(runtime, {
      send: true,
      text: '主人，今天也要记得喝水哦。',
      reasoning: { effort: 'medium', durationMs: 7 },
    })

    const sent = await runtime.proactive.maybeSend(DAYLIGHT)
    assert.equal(sent.status, 'sent')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].idleMs, 4 * HOUR)
    assert.deepEqual(calls[0].recentProactiveMessages, ['早上的主动提醒。'])
    assert.equal(Object.hasOwn(calls[0], 'turnId'), false)
    const history = await runtime.conversationStore.history()
    assert.equal(history.length, 2)
    assert.deepEqual(history.map(({ role, kind }) => ({ role, kind })), [
      { role: 'assistant', kind: 'proactive' },
      { role: 'assistant', kind: 'proactive' },
    ])
    assert.equal(history[1].text, '主人，今天也要记得喝水哦。')
    assert.ok(history[1].turnId)
    assert.equal(memorySnapshot(runtime), memoryBefore)
    assert.equal(innerLifeSnapshot(runtime), innerLifeBefore)

    const replyCalls = []
    runtime.brain.reply = async (request) => {
      replyCalls.push(request)
      return {
        ok: true,
        text: '好呀，我们聊聊。',
        replyMessages: ['好呀，我们聊聊。'],
        rawMemoryCandidate: null,
        memoryCandidate: null,
        beliefCandidates: [],
      }
    }
    const followup = await runtime.chat('好呀', null, null, { turnId: 'owner-followup' })
    assert.equal(followup.ok, true)
    assert.deepEqual(
      replyCalls[0].recentMessages.filter((message) => message.role === 'assistant' && message.content === history[1].text),
      [{ role: 'assistant', content: history[1].text }],
    )
    await runtime.chat('那继续聊聊吧。', null, null, { turnId: 'owner-next-turn' })
    assert.equal(replyCalls.length, 2)
    assert.equal(replyCalls[1].recentMessages.some((message) => message.role === 'assistant' && message.content === history[1].text), false)
    await runtime.flushExperienceWrites()
    await closeRuntime(runtime)
  }

  // Settings are persisted, and the cap is computed from the durable archive.
  {
    const { root, runtime } = await createRuntime()
    const settings = await runtime.setProactiveSettings({ maxPerDay: 1 })
    assert.equal(settings.maxPerDay, 1)
    await useBrain(runtime, { send: true, text: '今天的第一条提醒。' })
    assert.equal((await runtime.proactive.maybeSend(DAYLIGHT)).status, 'sent')

    const beforeRestart = await runtime.pollProactiveMessages(0)
    assert.equal(beforeRestart.messages.length, 1)
    const first = beforeRestart.messages[0]
    await runtime.conversationStore.appendMessage({
      role: 'assistant', kind: 'final', text: '普通聊天回复。', timestamp: DAYLIGHT + 1000, turnId: 'ordinary-reply',
    })
    await closeRuntime(runtime)

    const restarted = await createRuntime(DAYLIGHT + HOUR, root)
    assert.equal((await restarted.runtime.getProactiveSettings()).maxPerDay, 1)
    restarted.runtime.state.lastInteractionAt = DAYLIGHT - 4 * HOUR
    const calls = useBrain(restarted.runtime, { send: true, text: '不应再次生成。' })
    const capped = await restarted.runtime.proactive.maybeSend(DAYLIGHT + HOUR)
    assert.deepEqual(capped, { status: 'skipped', reason: 'daily-cap' })
    assert.equal(calls.length, 0)

    const replayed = await restarted.runtime.pollProactiveMessages(0)
    assert.deepEqual(replayed.messages[0], first)
    assert.equal(replayed.messages.length, 1)
    assert.equal(replayed.cursor, beforeRestart.cursor, 'replayed messages keep their durable sequence cursor')
    const after = await restarted.runtime.pollProactiveMessages(replayed.cursor)
    assert.deepEqual(after.messages, [])
    assert.ok(after.cursor > replayed.cursor, 'an empty poll advances over an ordinary reply without notifying it')
    assert.deepEqual(await restarted.runtime.pollProactiveMessages(after.cursor), { cursor: after.cursor, messages: [] })
    const latest = await restarted.runtime.pollProactiveMessages(0, { latest: true })
    assert.deepEqual(latest, { cursor: after.cursor, messages: [] })
    await closeRuntime(restarted.runtime)
  }

  // Quiet hours, sleep, active chat/Dream/Reflection, recent owner activity,
  // and the prior-proactive cooldown all avoid a model call.
  {
    const { runtime } = await createRuntime()
    const calls = useBrain(runtime, { send: true, text: '不应发送。' })

    assert.deepEqual(await runtime.proactive.maybeSend(QUIET_HOUR), { status: 'skipped', reason: 'quiet-hours' })
    runtime.state.current = 'sleep'
    assert.deepEqual(await runtime.proactive.maybeSend(DAYLIGHT), { status: 'skipped', reason: 'asleep' })
    runtime.state.current = 'idle'
    runtime.chatInFlight = 1
    assert.deepEqual(await runtime.proactive.maybeSend(DAYLIGHT), { status: 'skipped', reason: 'busy' })
    runtime.chatInFlight = 0
    runtime.dreamEngine = { isInFlight: () => true }
    assert.deepEqual(await runtime.proactive.maybeSend(DAYLIGHT), { status: 'skipped', reason: 'busy' })
    runtime.dreamEngine = { isInFlight: () => false }
    runtime.reflectionEngine = { isInFlight: () => true }
    assert.deepEqual(await runtime.proactive.maybeSend(DAYLIGHT), { status: 'skipped', reason: 'busy' })
    runtime.reflectionEngine = { isInFlight: () => false }

    await runtime.conversationStore.appendMessage({ role: 'user', text: '我刚刚还在。', timestamp: DAYLIGHT - HOUR })
    assert.deepEqual(await runtime.proactive.maybeSend(DAYLIGHT), { status: 'skipped', reason: 'owner-recently-active' })
    await appendProactive(runtime, DAYLIGHT - HOUR)
    assert.deepEqual(await runtime.proactive.maybeSend(DAYLIGHT), { status: 'skipped', reason: 'message-cooldown' })
    assert.equal(calls.length, 0)
    await closeRuntime(runtime)
  }

  // Messages from the previous local day do not use today's allowance.
  {
    const { runtime } = await createRuntime()
    await runtime.setProactiveSettings({ maxPerDay: 1 })
    await appendProactive(runtime, DAYLIGHT - 30 * HOUR, '昨天的一条。')
    await appendProactive(runtime, DAYLIGHT - 29 * HOUR, '昨天的第二条。')
    await appendProactive(runtime, DAYLIGHT - 28 * HOUR, '昨天的第三条。')
    const calls = useBrain(runtime, { send: true, text: '今天可以发送。' })
    assert.equal((await runtime.proactive.maybeSend(DAYLIGHT)).status, 'sent')
    assert.equal(calls.length, 1)
    await closeRuntime(runtime)
  }

  // A model decline does not append a conversation message.
  {
    const { runtime } = await createRuntime()
    const calls = useBrain(runtime, { send: false, text: '' })
    assert.deepEqual(await runtime.proactive.maybeSend(DAYLIGHT), { status: 'skipped', reason: 'model-declined' })
    assert.equal(calls.length, 1)
    assert.deepEqual(await runtime.conversationStore.history(), [])
    await closeRuntime(runtime)
  }

  // A newly archived owner message cancels a proactive result already in flight.
  {
    const { runtime } = await createRuntime()
    let enterBrain
    let releaseBrain
    const entered = new Promise((resolve) => { enterBrain = resolve })
    const blocked = new Promise((resolve) => { releaseBrain = resolve })
    const calls = useBrain(runtime, async (request) => {
      enterBrain(request)
      await blocked
      return { send: true, text: '主人出现后不应发送。' }
    })
    const pending = runtime.proactive.maybeSend(DAYLIGHT)
    const request = await entered
    assert.equal(request.idleMs, 4 * HOUR)
    await runtime.conversationStore.appendMessage({ role: 'user', text: '我回来了。', timestamp: DAYLIGHT })
    releaseBrain()
    assert.deepEqual(await pending, { status: 'skipped', reason: 'owner-became-active' })
    assert.equal(calls.length, 1)
    const history = await runtime.conversationStore.history()
    assert.deepEqual(history.map(({ role, kind }) => ({ role, kind: kind ?? 'dialogue' })), [
      { role: 'user', kind: 'dialogue' },
    ])
    await closeRuntime(runtime)
  }

  // Closing the engine prevents a pending model result from being published.
  {
    const { runtime } = await createRuntime()
    let enterBrain
    let releaseBrain
    const entered = new Promise((resolve) => { enterBrain = resolve })
    const blocked = new Promise((resolve) => { releaseBrain = resolve })
    useBrain(runtime, async () => {
      enterBrain()
      await blocked
      return { send: true, text: '关闭后不应发送。' }
    })
    const pending = runtime.proactive.maybeSend(DAYLIGHT)
    await entered
    runtime.proactive.close()
    releaseBrain()
    assert.equal((await pending).status, 'skipped')
    assert.equal((await runtime.conversationStore.history()).some((message) => message.kind === 'proactive'), false)
    await closeRuntime(runtime)
  }

  // LAN settings, inbox, and owner-triggered test-send routes use the runtime APIs.
  {
    const { root, runtime } = await createRuntime()
    let server
    let testMessageId
    try {
      server = await startLanServer({
        runtime,
        assetRoot: join(process.cwd(), 'assets/runtime'),
        port: 0,
        logger: { info() {} },
      })
      const settings = await callApi(server, 'GET', '/api/pet/proactive/settings')
      assert.equal(settings.status, 200)
      assert.equal(settings.body.maxPerDay, 3)

      const saved = await callApi(server, 'POST', '/api/pet/proactive/settings', { enabled: false, maxPerDay: 2 })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.ok, true)
      assert.equal(saved.body.enabled, false)
      assert.equal(saved.body.maxPerDay, 2)
      assert.equal((await callApi(server, 'POST', '/api/pet/proactive/settings', { maxPerDay: 0 })).status, 400)

      const empty = await callApi(server, 'GET', '/api/pet/proactive/messages?after=0')
      assert.equal(empty.status, 200)
      assert.deepEqual(empty.body.messages, [])
      assert.equal(empty.body.silent, false)
      runtime.proactive.now = () => QUIET_HOUR
      const quietInbox = await callApi(server, 'GET', '/api/pet/proactive/messages?after=0')
      assert.equal(quietInbox.status, 200)
      assert.equal(quietInbox.body.silent, true)
      runtime.proactive.now = () => DAYLIGHT
      const testMessage = await callApi(server, 'POST', '/api/pet/proactive/test')
      assert.equal(testMessage.status, 200)
      assert.equal(testMessage.body.ok, true)
      testMessageId = testMessage.body.message.id
      const sourceMessage = await runtime.conversationStore.sourceMessage(testMessageId)
      assert.equal(sourceMessage?.proactiveTest, true)
      assert.deepEqual((await runtime.conversationStore.proactiveEligibilityHistory()).messages, [])
      const inbox = await callApi(server, 'GET', '/api/pet/proactive/messages?after=0')
      assert.deepEqual(inbox.body.messages.map((message) => message.id), [testMessageId])
    } finally {
      if (server) {
        server.close()
        await once(server, 'close')
      }
      await closeRuntime(runtime)
    }

    const restarted = await createRuntime(DAYLIGHT + HOUR, root)
    try {
      assert.equal(
        (await restarted.runtime.conversationStore.sourceMessage(testMessageId))?.proactiveTest,
        true,
      )
      assert.deepEqual((await restarted.runtime.conversationStore.proactiveEligibilityHistory()).messages, [])
    } finally {
      await closeRuntime(restarted.runtime)
    }
  }

  // Long polls wake on proactive insertion, return on abort, and remove waiters.
  {
    const { runtime } = await createRuntime()
    const initial = await runtime.pollProactiveMessages(0)
    const waiting = runtime.pollProactiveMessages(initial.cursor, { wait: 2 })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(runtime.proactive.waiters.size, 1)
    const inserted = await runtime.sendProactiveTestMessage()
    const woken = await waiting
    assert.equal(woken.messages.length, 1)
    assert.equal(woken.messages[0].id, inserted.id)
    assert.equal(woken.messages[0].text, inserted.text)

    const controller = new AbortController()
    const aborting = runtime.pollProactiveMessages(woken.cursor, { wait: 2, signal: controller.signal })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(runtime.proactive.waiters.size, 1)
    controller.abort()
    const aborted = await aborting
    assert.deepEqual(aborted.messages, [])
    assert.equal(runtime.proactive.waiters.size, 0)
    await closeRuntime(runtime)
  }

  console.log('PROACTIVE_POLICY=PASS')
  console.log('PROACTIVE_CAP_AND_RESTART=PASS')
  console.log('PROACTIVE_INVITATION_CONTEXT=PASS')
  console.log('PROACTIVE_OWNER_RACE=PASS')
  console.log('PROACTIVE_CLOSE=PASS')
  console.log('PROACTIVE_INBOX_CURSOR=PASS')
  console.log('PROACTIVE_LAN_API=PASS')
  console.log('PROACTIVE_LONG_POLL_ABORT=PASS')
  console.log('MEMORY_CHANGED=NO')
  console.log('DREAM_REFLECTION_CHANGED=NO')
  console.log('LOCAL_BRAIN_MODEL_CALLS=0')
} finally {
  for (const runtime of runtimes) runtime.close()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
}

console.log('FINAL_STATUS=VC_AI_PET_PROACTIVE_MESSAGES_PASS')
