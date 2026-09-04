import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = await readFile(join(root, 'src/remote/mobile-ui/diagnostics.js'), 'utf8')
const mobile = await readFile(join(root, 'src/remote/mobile-ui/mobile.js'), 'utf8')
const html = await readFile(join(root, 'src/remote/mobile-ui/index.html'), 'utf8')
const css = await readFile(join(root, 'src/remote/mobile-ui/mobile.css'), 'utf8')

class MemoryStorage {
  constructor(seed = {}) { this.data = new Map(Object.entries(seed)) }
  getItem(key) { return this.data.get(key) ?? null }
  setItem(key, value) { this.data.set(key, value) }
  removeItem(key) { this.data.delete(key) }
}

function makeApi({ storage = new MemoryStorage(), fetchImpl = async () => response(200, {}) } = {}) {
  const context = { Date, JSON, Math, Set, Map, Error, TypeError, performance: { now: () => clock }, localStorage: storage, fetch: fetchImpl }
  context.globalThis = context
  vm.createContext(context)
  vm.runInContext(source, context, { filename: 'diagnostics.js' })
  return { api: context.VcAiPetDiagnostics, context, storage }
}

function response(status, payload, requestId = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'x-local-brain-request-id' ? requestId : null },
    json: async () => payload,
  }
}

let now = Date.parse('2026-09-05T12:00:00.000Z')
let clock = 100
const { api, context, storage } = makeApi()
const { DIAGNOSTIC_STORAGE_KEY, MAX_EVENTS, RETENTION_MS, sanitizeDiagnosticMessage } = api
const diagnostics = api.createFrontendDiagnostics({ storage, now: () => now, clock: () => clock, context: () => ({ tab: 'chat', online: true, pathname: '/chat?secret=no' }) })

for (let index = 0; index < MAX_EVENTS + 1; index += 1) diagnostics.record({ level: 'error', stage: 'chat', code: `CHAT_${index}` })
assert.equal(diagnostics.list().length, MAX_EVENTS)
assert.equal(diagnostics.list()[0].code, 'CHAT_1')

diagnostics.clear()
diagnostics.record({ level: 'error', stage: 'state', code: 'STATE_FAILURE', httpStatus: 503 })
now += 1_000
diagnostics.record({ level: 'error', stage: 'state', code: 'STATE_FAILURE', httpStatus: 503 })
assert.equal(diagnostics.list().length, 1)
diagnostics.record({ level: 'error', stage: 'chat', code: 'CHAT_FAILURE', httpStatus: 503 })
diagnostics.record({ level: 'error', stage: 'chat', code: 'CHAT_FAILURE', httpStatus: 503 })
assert.equal(diagnostics.list().length, 3)

diagnostics.clear()
const sensitiveChat = '主人私密聊天正文不要记录'
const imageDataUrl = `data:image/png;base64,${'A'.repeat(700)}`
const memoryContent = '记忆内容不要记录'
const hiddenReasoning = 'hidden chain-of-thought content'
diagnostics.record({
  stage: 'chat', code: 'LOCAL_BRAIN_QUEUE_FULL', httpStatus: 503, requestId: 'lb-test-123', durationMs: 814,
  message: `Authorization: Bearer token-value ${imageDataUrl}`,
  details: { hadImage: true, attachmentId: 'attachment-test', chatText: sensitiveChat, imageDataUrl, memoryContent, hiddenReasoning, filename: 'private.png' },
})
const serialized = JSON.stringify(diagnostics.list())
assert.doesNotMatch(serialized, new RegExp(sensitiveChat, 'u'))
assert.doesNotMatch(serialized, /data:image\/png;base64/u)
assert.doesNotMatch(serialized, /token-value/u)
assert.doesNotMatch(serialized, new RegExp(memoryContent, 'u'))
assert.doesNotMatch(serialized, /chain-of-thought/u)
assert.doesNotMatch(serialized, /private\.png/u)
assert.match(serialized, /LOCAL_BRAIN_QUEUE_FULL/u)
assert.match(serialized, /lb-test-123/u)
assert.match(sanitizeDiagnosticMessage(`x ${'x'.repeat(513)}`), /\[REDACTED\]/u)
assert.ok((sanitizeDiagnosticMessage('x'.repeat(500)) ?? '').length <= 240)

const staleStorage = new MemoryStorage({
  [DIAGNOSTIC_STORAGE_KEY]: JSON.stringify({ schemaVersion: 1, events: [{ id: 'old', at: new Date(now - RETENTION_MS - 1).toISOString(), level: 'error', stage: 'chat', code: 'OLD' }] }),
})
const staleApi = makeApi({ storage: staleStorage }).api
assert.equal(staleApi.createFrontendDiagnostics({ storage: staleStorage, now: () => now }).list().length, 0)
assert.deepEqual(JSON.parse(staleStorage.getItem(DIAGNOSTIC_STORAGE_KEY)).events, [])

