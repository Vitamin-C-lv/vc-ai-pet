import { createSocket } from 'node:dgram'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mapPetStateToBodyContract } from './contract.mjs'
import { isAllowedLanAddress } from './lan-guard.mjs'
import { hasValidBodyKey, loadBodyKey } from './body-auth.mjs'
import { TurnSpeechAggregator } from './turn-speech-aggregator.mjs'
import { evaluateWakeRecognition, stripWakePhrase } from './wake-phrase.mjs'
import { WakeSession } from './wake-session.mjs'

const run = promisify(execFile)
const root = dirname(fileURLToPath(import.meta.url))
const powershell = process.platform === 'linux'
  ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function boundedThreshold(name, fallback) {
  const value = process.env[name] === undefined || process.env[name] === '' ? fallback : Number(process.env[name])
  if (!Number.isFinite(value) || value < 0 || value > 1) throw Error(`${name} must be between 0 and 1`)
  return value
}

// These are calibration defaults, not owner-calibrated final thresholds. The
// strict ordering is intentional: plain “花花” requires a stronger combined
// score than “花花在吗”. Real-device samples will replace the defaults later.
const HUAHUA_STAGE1_MIN_SCORE = boundedThreshold('HUAHUA_STAGE1_MIN_SCORE', 0.80)
const HUAHUA_STAGE2_MIN_CONFIDENCE = boundedThreshold('HUAHUA_STAGE2_MIN_CONFIDENCE', 0.80)
const HUAHUA_ZAIMA_STAGE1_MIN_SCORE = boundedThreshold('HUAHUA_ZAIMA_STAGE1_MIN_SCORE', 0.60)
const HUAHUA_ZAIMA_STAGE2_MIN_CONFIDENCE = boundedThreshold('HUAHUA_ZAIMA_STAGE2_MIN_CONFIDENCE', 0.60)
if (!(HUAHUA_STAGE1_MIN_SCORE > HUAHUA_ZAIMA_STAGE1_MIN_SCORE &&
      HUAHUA_STAGE2_MIN_CONFIDENCE > HUAHUA_ZAIMA_STAGE2_MIN_CONFIDENCE)) {
  throw Error('HUAHUA_POLICY_MUST_BE_STRICTER_THAN_HUAHUA_ZAIMA')
}
const wakePolicy = Object.freeze({
  huahua: Object.freeze({
    stage1MinScore: HUAHUA_STAGE1_MIN_SCORE,
    stage2MinConfidence: HUAHUA_STAGE2_MIN_CONFIDENCE,
    policy: 'STRICT',
  }),
  huahua_zaima: Object.freeze({
    stage1MinScore: HUAHUA_ZAIMA_STAGE1_MIN_SCORE,
    stage2MinConfidence: HUAHUA_ZAIMA_STAGE2_MIN_CONFIDENCE,
    policy: 'NORMAL',
  }),
})
const data = process.env.STACKCHAN_DATA_DIR
if (!data) throw Error('STACKCHAN_DATA_DIR required')
await mkdir(data, { recursive: true })
const upstream = process.env.VC_AI_PET_UPSTREAM || 'http://127.0.0.1:17870'
const bodyKey = await loadBodyKey(process.env.STACKCHAN_BODY_KEY_FILE)
const status = {
  deviceSeenAt: null,
  stateRequests: 0,
  lastAck: null,
  camera: null,
  microphone: null,
  speech: null,
  wake: null,
  authConfigured: Boolean(bodyKey),
}
let capture = false
let record = false
let audioQueue = []
let inFlightAudio = null
let speechQueue = []
let speechWorkerRunning = false
let speaking = false
let wakeSpeakingState = false
const wakeSession = new WakeSession({
  onStateChange: ({ state }) => {
    status.wake = { ...(status.wake ?? {}), session: state }
  },
})

