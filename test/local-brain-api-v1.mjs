import assert from 'node:assert/strict'
import { LocalBrainClient, LocalBrainApiError } from '../src/brain/local-brain-client.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'

function headers(values = {}) {
  const lower = new Map(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]))
  return { get: (name) => lower.get(String(name).toLowerCase()) ?? null }
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(extraHeaders),
    json: async () => payload,
  }
}

{
  const calls = []
  const client = new LocalBrainClient({
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init })
      return jsonResponse(
        200,
        {
        choices: [{ message: { role: 'assistant', content: '{"reply":"汪！","memory":null}' } }],
        },
        { 'X-Local-Brain-Request-ID': 'lb-test' },
      )
    },
  })

  const result = await client.chat({
    messages: [{ role: 'user', content: 'hi' }],
    reasoningEffort: 'off',
    maxTokens: 256,
  })

  assert.equal(result.requestId, 'lb-test')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /127\.0\.0\.1:17862\/v1\/chat\/completions$/)

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.reasoning_effort, 'off')
  assert.equal(body.stream, false)
  assert.equal(body.max_tokens, 256)
  assert.equal(Object.hasOwn(body, 'model'), false)
  assert.equal(Object.hasOwn(body, 'chat_template_kwargs'), false)
  assert.equal(Object.hasOwn(body, 'n_ctx'), false)
}

{
  const client = new LocalBrainClient({
    fetchImpl: async () => jsonResponse(
      503,
      {
        error: {
          message: 'Local Brain backend unavailable',
          type: 'upstream_error',
          code: 'LOCAL_BRAIN_UPSTREAM_ERROR',
          retryable: true,
        },
      },
      { 'X-Local-Brain-Request-ID': 'lb-error' },
    ),
  })

  await assert.rejects(
    () => client.chat({ messages: [{ role: 'user', content: 'hi' }] }),
    (error) => {
      assert.ok(error instanceof LocalBrainApiError)
      assert.equal(error.code, 'LOCAL_BRAIN_UPSTREAM_ERROR')
      assert.equal(error.retryable, true)
      assert.equal(error.requestId, 'lb-error')
      return true
    },
  )
}

{
  const client = new LocalBrainClient({
    fetchImpl: async () => jsonResponse(200, { status: 'ok' }),
  })
  assert.equal(await client.health(), true)
}

{
  const fakeClient = {
    health: async () => true,
    chat: async ({ messages, reasoningEffort }) => {
      assert.equal(reasoningEffort, 'off')
      assert.equal(Array.isArray(messages), true)
      return {
        requestId: 'lb-pet',
        payload: {
          choices: [{
            message: {
              role: 'assistant',
              content: JSON.stringify({
                reply: '我是李花花呀。',
                memory: null,
              }),
            },
          }],
        },
      }
    },
  }

  const memory = {
    recall: () => [],
    stableIdentityContext: () => [],
  }

  const brain = new LocalBrain({
    config: { resourceGate: { enabled: false } },
    memory,
    sandbox: null,
    client: fakeClient,
  })

  const result = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: { mood: .8, energy: .8, boredom: .1, sleepiness: .1, attachment: .8 },
    userText: '花花，你叫什么名字？',
  })

  assert.equal(result.ok, true)
  assert.match(result.text, /李花花/)
}

console.log('VC_AI_PET_LOCAL_BRAIN_API_V1_TEST=PASS')
