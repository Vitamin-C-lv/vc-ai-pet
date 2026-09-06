import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConversationStore } from '../src/conversation/conversation-store.js'
import {
  VisualExperienceStore,
  VISUAL_EXPERIENCE_DB_FILENAME,
} from '../src/vision/visual-experience-store.js'
import {
  importLegacyObservations,
  observationVisualIdRef,
  resolveObservationAttachment,
} from '../src/vision/legacy-observation-importer.js'

function attachment(id) {
  return {
    id,
    mimeType: 'image/png',
    originalMimeType: 'image/png',
    thumbnailMimeType: 'image/png',
    thumbnailOriginalMimeType: 'image/png',
    assetPath: `conversation-assets/${id}.png`,
    thumbnailPath: `conversation-assets/${id}-thumbnail.png`,
  }
}

function tokenizeText(text, { boost }) {
  return [...new Set(String(text).split(/\s+/u).filter(Boolean))]
    .map((term) => ({ term, weight: boost }))
}

async function appendSingleTurn(conversation) {
  await conversation.appendMessage({
    id: 'a-user', role: 'user', turnId: 'turn-a', text: '旧图片', attachment: attachment('att-a'), timestamp: 1000,
  })
  await conversation.appendMessage({
    id: 'a-media', role: 'assistant', turnId: 'turn-a', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: 'att-a', text: '旧图片', timestamp: 1001,
  })
  await conversation.appendMessage({
    id: 'a-observation', role: 'assistant', turnId: 'turn-a', kind: 'activity', activityType: 'visual_observation', text: '看到：红色花盆和绿叶', timestamp: 1002,
  })
}

async function appendComparisonTurns(conversation) {
  await conversation.appendMessage({
    id: 'c-user-0', role: 'user', turnId: 'turn-c', text: '比较两张图', attachment: attachment('att-c0'), timestamp: 2000,
  })
  await conversation.appendMessage({
    id: 'c-user-1', role: 'user', turnId: 'turn-c', text: '比较两张图', attachment: attachment('att-c1'), timestamp: 2001,
  })
  await conversation.appendMessage({
    id: 'c-media-0', role: 'assistant', turnId: 'turn-c', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: 'att-c0', timestamp: 2002,
  })
  await conversation.appendMessage({
    id: 'c-media-1', role: 'assistant', turnId: 'turn-c', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: 'att-c1', timestamp: 2003,
  })
  await conversation.appendMessage({
    id: 'c-observation', role: 'assistant', turnId: 'turn-c', kind: 'activity', activityType: 'visual_observation', text: '看到：V0 和 V1 都有植物', timestamp: 2004,
  })

  await conversation.appendMessage({
    id: 'd-user-0', role: 'user', turnId: 'turn-d', text: '再比较两张图', attachment: attachment('att-d0'), timestamp: 3000,
  })
  await conversation.appendMessage({
    id: 'd-user-1', role: 'user', turnId: 'turn-d', text: '再比较两张图', attachment: attachment('att-d1'), timestamp: 3001,
  })
  await conversation.appendMessage({
    id: 'd-media-0', role: 'assistant', turnId: 'turn-d', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: 'att-d0', timestamp: 3002,
  })
  await conversation.appendMessage({
    id: 'd-media-1', role: 'assistant', turnId: 'turn-d', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: 'att-d1', timestamp: 3003,
  })
  await conversation.appendMessage({
    id: 'd-observation', role: 'assistant', turnId: 'turn-d', kind: 'activity', activityType: 'visual_observation', text: '看到：V0 有红色花盆', timestamp: 3004,
  })
}

function archiveReaders(conversation) {
  return {
    readBatch: (afterSequence, limit) => conversation.rawHistoryAfterSequence({ afterSequence, limit }),
    readMaxSequence: () => conversation.rawHistoryMaxSequence(),
  }
}

async function syncExperiences(store, conversation) {
  return store.syncFromArchive({
    ...archiveReaders(conversation),
    tokenizeText,
  })
}

function counts(root) {
  const db = new DatabaseSync(join(root, VISUAL_EXPERIENCE_DB_FILENAME))
  try {
    return {
      events: Number(db.prepare("SELECT COUNT(*) AS n FROM visual_events WHERE kind = 'observation'").get().n),
      terms: Number(db.prepare("SELECT COUNT(*) AS n FROM visual_terms WHERE source_kind = 'observation'").get().n),
      eventAttachments: db.prepare(`
        SELECT e.attachment_id AS attachmentId
        FROM visual_events v
        JOIN visual_experiences e ON e.experience_id = v.experience_id
        WHERE v.kind = 'observation'
        ORDER BY v.event_id
      `).all().map((row) => row.attachmentId),
      cursor: db.prepare('SELECT value FROM visual_sync_state WHERE key = ?').get('legacy_observation_sequence')?.value ?? null,
    }
  } finally {
    db.close()
  }
}

