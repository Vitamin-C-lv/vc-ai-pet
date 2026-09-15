import { createServer } from 'node:http'
import { isAllowedLanAddress } from './lan-guard.mjs'

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(JSON.stringify(payload))
}

function isPetState(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.visualState === 'string'
    && value.emotion !== null
    && typeof value.emotion === 'object'
    && !Array.isArray(value.emotion)
}

export function createStackChanBridgeServer({
  upstreamUrl,
  upstreamTimeoutMs = 1500,
  stateMaxAgeMs = 10_000,
  now = Date.now,
  fetchImpl = fetch,
  mapPetStateToBodyContract,
} = {}) {
  if (!upstreamUrl || typeof mapPetStateToBodyContract !== 'function') {
    throw new TypeError('upstreamUrl and mapPetStateToBodyContract are required')
  }

  let cached = null
  return createServer(async (request, response) => {
    if (!isAllowedLanAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: 'lan-only' })
      return
    }
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method-not-allowed' })
      return
    }
    if (request.url === '/healthz') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.url !== '/v1/body/state') {
      sendJson(response, 404, { error: 'not-found' })
      return
    }

    try {
      const upstream = await fetchImpl(upstreamUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      })
      if (!upstream.ok) throw new Error(`upstream-http-${upstream.status}`)
      const petState = await upstream.json()
      if (!isPetState(petState)) throw new Error('upstream-invalid-state')

      const fetchedAt = now()
      cached = { petState, fetchedAt, observedAt: new Date(fetchedAt).toISOString() }
      sendJson(response, 200, mapPetStateToBodyContract(petState, {
        reachable: true,
        observedAt: cached.observedAt,
        stateAgeMs: 0,
      }))
      return
    } catch {
      const currentTime = now()
      const stateAgeMs = cached ? Math.max(0, currentTime - cached.fetchedAt) : null
      if (cached && stateAgeMs <= stateMaxAgeMs) {
        sendJson(response, 200, mapPetStateToBodyContract(cached.petState, {
          reachable: false,
          observedAt: cached.observedAt,
          stateAgeMs,
        }))
        return
      }

      sendJson(response, 200, mapPetStateToBodyContract(null, {
        reachable: false,
        observedAt: new Date(currentTime).toISOString(),
        stateAgeMs: null,
      }))
    }
  })
}
