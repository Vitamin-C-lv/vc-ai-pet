import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

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

function loggerFor(logs) {
  return {
    info: (message) => logs.push({ level: 'info', message: String(message) }),
    warn: (message) => logs.push({ level: 'warn', message: String(message) }),
  }
}

function visualCounts(root) {
  const db = new DatabaseSync(join(root, 'visual-experience.db'), { readOnly: true })
  try {
    return {
      roots: Number(db.prepare('SELECT COUNT(*) AS n FROM visual_experiences').get().n),
      events: Number(db.prepare("SELECT COUNT(*) AS n FROM visual_events WHERE kind = 'observation'").get().n),
      terms: Number(db.prepare("SELECT COUNT(*) AS n FROM visual_terms WHERE source_kind = 'observation'").get().n),
      cursor: db.prepare('SELECT value FROM visual_sync_state WHERE key = ?').get('legacy_observation_sequence')?.value ?? null,
    }
  } finally {
    db.close()
  }
}

async function appendSingleImageObservation(root, label) {
  const conversation = new ConversationStore(root)
  await conversation.initialize()
  const turnId = `turn-${label}`
  await conversation.appendMessage({
    id: `${label}-user`,
    role: 'user',
    turnId,
    text: `${label} 图片`,
    attachment: attachment(`${label}-attachment`),
    timestamp: 1000,
  })
  await conversation.appendMessage({
    id: `${label}-observation`,
    role: 'assistant',
    turnId,
    kind: 'activity',
    activityType: 'visual_observation',
    text: `看到：${label} 的红色花盆和绿叶`,
    timestamp: 1001,
  })
  const maxSequence = await conversation.rawHistoryMaxSequence()
  conversation.close()
  return maxSequence
}

async function appendAmbiguousComparison(root) {
  const conversation = new ConversationStore(root)
  await conversation.initialize()
  const turnId = 'turn-ambiguous'
  await conversation.appendMessage({
    id: 'ambiguous-user-0',
    role: 'user',
    turnId,
    text: '比较两张图',
    attachment: attachment('ambiguous-attachment-0'),
    timestamp: 2000,
  })
  await conversation.appendMessage({
    id: 'ambiguous-user-1',
    role: 'user',
    turnId,
    text: '比较两张图',
    attachment: attachment('ambiguous-attachment-1'),
    timestamp: 2001,
  })
  await conversation.appendMessage({
    id: 'ambiguous-media-0',
    role: 'assistant',
    turnId,
    kind: 'media_ref',
    activityType: 'visual_image',
    sourceAttachmentId: 'ambiguous-attachment-0',
    timestamp: 2002,
  })
  await conversation.appendMessage({
    id: 'ambiguous-media-1',
    role: 'assistant',
    turnId,
    kind: 'media_ref',
    activityType: 'visual_image',
    sourceAttachmentId: 'ambiguous-attachment-1',
    timestamp: 2003,
  })
  await conversation.appendMessage({
    id: 'ambiguous-observation',
    role: 'assistant',
    turnId,
    kind: 'activity',
    activityType: 'visual_observation',
    text: '看到：V0 和 V1 都有植物',
    timestamp: 2004,
  })
  conversation.close()
}