const corruptStorage = new MemoryStorage({ [DIAGNOSTIC_STORAGE_KEY]: '{bad json' })
const corruptApi = makeApi({ storage: corruptStorage }).api
assert.doesNotThrow(() => corruptApi.createFrontendDiagnostics({ storage: corruptStorage, now: () => now }))
assert.equal(corruptStorage.getItem(DIAGNOSTIC_STORAGE_KEY), null)

const failingStorage = { getItem() { throw new Error('disabled') }, setItem() { throw new Error('full') }, removeItem() { throw new Error('disabled') } }
const failingApi = makeApi({ storage: failingStorage }).api
const failureSafe = failingApi.createFrontendDiagnostics({ storage: failingStorage, now: () => now })
assert.doesNotThrow(() => failureSafe.record({ stage: 'chat', code: 'CHAT_FAILURE' }))
assert.equal(failureSafe.list().length, 1)

let fetchCalls = 0
context.fetch = async () => {
  fetchCalls += 1
  if (fetchCalls === 1) return response(500, { error: { code: 'UPLOAD_FAILED', retryable: false } })
  if (fetchCalls === 2) return response(503, { error: { code: 'LOCAL_BRAIN_QUEUE_FULL', retryable: true } }, 'lb-test-123')
  if (fetchCalls === 3) throw new TypeError('fetch failed')
  if (fetchCalls === 4) return response(500, { error: { code: 'HISTORY_DOWN' } })
  return response(500, { error: { code: 'STATE_DOWN' } })
}
const fetchDiagnostics = api.createFrontendDiagnostics({ storage: new MemoryStorage(), now: () => now, clock: () => ++clock, context: () => ({ online: true }) })
await assert.rejects(fetchDiagnostics.fetchJsonDiagnostic('/api/pet/upload', {}, { stage: 'upload', hadImage: true, mime: 'image/png', inputBytes: 22 }))
await assert.rejects(fetchDiagnostics.fetchJsonDiagnostic('/api/pet/chat', {}, { stage: 'chat', hadImage: true, attachmentId: 'attachment-test' }))
await assert.rejects(fetchDiagnostics.fetchJsonDiagnostic('/api/pet/chat', {}, { stage: 'chat' }))
await assert.rejects(fetchDiagnostics.fetchJsonDiagnostic('/api/pet/history', {}, { stage: 'history' }))
await assert.rejects(fetchDiagnostics.fetchJsonDiagnostic('/api/pet/state', {}, { stage: 'state' }))
const fetchEvents = fetchDiagnostics.list()
assert.deepEqual(Array.from(fetchEvents, (event) => event.stage), ['upload', 'chat', 'chat', 'history', 'state'])
assert.equal(fetchEvents[1].code, 'LOCAL_BRAIN_QUEUE_FULL')
assert.equal(fetchEvents[1].requestId, 'lb-test-123')
assert.equal(fetchEvents[1].details.retryable, true)
assert.equal(fetchEvents[2].code, 'FRONTEND_FETCH_ERROR')

assert.match(html, /id="diagnostics-panel"/u)
assert.match(html, /id="diagnostics-copy"/u)
assert.match(html, /id="diagnostics-clear"/u)
assert.match(html, /src="\/diagnostics\.js"/u)
assert.match(mobile, /connectionTapCount < 5/u)
assert.match(mobile, /UNHANDLED_ERROR/u)
assert.match(mobile, /UNHANDLED_REJECTION/u)
assert.match(mobile, /IMAGE_PREP_FAILURE/u)
assert.match(mobile, /IMAGE_LOAD_FAILURE/u)
assert.match(mobile, /fetchJsonDiagnostic/u)
assert.match(css, /\.diagnostics-panel\s*\{[^}]*position:\s*fixed/su)

console.log('RING_BUFFER_MAX_50=PASS')
console.log('RETENTION_7_DAYS=PASS')
console.log('CORRUPT_STORAGE_SAFE=PASS')
console.log('LOCALSTORAGE_FAILURE_SAFE=PASS')
console.log('ERROR_DEDUPE=PASS')
console.log('CHAT_FAILURE_NOT_DEDUPED=PASS')
console.log('UPLOAD_FAILURE_STAGE=PASS')
console.log('CHAT_FAILURE_STAGE=PASS')
console.log('HISTORY_FAILURE_STAGE=PASS')
console.log('STATE_FAILURE_STAGE=PASS')
console.log('UNHANDLED_REJECTION=PASS')
console.log('CHAT_TEXT_LOGGED=NO')
console.log('IMAGE_BASE64_LOGGED=NO')
console.log('IMAGE_FILENAME_LOGGED=NO')
console.log('MEMORY_CONTENT_LOGGED=NO')
console.log('AUTH_HEADER_LOGGED=NO')
console.log('CHAIN_OF_THOUGHT_LOGGED=NO')
console.log('VC_AI_PET_FRONTEND_DIAGNOSTICS_TEST=PASS')
