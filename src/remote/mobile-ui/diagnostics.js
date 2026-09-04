(() => {
  const DIAGNOSTIC_STORAGE_KEY = 'vc-ai-pet-diagnostics-v1'
  const DIAGNOSTIC_SCHEMA_VERSION = 1
  const MAX_EVENTS = 50
  const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
  const DEDUPE_WINDOW_MS = 30 * 1000
  const DEDUPE_STAGES = new Set(['history', 'state', 'network'])
  const LEVELS = new Set(['error', 'warn', 'info'])
  let sequence = 0

  function isoAt(value) {
    const timestamp = Number(value)
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString()
  }

  function safeString(value, max = 160) {
    if (typeof value !== 'string') return null
    const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    return normalized ? normalized.slice(0, max) : null
  }

  function safeInteger(value, max = Number.MAX_SAFE_INTEGER) {
    const number = Number(value)
    return Number.isFinite(number) && number >= 0 ? Math.min(max, Math.round(number)) : null
  }

  function safeBoolean(value) {
    return typeof value === 'boolean' ? value : null
  }

  function sanitizeDiagnosticMessage(value) {
    if (typeof value !== 'string') return null
    const cleaned = value
      .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/giu, '[REDACTED_IMAGE]')
      .replace(/authorization\s*[:=]\s*(?:[a-z]+\s+)?[a-z0-9._~+\/-]+/giu, 'Authorization: [REDACTED]')
      .replace(/bearer\s+[a-z0-9._~+\/-]+/giu, 'Bearer [REDACTED]')
      .replace(/\S{513,}/gu, '[REDACTED]')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
    return cleaned ? cleaned.slice(0, 240) : null
  }

  function safeRequestId(value) {
    return safeString(value, 160)
  }

  function defaultStorage() {
    try { return globalThis.localStorage } catch { return null }
  }

  function safeDetails(input = {}) {
    const details = {}
    const stringFields = ['attachmentId', 'mime', 'tab', 'visibility', 'errorName', 'source']
    for (const field of stringFields) {
      const value = safeString(input[field], 120)
      if (value) details[field] = value
    }
    const pathname = safeString(input.pathname, 180)?.split(/[?#]/u)[0]
    if (pathname) details.pathname = pathname
    for (const field of ['hadImage', 'online', 'retryable']) {
      const value = safeBoolean(input[field])
      if (value !== null) details[field] = value
    }
    for (const field of ['width', 'height', 'inputBytes', 'imageBytes', 'viewportWidth', 'viewportHeight', 'line', 'column']) {
      const value = safeInteger(input[field], field.includes('Bytes') ? 20 * 1024 * 1024 : 20_000)
      if (value !== null) details[field] = value
    }
    return details
  }

  function eventTimestamp(event) {
    const timestamp = Date.parse(event?.at)
    return Number.isFinite(timestamp) ? timestamp : 0
  }

  function normalizeEvent(input = {}, now = Date.now()) {
    const level = LEVELS.has(input.level) ? input.level : 'error'
    const event = {
      id: `diag-${now.toString(36)}-${(++sequence).toString(36)}`,
      at: isoAt(now),
      level,
      stage: safeString(input.stage, 80) ?? 'unknown',
      code: safeString(input.code, 120) ?? 'UNKNOWN',
    }
    const httpStatus = safeInteger(input.httpStatus, 999)
    const durationMs = safeInteger(input.durationMs, 24 * 60 * 60 * 1000)
    const requestId = safeRequestId(input.requestId)
    const message = sanitizeDiagnosticMessage(input.message)
    if (httpStatus !== null) event.httpStatus = httpStatus
    if (durationMs !== null) event.durationMs = durationMs
    if (requestId) event.requestId = requestId
    if (message) event.message = message
    const details = safeDetails(input.details)
    if (Object.keys(details).length) event.details = details
    return event
  }

  function parseEvents(storage, now) {
    try {
      const raw = storage?.getItem?.(DIAGNOSTIC_STORAGE_KEY)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (parsed?.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION || !Array.isArray(parsed.events)) throw new Error('invalid diagnostics schema')
      return parsed.events.filter((event) => now - eventTimestamp(event) <= RETENTION_MS).slice(-MAX_EVENTS)
    } catch {
      try { storage?.removeItem?.(DIAGNOSTIC_STORAGE_KEY) } catch {}
      return []
    }
  }

  function publicError(payload) {
    const error = payload?.error
    const code = typeof error?.code === 'string'
      ? error.code
      : typeof error === 'string'
        ? error
        : typeof payload?.code === 'string'
          ? payload.code
          : null
    return {
      code,
      retryable: error?.retryable === true || payload?.retryable === true,
      requestId: payload?.requestId ?? payload?.request_id ?? error?.requestId ?? error?.request_id ?? null,
    }
  }

  function headerRequestId(response) {
    try { return response?.headers?.get?.('x-local-brain-request-id') ?? response?.headers?.get?.('X-Local-Brain-Request-ID') ?? null } catch { return null }
  }

  function elapsedSince(startedAt, clock) {
    return Math.max(0, Math.round(clock() - startedAt))
  }

  function createFrontendDiagnostics({ storage = null, now = () => Date.now(), clock = () => globalThis.performance?.now?.() ?? Date.now(), context = () => ({}) } = {}) {
    const diagnosticStorage = storage ?? defaultStorage()
    let events = parseEvents(diagnosticStorage, now())

    function persist() {
      try {
        diagnosticStorage?.setItem?.(DIAGNOSTIC_STORAGE_KEY, JSON.stringify({ schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, events }))
      } catch {
        // Diagnostics are best-effort and must never block the pet UI.
      }
    }

    // Startup retention cleanup is intentionally limited to this one key.
    try { if (diagnosticStorage?.getItem?.(DIAGNOSTIC_STORAGE_KEY)) persist() } catch {}

    function record(input = {}) {
      try {
        const timestamp = now()
        const event = normalizeEvent({ ...input, details: { ...context(), ...input.details } }, timestamp)
        const lastMatching = [...events].reverse().find((item) => (
          item.stage === event.stage && item.code === event.code && (item.httpStatus ?? null) === (event.httpStatus ?? null)
        ))
        if (DEDUPE_STAGES.has(event.stage) && lastMatching && timestamp - eventTimestamp(lastMatching) < DEDUPE_WINDOW_MS) return lastMatching
        events = [...events.filter((item) => timestamp - eventTimestamp(item) <= RETENTION_MS), event].slice(-MAX_EVENTS)
        persist()
        return event
      } catch {
        return null
      }
    }

    async function fetchJsonDiagnostic(url, options = {}, requestContext = {}) {
      const startedAt = clock()
      const stage = safeString(requestContext.stage, 80) ?? 'request'
      try {
        const response = await globalThis.fetch(url, options)
        const payload = await response.json().catch(() => null)
        const publicEnvelope = publicError(payload)
        const requestId = safeRequestId(publicEnvelope.requestId ?? headerRequestId(response))
        const durationMs = elapsedSince(startedAt, clock)
        if (!response.ok) {
          const error = new Error('request failed')
          error.diagnosticLogged = true
          error.code = publicEnvelope.code ?? `HTTP_${response.status}`
          error.httpStatus = response.status
          error.requestId = requestId
          error.retryable = publicEnvelope.retryable
          record({
            level: 'error', stage, code: error.code, httpStatus: response.status, requestId, durationMs,
            details: { ...requestContext, retryable: publicEnvelope.retryable },
          })
          throw error
        }
        if (!payload || typeof payload !== 'object') {
          const error = new Error('invalid json response')
          error.diagnosticLogged = true
          error.code = 'FRONTEND_INVALID_JSON'
          error.httpStatus = response.status
          error.requestId = requestId
          record({ level: 'error', stage, code: error.code, httpStatus: response.status, requestId, durationMs, details: requestContext })
          throw error
        }
        return { response, payload, requestId, durationMs }
      } catch (error) {
        if (!error?.diagnosticLogged) {
          record({
            level: 'error', stage, code: 'FRONTEND_FETCH_ERROR', durationMs: elapsedSince(startedAt, clock),
            message: error?.message, details: requestContext,
          })
        }
        throw error
      }
    }

    function clear() {
      events = []
      try { diagnosticStorage?.removeItem?.(DIAGNOSTIC_STORAGE_KEY) } catch {}
    }

    function list() { return [...events] }

    function exportText() {
      const lines = ['VC_AI_PET_FRONTEND_DIAGNOSTICS', `SCHEMA=${DIAGNOSTIC_SCHEMA_VERSION}`, `GENERATED_AT=${isoAt(now())}`]
      events.forEach((event, index) => {
        lines.push('', String(index + 1).padStart(2, '0'), `AT=${event.at}`, `LEVEL=${event.level}`, `STAGE=${event.stage}`, `CODE=${event.code}`)
        if (event.httpStatus !== undefined) lines.push(`HTTP_STATUS=${event.httpStatus}`)
        if (event.requestId) lines.push(`REQUEST_ID=${event.requestId}`)
        if (event.durationMs !== undefined) lines.push(`DURATION_MS=${event.durationMs}`)
        for (const [key, value] of Object.entries(event.details ?? {})) lines.push(`${key.replace(/([A-Z])/gu, '_$1').toUpperCase()}=${String(value)}`)
      })
      return lines.join('\n')
    }

    return { record, fetchJsonDiagnostic, clear, list, exportText }
  }

  globalThis.VcAiPetDiagnostics = Object.freeze({
    DIAGNOSTIC_STORAGE_KEY,
    DIAGNOSTIC_SCHEMA_VERSION,
    MAX_EVENTS,
    RETENTION_MS,
    DEDUPE_WINDOW_MS,
    sanitizeDiagnosticMessage,
    createFrontendDiagnostics,
  })
})()
