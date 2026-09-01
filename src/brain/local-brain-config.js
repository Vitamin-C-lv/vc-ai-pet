import { assertLoopbackUrl } from '../core/pet-policy.js'
import { DEFAULT_RESOURCE_POLICY } from './resource-gate.js'

const REASONING_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max'])

export const DEFAULT_LOCAL_BRAIN_CONFIG = Object.freeze({
  baseUrl: 'http://127.0.0.1:17862',
  reasoningEffort: 'off',
  healthTimeoutMs: 1_500,
  requestTimeoutMs: 60_000,

  // Pet may still decide not to ASK the shared brain while the owner is busy.
  // It must never start/stop/reconfigure the shared Local Brain service.
  // VRAM free-space is intentionally disabled as a Pet-side gate because the
  // shared Local Brain service itself owns the loaded model allocation.
  resourceGate: {
    ...DEFAULT_RESOURCE_POLICY,
    minFreeVramMiB: 0,
  },
})

export function validateLocalBrainConfig(raw = {}) {
  const config = {
    ...DEFAULT_LOCAL_BRAIN_CONFIG,
    ...raw,
    resourceGate: {
      ...DEFAULT_LOCAL_BRAIN_CONFIG.resourceGate,
      ...(raw.resourceGate ?? {}),
    },
  }

  const url = assertLoopbackUrl(config.baseUrl)
  if (url.protocol !== 'http:') {
    throw new Error('PET_LOCAL_BRAIN_API_MUST_USE_HTTP_LOOPBACK')
  }

  if (!REASONING_EFFORTS.has(config.reasoningEffort)) {
    throw new Error(`PET_LOCAL_BRAIN_REASONING_EFFORT_INVALID:${config.reasoningEffort}`)
  }

  for (const key of ['healthTimeoutMs', 'requestTimeoutMs']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new Error(`PET_LOCAL_BRAIN_TIMEOUT_INVALID:${key}`)
    }
  }

  return config
}
