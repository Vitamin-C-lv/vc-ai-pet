import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { buildVisualCandidatePool, isVisualIdentityStatement, RecentVisualResolver } from '../src/conversation/recent-visual-context.js'
import { PetTurnEvents } from '../src/runtime/pet-turn-events.js'
import { PetTurnOrchestrator } from '../src/runtime/pet-turn-orchestrator.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'
import { VisualSemanticIndex } from '../src/vision/visual-semantic-index.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-owner-correction-'))
const imageA = 'data:image/png;base64,QUFB'
const imageB = 'data:image/png;base64,QkJC'
const resolver = new RecentVisualResolver()
const correctionOne = '不不不这个图上的猫猫就是黑莓'
const correctionTwo = '刚才那个阳台上的晒太阳的小猫就是我们家的黑莓'

const store = new ConversationStore(root, {
  idFactory: (() => { let n = 0; return () => 'message-' + (++n) })(),
})
const experienceStore = new VisualExperienceStore(root, {
  idFactory: (() => { let n = 0; return () => 'experience-' + (++n) })(),
})
await store.initialize()
await experienceStore.initialize()

async function saveImage(dataUrl, text, timestamp) {
  const attachment = await store.saveAttachment({
    image: { dataUrl },
    thumbnail: { dataUrl },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
    timestamp,
  })
  await store.appendMessage({ role: 'user', text, timestamp, attachment })
  return attachment
}

