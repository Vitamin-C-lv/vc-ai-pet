import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOUSEHOLD_SESSION_TTL_MS } from '../identity/identity-store.js'
import { readInnerLifeTimeline } from '../memory/inner-life-timeline.js'
import { normalizeVisionImage } from '../brain/vision-input.js'
import { createChatSubmissionIdempotency } from './chat-submission-idempotency.js'
import {
  clearSessionCookie,
  isTrustedMutationOrigin,
  readSessionToken,
  requestUsesSecureTransport,
  sessionCookie,
} from './auth-cookie.js'
import { readVisualGallery, readVisualGalleryDetail } from './visual-gallery.js'

const REMOTE_ROOT = resolve(fileURLToPath(new URL('./mobile-ui/', import.meta.url)))
const DEFAULT_PORT = 17870
const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024
const CHAT_BODY_LIMIT_BYTES = 8 * 1024 * 1024
const UPLOAD_BODY_LIMIT_BYTES = 12 * 1024 * 1024
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5
const LOGIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const LOGIN_RATE_LIMIT_MAX_KEYS = 256
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
})
const CONVERSATION_ASSET_CONTENT_TYPES = Object.freeze({
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
})

export function isPrivateIPv4(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address ?? ''))
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return false
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

export function isAllowedLanAddress(address) {
  const value = String(address ?? '').replace(/^::ffff:/i, '')
  return value === '127.0.0.1' || value === '::1' || isPrivateIPv4(value)
}

export function localLanAddress(interfaces = networkInterfaces()) {
  for (const values of Object.values(interfaces)) {
    for (const entry of values ?? []) {
      if (entry?.family === 'IPv4' && !entry.internal && isPrivateIPv4(entry.address)) return entry.address
    }
  }
  return 'localhost'
}

export function actionToInteractionKind(action, state = {}) {
  if (action === 'click') return state.current === 'sleep' ? 'wake' : 'pet'
  if (action === 'double_click') return 'play'
  if (action === 'long_press') return 'long-press'
  return null
}

export class LoginRateLimiter {
  constructor({
    now = () => Date.now(),
    maxFailures = LOGIN_RATE_LIMIT_MAX_FAILURES,
    windowMs = LOGIN_RATE_LIMIT_WINDOW_MS,
    maxKeys = LOGIN_RATE_LIMIT_MAX_KEYS,
  } = {}) {
    this.now = now
    this.maxFailures = maxFailures
    this.windowMs = windowMs
    this.maxKeys = maxKeys
    this.entries = new Map()
  }

  isLimited(key) {
    this.#cleanup(this.now())
    return (this.entries.get(key)?.failures ?? 0) >= this.maxFailures
  }

  recordFailure(key) {
    const timestamp = this.now()
    this.#cleanup(timestamp)
    const existing = this.entries.get(key)
    this.entries.delete(key)
    this.entries.set(key, {
      failures: (existing?.failures ?? 0) + 1,
      lastFailureAt: timestamp,
    })
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value)
  }

  recordSuccess(key) {
    this.entries.delete(key)
  }

  get size() {
    this.#cleanup(this.now())
    return this.entries.size
  }

  #cleanup(timestamp) {
    for (const [key, entry] of this.entries) {
      if (timestamp - entry.lastFailureAt >= this.windowMs) this.entries.delete(key)
    }
  }
}

function loginRateLimitKey(req, username) {
  const normalizedUsername = typeof username === 'string' ? username.trim().toLowerCase().slice(0, 40) : ''
  const clientAddress = String(req.socket?.remoteAddress ?? '')
  return `${normalizedUsername || '<invalid>'}\u0000${clientAddress}`
}

function actorContextForSession(session) {
  return Object.freeze({
    actorId: session.person.personId,
    actorType: 'household',
    displayName: session.person.displayName,
    authenticated: true,
    sessionId: session.sessionId,
  })
}

function publicActorForSession(session) {
  return {
    actorId: session.person.personId,
    actorType: 'household',
    displayName: session.person.displayName,
    authenticated: true,
  }
}

export async function resolveActorContext(req, identityStore) {
  if (!identityStore) return null
  const token = readSessionToken(req.headers?.cookie)
  if (!token) return null
  const session = await identityStore.resolveSession(token)
  return session ? actorContextForSession(session) : null
}