const roots = []
try {
  // Production-path regression: initialize must run sync before the legacy
  // importer, without the test calling the importer directly.
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-runtime-init-'))
  roots.push(root)
  const firstArchiveMax = await appendSingleImageObservation(root, 'first')
  const firstLogs = []
  const firstOrder = []
  const first = new PetRuntime({ sandboxRoot: root, logger: loggerFor(firstLogs) })
  const sync = first.syncVisualExperiences.bind(first)
  first.syncVisualExperiences = async (...args) => {
    firstOrder.push('sync-start')
    const result = await sync(...args)
    firstOrder.push('sync-complete')
    return result
  }
  const recordEvent = first.visualExperience.recordEvent.bind(first.visualExperience)
  first.visualExperience.recordEvent = async (event) => {
    if (String(event?.eventId ?? '').startsWith('legacy-')) firstOrder.push('legacy-import')
    return recordEvent(event)
  }
  await first.initialize()
  assert.deepEqual(firstOrder, ['sync-start', 'sync-complete', 'legacy-import'])
  const firstCounts = visualCounts(root)
  assert.equal(firstCounts.roots, 1)
  assert.equal(firstCounts.events, 1)
  assert.ok(firstCounts.terms > 0)
  assert.equal(firstCounts.cursor, String(firstArchiveMax))
  assert.equal(firstLogs.filter((entry) => entry.level === 'warn').length, 0)
  assert.equal(firstLogs.some((entry) => entry.message.includes('modelCalls=0')), true)
  assert.equal(firstLogs.some((entry) => entry.message.includes('skippedAmbiguous=0')), true)
  first.close()
  console.log('PET_RUNTIME_INITIALIZATION_ORDER=sync-before-legacy')
  console.log('RUNTIME_INIT_FIRST_IMPORT=PASS')

  // Restart without new archive rows: the cursor and deterministic event id
  // must keep both event and term counts unchanged.
  const secondLogs = []
  const secondEvents = []
  const second = new PetRuntime({ sandboxRoot: root, logger: loggerFor(secondLogs) })
  const secondRecordEvent = second.visualExperience.recordEvent.bind(second.visualExperience)
  second.visualExperience.recordEvent = async (event) => {
    if (String(event?.eventId ?? '').startsWith('legacy-')) secondEvents.push(event.eventId)
    return secondRecordEvent(event)
  }
  await second.initialize()
  const secondCounts = visualCounts(root)
  assert.deepEqual(secondCounts, firstCounts)
  assert.deepEqual(secondEvents, [])
  assert.equal(secondLogs.some((entry) => entry.message.includes('total=0 mapped=0')), true)
  second.close()
  console.log('RUNTIME_INIT_SECOND_IMPORT=0')
  console.log('RUNTIME_INIT_MIGRATION_IDEMPOTENT=PASS')

  // Add one new user image root plus one deterministically mapped activity
  // after the stored legacy cursor. The next initialize may import only it.
  const incrementalArchiveMax = await appendSingleImageObservation(root, 'incremental')
  const thirdLogs = []
  const third = new PetRuntime({ sandboxRoot: root, logger: loggerFor(thirdLogs) })
  await third.initialize()
  const thirdCounts = visualCounts(root)
  assert.equal(thirdCounts.roots, 2)
  assert.equal(thirdCounts.events, 2)
  assert.ok(thirdCounts.terms > secondCounts.terms)
  assert.equal(thirdCounts.cursor, String(incrementalArchiveMax))
  assert.equal(thirdLogs.some((entry) => entry.message.includes('total=1 mapped=1')), true)
  third.close()
  console.log('INCREMENTAL_LEGACY_IMPORT=PASS')

  // A further restart remains idempotent after the incremental import.
  const fourth = new PetRuntime({ sandboxRoot: root, logger: loggerFor([]) })
  await fourth.initialize()
  assert.deepEqual(visualCounts(root), thirdCounts)
  fourth.close()

  // A completed migration with an ambiguous comparison is observable as a
  // successful/skipped result, not as a failure.
  const ambiguousRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-runtime-ambiguous-'))
  roots.push(ambiguousRoot)
  await appendAmbiguousComparison(ambiguousRoot)
  const ambiguousLogs = []
  const ambiguous = new PetRuntime({ sandboxRoot: ambiguousRoot, logger: loggerFor(ambiguousLogs) })
  await ambiguous.initialize()
  const ambiguousCounts = visualCounts(ambiguousRoot)
  assert.equal(ambiguousCounts.roots, 2)
  assert.equal(ambiguousCounts.events, 0)
  assert.equal(ambiguousLogs.some((entry) => entry.message.includes('total=1 mapped=0 skippedAmbiguous=1')), true)
  assert.equal(ambiguousLogs.some((entry) => entry.level === 'warn'), false)
  ambiguous.close()
  console.log('MIGRATION_COMPLETED_SKIPPED_AMBIGUOUS=PASS')

  // A real importer failure is logged as failed and does not masquerade as a
  // completed/skipped migration; runtime initialization itself remains alive.
  const failureRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-runtime-failure-'))
  roots.push(failureRoot)
  await appendSingleImageObservation(failureRoot, 'failure')
  const failureLogs = []
  const failure = new PetRuntime({ sandboxRoot: failureRoot, logger: loggerFor(failureLogs) })
  failure.visualExperience.getSyncState = async () => {
    throw Object.assign(new Error('test failure'), { code: 'TEST_MIGRATION_FAILURE' })
  }
  await failure.initialize()
  assert.equal(failureLogs.some((entry) => entry.level === 'warn' && entry.message.includes('migration failed code=TEST_MIGRATION_FAILURE')), true)
  assert.equal(failureLogs.some((entry) => entry.message.includes('migration completed')), false)
  failure.close()
  console.log('MIGRATION_FAILURE_DIAGNOSTIC=PASS')
  console.log('VISUAL_MEMORY_RUNTIME_INIT=PASS')
} finally {
  for (const root of roots) await rm(root, { recursive: true, force: true })
}
