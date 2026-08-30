export const PET_IDENTITY_SCHEMA_VERSION = 1

export const LI_HUAHUA_IDENTITY = Object.freeze({
  schemaVersion: PET_IDENTITY_SCHEMA_VERSION,
  name: '李花花',
  species: 'dog',
  speciesZh: '狗',
  breed: 'Bernese Mountain Dog',
  breedZh: '伯恩山犬',
  birthday: '2026-08-31',
  birthEvent: 'VC_AI_PET_V0_1_PASS',
})

export async function ensurePetIdentity(sandbox, state, now = Date.now()) {
  const existing = await sandbox.readJson('world', 'identity.json', null)
  const identity = {
    ...LI_HUAHUA_IDENTITY,
    bornAt: existing?.bornAt ?? state?.bornAt ?? null,
    namedAt: existing?.namedAt ?? now,
  }
  const unchanged = existing && Object.entries(identity).every(([k,v]) => existing[k] === v)
  if (!unchanged) await sandbox.writeJson('world', 'identity.json', identity)
  return identity
}