export function createLanRequestHandler({ runtime, assetRoot, visualConfig = {}, conversationStore = runtime?.conversationStore, logger = console, submissionRegistry = null, identityStore = null, loginRateLimiter = null } = {}) {
  const assets = resolve(assetRoot)
  const chatSubmissionIdempotency = submissionRegistry ?? createChatSubmissionIdempotency()
  const limiter = loginRateLimiter ?? new LoginRateLimiter()

  return async (req, res) => {
    if (!isAllowedLanAddress(req.socket?.remoteAddress)) return sendJson(res, 403, { error: 'lan-only' })
    const url = new URL(req.url ?? '/', 'http://lan.local')

    try {
      if (url.pathname === '/api/auth/login') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
        if (!isTrustedMutationOrigin(req)) return sendJson(res, 403, { error: 'untrusted-origin' })
        if (!identityStore) return sendJson(res, 503, { error: 'identity-unavailable' })
        const body = await readJsonBody(req, DEFAULT_BODY_LIMIT_BYTES)
        const username = typeof body?.username === 'string' && body.username.length <= 40 ? body.username : ''
        const password = typeof body?.password === 'string' && body.password.length <= 256 ? body.password : ''
        const limitKey = loginRateLimitKey(req, username)
        if (limiter.isLimited(limitKey)) return sendJson(res, 429, { error: 'too-many-attempts' })
        const verified = await identityStore.verifyHouseholdLogin({ username, password })
        if (!verified.ok) {
          limiter.recordFailure(limitKey)
          return sendJson(res, 401, { error: 'invalid-credentials' })
        }
        limiter.recordSuccess(limitKey)
        const previousToken = readSessionToken(req.headers?.cookie)
        if (previousToken && await identityStore.resolveSession(previousToken)) await identityStore.revokeSession(previousToken)
        const created = await identityStore.createSession(verified.person.personId)
        return sendJson(res, 200, { ok: true, person: created.session.person }, {
          'set-cookie': sessionCookie(created.token, {
            secure: requestUsesSecureTransport(req),
            maxAge: Math.floor(HOUSEHOLD_SESSION_TTL_MS / 1000),
          }),
        })
      }
      if (url.pathname === '/api/auth/logout') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
        if (!isTrustedMutationOrigin(req)) return sendJson(res, 403, { error: 'untrusted-origin' })
        const token = readSessionToken(req.headers?.cookie)
        if (identityStore && token) await identityStore.revokeSession(token)
        return sendJson(res, 200, { ok: true }, { 'set-cookie': clearSessionCookie({ secure: requestUsesSecureTransport(req) }) })
      }
      if (url.pathname === '/api/auth/me') {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
        const token = readSessionToken(req.headers?.cookie)
        const session = identityStore && token ? await identityStore.resolveSession(token) : null
        if (!session) return sendJson(res, 200, { authenticated: false, actor: null, person: null })
        return sendJson(res, 200, { authenticated: true, actor: publicActorForSession(session), person: session.person })
      }
      if (req.method === 'GET' && url.pathname === '/api/inner-life') {
        const offset = url.searchParams.get('offset') ?? '0'
        if (!/^\d{1,7}$/u.test(offset)) return sendJson(res, 400, { error: 'invalid-offset' })
        if (!runtime.memory?.db?.db) return sendJson(res, 503, { error: 'inner-life-unavailable' })
        return sendJson(res, 200, readInnerLifeTimeline(runtime.memory.db.db, {
          offset: Number(offset),
          findById: runtime.memory.db.findById?.bind(runtime.memory.db),
        }))
      }
      if (req.method === 'GET' && url.pathname === '/api/visual-gallery') {
        const limit = url.searchParams.get('limit') ?? '24'
        const offset = url.searchParams.get('offset') ?? '0'
        if (!/^\d{1,2}$/u.test(limit) || Number(limit) < 1 || Number(limit) > 40) {
          return sendJson(res, 400, { error: 'invalid-limit' })
        }
        if (!/^\d{1,5}$/u.test(offset) || Number(offset) > 10_000) {
          return sendJson(res, 400, { error: 'invalid-offset' })
        }
        if (!runtime.visualExperience) return sendJson(res, 503, { error: 'visual-gallery-unavailable' })
        return sendJson(res, 200, await readVisualGallery(runtime, { limit: Number(limit), offset: Number(offset) }))
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/visual-gallery/')) {
        let experienceId
        try {
          experienceId = decodeURIComponent(url.pathname.slice('/api/visual-gallery/'.length))
        } catch {
          return sendJson(res, 404, { error: 'not-found' })
        }
        if (!/^[a-z0-9_-]{1,120}$/iu.test(experienceId) || !runtime.visualExperience) {
          return sendJson(res, 404, { error: 'not-found' })
        }
        const detail = await readVisualGalleryDetail(runtime, experienceId)
        return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: 'not-found' })
      }
      if (req.method === 'GET' && url.pathname === '/api/pet/state') {
        const presentation = runtime.presentationSnapshot(visualConfig)
        return sendJson(res, 200, presentation)
      }
      if (req.method === 'GET' && url.pathname === '/api/pet/history') {
        const messages = typeof runtime.conversationHistory === 'function'
          ? await runtime.conversationHistory(50)
          : typeof conversationStore?.history === 'function'
            ? await conversationStore.history(50)
            : typeof conversationStore?.getHistory === 'function'
              ? await conversationStore.getHistory(50)
            : []
        return sendJson(res, 200, { messages: Array.isArray(messages) ? messages.slice(-50) : [] })
      }
      if (req.method === 'POST' && url.pathname === '/api/pet/action') {
        const body = await readJsonBody(req, DEFAULT_BODY_LIMIT_BYTES)
        const kind = actionToInteractionKind(body?.action, runtime.snapshot())
        if (!kind) return sendJson(res, 400, { error: 'invalid-action' })
        const state = await runtime.interact(kind)
        return sendJson(res, 200, { ok: true, state, ...runtime.presentationSnapshot(visualConfig) })
      }
      if (req.method === 'POST' && url.pathname === '/api/pet/upload') {
        if (!conversationStore?.saveAttachment) return sendJson(res, 503, { error: 'conversation-store-unavailable' })
        const body = await readJsonBody(req, UPLOAD_BODY_LIMIT_BYTES)
        if (Object.hasOwn(body ?? {}, 'images')) return sendJson(res, 400, { error: 'invalid-image' })
        const attachment = await conversationStore.saveAttachment({
          image: body?.image,
          thumbnail: body?.thumbnail,
          width: body?.width,
          height: body?.height,
          thumbnailWidth: body?.thumbnailWidth,
          thumbnailHeight: body?.thumbnailHeight,
          requireThumbnail: true,
        })
        const publicAttachment = typeof conversationStore.publicAttachment === 'function'
          ? conversationStore.publicAttachment(attachment)
          : attachment
        return sendJson(res, 200, { ok: true, attachment: publicAttachment })
      }
      if (req.method === 'POST' && url.pathname === '/api/pet/chat') {
        const body = await readJsonBody(req, CHAT_BODY_LIMIT_BYTES)
        const message = typeof body?.message === 'string' ? body.message.trim() : ''
        if (Object.hasOwn(body ?? {}, 'images')) return sendJson(res, 400, { error: 'invalid-image' })
        let image = null
        let attachment = null
        if (Object.hasOwn(body ?? {}, 'attachmentId')) {
          if (Object.hasOwn(body ?? {}, 'image') || typeof body?.attachmentId !== 'string') {
            return sendJson(res, 400, { error: 'invalid-image' })
          }
          const stored = typeof runtime.conversationAsset === 'function'
            ? await runtime.conversationAsset(body.attachmentId)
            : typeof conversationStore?.readAttachmentDataUrl === 'function'
              ? await conversationStore.readAttachmentDataUrl(body.attachmentId)
              : null
          if (!stored?.dataUrl || !stored.attachment) return sendJson(res, 400, { error: 'invalid-image' })
          image = { dataUrl: stored.dataUrl }
          attachment = stored.attachment
        } else {
          try {
            image = normalizeVisionImage(body?.image)
          } catch {
            return sendJson(res, 400, { error: 'invalid-image' })
          }
        }
        if ((message.length < 1 && !image) || message.length > 500) return sendJson(res, 400, { error: 'invalid-message' })
        return sendJson(res, 200, await runtime.chat(message, image, attachment))
      }
      if (req.method === 'POST' && url.pathname === '/api/pet/chat/start') {
        const body = await readJsonBody(req, CHAT_BODY_LIMIT_BYTES)
        const message = typeof body?.message === 'string' ? body.message.trim() : ''
        if (Object.hasOwn(body ?? {}, 'images')) return sendJson(res, 400, { error: 'invalid-image' })
        const hasSubmissionId = Object.hasOwn(body ?? {}, 'submissionId')
        const submissionId = hasSubmissionId ? body.submissionId : null
        if (hasSubmissionId && (typeof submissionId !== 'string' || !/^[a-z0-9_-]{1,80}$/iu.test(submissionId))) {
          return sendJson(res, 400, { error: 'invalid-submission-id' })
        }
        let image = null
        let attachment = null
        let attachmentId = null
        if (Object.hasOwn(body ?? {}, 'attachmentId')) {
          if (Object.hasOwn(body ?? {}, 'image') || typeof body?.attachmentId !== 'string') return sendJson(res, 400, { error: 'invalid-image' })
          attachmentId = body.attachmentId
          if (!/^[a-z0-9_-]{1,80}$/iu.test(attachmentId)) return sendJson(res, 400, { error: 'invalid-image' })
        } else {
          try { image = normalizeVisionImage(body?.image) } catch { return sendJson(res, 400, { error: 'invalid-image' }) }
        }
        if ((message.length < 1 && !image && !attachmentId) || message.length > 500) return sendJson(res, 400, { error: 'invalid-message' })
        if (submissionId) {
          try {
            const replay = chatSubmissionIdempotency.lookup({ submissionId, message, attachmentId })
            if (replay) return sendJson(res, 202, {
              ok: true,
              turnId: replay.turnId,
              submissionId,
              idempotentReplay: true,
            })
          } catch (error) {
            if (error?.code === 'SUBMISSION_ID_CONFLICT') return sendJson(res, 409, { error: 'SUBMISSION_ID_CONFLICT' })
            if (error?.code === 'SUBMISSION_ID_INVALID') return sendJson(res, 400, { error: 'invalid-submission-id' })
            throw error
          }
        }
        if (attachmentId) {
          const metadata = await conversationStore?.attachment?.(attachmentId)
          if (conversationStore?.attachment && !metadata) return sendJson(res, 400, { error: 'invalid-image' })
        }
        if (typeof runtime.startChatTurn !== 'function') return sendJson(res, 503, { error: 'turn-transport-unavailable' })
        let started
        try {
          const createTurn = () => runtime.startChatTurn({ userText: message, image, attachment, attachmentId })
          started = submissionId
            ? chatSubmissionIdempotency.start({ submissionId, message, attachmentId, createTurn })
            : createTurn()
        } catch (error) {
          if (error?.code === 'PET_TURN_MANAGER_CAPACITY') return sendJson(res, 503, { error: 'turn-capacity' })
          if (error?.code === 'SUBMISSION_ID_CONFLICT') return sendJson(res, 409, { error: 'SUBMISSION_ID_CONFLICT' })
          if (error?.code === 'SUBMISSION_ID_INVALID') return sendJson(res, 400, { error: 'invalid-submission-id' })
          throw error
        }
        if (!started?.turnId) return sendJson(res, 500, { error: 'turn-start-failed' })
        return sendJson(res, 202, {
          ok: true,
          turnId: started.turnId,
          ...(submissionId ? { submissionId, idempotentReplay: started.idempotentReplay === true } : {}),
        })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/pet/chat/turn/')) {
        const turnId = url.pathname.slice('/api/pet/chat/turn/'.length)
        if (!/^[a-z0-9-]{1,80}$/iu.test(turnId) || typeof runtime.pollChatTurn !== 'function') return sendJson(res, 404, { error: 'turn-not-found' })
        const after = url.searchParams.get('after')
        if (after !== null && !/^\d{1,9}$/u.test(after)) return sendJson(res, 400, { error: 'invalid-after' })
        const result = runtime.pollChatTurn(turnId, after)
        return result ? sendJson(res, 200, result) : sendJson(res, 404, { error: 'turn-not-found' })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/conversation-assets/')) {
        return await serveConversationAsset(url.pathname, conversationStore, res)
      }
      if (req.method === 'GET') return await serveStatic(url.pathname, assets, res)
      return sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      if (error?.code === 'invalid-json' || error?.code === 'body-too-large' || String(error?.code ?? '').startsWith('PET_CONVERSATION_')) {
        return sendJson(res, 400, { error: error.code })
      }
      logger?.warn?.(
        `vc-ai-pet: LAN request failed code=${String(error?.code ?? 'UNKNOWN')} `
        + `retryable=${error?.retryable === true ? 'true' : 'false'} `
        + `requestId=${String(error?.requestId ?? '')}`,
      )
      return sendJson(res, 500, { error: 'remote-ui-error' })
    }
  }
}

