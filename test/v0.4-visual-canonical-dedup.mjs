import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { readVisualGallery, readVisualGalleryDetail } from '../src/remote/visual-gallery.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import {
  ASPECT_RATIO_DELTA_MAX,
  DHASH_DISTANCE_MAX,
  PHASH_DISTANCE_MAX,
  fingerprintImage,
  isStrictNearDuplicate,
} from '../src/vision/visual-fingerprint.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, bytes) {
  const name = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + bytes.length)
  chunk.writeUInt32BE(bytes.length, 0)
  name.copy(chunk, 4)
  bytes.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, bytes])), 8 + bytes.length)
  return chunk
}

function pngFixture(width, height, pixels, { compressionLevel = 6, metadata = false } = {}) {
  const scanlines = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const source = pixels[y * width + x]
      const offset = y * (width * 3 + 1) + 1 + x * 3
      scanlines[offset] = source[0]
      scanlines[offset + 1] = source[1]
      scanlines[offset + 2] = source[2]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const chunks = [pngChunk('IHDR', header)]
  if (metadata) chunks.push(pngChunk('tEXt', Buffer.from('comment\0different metadata', 'latin1')))
  chunks.push(pngChunk('IDAT', deflateSync(scanlines, { level: compressionLevel })))
  chunks.push(pngChunk('IEND', Buffer.alloc(0)))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks])
}

function dataUrl(bytes) {
  return `data:image/png;base64,${bytes.toString('base64')}`
}

function canvas(width, height, background = [245, 245, 245]) {
  return Array.from({ length: width * height }, () => [...background])
}

function rect(pixels, width, height, left, top, right, bottom, color) {
  const x0 = Math.max(0, Math.floor(left * width))
  const y0 = Math.max(0, Math.floor(top * height))
  const x1 = Math.min(width, Math.ceil(right * width))
  const y1 = Math.min(height, Math.ceil(bottom * height))
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) pixels[y * width + x] = [...color]
}

function catScene(width, height, { pose = 'sit', shift = 0 } = {}) {
  const pixels = canvas(width, height, [238, 232, 224])
  rect(pixels, width, height, 0.05, 0.08, 0.95, 0.92, [220, 214, 207])
  const offset = shift / width
  rect(pixels, width, height, 0.25 + offset, 0.38, 0.72 + offset, 0.82, [70, 66, 64])
  rect(pixels, width, height, 0.34 + offset, 0.2, 0.66 + offset, 0.52, [82, 77, 73])
  rect(pixels, width, height, 0.37 + offset, 0.17, 0.44 + offset, 0.31, [82, 77, 73])
  rect(pixels, width, height, 0.56 + offset, 0.17, 0.63 + offset, 0.31, [82, 77, 73])
  rect(pixels, width, height, 0.41 + offset, 0.33, 0.45 + offset, 0.37, [245, 245, 240])
  rect(pixels, width, height, 0.55 + offset, 0.33, 0.59 + offset, 0.37, [245, 245, 240])
  rect(pixels, width, height, 0.425 + offset, 0.345, 0.435 + offset, 0.36, [20, 20, 20])
  rect(pixels, width, height, 0.56 + offset, 0.345, 0.57 + offset, 0.36, [20, 20, 20])
  if (pose === 'stand') rect(pixels, width, height, 0.69 + offset, 0.55, 0.9 + offset, 0.63, [70, 66, 64])
  else rect(pixels, width, height, 0.15 + offset, 0.61, 0.3 + offset, 0.67, [70, 66, 64])
  return pixels
}

function shinchanScene(width, height, { frame = 0 } = {}) {
  const pixels = canvas(width, height, [248, 239, 213])
  rect(pixels, width, height, 0.08, 0.1, 0.92, 0.88, [233, 222, 189])
  rect(pixels, width, height, 0.3, 0.22, 0.7, 0.72, [241, 184, 157])
  rect(pixels, width, height, 0.26, 0.14, 0.74, 0.3, [35, 31, 29])
  rect(pixels, width, height, 0.36, 0.35, 0.42, 0.42, [20, 20, 20])
  rect(pixels, width, height, 0.58, 0.35, 0.64, 0.42, [20, 20, 20])
  rect(pixels, width, height, 0.43 + frame / width, 0.5, 0.57 + frame / width, 0.54, [120, 35, 30])
  rect(pixels, width, height, 0.24, 0.72, 0.76, 0.84, [45, 66, 157])
  if (frame === 0) rect(pixels, width, height, 0.12, 0.62, 0.28, 0.7, [35, 31, 29])
  else rect(pixels, width, height, 0.72, 0.58, 0.9, 0.66, [35, 31, 29])
  return pixels
}

function attachmentBytes(width, height, pixels, options = {}) {
  return pngFixture(width, height, pixels, options)
}

