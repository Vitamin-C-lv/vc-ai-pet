import { resolve, sep } from 'node:path'
import { assertLoopbackUrl } from '../core/pet-policy.js'

export const D_ROOT = '/mnt/d/VC-AI-Pet'

export const DEFAULT_LOCAL_BRAIN_CONFIG = Object.freeze({
  root: D_ROOT,
  modelDir: `${D_ROOT}/models/Qwen3.5-4B`,
  modelPath: `${D_ROOT}/models/Qwen3.5-4B/Qwen3.5-4B-Q4_K_M.gguf`,
  // v0.3 reserved only; v0.2 MUST NOT download or pass an mmproj file.
  mmprojPath: `${D_ROOT}/models/Qwen3.5-4B/mmproj-BF16.gguf`,
  runtimeDir: `${D_ROOT}/runtime/llama.cpp`,
  serverBinary: `${D_ROOT}/runtime/llama.cpp/llama-server.exe`,
  cacheDir: `${D_ROOT}/cache`,
  tempDir: `${D_ROOT}/temp`,
  host: '127.0.0.1',
  port: 17861,
  baseUrl: 'http://127.0.0.1:17861',
  ctxSize: 4096,
  gpuLayers: 999,
  sleepIdleSeconds: 900,
  modelAlias: 'li-huahua-local',
  visionEnabled: false,
  resourceGate: {
    enabled: true,
    gpuIndex: 0,
    maxGpuUtilizationPct: 55,
    minFreeVramMiB: 6144,
    sampleTimeoutMs: 1800,
    probeIntervalMs: 15_000,
  },
})

function insideDRoot(path) {
  const root = resolve(D_ROOT)
  const target = resolve(path)
  return target === root || target.startsWith(root + sep)
}

export function validateLocalBrainConfig(raw = {}) {
  const config = {
    ...DEFAULT_LOCAL_BRAIN_CONFIG,
    ...raw,
    resourceGate: {
      ...DEFAULT_LOCAL_BRAIN_CONFIG.resourceGate,
      ...(raw.resourceGate ?? {}),
    },
  }

  for (const key of ['modelDir', 'modelPath', 'cacheDir', 'tempDir']) {
    if (!insideDRoot(config[key])) {
      throw new Error(`PET_D_STORAGE_POLICY_DENIED: ${key}=${config[key]}`)
    }
  }

  assertLoopbackUrl(config.baseUrl)

  if (config.host !== '127.0.0.1') {
    throw new Error('PET_LOCAL_MODEL_MUST_BIND_127_0_0_1')
  }

  if (config.visionEnabled !== false) {
    throw new Error('PET_V0_2_VISION_MUST_REMAIN_DISABLED')
  }

  if (!config.modelPath.endsWith('/Qwen3.5-4B-Q4_K_M.gguf')) {
    throw new Error('PET_SINGLE_MODEL_POLICY_DENIED')
  }

  return config
}
