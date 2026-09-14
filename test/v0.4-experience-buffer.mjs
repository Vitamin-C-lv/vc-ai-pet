import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ExperienceBuffer,
  classifyExperience,
  detectRepeatedExperience,
  EXPERIENCE_BUFFER_META_TABLE,
  EXPERIENCE_BUFFER_SCHEMA_VERSION,
  EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY,
  EXPERIENCE_BUFFER_RETENTION_MS,
} from '../src/experience/experience-buffer.js'
import { EXPERIENCE_BUFFER_DB_FILENAME } from '../src/experience/experience-buffer-schema.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DATA_URL = 'data:image/png;base64,QUFB'
const BARE_BASE64 = `${'A'.repeat(48)}==`

async function main() {
  assert.equal(EXPERIENCE_BUFFER_DB_FILENAME, 'experience-buffer.sqlite')
  assert.equal(EXPERIENCE_BUFFER_RETENTION_MS, 14 * DAY_MS)

  const explicit = classifyExperience({ ownerText: '请记住我们家的猫叫黑莓', assistantText: '好的。' })
  const identity = classifyExperience({ ownerText: '我家的狗生日是五月一日', assistantText: '我记下了。' })
  const repeated = classifyExperience({ ownerText: '黑莓跑到窗边', assistantText: '花花看到了。', occurrenceCount: 2 })
  const emotion = classifyExperience({ ownerText: '我很担心，花花最近生病了', assistantText: '会好起来的。', emotion: { mood: 'worried', intensity: 0.85 } })
  const lowValue = classifyExperience({ ownerText: '今天天气不错', assistantText: '嗯嗯。' })
  assert.equal(explicit.sourceType, 'explicit_memory')
  assert.equal(explicit.importanceScore >= 0.9, true)
  assert.equal(explicit.admitted, true)
  assert.equal(identity.sourceType, 'owner_chat')
  assert.equal(identity.importanceScore >= 0.8, true)
  assert.equal(identity.admitted, true)
  assert.equal(repeated.sourceType, 'repeated_behavior')
  assert.equal(repeated.admitted, true)
  assert.equal(emotion.sourceType, 'emotion_event')
  assert.equal(emotion.emotionScore, 0.85)
  assert.equal(emotion.admitted, true)
  // Ordinary chat is admitted at LOW importance on purpose: the first
  // occurrence is the baseline a later repeat is measured against.
  assert.equal(lowValue.admitted, true)
  assert.equal(lowValue.sourceType, 'owner_chat')
  assert.equal(lowValue.importanceScore < 0.8, true)
  const classifiedVision = classifyExperience({
    ownerText: '请看看这张照片',
    assistantText: '我来看看。',
    hadVision: true,
    visionSummary: '主人这一轮发送了图片',
    visionId: 'V0',
    attachmentId: 'attachment-vision',
    visualObservation: ['窗边有一只橘猫', DATA_URL, `背景 ${BARE_BASE64}`],
    visualFocus: '猫的姿态',
  })
  assert.equal(classifiedVision.sourceType, 'pet_vision')
  assert.equal(classifiedVision.importanceScore, 0.6)
  assert.deepEqual(classifiedVision.visualObservation, ['窗边有一只橘猫', '[图片]', '背景 [图片]'])
  assert.equal(classifiedVision.visionId, 'V0')
  assert.equal(classifiedVision.attachmentId, 'attachment-vision')
  assert.equal(classifiedVision.visualFocus, '猫的姿态')
  const structuredVision = classifyExperience({
    ownerText: '再看看',
    hadVision: true,
    visualObservation: [{ visualId: 'V1', attachmentId: 'attachment-structured', focus: '窗台', summary: '窗台上有绿色植物' }],
  })
  assert.deepEqual(structuredVision.visualObservation, ['窗台上有绿色植物'])
  assert.equal(structuredVision.visionId, 'V1')
  assert.equal(structuredVision.attachmentId, 'attachment-structured')
  assert.equal(structuredVision.visualFocus, '窗台')
  assert.deepEqual(detectRepeatedExperience('黑莓跑到窗边', 2), {
    fingerprint: '黑莓跑到窗边',
    occurrenceCount: 2,
    repeated: true,
  })

  const circular = {}
  circular.self = circular
  // Missing input fails closed: a caller bug is not life experience.
  for (const input of [null, undefined]) {
    assert.doesNotThrow(() => classifyExperience(input))
    const classified = classifyExperience(input)
    assert.equal(classified.admitted, false)
    assert.equal(classified.reason, 'invalid-input')
  }
  // A non-string field is coerced ("[object Object]") but stays worthless, so it
  // can never reach PetMemory through the consolidator's importance gate.
  assert.doesNotThrow(() => classifyExperience({ ownerText: circular }))
  assert.equal(classifyExperience({ ownerText: circular }).importanceScore < 0.8, true)

  // A property that throws while being read is genuinely unusable input, so the
  // classifier fails closed instead of inventing an experience.
  const throwingInput = { get ownerText() { throw new Error('bad input') } }
  assert.doesNotThrow(() => classifyExperience(throwingInput))
  assert.equal(classifyExperience(throwingInput).admitted, false)
  assert.equal(classifyExperience(throwingInput).reason, 'invalid-input')

  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-experience-buffer-v2-'))
  let buffer = null
  let boundaryBuffer = null
  let purgeBuffer = null
  try {
    let now = 1_000_000
    buffer = new ExperienceBuffer({ root, now: () => now })
    const initialized = await Promise.all(Array.from({ length: 8 }, () => buffer.initialize()))
    assert.ok(initialized.every((item) => item === buffer))
    await buffer.initialize()

    const explicitRow = buffer.record({
      turnId: 'conversation-explicit',
      messageId: 'message-explicit',
      actor: 'owner',
      ownerText: '请记住我们家的猫叫黑莓',
      assistantText: '花花记住啦。',
    })
    const identityRow = buffer.record({
      turnId: 'conversation-identity',
      messageId: 'message-identity',
      ownerText: '我家的狗生日是五月一日',
      assistantText: '花花记下了。',
    })
    const firstRepeat = buffer.record({ ownerText: '黑莓跑到窗边', assistantText: '花花看到了。' })
    const repeatedRow = buffer.record({ ownerText: '黑莓跑到窗边', assistantText: '又跑到窗边啦。' })
    const emotionRow = buffer.record({
      ownerText: '我很担心，花花最近生病了',
      assistantText: '会好起来的。',
      emotion: { mood: 'worried', intensity: 0.85 },
    })
    const candidate = { level: 'fact', content: '主人喜欢蓝色', importance: 3, keywords: ['蓝色'] }
    const candidateRow = buffer.record({
      ownerText: '我喜欢蓝色',
      assistantText: '花花知道啦。',
      modelCandidate: candidate,
      hadVision: true,
      dataURL: DATA_URL,
    })
    const visualRow = buffer.record({
      ownerText: '请看看这张照片',
      assistantText: '我来看看。',
      hadVision: true,
      visionSummary: '主人这一轮发送了图片',
      visionId: 'V0',
      attachmentId: 'attachment-vision',
      visualObservation: ['窗边有一只橘猫', DATA_URL, `背景 ${BARE_BASE64}`],
      visualFocus: `猫的姿态 ${DATA_URL}`,
      modelCandidate: { raw: DATA_URL, encoded: BARE_BASE64 },
    })
    const lowRow = buffer.record({ ownerText: '今天天气不错', assistantText: '嗯嗯。' })
    assert.equal(explicitRow.ok, true)
    assert.equal(explicitRow.sourceType, 'explicit_memory')
    assert.equal(explicitRow.importanceScore >= 0.9, true)
    assert.equal(explicitRow.admitted, true)
    assert.equal(identityRow.sourceType, 'owner_chat')
    assert.equal(identityRow.importanceScore >= 0.8, true)
    assert.equal(firstRepeat.admitted, true, 'the first occurrence is stored as the repetition baseline')
    assert.equal(typeof firstRepeat.id, 'number')
    assert.equal(repeatedRow.sourceType, 'repeated_behavior')
    assert.equal(repeatedRow.admitted, true)
    assert.equal(emotionRow.sourceType, 'emotion_event')
    assert.equal(candidateRow.admitted, true)
    assert.equal(visualRow.sourceType, 'pet_vision')
    assert.equal(visualRow.importanceScore, 0.6)
    assert.equal(visualRow.visionId, 'V0')
    assert.equal(visualRow.attachmentId, 'attachment-vision')
    assert.deepEqual(visualRow.visualObservation, ['窗边有一只橘猫', '[图片]', '背景 [图片]'])
    assert.equal(visualRow.visualFocus, `猫的姿态 [图片]`)
    assert.equal(lowRow.admitted, true)
    assert.equal(typeof lowRow.id, 'number')
    assert.equal(lowRow.importanceScore < 0.8, true)
    assert.equal(await buffer.count(), 8)

    assert.doesNotThrow(() => buffer.record({ ownerText: undefined, assistantText: '安全处理。' }))
    assert.doesNotThrow(() => buffer.record({ ownerText: 'x'.repeat(100_000), assistantText: undefined }))
    assert.doesNotThrow(() => buffer.record({ ownerText: '普通内容', assistantText: '收到。', modelCandidate: circular }))
    assert.equal(await buffer.count(), 11)

    const pending = await buffer.pendingExperience({ limit: 999 })
    // Every admitted row is pending until Reflection consumes it. Ordinary chat
    // and the first occurrence of a repeat are included on purpose: they are the
    // baselines a later repeat is measured against, and dropping them lost the
    // evidence before it could ever look repeated.
    const expectedPendingIds = [
      explicitRow.id, identityRow.id, firstRepeat.id, repeatedRow.id,
      emotionRow.id, candidateRow.id, visualRow.id, lowRow.id,
    ].sort((left, right) => left - right)
    assert.deepEqual(pending.slice(0, expectedPendingIds.length).map((row) => row.id), expectedPendingIds)
    assert.ok(pending.length >= expectedPendingIds.length)
    assert.equal(pending.every((row) => row.processed === false), true)
    assert.equal((await buffer.pendingExperience({ afterId: identityRow.id })).every((row) => row.id > identityRow.id), true)
    assert.deepEqual((await buffer.pendingExperience({ before: now - 1 })).length, 0)

    const processedAt = now + 123
    const marked = await buffer.markProcessed([explicitRow.id], { processedAt })
    assert.equal(marked.processedCount, 1)
    assert.equal((await buffer.pendingExperience({ limit: 200 })).some((row) => row.id === explicitRow.id), false)
    // `recent` is a newest-first-window view over every row, processed or not, and
    // is what Dream reads. Its order is ascending id, so take the newest window.
    const recent = await buffer.recent({ limit: 999 })
    assert.equal(recent.some((row) => row.id === explicitRow.id && row.processed && row.processedAt === processedAt), true)
    assert.deepEqual(recent.map((row) => row.id), [...recent].map((row) => row.id).sort((left, right) => left - right))
    const newest = await buffer.recent({ limit: 5 })
    assert.equal(newest.length, 5)
    assert.deepEqual(newest.map((row) => row.id), recent.slice(-5).map((row) => row.id))
    const candidateRead = recent.find((row) => row.id === candidateRow.id)
    assert.deepEqual(candidateRead.memoryCandidate, candidate)

    const dbPath = join(root, EXPERIENCE_BUFFER_DB_FILENAME)
    assert.equal((await stat(dbPath)).mode & 0o777, 0o600)
    const db = new DatabaseSync(dbPath)
    try {
      const columns = db.prepare('PRAGMA table_info(experience_events)').all().map((row) => row.name)
      assert.deepEqual(columns, [
        'id', 'created_at', 'source_type', 'conversation_id', 'conversation_key', 'message_id', 'actor_id', 'content',
        'importance_score', 'emotion_score', 'memory_candidate', 'vision_summary', 'vision_id',
        'attachment_id', 'visual_observation', 'visual_focus', 'processed', 'processed_at',
      ])
      const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'experience_events'").all().map((row) => row.name)
      assert.ok(indexes.some((name) => name.includes('created_at')))
      assert.ok(indexes.some((name) => name.includes('processed')))
      assert.ok(indexes.some((name) => name.includes('source_type')))
      assert.ok(indexes.some((name) => name.includes('conversation_id')))
      assert.ok(indexes.some((name) => name.includes('conversation_key')))
      const storedCandidate = db.prepare('SELECT memory_candidate FROM experience_events WHERE id = ?').get(candidateRow.id).memory_candidate
      assert.deepEqual(JSON.parse(storedCandidate), candidate)
      const storedVisual = db.prepare('SELECT vision_summary, vision_id, attachment_id, visual_observation, visual_focus FROM experience_events WHERE id = ?').get(visualRow.id)
      assert.equal(storedVisual.vision_summary, '主人这一轮发送了图片')
      assert.equal(storedVisual.vision_id, 'V0')
      assert.equal(storedVisual.attachment_id, 'attachment-vision')
      assert.deepEqual(JSON.parse(storedVisual.visual_observation), ['窗边有一只橘猫', '[图片]', '背景 [图片]'])
      assert.equal(storedVisual.visual_focus, '猫的姿态 [图片]')
      const dumped = JSON.stringify(db.prepare('SELECT * FROM experience_events').all())
      assert.equal(dumped.includes(DATA_URL), false)
      assert.equal(dumped.includes(BARE_BASE64), false)
    } finally {
      db.close()
    }

    let boundaryNow = 2_000_000
    boundaryBuffer = new ExperienceBuffer({ root: join(root, 'boundary'), now: () => boundaryNow })
    await boundaryBuffer.initialize()
    const exactBoundary = boundaryBuffer.record({ ownerText: '请记住14天边界', assistantText: '收到。' })
    await boundaryBuffer.markProcessed([exactBoundary.id], { processedAt: boundaryNow })
    assert.equal((await boundaryBuffer.purgeExpired({ now: boundaryNow + EXPERIENCE_BUFFER_RETENTION_MS })).deletedCount, 0)
    assert.equal((await boundaryBuffer.purgeExpired({ now: boundaryNow + EXPERIENCE_BUFFER_RETENTION_MS + 1 })).deletedCount, 1)
    assert.equal(await boundaryBuffer.count(), 0)

    let purgeNow = 3_000_000
    purgeBuffer = new ExperienceBuffer({ root: join(root, 'purge'), now: () => purgeNow })
    await purgeBuffer.initialize()
    const expiredProcessed = purgeBuffer.record({ ownerText: '14天前的已处理事件', assistantText: '收到。', modelCandidate: { importanceScore: 1 } })
    const expiredUnprocessed = purgeBuffer.record({ ownerText: '14天前的未处理事件', assistantText: '等待反思。', modelCandidate: { importanceScore: 1 } })
    purgeNow += 7 * DAY_MS
    assert.equal((await purgeBuffer.purgeExpired({ now: purgeNow })).deletedCount, 0)
    purgeNow += 7 * DAY_MS + 1
    const fresh = purgeBuffer.record({ ownerText: '当前事件', assistantText: '保留。', modelCandidate: { importanceScore: 1 } })
    await purgeBuffer.markProcessed([expiredProcessed.id], { processedAt: purgeNow })
    const purged = await purgeBuffer.purgeExpired({ now: purgeNow })
    assert.equal(purged.deletedCount, 1)
    assert.equal(purged.retainedUnprocessed, 1)
    assert.equal((await purgeBuffer.pendingExperience({ limit: 200 })).some((row) => row.id === expiredUnprocessed.id), true)
    assert.equal((await purgeBuffer.recent({ limit: 10 })).some((row) => row.id === fresh.id), true)

    // A database created before the visual columns existed upgrades safely and
    // keeps its old row readable. Reopening exercises the idempotent path again.
    let legacyRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-experience-buffer-legacy-'))
    let legacyBuffer = null
    try {
      const legacyDb = new DatabaseSync(join(legacyRoot, EXPERIENCE_BUFFER_DB_FILENAME))
      legacyDb.exec(`
        CREATE TABLE experience_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at INTEGER NOT NULL,
          source_type TEXT NOT NULL,
          conversation_id TEXT,
          message_id TEXT,
          actor_id TEXT,
          content TEXT NOT NULL,
          importance_score REAL NOT NULL DEFAULT 0,
          emotion_score REAL,
          memory_candidate TEXT,
          processed INTEGER NOT NULL DEFAULT 0,
          processed_at INTEGER
        );
        INSERT INTO experience_events(created_at, source_type, content, importance_score)
        VALUES (123, 'pet_vision', '主人这一轮发送了图片', 0.6);
      `)
      legacyDb.close()
      legacyBuffer = new ExperienceBuffer({ root: legacyRoot, now: () => now })
      await legacyBuffer.initialize()
      await legacyBuffer.close()
      legacyBuffer = new ExperienceBuffer({ root: legacyRoot, now: () => now })
      await legacyBuffer.initialize()
      const legacyRows = await legacyBuffer.recent({ limit: 12 })
      assert.equal(legacyRows.length, 1)
      assert.equal(legacyRows[0].sourceType, 'pet_vision')
      assert.deepEqual(legacyRows[0].visualObservation, [])
      assert.equal(legacyRows[0].visionId, null)
      assert.equal(legacyRows[0].attachmentId, null)
    } finally {
      try { await legacyBuffer?.close() } catch {}
      await rm(legacyRoot, { recursive: true, force: true })
    }

    await buffer.close()
    buffer = new ExperienceBuffer({ root, now: () => now })
    await buffer.initialize()
    // Persistence check: reopening the store must see every admitted row,
    // including the empty ones recorded above.
    assert.equal(await buffer.count(), 11)
    assert.equal((await stat(dbPath)).mode & 0o777, 0o600)
    console.log('EXPERIENCE_BUFFER=PASS')
  } finally {
    try { await buffer?.close() } catch {}
    try { await boundaryBuffer?.close() } catch {}
    try { await purgeBuffer?.close() } catch {}
    await rm(root, { recursive: true, force: true })
    await assert.rejects(stat(root))
  }
}

await main()