async function saveImage(conversation, bytes, timestamp, width = 64, height = 48) {
  const image = dataUrl(bytes)
  return conversation.saveAttachment({
    image: { dataUrl: image },
    thumbnail: { dataUrl: image },
    width,
    height,
    thumbnailWidth: width,
    thumbnailHeight: height,
    timestamp,
    requireThumbnail: true,
  })
}

async function appendImage(conversation, bytes, id, text, timestamp, width = 64, height = 48) {
  const attachment = await saveImage(conversation, bytes, timestamp, width, height)
  await conversation.appendMessage({ id, role: 'user', text, attachment, timestamp })
  return attachment
}

function readers(conversation) {
  return {
    readBatch: (afterSequence, limit) => conversation.rawHistoryAfterSequence({ afterSequence, limit }),
    readMaxSequence: () => conversation.rawHistoryMaxSequence(),
    readAttachment: (attachmentId) => conversation.readAttachmentDataUrl(attachmentId),
  }
}

async function runTurn(runtime, userText, attachmentId) {
  const started = runtime.startChatTurn({ userText, attachmentId })
  let poll = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  return poll
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-canonical-dedup-'))
  let conversation = null
  let store = null
  try {
    conversation = new ConversationStore(root)
    await conversation.initialize()
    store = new VisualExperienceStore(root)
    await store.initialize()

    const cat64 = attachmentBytes(64, 48, catScene(64, 48))
    const cat64Reencoded = attachmentBytes(64, 48, catScene(64, 48), { compressionLevel: 1 })
    const catResize = attachmentBytes(96, 72, catScene(96, 72))
    const catMetadata = attachmentBytes(64, 48, catScene(64, 48), { compressionLevel: 9, metadata: true })
    const catFrame = attachmentBytes(64, 48, catScene(64, 48, { pose: 'stand', shift: 5 }))
    const catPose = attachmentBytes(64, 48, catScene(64, 48, { pose: 'stand' }))
    const catPosition = attachmentBytes(64, 48, catScene(64, 48, { shift: 12 }))
    const catCrop = attachmentBytes(56, 48, catScene(56, 48))

    const firstCat = await appendImage(conversation, cat64, 'cat-1', '这是黑猫', 1000)
    const exactCat = await appendImage(conversation, cat64, 'cat-2', '黑猫又出现了', 2000)
    const reencodedCat = await appendImage(conversation, cat64Reencoded, 'cat-3', '这是重新编码的黑猫', 3000)
    const resizedCat = await appendImage(conversation, catResize, 'cat-4', '这是缩放后的黑猫', 4000, 96, 72)
    const metadataCat = await appendImage(conversation, catMetadata, 'cat-5', '黑猫的 EXIF 不同', 5000)
    const catFrameAttachment = await appendImage(conversation, catFrame, 'cat-frame', '相邻帧', 6000)
    const catPoseAttachment = await appendImage(conversation, catPose, 'cat-pose', '不同姿势', 7000)
    const catPositionAttachment = await appendImage(conversation, catPosition, 'cat-position', '背景里位置不同', 8000)
    const catCropAttachment = await appendImage(conversation, catCrop, 'cat-crop', '轻微裁剪', 9000, 56, 48)

    const shinchan = attachmentBytes(64, 48, shinchanScene(64, 48))
    const shinchanFrame = attachmentBytes(64, 48, shinchanScene(64, 48, { frame: 5 }))
    const shinchanFirst = await appendImage(conversation, shinchan, 'shinchan-1', '这是蜡笔小新', 10000)
    await appendImage(conversation, shinchan, 'shinchan-2', '还是这张蜡笔小新', 11000)
    await appendImage(conversation, shinchanFrame, 'shinchan-frame', '蜡笔小新相邻帧', 12000)

    const sync = await store.syncFromArchive({ ...readers(conversation), tokenizeText: (text) => String(text).split(/\s+/u).filter(Boolean).map((term) => ({ term, weight: 3 })) })
    assert.equal(sync.modelCalls, 0)
    assert.equal(sync.petMemoryWrites, 0)
    assert.equal(sync.dreamRuns, 0)

    const directAttachment = await saveImage(conversation, cat64, 13000)
    await conversation.appendMessage({ id: 'cat-direct', role: 'user', text: '实时再次发送黑猫', attachment: directAttachment, timestamp: 13000 })
    const directResult = await store.syncMessage({ id: 'cat-direct', role: 'user', text: '实时再次发送黑猫', timestamp: 13000, attachment: directAttachment }, {
      archiveSequence: 13,
      readAttachment: (attachmentId) => conversation.readAttachmentDataUrl(attachmentId),
    })
    assert.equal(directResult.createdExperience, false)
    assert.equal(directResult.createdOccurrence, true)
    assert.equal(directResult.duplicateKind, 'EXACT')
    assert.equal(typeof directResult.experienceId, 'string')
    const repeatedResult = await store.syncMessage({ id: 'cat-direct', role: 'user', text: '实时再次发送黑猫', timestamp: 13000, attachment: directAttachment }, {
      readAttachment: (attachmentId) => conversation.readAttachmentDataUrl(attachmentId),
    })
    assert.equal(repeatedResult.createdOccurrence, false)
    assert.equal(repeatedResult.duplicateKind, 'SOURCE_MESSAGE')

    const catExperience = await store.findExperienceByAttachmentId(firstCat.id)
    assert.ok(catExperience)
    assert.equal(await store.findExperienceByAttachmentId(exactCat.id).then((value) => value.experienceId), catExperience.experienceId)
    assert.equal(await store.findExperienceByAttachmentId(reencodedCat.id).then((value) => value.experienceId), catExperience.experienceId)
    assert.equal(await store.findExperienceByAttachmentId(resizedCat.id).then((value) => value.experienceId), catExperience.experienceId)
    assert.equal(await store.findExperienceByAttachmentId(metadataCat.id).then((value) => value.experienceId), catExperience.experienceId)
    assert.notEqual(await store.findExperienceByAttachmentId(catFrameAttachment.id).then((value) => value.experienceId), catExperience.experienceId)

    const occurrences = await store.occurrenceFor(catExperience.experienceId)
    assert.equal(occurrences.length, 6)
    assert.deepEqual(occurrences.map((item) => item.duplicateKind), ['NEW', 'EXACT', 'PERCEPTUAL', 'PERCEPTUAL', 'PERCEPTUAL', 'EXACT'])
    assert.equal((await store.findExperienceByAttachmentId(catPoseAttachment.id)).experienceId === catExperience.experienceId, false)
    assert.equal((await store.findExperienceByAttachmentId(catPositionAttachment.id)).experienceId === catExperience.experienceId, false)
    assert.equal((await store.findExperienceByAttachmentId(catCropAttachment.id)).experienceId === catExperience.experienceId, false)

    const shinchanExperience = await store.findExperienceByAttachmentId(shinchanFirst.id)
    assert.ok(shinchanExperience)
    assert.equal(await store.findExperienceByMessageId('shinchan-2').then((value) => value.experienceId), shinchanExperience.experienceId)
    assert.notEqual(await store.findExperienceByMessageId('shinchan-frame').then((value) => value.experienceId), shinchanExperience.experienceId)
    assert.equal((await store.countExperiences()), 7)
    assert.equal((await store.listExperiences({ limit: 100 })).filter((item) => item.occurrenceCount > 1).length, 2)

    const catTerms = await store.searchByTerms([{ term: '黑猫又出现了', weight: 3 }], { queryText: '黑猫又出现了' })
    assert.equal(catTerms[0].experienceId, catExperience.experienceId)
    assert.equal(catTerms[0].userTexts.includes('黑猫又出现了'), true)

    const detail = await readVisualGalleryDetail({ visualExperience: store, conversationStore: conversation }, catExperience.experienceId)
    assert.equal(detail.occurrences.length, 6)
    assert.deepEqual(Object.keys(detail.occurrences[0]).sort(), ['attachmentId', 'occurredAt', 'sourceMessageId', 'userText'])
    assert.equal(detail.occurrences.at(-1).userText, '实时再次发送黑猫')
    assert.equal(detail.occurrenceCount, 6)
    const gallery = await readVisualGallery({ visualExperience: store, conversationStore: conversation }, { limit: 100 })
    assert.equal(gallery.count, 7)
    assert.equal(gallery.items.some((item) => item.experienceId === catExperience.experienceId && item.occurrenceCount === 6), true)

    const fingerprintA = await fingerprintImage({ bytes: cat64, width: 64, height: 48 })
    const fingerprintB = await fingerprintImage({ bytes: catResize, width: 96, height: 72 })
    const near = isStrictNearDuplicate(fingerprintA, fingerprintB)
    assert.equal(near.match, true)
    assert.ok(near.phashDistance <= PHASH_DISTANCE_MAX)
    assert.ok(near.dhashDistance <= DHASH_DISTANCE_MAX)
    assert.ok(near.aspectRatioDelta <= ASPECT_RATIO_DELTA_MAX)

    const liveRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-canonical-live-'))
    const liveRuntime = new PetRuntime({ sandboxRoot: liveRoot })
    try {
      await liveRuntime.initialize()
      liveRuntime.brain = {
        visualStep: async () => ({ ok: true, observation: '看到了这只猫。', action: 'answer', nextVisualId: '', focus: '猫', replyMessages: ['花花看到了这只猫。'] }),
        reply: async () => ({ ok: true, text: '收到。', replyMessages: ['收到。'] }),
      }
      const liveFirst = await saveImage(liveRuntime.conversationStore, cat64, 20000)
      const liveSecond = await saveImage(liveRuntime.conversationStore, cat64Reencoded, 21000)
      const firstTurn = await runTurn(liveRuntime, '这是黑猫', liveFirst.id)
      const secondTurn = await runTurn(liveRuntime, '今天又发黑猫了', liveSecond.id)
      assert.equal(firstTurn?.status, 'done')
      assert.equal(secondTurn?.status, 'done')
      const liveExperience = await liveRuntime.visualExperience.findExperienceByAttachmentId(liveFirst.id)
      assert.equal(await liveRuntime.visualExperience.countExperiences(), 1)
      assert.equal((await liveRuntime.visualExperience.occurrenceFor(liveExperience.experienceId)).length, 2)
      assert.deepEqual((await liveRuntime.visualExperience.eventsFor(liveExperience.experienceId)).map((event) => event.kind), ['inspection', 'observation', 'revisit', 'observation'])
      assert.equal((await liveRuntime.conversationStore.rawHistory({ limit: 100 })).filter((message) => message.role === 'user' && message.attachment).length, 2)
      console.log('REAL_UPLOAD_OCCURRENCE_REVISIT_OBSERVATION=PASS')
    } finally {
      liveRuntime.close()
      await rm(liveRoot, { recursive: true, force: true })
    }

    const legacyRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-canonical-migration-'))
    let legacyConversation = null
    let legacyStore = null
    try {
      legacyConversation = new ConversationStore(legacyRoot)
      await legacyConversation.initialize()
      const legacyA = await appendImage(legacyConversation, shinchan, 'legacy-a', '第一次蜡笔小新', 1000)
      const legacyB = await appendImage(legacyConversation, shinchan, 'legacy-b', '第二次蜡笔小新', 2000)
      legacyStore = new VisualExperienceStore(legacyRoot, { idFactory: () => `generated-${Date.now()}` })
      await legacyStore.initialize()
      legacyStore.db.prepare(`INSERT INTO visual_experiences(experience_id, source_message_id, attachment_id, occurred_at, user_text, created_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`)
        .run('legacy-root-a', 'legacy-a', legacyA.id, 1000, '第一次蜡笔小新', 1000, 'legacy-root-b', 'legacy-b', legacyB.id, 2000, '第二次蜡笔小新', 2000)
      const beforeMessages = (await legacyConversation.rawHistory({ limit: 20 })).length
      const migrated = await legacyStore.migrateHistorical({
        readAttachment: (attachmentId) => legacyConversation.readAttachmentDataUrl(attachmentId),
        tokenizeText: (text) => [{ term: text, weight: 3 }],
      })
      assert.equal(migrated.rootsBefore, 2)
      assert.equal(migrated.aliasesCreated, 1)
      assert.equal(migrated.occurrencesCreated, 2)
      assert.equal(migrated.rootsAfterCanonicalView, 1)
      assert.equal((await legacyStore.occurrenceFor('legacy-root-a')).length, 2)
      assert.equal((await legacyConversation.rawHistory({ limit: 20 })).length, beforeMessages)
      const repeatedMigration = await legacyStore.migrateHistorical({ readAttachment: (attachmentId) => legacyConversation.readAttachmentDataUrl(attachmentId) })
      assert.equal(repeatedMigration.aliasesCreated, 0)
      assert.equal(repeatedMigration.occurrencesCreated, 0)
      assert.equal(repeatedMigration.newRoot, 0)
      console.log('HISTORICAL_MIGRATION_NON_DESTRUCTIVE=PASS')
      console.log(`MIGRATION_GROUPS=${migrated.duplicateGroups.length}`)
    } finally {
      legacyStore?.close()
      legacyConversation?.close()
      await rm(legacyRoot, { recursive: true, force: true })
    }

    const rawArchive = await readFile(join(root, 'conversation-archive.db'))
    assert.ok(createHash('sha256').update(rawArchive).digest('hex'))
    console.log('EXACT_DUPLICATE=PASS')
    console.log('REENCODED_DUPLICATE=PASS')
    console.log('RESIZED_DUPLICATE=PASS')
    console.log('METADATA_VARIANT_DUPLICATE=PASS')
    console.log('SIMILAR_DIFFERENT_FRAME_NOT_MERGED=PASS')
    console.log('SAME_CAT_DIFFERENT_POSE_NOT_MERGED=PASS')
    console.log('BACKGROUND_POSITION_NOT_MERGED=PASS')
    console.log('CROP_CONSERVATIVE_NOT_MERGED=PASS')
    console.log('OCCURRENCE_HISTORY_AND_TERM_AGGREGATION=PASS')
    console.log('VISUAL_CANONICAL_DEDUP=PASS')
  } finally {
    store?.close()
    conversation?.close()
    await rm(root, { recursive: true, force: true })
  }
}

await main()
