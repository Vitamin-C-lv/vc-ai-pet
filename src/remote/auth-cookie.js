export const SESSION_COOKIE_NAME = 'vc_ai_pet_session'
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

function cookieAttributes({ maxAge, secure }) {
  return [
    `Max-Age=${maxAge}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export function readSessionToken(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 4096) return null
  let token = null
  for (const segment of cookieHeader.split(';')) {
    const separator = segment.indexOf('=')
    if (separator < 1) continue
    const name = segment.slice(0, separator).trim()
    if (name !== SESSION_COOKIE_NAME) continue
    if (token !== null) return null
    token = segment.slice(separator + 1).trim()
  }
  return token && SESSION_TOKEN_PATTERN.test(token) ? token : null
}

export function sessionCookie(token, { secure = false, maxAge = SESSION_COOKIE_MAX_AGE_SECONDS } = {}) {
  if (typeof token !== 'string' || !SESSION_TOKEN_PATTERN.test(token)) throw new TypeError('IDENTITY_SESSION_TOKEN_INVALID')
  return `${SESSION_COOKIE_NAME}=${token}; ${cookieAttributes({ maxAge, secure })}`
}

export function clearSessionCookie({ secure = false } = {}) {
  return `${SESSION_COOKIE_NAME}=; ${cookieAttributes({ maxAge: 0, secure })}`
}

export function isTrustedMutationOrigin(req) {
  const origin = req.headers?.origin
  if (origin === undefined) return true
  const host = req.headers?.host
  if (typeof origin !== 'string' || typeof host !== 'string' || !host) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && !parsed.username
      && !parsed.password
      && parsed.origin === origin
      && parsed.host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

export function requestUsesSecureTransport(req) {
  return req.socket?.encrypted === true
}
