const DEFAULT_UPSTREAM = 'http://127.0.0.1:17870'

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`)
  return parsed
}

export function readConfig(env = process.env) {
  const upstream = new URL(env.VC_AI_PET_UPSTREAM || DEFAULT_UPSTREAM)
  if (!['http:', 'https:'].includes(upstream.protocol)) throw new TypeError('VC_AI_PET_UPSTREAM must use HTTP or HTTPS')

  return {
    upstreamUrl: new URL('/api/pet/state', upstream),
    bindAddress: env.STACKCHAN_BRIDGE_BIND || '127.0.0.1',
    port: positiveInteger(env.STACKCHAN_BRIDGE_PORT, 17871, 'STACKCHAN_BRIDGE_PORT'),
    upstreamTimeoutMs: positiveInteger(env.STACKCHAN_UPSTREAM_TIMEOUT_MS, 1500, 'STACKCHAN_UPSTREAM_TIMEOUT_MS'),
    stateMaxAgeMs: positiveInteger(env.STACKCHAN_STATE_MAX_AGE_MS, 10_000, 'STACKCHAN_STATE_MAX_AGE_MS'),
  }
}