export async function startLanServer({ runtime, assetRoot, visualConfig = {}, conversationStore = runtime?.conversationStore, port = DEFAULT_PORT, host = '0.0.0.0', logger = console, submissionRegistry = null, identityStore = null, loginRateLimiter = null } = {}) {
  if (!runtime || !assetRoot) throw new TypeError('runtime and assetRoot are required')
  if (host !== '0.0.0.0') throw new TypeError('LAN server must bind 0.0.0.0')
  const server = createServer(createLanRequestHandler({ runtime, assetRoot, visualConfig, conversationStore, logger, submissionRegistry, identityStore, loginRateLimiter }))
  await new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart)
    server.listen(port, host, () => {
      server.off('error', rejectStart)
      resolveStart()
    })
  })
  const address = server.address()
  const activePort = typeof address === 'object' && address ? address.port : port
  const url = `http://${localLanAddress()}:${activePort}`
  logger?.info?.('VC_AI_PET_LAN_UI')
  logger?.info?.('LOCAL_ONLY=true')
  logger?.info?.(`URL=${url}`)
  return Object.assign(server, { lanUrl: url, localOnly: true })
}

async function serveConversationAsset(pathname, conversationStore, res) {
  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return sendJson(res, 404, { error: 'not-found' })
  }
  const match = /^\/conversation-assets\/(\d{4})\/(\d{2})\/(\d{2})\/([a-z0-9_-]{1,80}(?:-thumbnail)?\.(?:webp|jpg|png))$/iu.exec(decoded)
  if (!match || !conversationStore?.assetsRoot) return sendJson(res, 404, { error: 'not-found' })
  const file = join(resolve(conversationStore.assetsRoot), match[1], match[2], match[3], match[4])
  const contentType = CONVERSATION_ASSET_CONTENT_TYPES[extname(file).toLowerCase()]
  if (!contentType) return sendJson(res, 404, { error: 'not-found' })
  try {
    const bytes = await readFile(file)
    res.writeHead(200, {
      'content-type': contentType,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    })
    res.end(bytes)
  } catch {
    sendJson(res, 404, { error: 'not-found' })
  }
}

