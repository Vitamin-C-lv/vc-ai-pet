import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { visualTermsFor } from '../src/vision/visual-keywords.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-owner-caption-'))
const conversation = new ConversationStore(root)
const visual = new VisualExperienceStore(root)
let attachmentReads = 0
const tokenized = []
const tokenizeText = (text, options) => {
  tokenized.push({ text, ...options })
  return visualTermsFor(text, options)
}

try {
  await conversation.initialize()
  await conversation.appendMessage({
    id: 'photo-blackberry',
    role: 'user',
    text: '阳台上有一只小猫',
    timestamp: 1000,
    attachment: {
      id: 'blackberry-photo',
      mimeType: 'image/jpeg',
      originalMimeType: 'image/jpeg',
      assetPath: 'conversation-assets/blackberry-photo.jpg',
      thumbnailPath: 'conversation-assets/blackberry-photo-thumbnail.jpg',
    },
  })
  const captionOne = await conversation.appendMessage({
    id: 'caption-blackberry-1',
    role: 'user',
    text: '不不不这张照片上的小猫就是黑莓',
    timestamp: 2000,
    sourceAttachmentId: 'blackberry-photo',
    activityType: 'visual_owner_caption',
  })
  const captionTwo = await conversation.appendMessage({
    id: 'caption-blackberry-2',
    role: 'user',
    text: '它是我们家在阳台晒太阳的黑莓',
    timestamp: 3000,
    sourceAttachmentId: 'blackberry-photo',
    activityType: 'visual_owner_caption',
  })
  const assistantCaption = await conversation.appendMessage({
    id: 'assistant-owner-caption',
    role: 'assistant',
    text: '这只猫可能是黑莓',
    timestamp: 4000,
    sourceAttachmentId: 'blackberry-photo',
    activityType: 'visual_owner_caption',
  })
  const missingPhotoCaption = await conversation.appendMessage({
    id: 'caption-missing-photo',
    role: 'user',
    text: '这张照片是黑莓',
    timestamp: 5000,
    sourceAttachmentId: 'not-in-gallery',
    activityType: 'visual_owner_caption',
  })
  const ordinaryReference = await conversation.appendMessage({
    id: 'ordinary-source-reference',
    role: 'user',
    text: '黑莓刚才晒太阳',
    timestamp: 6000,
    sourceAttachmentId: 'blackberry-photo',
  })

  const storedCaption = (await conversation.rawHistoryAfterSequence({ afterSequence: 1, limit: 1 }))[0]
  assert.equal(storedCaption.id, captionOne.id)
  assert.equal(storedCaption.attachment, null)
  assert.equal(storedCaption.role, 'user')
  assert.equal(storedCaption.sourceAttachmentId, 'blackberry-photo')
  assert.equal(storedCaption.activityType, 'visual_owner_caption')

  let availableSequence = 1
  const archiveReadBatch = async (afterSequence, limit) => (await conversation.rawHistoryAfterSequence({ afterSequence, limit }))
    .filter((message) => message.archiveSequence <= availableSequence)
  const archiveMaxSequence = () => conversation.rawHistoryMaxSequence()
  const readAttachment = async () => {
    attachmentReads += 1
    return null
  }
  await visual.initialize()
  const photoSync = await visual.syncFromArchive({
    readBatch: archiveReadBatch,
    readMaxSequence: async () => 1,
    tokenizeText,
    readAttachment,
  })
  assert.equal(photoSync.createdCount, 1)
  assert.equal(await visual.countExperiences(), 1)
  const original = await visual.findExperienceByMessageId('photo-blackberry')
  assert.equal(original.userText, '阳台上有一只小猫')

  const initialSource = (await visual.semanticIndexSources('fixture-model'))[0]
  assert.equal(initialSource.userText, '阳台上有一只小猫')
  await visual.upsertSemanticEmbedding({
    experienceId: original.experienceId,
    model: 'fixture-model',
    attachmentId: 'blackberry-photo',
    userText: initialSource.userText,
    imageVector: [1, 0],
    textVector: [0, 1],
  })
  assert.deepEqual(await visual.semanticIndexSources('fixture-model'), [])

  availableSequence = await archiveMaxSequence()
  const archiveSync = await visual.syncFromArchive({
    readBatch: archiveReadBatch,
    readMaxSequence: archiveMaxSequence,
    tokenizeText,
    readAttachment,
  })
  assert.equal(archiveSync.processedCount, 5)
  assert.equal(archiveSync.createdCount, 0)
  assert.equal(archiveSync.modelCalls, 0)
  assert.equal(archiveSync.petMemoryWrites, 0)
  assert.equal(archiveSync.dreamRuns, 0)
  assert.equal(attachmentReads, 1)

  let photoOccurrences = await visual.occurrenceFor(original.experienceId)
  assert.equal(photoOccurrences.length, 1)
  assert.equal(photoOccurrences[0].userText, '阳台上有一只小猫')
  assert.equal((await visual.findExperienceById(original.experienceId)).userText, '阳台上有一只小猫')

  const ownerEvents = (await visual.eventsFor(original.experienceId)).filter((event) => event.kind === 'owner_caption')
  assert.deepEqual(ownerEvents.map((event) => event.eventId), [captionOne.id, captionTwo.id])
  assert.deepEqual(ownerEvents.map((event) => event.summary), [captionOne.text, captionTwo.text])
  assert.ok(ownerEvents.every((event) => event.evidence === 'raw'))
  assert.ok(ownerEvents.every((event) => event.experienceId === original.experienceId))

  const pendingSemanticSource = await visual.semanticIndexSources('fixture-model')
  assert.equal(pendingSemanticSource.length, 1)
  assert.equal(pendingSemanticSource[0].attachmentId, 'blackberry-photo')
  assert.equal(pendingSemanticSource[0].userText, [
    '阳台上有一只小猫',
    captionOne.text,
    captionTwo.text,
  ].join('\n'))

  const firstCaptionTerms = await visual.termsFor(original.experienceId, { limit: 500 })
  assert.ok(firstCaptionTerms.some((term) => term.sourceKind === 'user_text' && term.sourceRef === captionOne.id))
  assert.ok(firstCaptionTerms.some((term) => term.sourceKind === 'user_text' && term.sourceRef === captionTwo.id))
  assert.ok(tokenized.some((entry) => entry.text === captionOne.text && entry.sourceKind === 'user_text' && entry.sourceRef === captionOne.id))

  const replay = await visual.syncMessage(captionOne, { tokenizeText, readAttachment })
  assert.equal(replay.createdEvent, false)
  assert.equal(replay.createdOccurrence, false)
  assert.equal(replay.eventId, captionOne.id)
  assert.equal((await visual.eventsFor(original.experienceId)).filter((event) => event.kind === 'owner_caption').length, 2)
  photoOccurrences = await visual.occurrenceFor(original.experienceId)
  assert.equal(photoOccurrences.length, 1)
  assert.equal(attachmentReads, 1)

  await visual.syncMessage(assistantCaption, { tokenizeText, readAttachment })
  await visual.syncMessage(missingPhotoCaption, { tokenizeText, readAttachment })
  await visual.syncMessage(ordinaryReference, { tokenizeText, readAttachment })
  await visual.recordEvent({
    experienceId: original.experienceId,
    kind: 'observation',
    evidence: 'inferred',
    eventId: 'inferred-blackberry-observation',
    occurredAt: 7000,
    summary: '推测照片里的猫咪可能是黑莓',
  })

  const finalSources = await visual.semanticIndexSources('fixture-model')
  assert.equal(finalSources.length, 1)
  const finalSource = finalSources[0]
  assert.equal(finalSource.userText, pendingSemanticSource[0].userText)
  assert.equal(finalSource.userText.includes(assistantCaption.text), false)
  assert.equal(finalSource.userText.includes('推测照片里的猫咪'), false)
  assert.equal((await visual.findExperienceByAttachmentId('not-in-gallery')), null)
  assert.equal(await visual.countRawRoots(), 1)
  assert.equal((await visual.occurrenceFor(original.experienceId)).length, 1)
  assert.equal((await visual.eventsFor(original.experienceId)).filter((event) => event.kind === 'owner_caption').length, 2)
  assert.equal(attachmentReads, 1)

  await visual.upsertSemanticEmbedding({
    experienceId: original.experienceId,
    model: 'fixture-model',
    attachmentId: finalSource.attachmentId,
    userText: finalSource.userText,
    imageVector: [1, 0],
    textVector: [0, 1],
  })
  assert.deepEqual(await visual.semanticIndexSources('fixture-model'), [])

  console.log('VISUAL_OWNER_CAPTION_ARCHIVE_METADATA=PASS')
  console.log('VISUAL_OWNER_CAPTION_RAW_ARCHIVE_SYNC_IDEMPOTENT=PASS')
  console.log('VISUAL_OWNER_CAPTION_OCCURRENCE_AND_IMAGE_ISOLATION=PASS')
  console.log('VISUAL_OWNER_CAPTION_SEMANTIC_STALE_REBUILD=PASS')
  console.log('VISUAL_OWNER_CAPTION_ASSISTANT_INFERENCE_FILTER=PASS')
} finally {
  try { visual.close() } catch {}
  try { conversation.close() } catch {}
  await rm(root, { recursive: true, force: true })
}
