import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  VisualExperienceStore,
  VISUAL_BACKFILL_CURSOR_KEY,
  VISUAL_EXPERIENCE_DB_FILENAME,
} from '../src/vision/visual-experience-store.js'

const IMAGE = 'data:image/png;base64,QUFB'

function makeMessage(id, sequence, { role = 'user', text = '', attachment = null, timestamp = sequence * 1000 } = {}) {
  return { id, archiveSequence: sequence, role, text, timestamp, attachment }
}

function makeAttachment(id) {
  return { id, mimeType: 'image/png', assetPath: `conversation-assets/${id}.png` }
}

let idNumber = 0
function idFactory() {
  idNumber += 1
  return `id-${idNumber}`
}

function fakeTokenizer(text, { boost }) {
  return [...new Set(String(text).split(/\s+/u).filter(Boolean))]
    .map((term) => ({ term, weight: boost }))
}

async function listFiles(root) {
  return (await readdir(root)).sort()
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-experience-'))
  let store = null
  try {
    const rows = [
      makeMessage('m1', 1, { text: '以前 那盆 植物', attachment: makeAttachment('a1') }),
      makeMessage('m2', 2, { role: 'assistant', text: '我看到了。' }),
      makeMessage('m3', 3, { text: '客厅 的 花', attachment: makeAttachment('a2') }),
      makeMessage('m4', 4, { role: 'assistant', text: '好的。' }),
      makeMessage('m5', 5, { text: '窗边 的 猫', attachment: makeAttachment('a3') }),
      makeMessage('m6', 6, { role: 'assistant', text: '真可爱。' }),
      makeMessage('m7', 7, { text: '没有图片' }),
      makeMessage('m8', 8, { role: 'assistant', text: '收到。' }),
      makeMessage('m9', 9, { text: '纯文字' }),
      makeMessage('m10', 10, { role: 'assistant', text: '明白。' }),
    ]
    let maxSequence = 10
    const readBatch = async (cursor, batchSize) => rows.filter((row) => row.archiveSequence > cursor).slice(0, batchSize)
    const readMaxSequence = async () => maxSequence

    store = new VisualExperienceStore(root, { now: () => 5000, idFactory })
    await store.initialize()
    await store.initialize()
    const dbStat = await stat(join(root, VISUAL_EXPERIENCE_DB_FILENAME))
    assert.equal(dbStat.mode & 0o777, 0o600)
    const db = new DatabaseSync(join(root, VISUAL_EXPERIENCE_DB_FILENAME))
    try {
      const tableNames = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
      for (const table of ['visual_experiences', 'visual_events', 'visual_terms', 'visual_sync_state']) assert.ok(tableNames.includes(table))
    } finally {
      db.close()
    }
    const filesBeforeBackfill = await listFiles(root)

    const backfill = await store.syncFromArchive({ readBatch, readMaxSequence, tokenizeText: fakeTokenizer }, { batchSize: 4 })
    assert.deepEqual(backfill, {
      ok: true,
      processedCount: 10,
      createdCount: 3,
      skippedCount: 7,
      cursorBefore: 0,
      cursorAfter: 10,
      modelCalls: 0,
      petMemoryWrites: 0,
      dreamRuns: 0,
    })
    assert.equal(await store.countExperiences(), 3)
    assert.equal(await store.countRawRoots(), 3)
    assert.deepEqual(await listFiles(root), filesBeforeBackfill)
    assert.equal(backfill.modelCalls, 0)
    assert.equal(backfill.petMemoryWrites, 0)
    assert.equal(backfill.dreamRuns, 0)
    const secondBackfill = await store.syncFromArchive({ readBatch, readMaxSequence, tokenizeText: fakeTokenizer }, { batchSize: 4 })
    assert.equal(secondBackfill.createdCount, 0)
    assert.equal(secondBackfill.cursorBefore, 10)
    assert.equal(secondBackfill.cursorAfter, 10)

    store.close()
    store = new VisualExperienceStore(root, { now: () => 6000, idFactory })
    rows.push(makeMessage('m11', 11, { text: '书房 的 植物', attachment: makeAttachment('a4') }))
    maxSequence = 11
    const restarted = await store.syncFromArchive({ readBatch, readMaxSequence, tokenizeText: fakeTokenizer })
    assert.equal(restarted.cursorBefore, 10)
    assert.equal(restarted.cursorAfter, 11)
    assert.equal(restarted.createdCount, 1)
    assert.equal(await store.countRawRoots(), 4)
    const cursorDb = new DatabaseSync(join(root, VISUAL_EXPERIENCE_DB_FILENAME))
    try {
      assert.equal(cursorDb.prepare('SELECT value FROM visual_sync_state WHERE key = ?').get(VISUAL_BACKFILL_CURSOR_KEY).value, '11')
    } finally {
      cursorDb.close()
    }

    const duplicate = await store.syncMessage(rows[10], { archiveSequence: 12, tokenizeText: fakeTokenizer })
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.experienceId, (await store.findExperienceByMessageId('m11')).experienceId)
    const single = makeMessage('m12', 13, { text: '另一张 图片', attachment: makeAttachment('a5') })
    const createdSingle = await store.syncMessage(single, { archiveSequence: 13, tokenizeText: fakeTokenizer })
    assert.equal(createdSingle.created, true)
    assert.equal(await store.countRawRoots(), 5)
    const afterSingleDuplicate = await store.syncMessage(single, { archiveSequence: 13 })
    assert.equal(afterSingleDuplicate.created, false)
    assert.equal(afterSingleDuplicate.experienceId, createdSingle.experienceId)

    const experienceA = await store.findExperienceByMessageId('m1')
    const experienceB = await store.findExperienceByMessageId('m3')
    assert.ok(experienceA)
    assert.ok(experienceB)
    const inspection = await store.recordEvent({ experienceId: experienceA.experienceId, kind: 'inspection', occurredAt: 7000, focus: '植物' })
    const revisit = await store.recordEvent({ experienceId: experienceA.experienceId, kind: 'revisit', occurredAt: 8000 })
    assert.equal(inspection.evidence, 'inferred')
    assert.equal(revisit.kind, 'revisit')
    assert.equal((await store.findExperienceById(experienceA.experienceId)).inspectionCount, 2)
    assert.equal((await store.findExperienceById(experienceA.experienceId)).lastInspectedAt, 8000)
    await assert.rejects(
      store.recordEvent({ experienceId: experienceA.experienceId, kind: 'observation', summary: '   ' }),
      /SUMMARY_REQUIRED/,
    )
    await assert.rejects(
      store.recordEvent({ experienceId: experienceA.experienceId, kind: 'comparison', summary: '相似' }),
      /TARGET_REQUIRED/,
    )
    const observation = await store.recordEvent({
      experienceId: experienceA.experienceId,
      kind: 'observation',
      occurredAt: 9000,
      summary: '花盆比以前更茂盛',
      terms: [{ term: '植物', weight: 3 }],
    })
    const comparison = await store.recordEvent({
      experienceId: experienceA.experienceId,
      kind: 'comparison',
      occurredAt: 9500,
      summary: '与另一张图比较',
      relatedExperienceId: experienceB.experienceId,
    })
    assert.equal(observation.evidence, 'inferred')
    assert.equal(comparison.relatedExperienceId, experienceB.experienceId)
    const observations = await store.recentObservationsFor(experienceA.experienceId, { limit: 3 })
    assert.deepEqual(observations.map((event) => event.kind), ['comparison', 'observation'])

    await store.indexTerms(experienceA.experienceId, [{ term: '植物', weight: 2 }], { sourceKind: 'user_text', sourceRef: 'm1-low' })
    await store.indexTerms(experienceA.experienceId, [{ term: '植物', weight: 9 }], { sourceKind: 'user_text', sourceRef: 'm1-high' })
    await store.indexTerms(experienceB.experienceId, [{ term: '植物', weight: 3 }], { sourceKind: 'observation', sourceRef: 'b-observation' })
    const matches = await store.searchByTerms([{ term: '植物', weight: 3 }], { limit: 10 })
    const matchA = matches.find((entry) => entry.experienceId === experienceA.experienceId)
    const matchB = matches.find((entry) => entry.experienceId === experienceB.experienceId)
    assert.ok(matchA && matchB)
    assert.equal(matchA.score, 9)
    assert.equal(matchA.matchedTerms.find((term) => term.term === '植物').sourceKind, 'user_text')
    assert.equal(matchB.score, 3)
    assert.ok(matchA.score > matchB.score)
    assert.equal(JSON.stringify(matches).includes(IMAGE), false)

    const sameAttachmentRoots = await store.findExperienceByAttachmentId('a1')
    assert.equal(sameAttachmentRoots.experienceId, experienceA.experienceId)
    for (let index = 0; index < 10; index += 1) {
      await store.recordEvent({ experienceId: experienceA.experienceId, kind: 'revisit', occurredAt: 10000 + index })
    }
    assert.equal(await store.countRawRoots(), 5)
    const listed = await store.listExperiences({ limit: 2 })
    assert.equal(listed.length, 2)
    assert.ok(listed[0].occurredAt >= listed[1].occurredAt)
    assert.equal((await store.listExperiences({ limit: 10, before: listed[1].occurredAt })).every((entry) => entry.occurredAt < listed[1].occurredAt), true)
    assert.equal(await store.findExperienceById('missing'), null)
    assert.equal(await store.findExperienceByAttachmentId('missing'), null)
    assert.equal((await store.recentObservationsFor('missing')).length, 0)

    console.log('VISUAL_EXPERIENCE_STORE=PASS')
  } finally {
    try { store?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    await assert.rejects(stat(root))
  }
}

await main()