async function serveStatic(pathname, assetRoot, res) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  if (relative.includes('..')) return sendJson(res, 404, { error: 'not-found' })
  const rootFile = join(REMOTE_ROOT, relative)
  const assetFile = join(assetRoot, basename(relative))
  const file = relative.startsWith('assets/') ? assetFile : rootFile
  const extension = extname(file)
  if (!CONTENT_TYPES[extension]) return sendJson(res, 404, { error: 'not-found' })
  try {
    const bytes = await readFile(file)
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extension],
      'cache-control': extension === '.png' ? 'public, max-age=3600' : 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    res.end(bytes)
  } catch {
    sendJson(res, 404, { error: 'not-found' })
  }
}

function readJsonBody(req, maxBytes = DEFAULT_BODY_LIMIT_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    let body = ''
    let bodyBytes = 0
    let settled = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (settled) return
      body += chunk
      bodyBytes += Buffer.byteLength(chunk, 'utf8')
      if (bodyBytes > maxBytes) {
        const error = new Error('body too large')
        error.code = 'body-too-large'
        settled = true
        rejectBody(error)
        // Stop buffering but drain the request so the caller can still receive
        // a normal 400 response instead of a connection reset.
        req.resume()
      }
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try { resolveBody(JSON.parse(body || '{}')) } catch {
        const error = new Error('invalid json')
        error.code = 'invalid-json'
        rejectBody(error)
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectBody(error)
    })
  })
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  res.end(JSON.stringify(value))
}
