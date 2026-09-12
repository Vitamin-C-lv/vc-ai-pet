import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import {
  highPriorityMemoryCandidate,
  userOptedOutOfMemory,
} from '../src/brain/memory-candidate.js'

const IMAGE = 'data:image/png;base64,QUFB'
const IMAGE_OBSERVATION = '图像观察：黑莓有一条白色花纹（模型候选）'

function visualStepAnswer() {
  return {
    ok: true,
    observation: '图中看到了黑莓。',
    action: 'answer',
    nextVisualId: '',
    focus: '黑莓',
    replyMessages: ['花花看到了。'],
    // These fields intentionally look like a memory proposal. Visual turns
    // must never pass them to MemoryGate.
    remember: true,
    level: 'fact',
    content: IMAGE_OBSERVATION,
    importance: 3,
    keywords: ['黑莓'],
    confidence: 1,
    evidence: IMAGE_OBSERVATION,
  }
}

function stubBrain() {
  return {
    visualStep: async () => visualStepAnswer(),
    reply: async () => ({
      ok: true,
      text: '花花听到啦。',
      replyMessages: ['花花听到啦。'],
      memoryCandidate: null,
      rawMemoryCandidate: null,
    }),
  }
}

async function withRuntime(fn) {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vision-explicit-memory-'))
  const runtime = new PetRuntime({ sandboxRoot: root })
  try {
    await runtime.initialize()
    runtime.brain = stubBrain()
    return await fn({ runtime, root })
  } finally {
    try { runtime.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

function allMemoryRows(runtime) {
  return ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
    .flatMap((level) => runtime.memory.db.list(level))
}

const optOutCases = [
  '不要记住', '别记住', '不用记住', '不许记住',
  '不要记', '别记', '不用记',
  '不要保存', '别保存', '不用保存',
  '不要存', '别存', '不用存',
  '不要记录下来', '别记录下来',
  '不必记住', '不需要记住',
]
for (const text of optOutCases) {
  assert.equal(userOptedOutOfMemory(text), true, `must remain opt-out: ${text}`)
  assert.equal(highPriorityMemoryCandidate(text), null, `opt-out must not create a candidate: ${text}`)
}

for (const text of ['不要记错花纹', '别记混了', '不要记反', '不要记岔']) {
  assert.equal(userOptedOutOfMemory(text), false, `accuracy request is not opt-out: ${text}`)
  assert.equal(highPriorityMemoryCandidate(text), null, `bare accuracy phrase has no claim: ${text}`)
}
console.log('OPT_OUT_MATRIX=PASS')

await withRuntime(async ({ runtime }) => {
  const explicitWithImageText = '你要记住黑莓的样子哦，不要记错花纹了'
  const imageWithExplicit = await runtime.chat(explicitWithImageText, { dataUrl: IMAGE })
  assert.equal(imageWithExplicit.memoryWrite, 'written')
  assert.equal(imageWithExplicit.memoryPriority, 'HIGH')

  const recalled = runtime.memory.recall('黑莓', 5)
  const rememberedBlackberry = recalled.find((row) => String(row.content).includes('黑莓的样子'))
  assert.ok(rememberedBlackberry, `explicit visual memory was not recallable: ${JSON.stringify(recalled)}`)
  assert.match(rememberedBlackberry.content, /黑莓的样子哦，不要记错花纹了/u)
  assert.equal(rememberedBlackberry.provenance?.evidenceQuote, '黑莓的样子哦，不要记错花纹了')
  assert.equal(rememberedBlackberry.source_session, 'vc-ai-pet')
  console.log('IMAGE_EXPLICIT_MEMORY=written')

  const imageWithoutExplicit = await runtime.chat('你看黑莓在凳子上', { dataUrl: IMAGE })
  assert.equal(imageWithoutExplicit.memoryWrite, 'skipped')
  assert.equal(imageWithoutExplicit.memoryWriteReason, 'vision-context')
  console.log('IMAGE_NO_EXPLICIT_MEMORY=skipped/vision-context')

  const beforeVisualCandidate = allMemoryRows(runtime).filter((row) => String(row.content).includes(IMAGE_OBSERVATION)).length
  assert.equal(beforeVisualCandidate, 0)
  assert.equal(
    allMemoryRows(runtime).some((row) => String(row.content).includes(IMAGE_OBSERVATION)),
    false,
    'visual model observation must not become PetMemory',
  )
  console.log('VISUAL_MODEL_CANDIDATE=not-written')

  const textWithExplicit = await runtime.chat('记住我们家的猫叫黑莓')
  assert.equal(textWithExplicit.memoryWrite, 'written', JSON.stringify(textWithExplicit))
  console.log('NO_IMAGE_EXPLICIT_MEMORY=written')

  const textWithoutExplicit = await runtime.chat('今天只是普通聊天')
  assert.equal(textWithoutExplicit.memoryWrite, 'skipped')
  assert.equal(textWithoutExplicit.memoryWriteReason, undefined)
  console.log('NO_IMAGE_NO_EXPLICIT_MEMORY=skipped/model-skip')

  const beforeSensitive = allMemoryRows(runtime).length
  const sensitive = await runtime.chat('记住我的密码是 x', { dataUrl: IMAGE })
  assert.equal(sensitive.memoryWrite, 'skipped')
  assert.equal(sensitive.memoryWriteReason, 'memory-sensitive-reject')
  assert.equal(allMemoryRows(runtime).length, beforeSensitive)
  console.log('IMAGE_SENSITIVE_EXPLICIT_MEMORY=skipped/memory-sensitive-reject')
})

console.log('VC_AI_PET_V0_4_VISION_EXPLICIT_MEMORY=PASS')
