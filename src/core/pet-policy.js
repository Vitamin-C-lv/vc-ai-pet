export const PET_POLICY = Object.freeze({
  hostAccess: 'NONE',
  shellAccess: 'NONE',
  resourceTelemetry: 'FIXED_NVIDIA_SMI_PROBE_ONLY',
  deepSeekUsage: 'NONE',
  dshToolAccess: 'NONE',
  memoryDatabase: 'FULLY_ISOLATED',
  networkAccess: 'LOOPBACK_ONLY_V0_2',
  modelStorage: 'D_DRIVE_ONLY',
  backupStorage: 'E_DRIVE_RESERVED',
})

export function assertPetPolicy() {
  if (PET_POLICY.hostAccess !== 'NONE') throw new Error('PET_POLICY_BROKEN: hostAccess')
  if (PET_POLICY.shellAccess !== 'NONE') throw new Error('PET_POLICY_BROKEN: shellAccess')
  if (PET_POLICY.resourceTelemetry !== 'FIXED_NVIDIA_SMI_PROBE_ONLY') throw new Error('PET_POLICY_BROKEN: telemetry')
  if (PET_POLICY.deepSeekUsage !== 'NONE') throw new Error('PET_POLICY_BROKEN: deepSeekUsage')
  if (PET_POLICY.memoryDatabase !== 'FULLY_ISOLATED') throw new Error('PET_POLICY_BROKEN: memoryDatabase')
  if (PET_POLICY.networkAccess !== 'LOOPBACK_ONLY_V0_2') throw new Error('PET_POLICY_BROKEN: networkAccess')
  if (PET_POLICY.modelStorage !== 'D_DRIVE_ONLY') throw new Error('PET_POLICY_BROKEN: modelStorage')
  return true
}

export function assertLoopbackUrl(value) {
  const url = new URL(value)
  const allowed = new Set(['127.0.0.1', 'localhost', '::1'])
  if (!allowed.has(url.hostname)) throw new Error(`PET_NETWORK_DENIED: ${url.hostname}`)
  return url
}