const json = (res, code, value) => {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}
async function body(req, limit = 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const chunk of req) {
    n += chunk.length
    if (n > limit) throw Error('body-too-large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function refreshSpeaking() {
  const next = speechWorkerRunning || speechQueue.length > 0 || audioQueue.length > 0 || Boolean(inFlightAudio)
  speaking = next
  if (next !== wakeSpeakingState) {
    wakeSpeakingState = next
    wakeSession.markSpeaking(next)
  }
}

async function renderSpeech(text) {
  const textPath = join(data, 'speech.txt')
  const pcmPath = join(data, 'speech.pcm')
  await writeFile(textPath, text, 'utf8')
  await run(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, '../speak-local.ps1'),
    '-TextFile', textPath, '-OutputFile', pcmPath,
  ], { windowsHide: true, timeout: 90000 })
  return readFile(pcmPath)
}

async function runSpeechWorker() {
  if (speechWorkerRunning) return
  speechWorkerRunning = true
  refreshSpeaking()
  while (speechQueue.length > 0) {
    const item = speechQueue.shift()
    try {
      const pcm = await renderSpeech(item.text)
      audioQueue.push({ id: item.id, pcm })
      status.speech = {
        queuedAt: new Date().toISOString(),
        bytes: pcm.length,
        queueDepth: audioQueue.length,
        turnId: item.turnId ?? null,
      }
    } catch (error) {
      status.speech = {
        ...(status.speech ?? {}),
        failedAt: new Date().toISOString(),
        error: String(error?.message ?? error),
        queueDepth: audioQueue.length,
      }
      console.error('SPEECH_ERROR', String(error?.message ?? error))
    }
    refreshSpeaking()
  }
  speechWorkerRunning = false
  refreshSpeaking()
}

function enqueueSpeech(text, { turnId = null } = {}) {
  const value = typeof text === 'string' ? text.trim() : ''
  if (!value || value.length > 2000) return false
  speechQueue.push({ id: `${Date.now().toString(36)}-${speechQueue.length}`, text: value, turnId })
  refreshSpeaking()
  void runSpeechWorker()
  return true
}

async function askHuahuaAboutCamera(attachmentId) {
  const submissionId = `stackchan-camera-${Date.now().toString(36)}`
  const started = await fetch(upstream + '/api/pet/chat/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      submissionId,
      source: 'stackchan-bridge',
      attachmentId,
      message: '花花通过实体身体的摄像头主动看了看现实环境。请直接告诉主人你看到了什么。',
    }),
    signal: AbortSignal.timeout(10000),
  })
  const startResult = await started.json()
  if (!started.ok || !startResult.turnId) throw Error(startResult.error || 'vision-turn-start-failed')

  const replies = []
  let after = 0
  for (let attempt = 0; attempt < 160; attempt++) {
    const response = await fetch(`${upstream}/api/pet/chat/turn/${startResult.turnId}?after=${after}`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw Error('vision-turn-poll-failed')
    const turn = await response.json()
    after = turn.lastSeq ?? after
    for (const event of turn.events ?? []) {
      if (event.type === 'assistant_message' && typeof event.payload?.text === 'string') replies.push(event.payload.text)
    }
    if (turn.status === 'done') {
      const reply = replies.join('\n').trim()
      if (reply) enqueueSpeech(reply, { turnId: startResult.turnId })
      return { turnId: startResult.turnId, status: 'done', reply, spoken: Boolean(reply) }
    }
    if (turn.status === 'error') throw Error(turn.error?.code || 'vision-turn-failed')
    await wait(750)
  }
  throw Error('vision-turn-timeout')
}

async function toWindowsPath(pathname) {
  const result = await run('wslpath', ['-w', pathname], { timeout: 5000 })
  const converted = result.stdout.trim()
  if (!converted) throw Error(`windows-path-conversion-failed:${pathname}`)
  return converted
}

async function askHuahuaByVoice(message) {
  const submissionId = `stackchan-voice-${Date.now().toString(36)}`
  const started = await fetch(upstream + '/api/pet/chat/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ submissionId, source: 'stackchan-bridge', message }),
    signal: AbortSignal.timeout(10000),
  })
  const startResult = await started.json()
  if (!started.ok || !startResult.turnId) throw Error(startResult.error || 'voice-turn-start-failed')
  const replies = []
  let after = 0
  for (let attempt = 0; attempt < 160; attempt++) {
    const response = await fetch(`${upstream}/api/pet/chat/turn/${startResult.turnId}?after=${after}`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw Error('voice-turn-poll-failed')
    const turn = await response.json()
    after = turn.lastSeq ?? after
    for (const event of turn.events ?? []) {
      if (event.type === 'assistant_message' && typeof event.payload?.text === 'string') replies.push(event.payload.text)
    }
    if (turn.status === 'done') {
      const reply = replies.join('\n').trim()
      if (reply) enqueueSpeech(reply, { turnId: startResult.turnId })
      return { turnId: startResult.turnId, status: 'done', reply, spoken: Boolean(reply) }
    }
    if (turn.status === 'error') throw Error(turn.error?.code || 'voice-turn-failed')
    await wait(750)
  }
  throw Error('voice-turn-timeout')
}

