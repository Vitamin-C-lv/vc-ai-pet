import { assertLoopbackUrl } from '../core/pet-policy.js'

export class LocalBrainApiError extends Error {
  constructor(message, {
    status = 0,
    code = 'PET_LOCAL_BRAIN_API_ERROR',
    retryable = false,
    requestId = null,
    cause = undefined,
  } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LocalBrainApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.requestId = requestId
  }
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(ms)
}

async function readJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export class LocalBrainClient {
  constructor({
    baseUrl = 'http://127.0.0.1:17862',
    healthTimeoutMs = 1_500,
    requestTimeoutMs = 60_000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('PET_LOCAL_BRAIN_FETCH_UNAVAILABLE')

    const url = assertLoopbackUrl(baseUrl)
    if (url.protocol !== 'http:') throw new Error('PET_LOCAL_BRAIN_API_MUST_USE_HTTP_LOOPBACK')

    this.baseUrl = url.toString().replace(/\/$/, '')
    this.healthTimeoutMs = healthTimeoutMs
    this.requestTimeoutMs = requestTimeoutMs
    this.fetchImpl = fetchImpl
  }

  _url(path) {
    return assertLoopbackUrl(`${this.baseUrl}${path}`)
  }

  async health() {
    try {
      const response = await this.fetchImpl(this._url('/health'), {
        method: 'GET',
        signal: timeoutSignal(this.healthTimeoutMs),
      })
      if (!response.ok) return false
      const payload = await readJson(response)
      return payload?.status === 'ok'
    } catch {
      return false
    }
  }

  async chat({
    messages,
    reasoningEffort = 'off',
    temperature = 0.72,
    topP = 0.9,
    maxTokens = 256,
    responseFormat = undefined,
  }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new LocalBrainApiError('messages must be a non-empty array', {
        code: 'PET_LOCAL_BRAIN_INVALID_MESSAGES',
        retryable: false,
      })
    }

    const body = {
      messages,
      stream: false,
      reasoning_effort: reasoningEffort,
    }

    // These are standard Chat behavior controls, not physical runtime controls.
    // Pet never sends model/n_ctx/context tier/mmproj/llama lifecycle parameters.
    if (temperature !== undefined) body.temperature = temperature
    if (topP !== undefined) body.top_p = topP
    if (maxTokens !== undefined) body.max_tokens = maxTokens
    if (responseFormat !== undefined) body.response_format = responseFormat

    let response
    try {
      response = await this.fetchImpl(this._url('/v1/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: timeoutSignal(this.requestTimeoutMs),
      })
    } catch (error) {
      throw new LocalBrainApiError('Local Brain service is unavailable', {
        code: 'PET_LOCAL_BRAIN_TRANSPORT_ERROR',
        retryable: true,
        cause: error,
      })
    }

    const requestId = response.headers?.get?.('x-local-brain-request-id') ?? null
    const payload = await readJson(response)

    if (!response.ok) {
      const remote = payload?.error
      throw new LocalBrainApiError(
        typeof remote?.message === 'string' ? remote.message : 'Local Brain request failed',
        {
          status: response.status,
          code: typeof remote?.code === 'string' ? remote.code : 'PET_LOCAL_BRAIN_HTTP_ERROR',
          retryable: remote?.retryable === true,
          requestId,
        },
      )
    }

    if (!payload || typeof payload !== 'object') {
      throw new LocalBrainApiError('Local Brain returned an invalid JSON response', {
        status: response.status,
        code: 'PET_LOCAL_BRAIN_BAD_RESPONSE',
        retryable: false,
        requestId,
      })
    }

    return { payload, requestId }
  }
}
