import assert from 'node:assert/strict'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { PET_POLICY, assertLoopbackUrl, assertPetPolicy } from '../src/core/pet-policy.js'
import { validateLocalBrainConfig } from '../src/brain/local-brain-config.js'
import { buildPetMessages, petAgeContext } from '../src/brain/prompt-builder.js'
import { DEFAULT_RESOURCE_POLICY, busyPetLine } from '../src/brain/resource-gate.js'

assert.equal(assertPetPolicy(), true)
assert.equal(PET_POLICY.deepSeekUsage, 'NONE')
assert.equal(PET_POLICY.networkAccess, 'LOOPBACK_ONLY_V0_2')
assert.equal(PET_POLICY.localBrainAccess, 'LOCAL_BRAIN_API_V1_ONLY')
assert.equal(PET_POLICY.localBrainLifecycle, 'EXTERNAL_SHARED_SERVICE')

assert.equal(LI_HUAHUA_IDENTITY.name, '李花花')
assert.equal(LI_HUAHUA_IDENTITY.species, 'dog')
assert.equal(LI_HUAHUA_IDENTITY.breedZh, '伯恩山犬')
assert.equal(LI_HUAHUA_IDENTITY.birthday, '2026-08-31')

const config = validateLocalBrainConfig()
assert.equal(config.baseUrl, 'http://127.0.0.1:17862')
assert.equal(config.reasoningEffort, 'low')
assert.equal(config.resourceGate.minFreeVramMiB, 0)
assert.equal(config.resourceGate.maxGpuUtilizationPct, 55)

for (const forbidden of [
  'modelDir',
  'modelPath',
  'mmprojPath',
  'runtimeDir',
  'serverBinary',
  'cacheDir',
  'tempDir',
  'host',
  'port',
  'ctxSize',
  'gpuLayers',
  'sleepIdleSeconds',
  'modelAlias',
]) {
  assert.equal(Object.hasOwn(config, forbidden), false, `Pet config must not expose ${forbidden}`)
}

assert.equal(assertLoopbackUrl('http://127.0.0.1:17862').hostname, '127.0.0.1')
assert.throws(() => assertLoopbackUrl('https://api.deepseek.com'))

const messages = buildPetMessages({
  identity: LI_HUAHUA_IDENTITY,
  state: { mood: .8, energy: .4, boredom: .2, sleepiness: .6, attachment: .7 },
  memories: [{ level: 'fact', content: '今天主人摸了我一次。' }],
  userText: '花花你困不困？',
  now: new Date(2026, 7, 31),
})
assert.equal(messages.length, 2)
assert.match(messages[0].content, /李花花/)
assert.match(messages[0].content, /2026-08-31/)
assert.match(messages[0].content, /不是 AI 助手/)
assert.match(messages[1].content, /花花你困不困/)

assert.deepEqual(petAgeContext('2026-08-31', new Date(2026, 7, 31)), {
  today: '2026-08-31',
  age: 0,
  isBirthday: true,
})
assert.equal(petAgeContext('2026-08-31', new Date(2027, 7, 30)).age, 0)
assert.equal(petAgeContext('2026-08-31', new Date(2027, 7, 31)).age, 1)

assert.equal(DEFAULT_RESOURCE_POLICY.maxGpuUtilizationPct, 55)
assert.match(busyPetLine('gpu-busy'), /主人/)
assert.equal(PET_POLICY.resourceTelemetry, 'FIXED_NVIDIA_SMI_PROBE_ONLY')

console.log('VC_AI_PET_V0_2_CORE_SMOKE=PASS')