function speechPythonPath() {
  if (process.env.STACKCHAN_SPEECH_PYTHON) return process.env.STACKCHAN_SPEECH_PYTHON
  return process.platform === 'win32'
    ? join(data, 'speech-venv', 'Scripts', 'python.exe')
    : join(data, 'speech-venv', 'bin', 'python')
}

async function transcribeLocal(pcmPath, sampleRate, { wakeMode = false } = {}) {
  const speechPython = speechPythonPath()
  const speechModel = process.env.STACKCHAN_SPEECH_MODEL || join(data, 'vosk-model-small-cn-0.22')
  const args = [join(root, '../transcribe-local.py'), '--model', speechModel, '--pcm', pcmPath, '--sample-rate', String(sampleRate)]
  if (wakeMode) args.push('--wake-mode')
  const result = await run(speechPython, args, {
    windowsHide: true,
    timeout: 90000,
    env: { ...process.env, PYTHONUTF8: '1' },
  })
  if (!wakeMode) return result.stdout.trim()
  return JSON.parse(result.stdout.trim() || '{}')
}

async function processMicrophone(pcmPath) {
  const transcript = await transcribeLocal(pcmPath, 24000)
  status.microphone ??= {}
  status.microphone.transcript = transcript
  if (!transcript) {
    status.microphone.voice = { status: 'no-speech' }
    return
  }
  status.microphone.voice = await askHuahuaByVoice(transcript)
}

async function processWake(pcmPath, candidate, sampleRate, stage1Score) {
  status.wake ??= {}
  try {
    status.wake.session = wakeSession.state
    status.wake.candidate = candidate
    status.wake.stage1Score = stage1Score
    status.wake.status = 'transcribing'
    const recognition = await transcribeLocal(pcmPath, sampleRate, { wakeMode: true })
    const fullText = typeof recognition?.text === 'string' ? recognition.text : ''
    const fullConfidence = Number(recognition?.confidence ?? 0)
    const wakeText = typeof recognition?.wakeText === 'string' ? recognition.wakeText : ''
    const wakeConfidence = Number(recognition?.wakeConfidence ?? 0)
    status.wake.transcript = fullText
    status.wake.fullTranscript = fullText
    status.wake.wakeText = wakeText
    status.wake.wakeConfidence = Number.isFinite(wakeConfidence) ? wakeConfidence : 0
    status.wake.vosk = {
      words: Array.isArray(recognition?.words) ? recognition.words : [],
      confidence: Number.isFinite(fullConfidence) ? fullConfidence : 0,
    }
    status.wake.wakeVerifier = {
      words: Array.isArray(recognition?.wakeWords) ? recognition.wakeWords : [],
      confidence: Number.isFinite(wakeConfidence) ? wakeConfidence : 0,
      grammarSupported: recognition?.grammarSupported !== false,
    }
    if (recognition?.grammarSupported === false) {
      console.warn('WAKE_GRAMMAR_SUPPORTED=NO MISSING_WORD=' + String(recognition?.missingWord ?? '花花'))
    } else {
      status.wake.wakeVerifier.grammar = 'PASS'
    }

    if (wakeSession.state === 'LISTENING') {
      const accepted = wakeSession.acceptFollowUp(stripWakePhrase(fullText, candidate))
      if (!accepted.accepted) {
        status.wake.status = accepted.reason
        return
      }
      status.wake.status = accepted.kind
      status.wake.query = accepted.query
      status.wake.finalDecision = accepted.kind
      status.wake.voice = await askHuahuaByVoice(accepted.query)
      return
    }

    const policyCandidate = evaluateWakeRecognition({
      wakeText,
      wakeConfidence,
      fullText,
      candidate,
      stage1Score,
      stage1MinScore: 0,
      stage2MinConfidence: 0,
    })
    status.wake.wakeKind = policyCandidate.wakeKind
    const policy = policyCandidate.wakeKind ? wakePolicy[policyCandidate.wakeKind] : null
    if (policy) {
      status.wake.policy = {
        name: policy.policy,
        stage1MinScore: policy.stage1MinScore,
        stage2MinConfidence: policy.stage2MinConfidence,
        calibration: 'PROVISIONAL_UNCALIBRATED',
      }
    }
    const decision = evaluateWakeRecognition({
      wakeText,
      wakeConfidence,
      fullText,
      candidate,
      stage1Score,
      stage1MinScore: policy?.stage1MinScore ?? 1,
      stage2MinConfidence: policy?.stage2MinConfidence ?? 1,
    })
    status.wake.wakeKind = decision.wakeKind
    if (!decision.accepted) {
      status.wake.status = decision.reason === 'wake-verifier-rejected'
        ? 'candidate-rejected'
        : decision.reason
      status.wake.finalDecision = status.wake.status
      return
    }
    if (!wakeSession.beginCandidate()) {
      status.wake.status = 'session-busy'
      status.wake.finalDecision = status.wake.status
      return
    }
    const accepted = wakeSession.acceptWake(decision.query)
    if (!accepted.accepted) {
      status.wake.status = accepted.reason
      status.wake.finalDecision = status.wake.status
      return
    }
    status.wake.status = accepted.kind
    status.wake.query = accepted.query
    status.wake.finalDecision = accepted.kind
    if (accepted.kind === 'query') status.wake.voice = await askHuahuaByVoice(accepted.query)
  } finally {
    await unlink(pcmPath).catch(() => {})
    status.wake.audioFile = 'deleted'
  }
}

