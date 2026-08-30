import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEFAULT_RESOURCE_POLICY = Object.freeze({
  enabled: true,
  gpuIndex: 0,
  maxGpuUtilizationPct: 55,
  minFreeVramMiB: 6144,
  sampleTimeoutMs: 1800,
  probeIntervalMs: 15_000,
})

const NVIDIA_SMI_CANDIDATES = Object.freeze([
  'nvidia-smi',
  '/usr/lib/wsl/lib/nvidia-smi',
])

function parseCsvLine(text) {
  const [util, free, used, total] = String(text)
    .trim()
    .split(',')
    .map((x) => Number(String(x).trim()))

  if (![util, free, used, total].every(Number.isFinite)) {
    throw new Error(`PET_GPU_STATUS_PARSE_FAILED: ${text}`)
  }

  return {
    utilizationPct: util,
    freeVramMiB: free,
    usedVramMiB: used,
    totalVramMiB: total,
  }
}

async function runFixedProbe(binary, policy) {
  const args = [
    `--id=${policy.gpuIndex}`,
    '--query-gpu=utilization.gpu,memory.free,memory.used,memory.total',
    '--format=csv,noheader,nounits',
  ]

  const { stdout } = await execFileAsync(binary, args, {
    timeout: policy.sampleTimeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024,
  })

  const line = stdout.split(/\r?\n/).find((x) => x.trim())
  if (!line) throw new Error('PET_GPU_STATUS_EMPTY')

  return {
    ...parseCsvLine(line),
    probe: binary,
  }
}

export async function readNvidiaStatus(rawPolicy = {}) {
  const policy = { ...DEFAULT_RESOURCE_POLICY, ...rawPolicy }
  let lastError

  for (const binary of NVIDIA_SMI_CANDIDATES) {
    try {
      return await runFixedProbe(binary, policy)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError ?? new Error('PET_GPU_STATUS_UNAVAILABLE')
}

export async function evaluateLocalBrainAvailability(rawPolicy = {}) {
  const policy = { ...DEFAULT_RESOURCE_POLICY, ...rawPolicy }

  if (!policy.enabled) {
    return { available: true, reason: 'resource-gate-disabled', sample: null }
  }

  let sample
  try {
    sample = await readNvidiaStatus(policy)
  } catch (error) {
    // Fail closed. If the plugin cannot prove the GPU is available,
    // it must not load a persistent local model.
    return {
      available: false,
      reason: 'gpu-status-unavailable',
      detail: error?.message ?? String(error),
      sample: null,
    }
  }

  if (sample.utilizationPct >= policy.maxGpuUtilizationPct) {
    return { available: false, reason: 'gpu-busy', sample }
  }

  if (sample.freeVramMiB < policy.minFreeVramMiB) {
    return { available: false, reason: 'vram-busy', sample }
  }

  return { available: true, reason: 'available', sample }
}

export function busyPetLine(reason) {
  if (reason === 'gpu-busy' || reason === 'vram-busy') {
    return '主人好像在忙……为什么不陪花花玩呀？'
  }
  if (reason === 'gpu-status-unavailable') {
    return '花花先安静待一会儿，等主人忙完再陪我。'
  }
  return '花花先在旁边等主人。'
}
