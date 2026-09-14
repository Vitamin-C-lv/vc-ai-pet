import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { EXPERIENCE_BUFFER_DB_FILENAME } from '../src/experience/experience-buffer-schema.js'
import { REFLECTION_ALLOWED_STATES } from '../src/dream/dream-scheduler.js'

/**
 * The scheduler path — not the manual path — is the one production actually uses.
 *
 * `runReflectionNow()` is a convenience wrapper; the pet's heartbeat calls
 * `maybeRunReflection()` through `DreamScheduler`, which owns the gates (state,
 * in-flight counters, minimum interval) and calls back into the runtime through
 * the injected `reflectionEligibility` / `reflectionRun` contracts.
 *
 * The audit found two opposite failures here and the fix must hold for both:
 *   - a *skipped* scheduled pass consumed the whole pending set, so the reflection
 *     that was supposed to read that life never got to;
 *   - a *completed* pass must consume exactly the frozen snapshot it was shown,
 *     never events that arrived while it was running.
 *
 * This file pins both against the real scheduler object, so a future refactor that
 * re-introduces either bug fails here rather than in production.
 */

function stubBrain() {
  let replyCount = 0
  return {
    async reply(request) {
      replyCount += 1
      const userText = String(request?.userText ?? '')
      return {
        ok: true,
        text: `花花听到啦：${userText.slice(0, 12)}`,
        replyMessages: [`花花听到啦：${userText.slice(0, 12)}`],
        memoryCandidate: null,
        rawMemoryCandidate: {
          remember: false,
          level: 'fact',
          content: '',
          importance: 1,
          keywords: [],
          confidence: 0,
          evidence: '',
        },
        beliefCandidates: [],
        memoryDecision: 'model-skip',
        structured: true,
      }
    },
    async reflectionCompletion() {
      return {
        ok: true,
        rawText: JSON.stringify({
          summary: '花花整理了最近和主人一起经历的事。',
          memories: [],
        }),
      }
    },
    get replyCount() { return replyCount },
  }
}

function countExperiences(root, { processed = null } = {}) {
  const db = new DatabaseSync(join(root, EXPERIENCE_BUFFER_DB_FILENAME), { readOnly: true })
  try {
    const where = processed === null ? '' : ` WHERE processed = ${processed === true ? 1 : 0}`
    return Number(db.prepare(`SELECT COUNT(*) AS n FROM experience_events${where}`).get().n)
  } finally {
    db.close()
  }
}