const eventCursorPath = join(data, 'turn-events.cursor.json')
let eventCursor = 0
let eventCursorInitialized = false
const pendingTurnText = new Map()
const spokenTurnIds = new Set()
try {
  const saved = JSON.parse(await readFile(eventCursorPath, 'utf8'))
  if (Number.isInteger(saved?.cursor) && saved.cursor >= 0) eventCursor = saved.cursor
  for (const id of Array.isArray(saved?.spokenTurnIds) ? saved.spokenTurnIds.slice(-256) : []) {
    if (typeof id === 'string') spokenTurnIds.add(id)
  }
  eventCursorInitialized = true
} catch {
  // A fresh bridge starts at the current host cursor; old chat replies are not
  // replayed as new speech. The next poll then observes only new turns.
}
const turnSpeech = new TurnSpeechAggregator({ pending: pendingTurnText, spoken: spokenTurnIds })

async function persistEventCursor() {
  await writeFile(eventCursorPath, JSON.stringify({ cursor: eventCursor, spokenTurnIds: [...spokenTurnIds].slice(-256) }), 'utf8')
}

async function pollHostTurnEvents() {
  try {
    const response = await fetch(`${upstream}/api/pet/turn-events?after=${eventCursor}`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) throw Error(`event-feed-http-${response.status}`)
    const feed = await response.json()
    if (!eventCursorInitialized) {
      eventCursor = Number(feed.cursor ?? eventCursor)
      eventCursorInitialized = true
      await persistEventCursor()
      return
    }
    if (Number(feed.cursor ?? 0) < eventCursor) {
      eventCursor = Number(feed.cursor ?? 0)
      pendingTurnText.clear()
      await persistEventCursor()
      return
    }
    if (feed.gap === true) pendingTurnText.clear()
    for (const item of feed.events ?? []) {
      if (!Number.isInteger(item.cursor) || item.cursor <= eventCursor) continue
      eventCursor = item.cursor
      const reply = turnSpeech.ingest(item)
      if (reply) enqueueSpeech(reply, { turnId: item.turnId })
    }
    await persistEventCursor()
  } catch (error) {
    status.speech = { ...(status.speech ?? {}), eventFeed: 'offline', eventFeedError: String(error?.message ?? error) }
  }
}