async function runImport(store, conversation) {
  return importLegacyObservations({
    store,
    ...archiveReaders(conversation),
    tokenizeText,
  })
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-legacy-observation-'))
let conversation = null
let store = null
try {
  assert.deepEqual(observationVisualIdRef('看到：V0 和 V1'), { kind: 'ambiguous' })
  assert.deepEqual(observationVisualIdRef('对照：V0'), { kind: 'explicit', index: 0 })
  assert.deepEqual(observationVisualIdRef('当前图片'), { kind: 'current', index: 0 })
  assert.equal(observationVisualIdRef('没有图片引用'), null)
  assert.deepEqual(resolveObservationAttachment([
    { archiveSequence: 1, role: 'user', attachment: attachment('one') },
    { archiveSequence: 2, role: 'assistant', kind: 'activity', activityType: 'visual_observation', text: '看到：单图' },
  ]), { attachmentId: 'one', visualIdIndex: 0 })
  assert.equal(resolveObservationAttachment([
    { archiveSequence: 1, role: 'assistant', kind: 'media_ref', sourceAttachmentId: 'left' },
    { archiveSequence: 2, role: 'assistant', kind: 'media_ref', sourceAttachmentId: 'right' },
    { archiveSequence: 3, role: 'assistant', activityType: 'visual_observation', text: '看到：V0 和 V1' },
  ]), null)

  conversation = new ConversationStore(root)
  await conversation.initialize()
  await appendSingleTurn(conversation)

  store = new VisualExperienceStore(root)
  await store.initialize()
  await syncExperiences(store, conversation)
  const first = await runImport(store, conversation)
  assert.equal(first.total, 1)
  assert.equal(first.mapped, 1)
  assert.equal(first.skippedAmbiguous, 0)
  assert.equal(first.modelCalls, 0)
  assert.equal(first.petMemoryWrites, 0)
  assert.equal(first.dreamRuns, 0)
  const firstCounts = counts(root)
  assert.equal(firstCounts.events, 1)
  assert.ok(firstCounts.terms > 0)
  assert.deepEqual(firstCounts.eventAttachments, ['att-a'])
  assert.equal(firstCounts.cursor, String(first.cursorAfter))
  console.log(`MODEL_CALLS_DURING_MIGRATION=${first.modelCalls}`)

  await store.setSyncState('legacy_observation_sequence', first.cursorBefore)
  const repeated = await runImport(store, conversation)
  assert.equal(repeated.total, 1)
  assert.equal(repeated.mapped, 1)
  assert.equal(repeated.cursorBefore, first.cursorBefore)
  assert.equal(repeated.cursorAfter, first.cursorAfter)
  const repeatedCounts = counts(root)
  assert.equal(repeatedCounts.events, firstCounts.events)
  assert.equal(repeatedCounts.terms, firstCounts.terms)

  await appendComparisonTurns(conversation)
  conversation.close()
  store.close()
  conversation = new ConversationStore(root)
  await conversation.initialize()
  store = new VisualExperienceStore(root)
  await store.initialize()
  await syncExperiences(store, conversation)
  const restarted = await runImport(store, conversation)
  assert.equal(restarted.cursorBefore, first.cursorAfter)
  assert.equal(restarted.total, 2)
  assert.equal(restarted.mapped, 1)
  assert.equal(restarted.skippedAmbiguous, 1)
  assert.equal(restarted.skippedNoAttachment, 0)
  assert.equal(restarted.skippedNoExperience, 0)
  assert.equal(restarted.modelCalls, 0)
  const restartedCounts = counts(root)
  assert.equal(restartedCounts.events, 2)
  assert.deepEqual(restartedCounts.eventAttachments, ['att-a', 'att-d0'])
  assert.equal(restartedCounts.cursor, String(restarted.cursorAfter))

  const finalRepeat = await runImport(store, conversation)
  assert.equal(finalRepeat.total, 0)
  assert.equal(counts(root).events, 2)
  console.log(`LEGACY_OBSERVATIONS_TOTAL=${first.total + restarted.total}`)
  console.log(`LEGACY_OBSERVATIONS_MAPPED=${first.mapped + restarted.mapped}`)
  console.log(`LEGACY_OBSERVATIONS_SKIPPED_AMBIGUOUS=${first.skippedAmbiguous + restarted.skippedAmbiguous}`)
  console.log('LEGACY_OBSERVATION_IMPORT=PASS')
} finally {
  try { conversation?.close() } catch {}
  try { store?.close() } catch {}
  await rm(root, { recursive: true, force: true })
}
