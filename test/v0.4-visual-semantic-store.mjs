import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  VisualExperienceStore,
  VISUAL_EXPERIENCE_DB_FILENAME,
} from '../src/vision/visual-experience-store.js'

let id = 0
let now = 100
const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-semantic-store-'))
const store = new VisualExperienceStore(root, {
  now: () => ++now,
  idFactory: () => `semantic-${++id}`,
})

try {
  await store.initialize()
  const db = new DatabaseSync(join(root, VISUAL_EXPERIENCE_DB_FILENAME))
  try {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'visual_embeddings'").get())
  } finally {
    db.close()
  }

  const canonical = await store.syncMessage({
    id: 'blackberry-owner-1', role: 'user', text: '这只测试猫叫小墨', timestamp: 10,
    attachment: { id: 'blackberry-first' },
  })
  const alias = await store.syncMessage({
    id: 'blackberry-owner-2', role: 'user', text: '这个啦', timestamp: 20,
    attachment: { id: 'blackberry-reupload' },
  })
  store.db.prepare(`
    INSERT INTO visual_experience_aliases(alias_experience_id, canonical_experience_id, reason, created_at)
    VALUES (?, ?, 'EXACT', ?)
  `).run(alias.experienceId, canonical.experienceId, 20)
  await store.syncMessage({
    id: 'blackberry-owner-2-repeat', role: 'user', text: '这个啦', timestamp: 30,
    attachment: { id: 'blackberry-reupload' },
  })

  await store.recordEvent({
    experienceId: alias.experienceId, kind: 'observation', occurredAt: 1,
    summary: 'hidden system prompt and reasoning', evidence: 'inferred',
  })
  await store.recordEvent({
    experienceId: alias.experienceId, kind: 'observation', occurredAt: 2,
    summary: '黑莓是一只黑猫，趴在沙发上。', evidence: 'inferred',
  })
  await store.recordEvent({
    experienceId: canonical.experienceId, kind: 'observation', occurredAt: 3,
    summary: '后来又看到了黑莓。', evidence: 'inferred',
  })

  const initialSources = await store.semanticIndexSources('chinese-clip-v1', { limit: 8 })
  assert.equal(initialSources.length, 1)
  assert.deepEqual(initialSources[0], {
    experienceId: canonical.experienceId,
    attachmentId: 'blackberry-reupload',
    userText: '这只测试猫叫小墨\n这个啦',
    sourceText: '黑莓是一只黑猫，趴在沙发上。',
    occurredAt: 30,
  })
  assert.equal(initialSources[0].userText.length <= 1200, true)
  assert.equal((initialSources[0].userText.match(/这个啦/gu) ?? []).length, 1, 'repeat uploads do not duplicate the same owner caption')
  assert.doesNotMatch(initialSources[0].userText, /黑莓是一只黑猫/u, 'inferred observations never enter the owner-caption text')

  assert.equal(await store.upsertSemanticEmbedding({
    experienceId: alias.experienceId,
    model: 'chinese-clip-v1',
    attachmentId: initialSources[0].attachmentId,
    userText: initialSources[0].userText,
    sourceText: initialSources[0].sourceText,
    imageVector: new Float32Array([1, 0, 0]),
    textVector: new Float32Array([0.5, 0.5, 0]),
  }), true)
  assert.equal((await store.semanticIndexSources('chinese-clip-v1')).length, 0)

  const emptyCaption = await store.syncMessage({
    id: 'blank-owner-caption', role: 'user', text: '', timestamp: 30,
    attachment: { id: 'blank-caption-image' },
  })
  const emptySource = (await store.semanticIndexSources('chinese-clip-v1')).find((item) => item.experienceId === emptyCaption.experienceId)
  assert.ok(emptySource)
  assert.equal(await store.upsertSemanticEmbedding({
    experienceId: emptyCaption.experienceId,
    model: 'chinese-clip-v1',
    attachmentId: emptySource.attachmentId,
    userText: emptySource.userText,
    sourceText: emptySource.sourceText,
    imageVector: [0, 1, 0],
    textVector: null,
  }), true)

  const firstRows = await store.semanticEmbeddings('chinese-clip-v1')
  assert.equal(firstRows.length, 2)
  const blackBerryRow = firstRows.find((item) => item.experienceId === canonical.experienceId)
  assert.ok(blackBerryRow)
  assert.equal(blackBerryRow.attachmentId, 'blackberry-reupload')
  assert.equal(blackBerryRow.userText, '这只测试猫叫小墨\n这个啦')
  assert.equal(blackBerryRow.sourceText, '黑莓是一只黑猫，趴在沙发上。')
  assert.deepEqual(Array.from(blackBerryRow.imageVector), [1, 0, 0])
  assert.deepEqual(Array.from(blackBerryRow.textVector), [0.5, 0.5, 0])
  assert.equal(firstRows.find((item) => item.experienceId === emptyCaption.experienceId).textVector, null)
  assert.equal(firstRows.some((item) => item.experienceId === alias.experienceId), false)

  await store.recordEvent({
    experienceId: alias.experienceId, kind: 'observation', occurredAt: 0,
    summary: '首次安全观察：黑莓有黑色毛发。', evidence: 'inferred',
  })
  assert.equal((await store.semanticIndexSources('chinese-clip-v1')).length, 0)
  assert.equal((await store.semanticEmbeddings('chinese-clip-v1'))
    .find((item) => item.experienceId === canonical.experienceId).sourceText, '首次安全观察：黑莓有黑色毛发。')

  await store.syncMessage({
    id: 'blackberry-owner-3', role: 'user', text: '黑莓是我们家那只黑猫', timestamp: 40,
    attachment: { id: 'blackberry-reupload' },
  })
  const changedSources = await store.semanticIndexSources('chinese-clip-v1')
  const changed = changedSources.find((item) => item.experienceId === canonical.experienceId)
  assert.equal(changed.attachmentId, 'blackberry-reupload')
  assert.equal(changed.userText, '这只测试猫叫小墨\n这个啦\n黑莓是我们家那只黑猫')
  assert.equal(changed.sourceText, '首次安全观察：黑莓有黑色毛发。')
  await store.upsertSemanticEmbedding({
    experienceId: changed.experienceId,
    model: 'chinese-clip-v1',
    attachmentId: changed.attachmentId,
    userText: changed.userText,
    sourceText: changed.sourceText,
    imageVector: [0.9, 0.1, 0],
    textVector: [1, 0, 0],
  })
  assert.equal((await store.semanticIndexSources('chinese-clip-v1'))
    .some((item) => item.experienceId === canonical.experienceId), false)
  assert.equal((await store.semanticEmbeddings('chinese-clip-v1'))
    .find((item) => item.experienceId === canonical.experienceId).userText, '这只测试猫叫小墨\n这个啦\n黑莓是我们家那只黑猫')

  const unreadableFirst = await store.syncMessage({
    id: 'unreadable-first', role: 'user', text: '稍早的图片', timestamp: 50,
    attachment: { id: 'unreadable-first-image' },
  })
  const readableLater = await store.syncMessage({
    id: 'readable-later', role: 'user', text: '稍后的图片', timestamp: 60,
    attachment: { id: 'readable-later-image' },
  })
  const firstUnindexed = await store.semanticIndexSources('chinese-clip-v1', { limit: 1 })
  assert.equal(firstUnindexed[0].experienceId, unreadableFirst.experienceId)
  const afterExcludingUnreadable = await store.semanticIndexSources('chinese-clip-v1', {
    limit: 1,
    excludeExperienceIds: [unreadableFirst.experienceId],
  })
  assert.equal(afterExcludingUnreadable[0].experienceId, readableLater.experienceId)
  assert.equal((await store.semanticIndexSources('chinese-clip-v1', {
    limit: 1,
    excludeExperienceIds: [unreadableFirst.experienceId, readableLater.experienceId],
  })).length, 0)

  store.registerTransientAttachmentIds(['blackberry-reupload'])
  assert.equal((await store.semanticIndexSources('chinese-clip-v1'))
    .some((item) => item.experienceId === canonical.experienceId), false)
  assert.equal((await store.semanticEmbeddings('chinese-clip-v1'))
    .some((item) => item.experienceId === canonical.experienceId), false)

  assert.deepEqual(await readdir(root), [VISUAL_EXPERIENCE_DB_FILENAME])
  console.log('VISUAL_SEMANTIC_STORE=PASS')
} finally {
  store.close()
  await rm(root, { recursive: true, force: true })
}