const eventPoll = setInterval(() => { void pollHostTurnEvents() }, 800)
eventPoll.unref?.()

const server = createServer(async (req, res) => {
  try {
    if (!isAllowedLanAddress(req.socket.remoteAddress)) return json(res, 403, { error: 'lan-only' })
    const path = new URL(req.url, 'http://local').pathname
    if (req.method === 'GET' && path === '/healthz') {
      refreshSpeaking()
      wakeSession.tick()
      return json(res, 200, { ok: true, ...status, speaking, wakeSession: wakeSession.state, audioQueue: audioQueue.length, speechQueue: speechQueue.length })
    }
    if (path.startsWith('/v1/body/') && !hasValidBodyKey(req, bodyKey)) {
      return json(res, 401, { error: 'body-key-required' })
    }
    if (req.method === 'GET' && path === '/v1/body/state') {
      const response = await fetch(upstream + '/api/pet/state', { signal: AbortSignal.timeout(1500) })
      if (!response.ok) throw Error('upstream-state-unavailable')
      const state = await response.json()
      status.deviceSeenAt = new Date().toISOString()
      status.stateRequests++
      refreshSpeaking()
      return json(res, 200, mapPetStateToBodyContract(state, { reachable: true, observedAt: status.deviceSeenAt, stateAgeMs: 0, speaking }))
    }
    if (req.method === 'GET' && path === '/v1/body/commands') {
      const canPlay = !inFlightAudio && audioQueue.length > 0
      json(res, 200, { capture, record, audio: canPlay })
      capture = false
      record = false
      return
    }
    if (req.method === 'GET' && path === '/v1/body/audio') {
      if (inFlightAudio || audioQueue.length === 0) return json(res, 204, {})
      inFlightAudio = audioQueue.shift()
      refreshSpeaking()
      const pcm = inFlightAudio.pcm
      res.writeHead(200, { 'content-type': 'audio/pcm', 'content-length': pcm.length })
      res.end(pcm)
      return
    }
    if (req.method === 'GET' && path === '/v1/body/camera/latest') {
      const image = await readFile(join(data, 'camera.jpg'))
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': image.length })
      res.end(image)
      return
    }
    if (req.method === 'POST' && path === '/v1/body/ack') {
      const value = JSON.parse(await body(req, 16 * 1024))
      status.lastAck = { ...value, at: new Date().toISOString() }
      if (value?.kind === 'speaker') {
        inFlightAudio = null
        refreshSpeaking()
        status.speech = { ...(status.speech ?? {}), playback: value.ok === true ? 'acknowledged' : 'failed' }
      }
      console.log('DEVICE_ACK', JSON.stringify(status.lastAck))
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/v1/body/camera') {
      const image = await body(req)
      if (image[0] !== 255 || image[1] !== 216) throw Error('not-jpeg')
      const cameraPath = join(data, 'camera.jpg')
      const thumbnailPath = join(data, 'camera-thumbnail.jpg')
      await writeFile(cameraPath, image)
      const thumbnailScript = await toWindowsPath(join(root, '../thumbnail-local.ps1'))
      const windowsCameraPath = await toWindowsPath(cameraPath)
      const windowsThumbnailPath = await toWindowsPath(thumbnailPath)
      await run(powershell, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', thumbnailScript,
        '-InputFile', windowsCameraPath, '-OutputFile', windowsThumbnailPath,
      ], { windowsHide: true, timeout: 30000 })
      const imageDto = { dataUrl: 'data:image/jpeg;base64,' + image.toString('base64') }
      const thumbnail = await readFile(thumbnailPath)
      const thumbnailDto = { dataUrl: 'data:image/jpeg;base64,' + thumbnail.toString('base64') }
      const upload = await fetch(upstream + '/api/pet/upload', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          image: imageDto,
          thumbnail: thumbnailDto,
          source: 'stackchan_camera',
          visualClass: 'embodied_transient',
        }), signal: AbortSignal.timeout(10000),
      })
      const result = await upload.json()
      status.camera = { at: new Date().toISOString(), bytes: image.length, uploaded: upload.ok, attachmentId: result.attachment?.id, error: result.error }
      if (upload.ok && result.attachment?.id) {
        status.camera.vision = { status: 'running' }
        void askHuahuaAboutCamera(result.attachment.id).then((vision) => {
          status.camera.vision = vision
          console.log('CAMERA_VISION', JSON.stringify(status.camera))
        }).catch((error) => {
          status.camera.vision = { status: 'error', error: error.message }
          console.error('CAMERA_VISION_ERROR', error.message)
        })
      }
      console.log('CAMERA', JSON.stringify(status.camera))
      return json(res, upload.ok ? 200 : 502, status.camera)
    }
    if (req.method === 'POST' && path === '/v1/body/microphone') {
      const pcm = await body(req)
      const pcmPath = join(data, 'microphone.pcm')
      await writeFile(pcmPath, pcm)
      status.microphone = { at: new Date().toISOString(), bytes: pcm.length, sampleRate: 24000, voice: { status: 'running' } }
      void processMicrophone(pcmPath).then(() => console.log('MICROPHONE', JSON.stringify(status.microphone))).catch((error) => {
        status.microphone.voice = { status: 'error', error: error.message }
        console.error('MICROPHONE_ERROR', error.message)
      })
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path === '/v1/body/wake') {
      const sampleRate = Number(req.headers['x-lihuahua-audio-rate'] ?? 16000)
      const candidate = String(req.headers['x-lihuahua-wake-candidate'] ?? 'huahua')
      const stage1Score = Number(req.headers['x-lihuahua-wake-score'] ?? NaN)
      if (sampleRate !== 16000) return json(res, 400, { error: 'wake-audio-rate-must-be-16000' })
      if (candidate !== 'huahua') return json(res, 400, { error: 'wake-candidate-invalid' })
      if (!Number.isFinite(stage1Score) || stage1Score < 0 || stage1Score > 1) return json(res, 400, { error: 'wake-score-invalid' })
      const pcm = await body(req, 512 * 1024)
      if (pcm.length === 0 || pcm.length % 2 !== 0) return json(res, 400, { error: 'wake-pcm-invalid' })
      const pcmPath = join(data, 'wake.pcm')
      await writeFile(pcmPath, pcm)
      status.wake = {
        at: new Date().toISOString(),
        bytes: pcm.length,
        sampleRate,
        candidate,
        stage1Score,
        status: 'running',
        session: wakeSession.state,
      }
      void processWake(pcmPath, candidate, sampleRate, stage1Score)
        .then(() => console.log('WAKE', JSON.stringify(status.wake)))
        .catch((error) => {
          status.wake = { ...(status.wake ?? {}), status: 'error', error: error.message }
          console.error('WAKE_ERROR', error.message)
        })
      return json(res, 202, { ok: true, accepted: true, bytes: pcm.length })
    }
    if (req.method === 'POST' && path === '/v1/body/control') {
      const value = JSON.parse(await body(req, 16 * 1024))
      if (value.capture) capture = true
      if (value.record) record = true
      if (value.reprocessMicrophone) {
        const pcmPath = join(data, 'microphone.pcm')
        status.microphone = { ...(status.microphone ?? {}), voice: { status: 'running' } }
        void processMicrophone(pcmPath).then(() => console.log('MICROPHONE', JSON.stringify(status.microphone))).catch((error) => {
          status.microphone.voice = { status: 'error', error: error.message }
          console.error('MICROPHONE_ERROR', error.message)
        })
      }
      const queued = typeof value.speak === 'string' ? enqueueSpeech(value.speak) : false
      return json(res, 200, { ok: true, speechQueued: queued })
    }
    return json(res, 404, { error: 'not-found' })
  } catch (error) {
    console.error('REQUEST_ERROR', error.message)
    return json(res, 500, { error: error.message })
  }
})

server.listen(17871, process.env.STACKCHAN_BRIDGE_BIND || '127.0.0.1', () => console.log('BODY_BRIDGE_READY'))
const discovery = createSocket('udp4')
discovery.on('message', (message, peer) => {
  if (message.toString() === 'LIHUAHUA_DISCOVER_V1' && isAllowedLanAddress(peer.address)) {
    discovery.send('LIHUAHUA_BODY_V1 17871', peer.port, peer.address)
  }
})
discovery.bind(17872, '0.0.0.0')
