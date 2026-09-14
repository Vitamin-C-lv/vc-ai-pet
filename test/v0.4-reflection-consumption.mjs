import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PetRuntime } from '../src/runtime/pet-runtime.js'

const LIMIT = 10

async function fixture(name, outcome, { addDuringRun = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-reflection-consumption-${name}-`))
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  for (let index = 1; index <= LIMIT; index += 1) {
    runtime.experienceBuffer.record({
      ownerText: `我的生日是 3 月 ${index} 日。`,
      conversationId: `old-${index}`,
    })
  }
  await runtime.flushExperienceWrites()
  const initial = await runtime.experienceBuffer.pendingExperience({ limit: 50 })
  assert.equal(initial.length, LIMIT)

  let snapshotSeen = null
  runtime.reflectionEngine = {
    isInFlight: () => false,
    run: async () => {
      snapshotSeen = runtime.reflectionExperienceSnapshot
      if (addDuringRun) {
        runtime.experienceBuffer.record({
          ownerText: '我的生日是 12 月 31 日。',
          conversationId: 'new-1',
        })
        runtime.experienceBuffer.record({
          ownerText: '我的生日是 1 月 1 日。',
          conversationId: 'new-2',
        })
      }
      return outcome
    },
  }

  try {
    const result = await runtime.runReflectionNow()
    await runtime.flushExperienceWrites()
    const pending = await runtime.experienceBuffer.pendingExperience({ limit: 50 })
    return { runtime, root, result, pending, snapshotSeen }
  } catch (error) {
    runtime.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

// A: a successful pass consumes exactly the ten rows captured before it.
{
  const fixtureResult = await fixture('success', { status: 'completed', ok: true })
  try {
    assert.equal(fixtureResult.result.status, 'completed')
    assert.equal(fixtureResult.pending.length, 0)
    assert.deepEqual(fixtureResult.result.consumedExperienceIds.length, LIMIT)
    console.log('REFLECTION_SUCCESS_CONSUMES_SNAPSHOT=PASS')
  } finally {
    fixtureResult.runtime.close()
    await rm(fixtureResult.root, { recursive: true, force: true })
  }
}

// B: rows arriving while the model is running remain pending.
{
  const fixtureResult = await fixture('late-arrivals', { status: 'completed', ok: true }, { addDuringRun: true })
  try {
    assert.deepEqual(fixtureResult.snapshotSeen.ids.length, LIMIT)
    assert.deepEqual(fixtureResult.snapshotSeen.rows.map((row) => row.id), fixtureResult.snapshotSeen.ids)
    assert.equal(fixtureResult.pending.length, 2)
    assert.equal(fixtureResult.result.consumedExperienceCount, LIMIT)
    console.log('REFLECTION_LATE_ARRIVALS_STAY_PENDING=PASS')
  } finally {
    fixtureResult.runtime.close()
    await rm(fixtureResult.root, { recursive: true, force: true })
  }
}

// C/D: skipped and failed runs consume nothing.
for (const [label, outcome] of [
  ['skipped', { status: 'skipped', ok: false, reason: 'stub-skipped' }],
  ['failed', { status: 'failed', ok: false, reason: 'stub-failed' }],
]) {
  const fixtureResult = await fixture(label, outcome)
  try {
    assert.equal(fixtureResult.result.status, outcome.status)
    assert.equal(fixtureResult.pending.length, LIMIT)
    assert.deepEqual(fixtureResult.result.consumedExperienceIds, [])
    console.log(`REFLECTION_${label.toUpperCase()}_CONSUMES_ZERO=PASS`)
  } finally {
    fixtureResult.runtime.close()
    await rm(fixtureResult.root, { recursive: true, force: true })
  }
}

// C: processed experience remains part of Dream's recent-life view, while a
// later Reflection snapshot only contains still-pending rows.
{
  const fixtureResult = await fixture('semantic-split', { status: 'completed', ok: true })
  try {
    const recent = await fixtureResult.runtime.recentExperienceContext({ limit: 50 })
    assert.equal(recent.entries.length, LIMIT)
    assert.ok(recent.entries.every((row) => row.processed === true))
    fixtureResult.runtime.experienceBuffer.record({ ownerText: '我的生日是 2 月 2 日。', conversationId: 'pending-after' })
    await fixtureResult.runtime.flushExperienceWrites()
    const pending = await fixtureResult.runtime.experienceBuffer.pendingExperience({ limit: 50 })
    assert.equal(pending.length, 1)
    assert.equal(pending[0].conversationId, 'pending-after')
    console.log('PROCESSED_REFED_TO_REFLECTION=NO')
    console.log('PROCESSED_VISIBLE_TO_DREAM=YES')
  } finally {
    fixtureResult.runtime.close()
    await rm(fixtureResult.root, { recursive: true, force: true })
  }
}

console.log('VC_AI_PET_V0_4_REFLECTION_CONSUMPTION=PASS')