try {
  assert.equal(isVisualIdentityStatement(correctionOne), true, 'the screenshot correction identifies the pictured cat')
  assert.equal(isVisualIdentityStatement(correctionTwo), true, 'a descriptive follow-up still identifies the pictured cat')
  assert.equal(isVisualIdentityStatement('今晚我们吃什么'), false, 'ordinary chat is not an image identity statement')
  assert.equal(isVisualIdentityStatement('这只猫看起来像黑莓'), false, 'a resemblance or guess is not an owner-confirmed identity')

  // The assistant is looking back at an older photo while a newer, unrelated
  // photo exists in the conversation. The visible media reference is the active
  // referent, so the owner's correction must follow that exact attachment.
  const olderPhoto = await saveImage(imageA, '你看黑莓在晒太阳诶', 100)
  const newerPhoto = await saveImage(imageB, '后来又拍的一张普通照片', 200)
  await store.appendMessage({
    role: 'assistant',
    kind: 'final',
    turnId: 'turn-old-photo-recall',
    text: '花花觉得这只猫可能不是黑莓。',
    timestamp: 250,
  })
  await store.appendMessage({
    role: 'assistant',
    kind: 'media_ref',
    activityType: 'visual_image',
    relation: 'recalled',
    sourceAttachmentId: olderPhoto.id,
    attachment: olderPhoto,
    turnId: 'turn-old-photo-recall',
    text: '花花重新看看这张',
    timestamp: 300,
  })

  let messages = await store.listForRecentVisualRecall()
  const firstAssociation = resolver.resolve(correctionOne, messages)
  assert.equal(firstAssociation.matched, true)
  assert.equal(firstAssociation.attachmentId, olderPhoto.id, 'active assistant image must beat the newer unrelated upload')
  assert.equal(firstAssociation.reason, 'active-visual-reference')
  const secondAssociation = resolver.resolve(correctionTwo, messages)
  assert.equal(secondAssociation.matched, true, 'the follow-up description stays attached to the active image')
  assert.equal(secondAssociation.attachmentId, olderPhoto.id)
  assert.equal(secondAssociation.reason, 'active-visual-reference')
  console.log('ACTIVE_OLDER_VISUAL_REFERENCE=PASS')

  const calls = []
  const runtime = {
    conversationStore: store,
    conversation: { append() {} },
    memory: { recall() { return [] } },
    brain: {
      async visualStep(request) {
        calls.push(request)
        return {
          ok: true,
          observation: '原图是一只在阳台晒太阳的小猫。',
          action: 'answer',
          nextVisualId: '',
          focus: '小猫',
          replyMessages: ['花花重新看过这张照片了。'],
          match: 'match',
        }
      },
    },
  }
  const orchestrator = new PetTurnOrchestrator({
    runtime,
    resolver,
    experienceStore,
    now: () => 1000,
  })

  const firstEvents = new PetTurnEvents({ turnId: 'turn-owner-correction-1' })
  const firstTurn = await orchestrator.runVisual({
    turnId: 'turn-owner-correction-1',
    emit: (type, payload) => firstEvents.emit(type, payload),
    userText: correctionOne,
    attachment: null,
  })
  assert.equal(firstTurn.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].image.dataUrl, imageA, 'the older image currently on screen is re-inspected')
  assert.equal(calls[0].verifyRecall, true, 'an old photo is verified before being shown again')
  assert.match(calls[0].ownerCaption, /不不不这个图上的猫猫就是黑莓/u)
  assert.doesNotMatch(calls[0].ownerCaption, /花花觉得这只猫可能不是黑莓/u, 'assistant guess is excluded from owner evidence')

  messages = await store.listForRecentVisualRecall()
  const persistedFirstCorrection = messages.find((message) => message.role === 'user' && message.text === correctionOne)
  assert.ok(persistedFirstCorrection)
  assert.equal(persistedFirstCorrection.sourceAttachmentId, olderPhoto.id)
  assert.equal(persistedFirstCorrection.activityType, 'visual_owner_caption')
  assert.equal(persistedFirstCorrection.attachment, null, 'linking the statement must not create or upload an image')

  const secondEvents = new PetTurnEvents({ turnId: 'turn-owner-correction-2' })
  const secondTurn = await orchestrator.runVisual({
    turnId: 'turn-owner-correction-2',
    emit: (type, payload) => secondEvents.emit(type, payload),
    userText: correctionTwo,
    attachment: null,
  })
  assert.equal(secondTurn.ok, true, 'one concrete clarification can continue on the same active image')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].image.dataUrl, imageA)
  assert.match(calls[1].ownerCaption, /刚才那个阳台上的晒太阳的小猫就是我们家的黑莓/u)
  assert.doesNotMatch(calls[1].ownerCaption, /花花觉得这只猫可能不是黑莓/u)

  messages = await store.listForRecentVisualRecall()
  const persistedSecondCorrection = messages.find((message) => message.role === 'user' && message.text === correctionTwo)
  assert.ok(persistedSecondCorrection)
  assert.equal(persistedSecondCorrection.sourceAttachmentId, olderPhoto.id)
  assert.equal(persistedSecondCorrection.activityType, 'visual_owner_caption')
  assert.equal(persistedSecondCorrection.attachment, null)

  const targetCandidate = buildVisualCandidatePool({ messages })
    .find((candidate) => candidate.attachmentId === olderPhoto.id)
  assert.ok(targetCandidate)
  assert.match(targetCandidate.userText, /你看黑莓在晒太阳诶/u)
  assert.match(targetCandidate.userText, /不不不这个图上的猫猫就是黑莓/u)
  assert.match(targetCandidate.userText, /刚才那个阳台上的晒太阳的小猫就是我们家的黑莓/u)
  assert.doesNotMatch(targetCandidate.userText, /花花觉得这只猫可能不是黑莓/u)
  console.log('OWNER_CORRECTIONS_LINKED_TO_RAW_IMAGE=PASS')
  console.log('ASSISTANT_GUESS_NOT_OWNER_EVIDENCE=PASS')
  console.log('OWNER_CAPTION_RETRIEVAL_POOL=PASS')

  // A concise old owner name can be corrected and retained as a separate raw
  // owner statement linked to the same original image.
  const namedPhoto = { id: 'named-cat' }
  const namedMessages = [
    { role: 'user', text: '这只猫叫小橘', attachment: namedPhoto, timestamp: 500 },
    { role: 'assistant', kind: 'final', text: '花花猜这只猫叫小橘。', timestamp: 550 },
    { role: 'assistant', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: namedPhoto.id, attachment: namedPhoto, turnId: 'turn-named-photo', timestamp: 600 },
    { role: 'user', text: '这个图上的猫就是黑莓', sourceAttachmentId: namedPhoto.id, activityType: 'visual_owner_caption', timestamp: 650 },
  ]
  const namedResolution = resolver.resolve('这个图上的猫就是黑莓', namedMessages)
  assert.equal(namedResolution.matched, true)
  assert.equal(namedResolution.attachmentId, namedPhoto.id)
  assert.equal(namedResolution.reason, 'active-visual-reference')
  const namedCandidate = buildVisualCandidatePool({ messages: namedMessages })
    .find((candidate) => candidate.attachmentId === namedPhoto.id)
  assert.ok(namedCandidate)
  assert.match(namedCandidate.userText, /这只猫叫小橘/u)
  assert.match(namedCandidate.userText, /这个图上的猫就是黑莓/u)
  assert.doesNotMatch(namedCandidate.userText, /花花猜这只猫叫小橘/u, 'assistant guess must not become owner caption')
  const knownNames = ['黑莓', '小橘'].map((name) => ({ content: `我们家的猫叫${name}`, level: 'fact', provenance: { evidence: 'confirmed' } }))
  const renamedIndex = new VisualSemanticIndex({
    experienceStore: { async semanticEmbeddings() { return [
      { experienceId: 'renamed-cat', attachmentId: namedPhoto.id, userText: namedCandidate.userText, imageVector: [1, 0], textVector: [1, 0] },
      { experienceId: 'still-orange', attachmentId: 'orange-photo', userText: '这只猫叫小橘', imageVector: [0.8, 0.6], textVector: [0.8, 0.6] },
    ] } },
    client: { async embed() { return { model: 'fixture', vectors: [[1, 0]] } } },
    memory: { recall(query, limit, { filter }) { return knownNames.filter(filter).slice(0, limit) } },
  })
  const renamedRecall = await renamedIndex.search('黑莓长什么样子', { recallGoal: 'describe_subject' })
  assert.equal(renamedRecall.winner.attachmentId, namedPhoto.id, 'the corrected name is used before top K')
  const oldNameRecall = await renamedIndex.search('小橘长什么样子', { recallGoal: 'describe_subject' })
  assert.equal(oldNameRecall.winner.attachmentId, 'orange-photo', 'the retained old caption cannot rename this image back')
  assert.equal(oldNameRecall.candidates.some((candidate) => candidate.attachmentId === namedPhoto.id), false)
  console.log('NAMED_OWNER_CAPTION_CORRECTION=PASS')
  console.log('CORRECTED_NAME_FILTER_BEFORE_TOP_K=PASS')

  const clarifiedMessages = [
    { role: 'user', text: '阳台上晒太阳的小猫', attachment: namedPhoto, timestamp: 700 },
    { role: 'assistant', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: namedPhoto.id, attachment: namedPhoto, turnId: 'turn-clarification', timestamp: 750 },
    { role: 'user', text: correctionOne, sourceAttachmentId: namedPhoto.id, activityType: 'visual_owner_caption', timestamp: 800 },
    { role: 'assistant', kind: 'final', text: '主人说的是哪一张呀？花花怕认错，能再说得具体一点吗？', timestamp: 850 },
  ]
  const clarificationFollowUp = resolver.resolve(correctionTwo, clarifiedMessages)
  assert.equal(clarificationFollowUp.matched, true, 'a concrete answer to the fixed clarification keeps the displayed photo anchor')
  assert.equal(clarificationFollowUp.attachmentId, namedPhoto.id)
  assert.equal(clarificationFollowUp.reason, 'active-visual-reference')
  console.log('FIXED_CLARIFICATION_FOLLOWUP=PASS')

  const interruptedMessages = [
    { role: 'user', text: '窗边的一张照片', attachment: { id: 'photo-a' }, timestamp: 100 },
    { role: 'assistant', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: 'photo-a', attachment: { id: 'photo-a' }, turnId: 'turn-before-topic', timestamp: 200 },
    { role: 'user', text: '今晚吃什么', timestamp: 300 },
    { role: 'assistant', kind: 'final', text: '可以吃面条。', turnId: 'turn-topic', timestamp: 400 },
  ]
  const afterTopic = resolver.resolve(correctionOne, interruptedMessages)
  assert.equal(afterTopic.reason, 'ambiguous-visual-reference', 'an intervening ordinary topic ends the active image referent')
  assert.equal(afterTopic.matched, false)
  console.log('ORDINARY_TOPIC_BREAKS_ACTIVE_REFERENCE=PASS')

  const comparisonMessages = [
    { role: 'user', text: '第一张普通照片', attachment: { id: 'compare-a' }, timestamp: 100 },
    { role: 'user', text: '第二张普通照片', attachment: { id: 'compare-b' }, timestamp: 200 },
    { role: 'assistant', kind: 'media_ref', activityType: 'visual_image', relation: 'current', sourceAttachmentId: 'compare-a', attachment: { id: 'compare-a' }, turnId: 'turn-comparison', timestamp: 300 },
    { role: 'assistant', kind: 'media_ref', activityType: 'visual_image', relation: 'previous', sourceAttachmentId: 'compare-b', attachment: { id: 'compare-b' }, turnId: 'turn-comparison', timestamp: 400 },
  ]
  const comparisonCorrection = resolver.resolve('这只猫猫就是黑莓', comparisonMessages)
  assert.equal(comparisonCorrection.matched, false, 'a correction after a two-photo comparison must remain ambiguous')
  console.log('MULTI_IMAGE_IDENTITY_STAYS_AMBIGUOUS=PASS')

  const userPhotoIds = messages
    .filter((message) => message.role === 'user' && message.attachment?.id)
    .map((message) => message.attachment.id)
  assert.deepEqual(userPhotoIds, [olderPhoto.id, newerPhoto.id], 'corrections must link to the image without creating uploads')
} finally {
  store.close()
  experienceStore.close()
  await rm(root, { recursive: true, force: true })
}

console.log('VISUAL_OWNER_CORRECTION=PASS')
