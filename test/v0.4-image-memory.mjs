import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { EXPERIENCE_BUFFER_DB_FILENAME } from '../src/experience/experience-buffer-schema.js'

/**
 * Image memory — "a picture the owner showed is part of the pet's life".
 *
 * What is asserted here:
 * 1. A visual turn records what the pet *actually perceived* (the sanitized
 *    observation from the vision step), not the old placeholder sentence.
 * 2. The picture produces two rows in PetMemory with two different evidence
 *    classes: an owner-confirmed anchor ("主人给花花看过一张图片") and an
 *    inferred observation ("花花看过这张图片，看到的是…").
 * 3. Nothing writes an image payload into memory or the buffer — only the
 *    attachment id, so the original file stays under ConversationStore and can
 *    be re-opened later.
 * 4. The pet can look at the remembered picture again (`reInspectVisualMemory`)
 *    and consolidation performs that refresh itself, writing a new inferred row
 *    that cites the anchor instead of trusting a stale sentence.
 */

// A real 1x1 PNG. The fixture must be a genuine image: re-inspection validates
// the file signature before handing anything to the brain, so a placeholder
// payload would be (correctly) refused and silently skip the re-open path.
const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const OBSERVATION = '图中是一只白底黑斑的猫，正趴在窗台的花盆旁边。'
const FOCUS = '猫和花盆'

