import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeVisionImage } from '../brain/vision-input.js'

const REMOTE_ROOT = resolve(fileURLToPath(new URL('./mobile-ui/', import.meta.url)))
const DEFAULT_PORT = 17870
const DEFAULT_BODY_LIMIT_BYTES = 16 * 1024
const CHAT_BODY_LIMIT_BYTES = 8 * 1024 * 1024
const UPLOAD_BODY_LIMIT_BYTES = 12 * 1024 * 1024
const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
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

export function createLanRequestHandler({ runtime, assetRoot, visualConfig = {}, conversationStore = runtime?.conversationStore, logger = console } = {}) {
  const assets = resolve(assetRoot)

  return async (req, res) => {
    if (!isAllowedLanAddress(req.socket?.remoteAddress)) return sendJson(res, 403, { error: 'lan-only' })
    const url = new URL(req.url ?? '/', 'http://lan.local')

    try {
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
        let image = null
        let attachment = null
        let attachmentId = null
        if (Object.hasOwn(body ?? {}, 'attachmentId')) {
          if (Object.hasOwn(body ?? {}, 'image') || typeof body?.attachmentId !== 'string') return sendJson(res, 400, { error: 'invalid-image' })
          attachmentId = body.attachmentId
          if (!/^[a-z0-9_-]{1,80}$/iu.test(attachmentId)) return sendJson(res, 400, { error: 'invalid-image' })
          const metadata = await conversationStore?.attachment?.(attachmentId)
          if (conversationStore?.attachment && !metadata) return sendJson(res, 400, { error: 'invalid-image' })
        } else {
          try { image = normalizeVisionImage(body?.image) } catch { return sendJson(res, 400, { error: 'invalid-image' }) }
        }
        if ((message.length < 1 && !image && !attachmentId) || message.length > 500) return sendJson(res, 400, { error: 'invalid-message' })
        if (typeof runtime.startChatTurn !== 'function') return sendJson(res, 503, { error: 'turn-transport-unavailable' })
        let started
        try {
          started = runtime.startChatTurn({ userText: message, image, attachment, attachmentId })
        } catch (error) {
          if (error?.code === 'PET_TURN_MANAGER_CAPACITY') return sendJson(res, 503, { error: 'turn-capacity' })
          throw error
        }
        if (!started?.turnId) return sendJson(res, 500, { error: 'turn-start-failed' })
        return sendJson(res, 202, { ok: true, turnId: started.turnId })
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

export async function startLanServer({ runtime, assetRoot, visualConfig = {}, conversationStore = runtime?.conversationStore, port = DEFAULT_PORT, host = '0.0.0.0', logger = console } = {}) {
  if (!runtime || !assetRoot) throw new TypeError('runtime and assetRoot are required')
  if (host !== '0.0.0.0') throw new TypeError('LAN server must bind 0.0.0.0')
  const server = createServer(createLanRequestHandler({ runtime, assetRoot, visualConfig, conversationStore, logger }))
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

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(value))
}
