import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { startLanServer } from '../src/remote/lan-server.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-reasoning-runtime-'))
const runtime = new PetRuntime({ sandboxRoot: root })
const modelCalls = []
const modelEfforts = []
let server

function chatResponse(reply, visualRecall = undefined) {
  return JSON.stringify({
    reply,
    memory: { remember: false, level: 'fact', content: '', importance: 1, keywords: [], confidence: 0, evidence: '' },
    beliefs: [],
    ...(visualRecall === undefined ? {} : { visualRecall }),
  })
}

async function call(method, pathname, body = undefined) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

async function completedTurn(message) {
  const started = await call('POST', '/api/pet/chat/start', { message })
  assert.equal(started.status, 202)
  let poll
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const result = await call('GET', `/api/pet/chat/turn/${started.body.turnId}?after=0`)
    assert.equal(result.status, 200)
    poll = result.body
    if (poll.status !== 'running') break
  }
  assert.ok(poll && poll.status !== 'running', 'chat turn should settle')
  return { turnId: started.body.turnId, poll }
}

try {
  await runtime.initialize()
  runtime.brain.client.fetchImpl = async (_url, init) => {
    const next = modelCalls.shift()
    assert.ok(next, 'unexpected Local Brain request')
    const request = JSON.parse(init.body)
    assert.equal(Object.hasOwn(request, 'reasoningStage'), false, 'debug stage must stay out of model request body')
    modelEfforts.push(request.reasoning_effort)
    const response = {
      choices: [{
        message: { role: 'assistant', content: next.content, reasoning_content: next.reasoning },
        finish_reason: 'stop',
      }],
    }
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-local-brain-request-id': next.requestId,
      },
    })
  }
  server = await startLanServer({ runtime, assetRoot: new URL('../assets/runtime/', import.meta.url).pathname, port: 0, logger: { info() {} } })

  const settingsOff = await call('GET', '/api/pet/developer/settings')
  assert.equal(settingsOff.status, 200)
  assert.deepEqual(settingsOff.body, { reasoningDebugEnabled: false })
  assert.equal((await call('GET', '/api/pet/developer/reasoning/turn-off')).status, 403)

  modelCalls.push({
    content: chatResponse('关闭状态回复'),
    reasoning: 'OFF_ONLY_REASONING',
    requestId: 'off-request',
  })
  const off = await completedTurn('普通聊天测试')
  assert.equal(off.poll.status, 'done')
  assert.equal((await call('GET', `/api/pet/developer/reasoning/${off.turnId}`)).status, 403)

  assert.equal((await call('POST', '/api/pet/developer/settings', { reasoningDebugEnabled: 'true' })).status, 400)
  const enabled = await call('POST', '/api/pet/developer/settings', { reasoningDebugEnabled: true })
  assert.equal(enabled.status, 200)
  assert.deepEqual(enabled.body, { ok: true, reasoningDebugEnabled: true })
  assert.deepEqual(await call('GET', '/api/pet/developer/reasoning/not-recorded-yet'), {
    status: 200,
    body: { status: 'unavailable', calls: [] },
  })

  modelCalls.push({
    content: chatResponse('正常回复'),
    reasoning: 'ENABLED_REPLY_REASONING',
    requestId: 'reply-request',
  })
  const replyTurn = await completedTurn('今天过得怎么样？')
  assert.equal(replyTurn.poll.status, 'done')
  const replyTrace = await call('GET', `/api/pet/developer/reasoning/${replyTurn.turnId}`)
  assert.equal(replyTrace.status, 200)
  assert.equal(replyTrace.body.calls.length, 1)
  assert.equal(replyTrace.body.calls[0].index, 1)
  assert.equal(replyTrace.body.calls[0].text, 'ENABLED_REPLY_REASONING')
  assert.equal(replyTrace.body.calls[0].stage, 'reply')
  assert.equal(replyTrace.body.calls[0].effort, modelEfforts.at(-1))
  assert.equal(typeof replyTrace.body.calls[0].durationMs, 'number')
  assert.equal(replyTrace.body.calls[0].requestId, 'reply-request')
  assert.equal(replyTrace.body.calls[0].finishReason, 'stop')
  assert.equal(JSON.stringify(replyTurn.poll).includes('ENABLED_REPLY_REASONING'), false)
  const history = await call('GET', '/api/pet/history')
  assert.equal(history.status, 200)
  assert.equal(JSON.stringify(history.body).includes('ENABLED_REPLY_REASONING'), false)

  modelCalls.push({
    content: '{not valid JSON',
    reasoning: 'CAPTURE_BEFORE_RESPONSE_PARSE',
    requestId: 'malformed-request',
  })
  const malformedTurn = await completedTurn('这是一次格式异常测试')
  const malformedTrace = await call('GET', `/api/pet/developer/reasoning/${malformedTurn.turnId}`)
  assert.equal(malformedTrace.status, 200)
  assert.equal(malformedTrace.body.calls[0].text, 'CAPTURE_BEFORE_RESPONSE_PARSE', 'reasoning is captured before LocalBrain parses message.content')
  assert.equal(JSON.stringify(malformedTurn.poll).includes('CAPTURE_BEFORE_RESPONSE_PARSE'), false)

  const attachment = await runtime.conversationStore.saveAttachment({
    image: { dataUrl: 'data:image/png;base64,QUFB' },
    thumbnail: { dataUrl: 'data:image/png;base64,QUFB' },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
  })
  await runtime.conversationStore.appendMessage({ role: 'user', text: '周末散步时拍的一张照片', attachment })
  runtime.visualSemanticIndex = {
    active: true,
    async sync() {},
    stop() {},
    async search() {
      return { candidates: [{ attachmentId: attachment.id, userText: '周末散步时拍的一张照片' }] }
    },
  }
  runtime.turnOrchestrator.semanticIndex = runtime.visualSemanticIndex

  modelCalls.push(
    {
      content: chatResponse('我去图库里找找～', {
        tool: 'search_visual_memory',
        query: '黑莓的照片',
        goal: 'find_photo',
      }),
      reasoning: 'VISUAL_PLAN_REASONING',
      requestId: 'visual-reply-request',
    },
    {
      content: JSON.stringify({
        observation: '照片中有一只黑白猫。',
        action: 'answer',
        nextVisualId: '',
        focus: '猫的毛色',
        replyMessages: ['黑莓是一只黑白猫。'],
        match: 'match',
      }),
      reasoning: 'VISUAL_STEP_REASONING',
      requestId: 'visual-step-request',
    },
  )
  const visualStart = await call('POST', '/api/pet/chat/start', { message: '你还记得黑莓吗？' })
  assert.equal(visualStart.status, 202)
  let visualPoll
  for (let i = 0; i < 500; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const result = await call('GET', `/api/pet/chat/turn/${visualStart.body.turnId}?after=0`)
    assert.equal(result.status, 200)
    visualPoll = result.body
    if (visualPoll.status !== 'running') break
  }
  assert.equal(visualPoll.status, 'done', JSON.stringify(visualPoll))
  const trace = await call('GET', `/api/pet/developer/reasoning/${visualStart.body.turnId}`)
  assert.equal(trace.status, 200)
  assert.deepEqual(trace.body.calls.map(({ index, stage, text, requestId }) => ({ index, stage, text, requestId })), [
    { index: 1, stage: 'reply', text: 'VISUAL_PLAN_REASONING', requestId: 'visual-reply-request' },
    { index: 2, stage: 'visual-step', text: 'VISUAL_STEP_REASONING', requestId: 'visual-step-request' },
  ])
  const ordinaryTurnData = JSON.stringify({ poll: visualPoll, history: await call('GET', '/api/pet/history') })
  assert.equal(ordinaryTurnData.includes('VISUAL_PLAN_REASONING'), false)
  assert.equal(ordinaryTurnData.includes('VISUAL_STEP_REASONING'), false)

  const disabled = await call('POST', '/api/pet/developer/settings', { reasoningDebugEnabled: false })
  assert.deepEqual(disabled.body, { ok: true, reasoningDebugEnabled: false })
  assert.equal((await call('GET', `/api/pet/developer/reasoning/${visualStart.body.turnId}`)).status, 403)
  assert.equal(modelCalls.length, 0)
  console.log('REASONING_DEBUG_RUNTIME=PASS')
} finally {
  server?.close()
  runtime.close()
  await rm(root, { recursive: true, force: true })
}