function stubBrain({ observation = OBSERVATION, focus = FOCUS } = {}) {
  const calls = { reply: 0, visualStep: 0 }
  return {
    calls,
    async reply(request) {
      calls.reply += 1
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
    async visualStep() {
      calls.visualStep += 1
      return {
        ok: true,
        observation,
        action: 'answer',
        nextVisualId: '',
        focus,
        replyMessages: ['花花看到了。'],
      }
    },
  }
}

async function withRuntime(run, { brain = stubBrain() } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-image-memory-'))
  const runtime = new PetRuntime({ sandboxRoot: root })
  try {
    await runtime.initialize()
    runtime.brain = brain
    return await run({ runtime, root, brain })
  } finally {
    try { runtime.close() } catch {}
    await rm(root, { recursive: true, force: true })
  }
}

function allMemoryRows(runtime) {
  return ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
    .flatMap((level) => runtime.memory.db.list(level))
    // The meow-memory row keeps its legacy columns; provenance lives in the
    // side table and is resolved through the store, exactly as recall does.
    .map((row) => ({ ...row, provenance: runtime.memory.provenanceStore.resolve(row) }))
}

function bufferRows(root) {
  const db = new DatabaseSync(join(root, EXPERIENCE_BUFFER_DB_FILENAME), { readOnly: true })
  try {
    return db.prepare('SELECT * FROM experience_events ORDER BY id').all()
  } finally {
    db.close()
  }
}

/** 1 — the pet's real perception survives a visual turn. */
async function caseObservationIsRecorded() {
  await withRuntime(async ({ runtime, root }) => {
    const turn = await runtime.chat('看看这张图', { dataUrl: IMAGE })
    assert.equal(turn.ok, true, 'a visual turn must succeed')
    await runtime.flushExperienceWrites()

    const rows = bufferRows(root)
    assert.equal(rows.length, 1, `exactly one experience row, got ${rows.length}`)
    const row = rows[0]
    assert.equal(row.source_type, 'pet_vision', 'an image turn stays a visual experience')

    const serialized = JSON.stringify(row)
    assert.ok(
      serialized.includes(OBSERVATION),
      'the real observation must be persisted, not the placeholder sentence',
    )
    assert.ok(
      !serialized.includes('主人这一轮发送了图片')
      || !Buffer.from(serialized).includes(Buffer.from(OBSERVATION)) === false,
      'the placeholder may stay as a compatibility field but must not be the content',
    )
    assert.equal(
      serialized.includes('base64'),
      false,
      'an image payload must never reach the experience buffer',
    )
    console.log('CASE_IMAGE_OBSERVATION_RECORDED=PASS')
  })
}

/** 2 — two evidence classes, one picture. */
async function caseImageMemoryHasTwoEvidenceClasses() {
  await withRuntime(async ({ runtime }) => {
    const turn = await runtime.chat('看看这张图', { dataUrl: IMAGE })
    assert.equal(turn.ok, true)
    assert.equal(turn.imageMemory, 'written', `image memory must be written, got ${turn.imageMemory}`)

    const rows = allMemoryRows(runtime)
    const anchor = rows.find((row) => String(row.content).includes('主人给花花看过一张图片'))
    const observation = rows.find((row) => String(row.content).includes('花花看过这张图片'))
    assert.ok(anchor, 'the owner-confirmed anchor row must exist')
    assert.ok(observation, 'the inferred observation row must exist')

    assert.equal(anchor.provenance.source, 'SYSTEM_EVENT')
    assert.equal(anchor.provenance.evidence, 'confirmed')
    assert.equal(observation.provenance.source, 'VISUAL_OBSERVATION')
    assert.equal(
      observation.provenance.evidence,
      'inferred',
      'what the pet saw can never present itself as a confirmed fact',
    )
    assert.ok(
      observation.provenance.sourceIds.includes(anchor.id),
      'the observation must cite the image anchor as its source root',
    )
    assert.ok(
      String(observation.content).includes(OBSERVATION),
      'the memory row must carry what the pet actually saw',
    )
    console.log('CASE_IMAGE_MEMORY_TWO_EVIDENCE_CLASSES=PASS')
  })
}

/** 3 — the same picture is remembered once. */
async function caseSameAttachmentRememberedOnce() {
  await withRuntime(async ({ runtime, root }) => {
    const attachment = await runtime.conversationStore.saveAttachment({ image: { dataUrl: IMAGE } })
    const first = await runtime.chat('看看这张图', { dataUrl: IMAGE }, attachment)
    const second = await runtime.chat('再看看这张', { dataUrl: IMAGE }, attachment)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(second.imageMemory, 'duplicate', 'one picture must not be remembered twice')

    const anchors = allMemoryRows(runtime)
      .filter((row) => String(row.content).includes('主人给花花看过一张图片'))
    assert.equal(anchors.length, 1, `exactly one anchor row, got ${anchors.length}`)
    console.log('CASE_IMAGE_REMEMBERED_ONCE=PASS')
  })
}

/** 4 — consolidation genuinely looks at the picture again. */
async function caseReinspectionOnConsolidation() {
  await withRuntime(async ({ runtime, brain }) => {
    await runtime.chat('看看这张图', { dataUrl: IMAGE })
    const before = brain.calls.visualStep
    assert.ok(before >= 1, 'the first look must have happened')

    const result = await runtime.consolidateExperiences({ limit: 20 })
    assert.ok(result, 'consolidation must return a result')
    assert.equal(
      result.visualReinspections,
      1,
      `consolidation must re-open the remembered picture, got ${JSON.stringify(result)}`,
    )
    assert.ok(brain.calls.visualStep > before, 're-inspection must call the vision step again')

    const refresh = allMemoryRows(runtime)
      .find((row) => String(row.content).includes('花花又看了一眼这张图片'))
    assert.ok(refresh, 'the refreshed observation must be written as its own row')
    assert.equal(refresh.provenance.evidence, 'inferred', 'a refreshed look is still an observation')

    // The second consolidation inside the cooldown must not look again.
    const again = await runtime.consolidateExperiences({ limit: 20 })
    assert.equal(
      again.visualReinspections,
      undefined,
      're-inspection must respect its cooldown instead of looping',
    )
    console.log('CASE_REINSPECTION_ON_CONSOLIDATION=PASS')
  })
}

/** 5 — a turn with no safe observation still records that the picture was shown. */
async function caseUnsafeObservationDegradesGracefully() {
  const brain = stubBrain({ observation: '', focus: '' })
  await withRuntime(async ({ runtime }) => {
    const turn = await runtime.chat('看看这张图', { dataUrl: IMAGE })
    assert.equal(turn.ok, true, 'a vision step that answers without an observation still succeeds')
    assert.equal(turn.imageMemory, 'written')
    const rows = allMemoryRows(runtime)
    assert.ok(
      rows.some((row) => String(row.content).includes('主人给花花看过一张图片')),
      'the confirmed anchor must exist even when nothing safe was perceived',
    )
    const observation = rows.find((row) => (
      row.provenance.source === 'VISUAL_OBSERVATION'
      || /花花看过这张图片|没有形成可以记住的确定印象/u.test(String(row.content))
    ))
    assert.equal(observation, undefined, 'no observation row without a safe observation')
    console.log('CASE_UNSAFE_OBSERVATION_DEGRADES=PASS')
  }, { brain })
}

/** 6 — an image must not become a side door around the Gate's vetoes. */
async function caseGateVetoesStillBlockImageMemory() {
  await withRuntime(async ({ runtime, root }) => {
    for (const [label, text, reason] of [
      ['敏感内容', '记住我的密码是 x', 'memory-sensitive-reject'],
      ['退出指令', '不要记住这张图', 'user-opt-out'],
    ]) {
      const before = allMemoryRows(runtime).length
      const turn = await runtime.chat(text, { dataUrl: IMAGE })
      assert.equal(turn.ok, true, `${label}: the turn itself must still succeed`)
      assert.equal(turn.imageMemory, 'skipped', `${label}: image memory must be withheld, got ${turn.imageMemory}`)
      assert.equal(
        allMemoryRows(runtime).length,
        before,
        `${label}: no PetMemory row may be written for a vetoed turn`,
      )
    }
    // The short-lived life record still exists: the buffer is not long-term memory.
    await runtime.flushExperienceWrites()
    assert.ok(bufferRows(root).length > 0, 'the turn still belongs to the buffer')
    console.log('CASE_IMAGE_MEMORY_RESPECTS_GATE_VETOES=PASS')
  })
}

await caseObservationIsRecorded()
await caseImageMemoryHasTwoEvidenceClasses()
await caseSameAttachmentRememberedOnce()
await caseReinspectionOnConsolidation()
await caseUnsafeObservationDegradesGracefully()
await caseGateVetoesStillBlockImageMemory()
console.log('VC_AI_PET_V0_4_IMAGE_MEMORY=PASS')
