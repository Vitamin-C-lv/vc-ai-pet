import { assertLoopbackUrl } from '../core/pet-policy.js'
import { DEFAULT_RESOURCE_POLICY } from './resource-gate.js'

const REASONING_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max'])

// Per-feature reasoning is a Pet product policy, not a model/router decision.
// Keep the mapping in one place so every inference surface uses the same
// contract and no caller can silently promote a normal chat turn.
export const PET_REASONING_PROFILE = Object.freeze({
  chat: 'low',
  vision: 'medium',
  dream: 'high',
  reflection: 'off',
})

export function shouldUseFastVoiceMode({
  source,
  hasVision = false,
  explicitMemory = false,
  memoryFollowUp = false,
} = {}) {
  return source === 'stackchan-bridge'
    && !hasVision
    && !explicitMemory
    && !memoryFollowUp
}

export const DEFAULT_LOCAL_BRAIN_CONFIG = Object.freeze({
  baseUrl: 'http://127.0.0.1:17862',
  // Read-only probe of the shared service reports n_ctx=16384. This is a Pet
  // delivery budget only; it never changes Local Brain/model startup options.
  contextWindowTokens: 16_384,
  // Legacy config compatibility. LocalBrain selects the per-feature profile
  // below at each request; this field is not an override/router.
  reasoningEffort: PET_REASONING_PROFILE.chat,
  healthTimeoutMs: 1_500,
  requestTimeoutMs: 180_000,

  // Legacy compatibility only. Pet production inference no longer uses a GPU
  // busy gate; Local Brain API owns request admission and scheduling.
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

  if (!Number.isInteger(config.contextWindowTokens) || config.contextWindowTokens < 1) {
    throw new Error('PET_LOCAL_BRAIN_CONTEXT_WINDOW_INVALID')
  }

  return config
}