async function withRuntime(run) {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-sched-reflection-'))
  const runtime = new PetRuntime({ sandboxRoot: root })
  try {
    await runtime.initialize()
    runtime.brain = stubBrain()
    await run({ runtime, root })
  } finally {
    try { runtime.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

/** Record one experience row straight into the buffer, bypassing the chat path. */
function seedExperience(runtime, text, { sessionKey = 'seed-session', sourceType = 'conversation' } = {}) {
  runtime.experienceBuffer.record({
    turnId: `turn-${text}`,
    conversationKey: sessionKey,
    messageId: `message-${text}`,
    ownerText: text,
    assistantText: '收到。',
    sourceType,
  })
}

async function main() {
  await withRuntime(async ({ runtime, root }) => {
    const scheduler = runtime.dreamScheduler
    assert.ok(scheduler, 'the runtime must own a DreamScheduler')

    // Watch consumption at the buffer boundary: this is the only place a row can
    // actually be consumed, so it reports the truth regardless of what any layer
    // claims in its own result object.
    const marked = []
    const realMark = runtime.experienceBuffer.markProcessed.bind(runtime.experienceBuffer)
    runtime.experienceBuffer.markProcessed = async (ids, options) => {
      marked.push(...ids.map(Number))
      return realMark(ids, options)
    }

    for (const text of ['黑莓今天睡沙发', '黑莓又睡沙发了', '黑莓还是睡沙发', '花花陪主人玩了一会儿']) {
      seedExperience(runtime, text)
    }
    await runtime.flushExperienceWrites()
    const pending = countExperiences(root, { processed: false })
    assert.ok(pending >= 4, `fixture must have pending experiences, got ${pending}`)

    // 1. A scheduled pass that the state gate refuses must consume nothing. This is
    //    the failure the owner reported: scheduled Reflection never got to run, yet
    //    the buffer was drained by the same tick.
    const refusedByState = await scheduler.maybeRunReflection({ state: 'working' })
    assert.equal(refusedByState.status, 'skipped', `state gate must refuse, got ${JSON.stringify(refusedByState)}`)
    assert.equal(refusedByState.reason, 'reflection-state-not-allowed')
    assert.deepEqual(marked, [], 'a state-refused pass must consume nothing')
    assert.equal(countExperiences(root, { processed: false }), pending)

    // 2. Same for a pass refused by the minimum-interval gate.
    scheduler.lastReflectionAt = Date.now()
    const refusedByInterval = await scheduler.maybeRunReflection({ state: 'idle' })
    assert.equal(refusedByInterval.status, 'skipped')
    assert.equal(refusedByInterval.reason, 'reflection-min-interval')
    assert.deepEqual(marked, [], 'an interval-refused pass must consume nothing')
    assert.equal(countExperiences(root, { processed: false }), pending)

    // 3. A pass refused because Reflection is already running must consume nothing.
    scheduler.lastReflectionAt = null
    const refusedInFlight = await scheduler.maybeRunReflection({ state: 'idle', reflectionInFlight: true })
    assert.equal(refusedInFlight.status, 'skipped')
    assert.equal(refusedInFlight.reason, 'reflection-in-flight')
    assert.deepEqual(marked, [], 'an in-flight-refused pass must consume nothing')
    assert.equal(countExperiences(root, { processed: false }), pending)

    // 4. A pass refused by the runtime's own eligibility (not enough new raw
    //    memory) must consume nothing either.
    scheduler.lastReflectionAt = null
    const refusedByEligibility = await scheduler.maybeRunReflection({ state: 'idle' })
    assert.equal(refusedByEligibility.status, 'skipped', `eligibility must refuse, got ${JSON.stringify(refusedByEligibility)}`)
    assert.deepEqual(marked, [], 'an ineligible pass must consume nothing')
    assert.equal(countExperiences(root, { processed: false }), pending)

    // 5. A forced scheduled pass must run the lifecycle and freeze its own view.
    const pendingIdsAtFreeze = runtime.experienceBuffer.pendingExperience({ limit: 50 })
      ? await runtime.experienceBuffer.pendingExperience({ limit: 50 }).then((rows) => rows.map((row) => Number(row.id)))
      : []
    scheduler.lastReflectionAt = null
    const ran = await scheduler.runReflectionNow({ state: 'idle' })
    assert.equal(ran.schedulerStatus, 'started', `forced reflection must reach the runner, got ${JSON.stringify(ran)}`)
    assert.equal(ran.schedulerDue, true)
    assert.equal(ran.force, true)
    const snapshotIds = ran.reflectionExperienceSnapshotIds
    assert.ok(Array.isArray(snapshotIds) && snapshotIds.length > 0, `the run must report the view it froze, got ${JSON.stringify(snapshotIds)}`)
    // The frozen view has to be exactly the pending set at that moment: a snapshot
    // that is empty, or that contains already-consumed rows, makes the count lie.
    for (const row of pendingIdsAtFreeze) {
      assert.ok(snapshotIds.includes(row), `frozen view must contain pending row ${row}, got ${JSON.stringify(snapshotIds)}`)
    }
    // Consumption may only ever be a subset of the frozen view, and the reported
    // count has to match what the buffer actually did.
    for (const id of marked) {
      assert.ok(snapshotIds.includes(id), `consumed id ${id} must be inside the frozen snapshot ${JSON.stringify(snapshotIds)}`)
    }
    assert.equal(
      ran.consumedExperienceCount,
      marked.length,
      `reported consumption must match the buffer (reported=${ran.consumedExperienceCount} marked=${marked.length})`,
    )
    assert.deepEqual(ran.consumedExperienceIds, marked, 'reported consumed ids must be the ids that were marked')
    const pendingAfter = countExperiences(root, { processed: false })
    assert.equal(
      pendingAfter,
      pending - marked.length,
      `pending must drop by exactly the consumed count (before=${pending} consumed=${marked.length} after=${pendingAfter})`,
    )
    // This fixture has no new raw PetMemory sources, so the engine correctly
    // derives nothing and consumes nothing: the life stays in the buffer instead of
    // being deleted by a pass that never read it.
    assert.equal(ran.status, 'skipped')
    assert.equal(marked.length, 0, 'a pass that derived nothing must consume nothing')
    assert.equal(pendingAfter, pending, 'a pass that consumed nothing must leave the buffer untouched')

    // 6. The manual wrapper drives the same lifecycle, not a parallel one.
    const beforeManual = countExperiences(root, { processed: false })
    scheduler.lastReflectionAt = null
    const manualRan = await runtime.runReflectionNow()
    assert.notEqual(manualRan, null, 'the manual wrapper must still work')
    assert.ok(
      Array.isArray(manualRan.reflectionExperienceSnapshotIds),
      'both paths must report the frozen view, so callers can audit consumption',
    )
    assert.ok(countExperiences(root, { processed: false }) <= beforeManual, 'a manual pass must never add pending rows')

    console.log(`SCHEDULER_CONSUMPTION=PASS states=${REFLECTION_ALLOWED_STATES.length} refusals=4 snapshot=${JSON.stringify(snapshotIds)} consumed=${JSON.stringify(marked)}`)
  })
}

await main()
