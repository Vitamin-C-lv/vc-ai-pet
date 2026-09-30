import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'

import { VisualSemanticIndex } from '../src/vision/visual-semantic-index.js'
import {
  VisualExperienceStore,
  VISUAL_EXPERIENCE_DB_FILENAME,
} from '../src/vision/visual-experience-store.js'
import {
  createReadOnlyAttachmentStore,
  runVisualSemanticIndex,
} from '../scripts/build-visual-semantic-index.mjs'

const ROOT_CAPTIONS = [
  '我们家的猫黑莓，第一次趴在窗边。',
  '邻居家的橘猫，第一次在院子里。',
]
const OBSERVATION_TEXT = '推测：黑莓的毛是深色的。'
const LATER_OBSERVATION_TEXT = '后来看到黑莓在窗边打盹。'

class FakeEncoder {
  constructor(model, { reverse = false } = {}) {
    this.model = model
    this.reverse = reverse
    this.calls = []
  }

  async describe() {
    return { status: 'ok', model: this.model, dimension: 3 }
  }

  async embed(inputs) {
    this.calls.push(inputs.map((input) => ({ ...input })))
    const vectors = inputs.map((input) => {
      let blackberry = false
      if (input.text !== undefined) {
        blackberry = input.text === ROOT_CAPTIONS[0]
          || input.text === '家里那只小黑猫叫什么？'
      } else if (input.image !== undefined) {
        const payload = input.image.split(',', 2)[1] ?? ''
        blackberry = Buffer.from(payload, 'base64').toString('utf8').includes('blackberry')
      }
      const direction = blackberry !== this.reverse ? [1, 0, 0] : [0, 1, 0]
      return direction
    })
    return { model: this.model, vectors }
  }
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-semantic-index-'))
let store = null
let otherStore = null
try {
  store = new VisualExperienceStore(root)
  await store.initialize()
  for (const [index, caption] of ROOT_CAPTIONS.entries()) {
    const attachmentId = index === 0 ? 'blackberry-photo' : 'orange-cat-photo'
    await store.syncMessage({
      id: `visual-message-${index}`,
      role: 'user',
      text: caption,
      timestamp: (index + 1) * 1000,
      attachment: {
        id: attachmentId,
        mimeType: 'image/png',
        assetPath: `conversation-assets/${attachmentId}.png`,
      },
    })
  }
  const blackberry = await store.findExperienceByMessageId('visual-message-0')
  await store.recordEvent({
    experienceId: blackberry.experienceId,
    kind: 'observation',
    occurredAt: 10,
    summary: OBSERVATION_TEXT,
    evidence: 'inferred',
  })
  store.close()
  store = null

  const attachments = []
  const assetDirectory = join(root, 'conversation-assets')
  await mkdir(assetDirectory, { recursive: true })
  for (const attachmentId of ['blackberry-photo', 'orange-cat-photo']) {
    const thumbnailPath = `conversation-assets/${attachmentId}-thumbnail.png`
    await writeFile(join(root, thumbnailPath), Buffer.from(`${attachmentId}-thumbnail`))
    attachments.push({
      id: attachmentId,
      mimeType: 'image/png',
      originalMimeType: 'image/png',
      assetPath: `conversation-assets/${attachmentId}.png`,
      thumbnailPath,
      thumbnailMimeType: 'image/png',
      thumbnailOriginalMimeType: 'image/png',
    })
  }
  await writeFile(join(root, 'conversation-store.json'), JSON.stringify({ version: 1, messages: [], attachments }))

  const encoder = new FakeEncoder('fake-chineseclip-v1')
  const summary = await runVisualSemanticIndex({ sandboxRoot: root, client: encoder, batchSize: 1 })
  assert.equal(summary.indexed, 2)
  assert.equal(summary.batches, 2)
  assert.ok(Number.isInteger(summary.elapsedMs) && summary.elapsedMs >= 0)
  assert.deepEqual(Object.keys(summary).sort(), ['batches', 'elapsedMs', 'indexed', 'scanned', 'skipped'])
  assert.equal(encoder.calls.flat().filter((input) => input.image !== undefined).length, 2)
  assert.deepEqual(
    encoder.calls.flat().filter((input) => input.text !== undefined).map((input) => input.text).sort(),
    [...ROOT_CAPTIONS].sort(),
  )
  assert.equal(encoder.calls.flat().some((input) => input.text === OBSERVATION_TEXT), false)
  assert.equal(encoder.calls.flat().some((input) => input.text === LATER_OBSERVATION_TEXT), false)

  const state = JSON.parse(await readFile(join(root, 'conversation-store.json'), 'utf8'))
  assert.equal(state.attachments.length, 2)
  await access(join(root, VISUAL_EXPERIENCE_DB_FILENAME))
  await assert.rejects(readFile(join(root, 'conversation-archive.db')))

  const conversationStore = await createReadOnlyAttachmentStore(root)
  const indexedStore = new VisualExperienceStore(root)
  otherStore = indexedStore
  await indexedStore.initialize()
  const index = new VisualSemanticIndex({ experienceStore: indexedStore, conversationStore, client: encoder })
  const unchanged = await index.sync()
  assert.equal(unchanged.indexed, 0)
  assert.equal(conversationStore.fileReads, 0)
  assert.equal(encoder.calls.flat().filter((input) => input.image !== undefined).length, 2)

  await indexedStore.recordEvent({
    experienceId: blackberry.experienceId,
    kind: 'observation',
    occurredAt: 1,
    summary: LATER_OBSERVATION_TEXT,
    evidence: 'inferred',
  })
  const afterObservation = await index.sync()
  assert.equal(afterObservation.indexed, 0)
  assert.equal(conversationStore.fileReads, 0)
  assert.equal(encoder.calls.flat().filter((input) => input.image !== undefined).length, 2)
  assert.equal(encoder.calls.flat().some((input) => input.text === LATER_OBSERVATION_TEXT), false)

  const recalled = await index.search('家里那只小黑猫叫什么？')
  assert.equal(recalled.model, 'fake-chineseclip-v1')
  assert.equal(recalled.winner.experienceId, blackberry.experienceId)
  assert.equal(recalled.winner.attachmentId, 'blackberry-photo')
  assert.equal(conversationStore.fileReads, 0)

  const otherEncoder = new FakeEncoder('fake-chineseclip-v2', { reverse: true })
  const otherIndex = new VisualSemanticIndex({ experienceStore: indexedStore, conversationStore, client: otherEncoder })
  assert.equal((await otherIndex.sync()).indexed, 2)
  const versionOneRows = await indexedStore.semanticEmbeddings('fake-chineseclip-v1')
  const versionTwoRows = await indexedStore.semanticEmbeddings('fake-chineseclip-v2')
  assert.equal(versionOneRows.length, 2)
  assert.equal(versionTwoRows.length, 2)
  assert.equal(new Set([...versionOneRows, ...versionTwoRows].map((row) => row.model)).size, 2)
  assert.equal((await otherIndex.search('家里那只小黑猫叫什么？')).winner.experienceId, blackberry.experienceId)

  const vectorFor = (score) => {
    const vector = new Float32Array(512)
    vector[0] = score
    return vector
  }
  const syntheticRows = Array.from({ length: 500 }, (_, position) => {
    const imageScore = position === 0 ? 1 : position === 1 ? 0.999 : position === 2 ? 0.998 : 0.5 - position / 100_000
    const textScore = position === 3 ? 1 : position === 4 ? 0.999 : position === 0 ? -1 : 0.5 - position / 100_000
    return {
      experienceId: `synthetic-${position}`,
      attachmentId: position === 0 ? 'toast-photo' : `synthetic-photo-${position}`,
      userText: position === 3 || position === 4 ? '你看看这个' : `合成记录 ${position}`,
      occurredAt: 1000 - position,
      imageVector: vectorFor(imageScore),
      textVector: vectorFor(textScore),
    }
  })
  const syntheticIndex = new VisualSemanticIndex({
    experienceStore: {
      async semanticEmbeddings(model) {
        assert.equal(model, 'fake-chineseclip-512')
        return syntheticRows
      },
    },
    conversationStore: {
      async readAttachmentDataUrl() {
        throw new Error('SEARCH_MUST_NOT_READ_IMAGES')
      },
    },
    client: {
      async embed(inputs) {
        assert.equal(inputs.length, 1)
        return { model: 'fake-chineseclip-512', vectors: [vectorFor(1)] }
      },
    },
  })
  const searchStartedAt = performance.now()
  const protectedCandidates = await syntheticIndex.search('笑脸烤面包和海苔饭卷')
  const syntheticSearchMs = Math.max(0, Math.round(performance.now() - searchStartedAt))
  assert.equal(protectedCandidates.candidates.length, 5)
  assert.ok(protectedCandidates.candidates.some((candidate) => candidate.attachmentId === 'toast-photo'))
  assert.ok(protectedCandidates.candidates.some((candidate) => candidate.experienceId === 'synthetic-1'))
  assert.ok(protectedCandidates.candidates.some((candidate) => candidate.experienceId === 'synthetic-2'))
  assert.ok(protectedCandidates.candidates.some((candidate) => candidate.experienceId === 'synthetic-3'))
  assert.ok(protectedCandidates.candidates.some((candidate) => candidate.experienceId === 'synthetic-4'))
  console.log(`VISUAL_SEMANTIC_500X512_SEARCH_MS=${syntheticSearchMs}`)

  const retryRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-semantic-retry-'))
  let retryStore = null
  let retryIndex = null
  try {
    retryStore = new VisualExperienceStore(retryRoot)
    await retryStore.initialize()
    const unreadable = await retryStore.syncMessage({
      id: 'unreadable-oldest', role: 'user', text: '稍早但暂不可读的图片', timestamp: 100,
      attachment: { id: 'unreadable-oldest-image' },
    })
    await retryStore.syncMessage({
      id: 'readable-next', role: 'user', text: '稍后的可读图片', timestamp: 200,
      attachment: { id: 'readable-next-image' },
    })
    retryStore.close()
    retryStore = null

    const retryAssetDirectory = join(retryRoot, 'conversation-assets')
    await mkdir(retryAssetDirectory, { recursive: true })
    const unreadableThumbnail = 'conversation-assets/unreadable-oldest-thumbnail.png'
    const readableThumbnail = 'conversation-assets/readable-next-thumbnail.png'
    await writeFile(join(retryRoot, readableThumbnail), Buffer.from('readable-next-image'))
    await writeFile(join(retryRoot, 'conversation-store.json'), JSON.stringify({
      version: 1,
      messages: [],
      attachments: [
        { id: 'unreadable-oldest-image', thumbnailPath: unreadableThumbnail, thumbnailMimeType: 'image/png' },
        { id: 'readable-next-image', thumbnailPath: readableThumbnail, thumbnailMimeType: 'image/png' },
      ],
    }))

    const retryEncoder = new FakeEncoder('fake-semantic-retry-v1')
    const firstPass = await runVisualSemanticIndex({ sandboxRoot: retryRoot, client: retryEncoder, batchSize: 1 })
    assert.equal(firstPass.indexed, 1)
    assert.equal(firstPass.scanned, 2)
    assert.equal(firstPass.skipped, 1)
    assert.equal(firstPass.batches, 2)
    assert.deepEqual(
      retryEncoder.calls.flat().filter((input) => input.text !== undefined).map((input) => input.text),
      ['稍后的可读图片'],
    )

    const retryAttachments = await createReadOnlyAttachmentStore(retryRoot)
    retryStore = new VisualExperienceStore(retryRoot)
    await retryStore.initialize()
    retryIndex = new VisualSemanticIndex({
      experienceStore: retryStore,
      conversationStore: retryAttachments,
      client: retryEncoder,
    })
    const missing = await retryIndex.sync({ limit: 1 })
    assert.equal(missing.scanned, 1)
    assert.equal(missing.skipped, 1)
    assert.equal(missing.indexed, 0)
    const drained = await retryIndex.sync({ limit: 1 })
    assert.equal(drained.scanned, 0)
    await writeFile(join(retryRoot, unreadableThumbnail), Buffer.from('restored-oldest-image'))
    const restored = await retryIndex.sync({ limit: 1 })
    assert.equal(restored.scanned, 1)
    assert.equal(restored.skipped, 0)
    assert.equal(restored.indexed, 1)
    assert.equal(unreadable.experienceId, (await retryStore.findExperienceByMessageId('unreadable-oldest')).experienceId)
  } finally {
    retryIndex?.stop()
    retryStore?.close()
    await rm(retryRoot, { recursive: true, force: true })
  }

  index.stop()
  otherIndex.stop()
  console.log('VISUAL_SEMANTIC_INDEX=PASS')
} finally {
  store?.close()
  otherStore?.close()
  await rm(root, { recursive: true, force: true })
}
