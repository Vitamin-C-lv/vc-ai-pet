import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { validateVisualStepResponse } from '../src/brain/local-brain.js'
import { PetTurnOrchestrator } from '../src/runtime/pet-turn-orchestrator.js'
import {
  MAX_VISUAL_INSPECTIONS_PER_TURN,
  VisualWorkingSession,
} from '../src/vision/visual-working-session.js'

const IMAGES = [
  'data:image/png;base64,QUFB',
  'data:image/png;base64,QkJC',
  'data:image/png;base64,Q0ND',
  'data:image/png;base64,RERE',
  'data:image/png;base64,RUVF',
  'data:image/png;base64,RkZG',
  'data:image/png;base64,R0dH',
  'data:image/png;base64,SEhI',
  'data:image/png;base64,SUlJ',
  'data:image/png;base64,SktL',
]

async function saveImage(store, dataUrl) {
  return store.saveAttachment({
    image: { dataUrl },
    thumbnail: { dataUrl },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
  })
}

function makeCandidate(attachment, index, score) {
  return {
    visualId: 'V' + index,
    attachmentId: attachment.id,
    relation: 'recalled',
    score,
    userText: '历史候选 ' + index,
  }
}

function makeBrain(matches, calls) {
  return {
    async visualStep(request) {
      calls.push(request)
      const match = matches[calls.length - 1] ?? 'mismatch'
      return {
        ok: true,
        observation: match === 'match' ? '和主人描述的主体与场景一致。' : '',
        action: 'answer',
        nextVisualId: '',
        focus: '',
        replyMessages: match === 'match' ? ['花花找到你说的那张啦。'] : [],
        match,
      }
    },
  }
}

function createSession({ store, candidates, matches, turnId, events, calls }) {
  return new VisualWorkingSession({
    turnId,
    userText: '你还记得以前给我看的那张照片吗？',
    candidatePool: candidates,
    conversationStore: store,
    brain: makeBrain(matches, calls),
    emit(type, payload) {
      const event = { type, payload }
      events.push(event)
      return { seq: events.length, at: events.length }
    },
  })
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-recall-verify-'))
const store = new ConversationStore(root)

try {
  await store.initialize()

  // The resolver's first, highest-scoring historical candidate is wrong.
  // Vision must reject A, inspect B, and publish only the confirmed image B.
  const imageA = await saveImage(store, IMAGES[0])
  const imageB = await saveImage(store, IMAGES[1])
  const rankedCandidates = [
    makeCandidate(imageA, 0, 100),
    makeCandidate(imageB, 1, 72),
  ]
  const matchCalls = []
  const matchEvents = []
  const matched = await createSession({
    store,
    candidates: rankedCandidates,
    matches: ['mismatch', 'match'],
    turnId: 'recall-verify-match',
    events: matchEvents,
    calls: matchCalls,
  }).run('V0')

  assert.equal(matched.ok, true)
  assert.deepEqual(matchCalls.map(({ image, verifyRecall }) => ({
    dataUrl: image.dataUrl,
    verifyRecall,
  })), [
    { dataUrl: IMAGES[0], verifyRecall: true },
    { dataUrl: IMAGES[1], verifyRecall: true },
  ])
  assert.deepEqual(matchEvents
    .filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [imageB.id])
  assert.deepEqual((await store.listForRecentVisualRecall(100))
    .filter((message) => message.turnId === 'recall-verify-match' && message.kind === 'media_ref')
    .map((message) => message.sourceAttachmentId), [imageB.id])

  const duplicateMatchEvents = []
  const duplicateMatch = await createSession({
    store, candidates: rankedCandidates, matches: ['match', 'match'],
    turnId: 'recall-verify-not-unique', events: duplicateMatchEvents, calls: [],
  }).run('V0')
  assert.equal(duplicateMatch.ok, true)
  assert.equal(duplicateMatch.verifiedAttachmentId, null)
  assert.equal(duplicateMatchEvents.some(({ type }) => type === 'visual_image'), false)
  assert.match(duplicateMatch.final.replyMessages[0], /先不发图/u)

  // The long-term resolver's runner-up must reach the visual session. The
  // previous orchestrator discarded it and substituted recent-chat images.
  const routedCalls = []
  const routedEvents = []
  const otherOccurrences = []
  for (let index = 0; index < 4; index += 1) otherOccurrences.push((await saveImage(store, IMAGES[index + 2])).id)
  const groupedWinner = { ...rankedCandidates[0], attachmentIds: [imageA.id, ...otherOccurrences] }
  const runtime = {
    conversationStore: store,
    conversation: { append() {} },
    memory: { recall() { return [] } },
    brain: makeBrain(['mismatch', 'match'], routedCalls),
  }
  const orchestrator = new PetTurnOrchestrator({
    runtime,
    longTermResolver: { async resolve() {
      return { status: 'matched', winner: groupedWinner, candidates: [groupedWinner, rankedCandidates[1]] }
    } },
  })
  const routed = await orchestrator.runVisual({
    turnId: 'recall-verify-routed',
    userText: '你记得以前那张黑莓在纸箱里的照片吗？',
    attachment: null,
    emit(type, payload) { routedEvents.push({ type, payload }); return { seq: routedEvents.length, at: routedEvents.length } },
  })
  assert.equal(routed.ok, true)
  assert.equal(routedCalls.length, MAX_VISUAL_INSPECTIONS_PER_TURN)
  assert.deepEqual(routedEvents.filter(({ type }) => type === 'visual_image').map(({ payload }) => payload.sourceAttachmentId), [imageB.id])
  assert.deepEqual((await store.listForRecentVisualRecall(100))
    .filter((message) => message.turnId === 'recall-verify-routed' && message.kind === 'media_ref')
    .map((message) => message.sourceAttachmentId), [imageB.id])

  const wrongRecent = await store.saveAttachment({ image: { dataUrl: IMAGES[4] }, thumbnail: { dataUrl: IMAGES[5] }, width: 1024, height: 768, thumbnailWidth: 256, thumbnailHeight: 192, requireThumbnail: true })
  const rightRecent = await store.saveAttachment({ image: { dataUrl: IMAGES[6] }, thumbnail: { dataUrl: IMAGES[7] }, width: 1024, height: 768, thumbnailWidth: 256, thumbnailHeight: 192, requireThumbnail: true })
  await store.appendMessage({ role: 'user', text: '桌上的玩具', attachment: wrongRecent })
  await store.appendMessage({ role: 'user', text: '猫在纸箱里', attachment: rightRecent })
  const semanticSearchCalls = []
  const semanticVerifyCalls = []
  const semanticEvents = []
  const semanticOrchestrator = new PetTurnOrchestrator({
    runtime: { ...runtime, brain: {
      async visualSearch(request) {
        semanticSearchCalls.push(request)
        return { ok: true, visualIds: ['V1', 'V0'] }
      },
      ...makeBrain(['mismatch', 'match'], semanticVerifyCalls),
    } },
  })
  const semanticResult = await semanticOrchestrator.runVisual({
    turnId: 'recent-semantic-verify', userText: '帮我找猫在纸箱里的照片', attachment: null,
    emit(type, payload) { semanticEvents.push({ type, payload }) },
  })
  assert.equal(semanticResult.ok, true)
  assert.deepEqual(semanticSearchCalls[0].candidates.map(({ image }) => image.dataUrl), [IMAGES[7], IMAGES[5]])
  assert.deepEqual(semanticVerifyCalls.map(({ image }) => image.dataUrl), [IMAGES[4], IMAGES[6]])
  assert.deepEqual(semanticEvents.filter(({ type }) => type === 'visual_image').map(({ payload }) => payload.sourceAttachmentId), [rightRecent.id])
  assert.deepEqual((await store.listForRecentVisualRecall(100)).filter((message) => message.turnId === 'recent-semantic-verify' && message.kind === 'media_ref').map((message) => message.sourceAttachmentId), [rightRecent.id])

  const gallery = []
  for (let index = 0; index < 12; index += 1) {
    const attachment = await saveImage(store, IMAGES[0])
    gallery.push({ experienceId: `gallery-${index}`, attachmentId: attachment.id, userText: '早餐', lastOccurredAt: index, occurrenceCount: index === 11 ? 2 : 1 })
  }
  const groupedTarget = await saveImage(store, IMAGES[8])
  const gallerySearchCalls = []
  const galleryVerifyCalls = []
  const galleryEvents = []
  const galleryOrchestrator = new PetTurnOrchestrator({
    runtime: { ...runtime, brain: {
      async visualSearch(request) {
        gallerySearchCalls.push(request)
        const target = request.candidates.find(({ image }) => image.dataUrl === IMAGES[8])
        return { ok: true, visualIds: target ? [target.visualId] : [] }
      },
      ...makeBrain(['match'], galleryVerifyCalls),
    } },
    experienceStore: {
      async listExperiences() { return gallery },
      async occurrenceFor() { return [gallery[11], { attachmentId: groupedTarget.id, userText: '是这个早餐', occurredAt: 13 }] },
    },
  })
  const galleryResult = await galleryOrchestrator.runVisual({
    turnId: 'gallery-semantic-verify', userText: '帮我找纸箱里的猫照片', attachment: null,
    emit(type, payload) { galleryEvents.push({ type, payload }) },
  })
  assert.equal(galleryResult.ok, true)
  assert.equal(gallerySearchCalls.length, 2, 'gallery previews are screened in small batches')
  assert.deepEqual(galleryVerifyCalls.map(({ image }) => image.dataUrl), [IMAGES[8]])
  assert.deepEqual(galleryEvents.filter(({ type }) => type === 'visual_image').map(({ payload }) => payload.sourceAttachmentId), [groupedTarget.id])
  const searchCallsBeforeBareReference = gallerySearchCalls.length
  const bareEvents = []
  const bareReference = await galleryOrchestrator.runVisual({
    turnId: 'gallery-bare-reference', userText: '你记得以前那张照片吗', attachment: null,
    emit(type, payload) { bareEvents.push({ type, payload }) },
  })
  assert.equal(bareReference.ok, true)
  assert.equal(gallerySearchCalls.length, searchCallsBeforeBareReference)
  assert.equal(bareEvents.some(({ type }) => type === 'visual_image'), false)
  assert.match(bareReference.text, /哪一张/u)

  const noMatchEvents = []
  const noMatchOrchestrator = new PetTurnOrchestrator({
    runtime: { ...runtime, brain: makeBrain(['mismatch', 'uncertain'], []) },
    longTermResolver: { async resolve() { return { status: 'matched', winner: rankedCandidates[0], candidates: rankedCandidates } } },
  })
  const noMatchResult = await noMatchOrchestrator.runVisual({
    turnId: 'recall-verify-routed-none',
    userText: '你记得以前那张黑莓在纸箱里的照片吗？',
    attachment: null,
    emit(type, payload) { noMatchEvents.push({ type, payload }) },
  })
  assert.equal(noMatchResult.ok, true)
  assert.match(noMatchResult.text, /先不发图/u)
  assert.equal(noMatchOrchestrator.recallContextActive(), true)
  assert.equal(noMatchEvents.some(({ type }) => type === 'visual_image'), false)
  assert.equal((await store.listForRecentVisualRecall(100))
    .some((message) => message.turnId === 'recall-verify-routed-none' && message.kind === 'media_ref'), false)

  // Six retrieved historical candidates are bounded to five inspections.
  // Rejected candidates never produce an image event or a media_ref row.
  const mismatchCandidates = []
  for (let index = 0; index < 6; index += 1) {
    const attachment = await saveImage(store, IMAGES[index + 2])
    mismatchCandidates.push(makeCandidate(attachment, index, 100 - index))
  }
  const mismatchCalls = []
  const mismatchEvents = []
  const allMismatch = await createSession({
    store,
    candidates: mismatchCandidates,
    matches: Array(6).fill('mismatch'),
    turnId: 'recall-verify-mismatch',
    events: mismatchEvents,
    calls: mismatchCalls,
  }).run('V0')

  assert.equal(allMismatch.ok, true)
  assert.equal(mismatchCalls.length, MAX_VISUAL_INSPECTIONS_PER_TURN)
  assert.equal(mismatchCalls.every((request) => request.verifyRecall === true), true)
  assert.equal(mismatchEvents.some(({ type }) => type === 'visual_image'), false)
  assert.equal((await store.listForRecentVisualRecall(100))
    .some((message) => message.turnId === 'recall-verify-mismatch' && message.kind === 'media_ref'), false)

  // Uncertain results also exhaust the bounded candidates without publishing.
  const uncertainCandidates = []
  for (let index = 0; index < 2; index += 1) {
    const attachment = await saveImage(store, IMAGES[index + 8])
    uncertainCandidates.push(makeCandidate(attachment, index, 20 - index))
  }
  const uncertainCalls = []
  const uncertainEvents = []
  const uncertain = await createSession({
    store,
    candidates: uncertainCandidates,
    matches: ['uncertain', 'uncertain'],
    turnId: 'recall-verify-uncertain',
    events: uncertainEvents,
    calls: uncertainCalls,
  }).run('V0')

  assert.equal(uncertain.ok, true)
  assert.equal(uncertainCalls.length, 2)
  assert.equal(uncertainCalls.every((request) => request.verifyRecall === true), true)
  assert.equal(uncertainEvents.some(({ type }) => type === 'visual_image'), false)
  assert.equal((await store.listForRecentVisualRecall(100))
    .some((message) => message.turnId === 'recall-verify-uncertain' && message.kind === 'media_ref'), false)

  const failureEvents = []
  const failed = await new VisualWorkingSession({
    turnId: 'recall-verify-failed',
    userText: '以前那张黑莓在纸箱里的照片',
    candidatePool: rankedCandidates,
    conversationStore: store,
    brain: { async visualStep() { throw new Error('vision unavailable') } },
    emit(type, payload) { failureEvents.push({ type, payload }) },
  }).run('V0')
  assert.equal(failed.ok, false)
  assert.equal(failureEvents.some(({ type }) => type === 'visual_image'), false)
  assert.equal((await store.listForRecentVisualRecall(100))
    .some((message) => message.turnId === 'recall-verify-failed' && message.kind === 'media_ref'), false)

  const recallStep = (match, replyMessages) => ({
    observation: '',
    action: 'answer',
    nextVisualId: '',
    focus: '',
    replyMessages,
    match,
  })
  const validMatch = validateVisualStepResponse(recallStep('match', ['确认是这张。']), { verifyRecall: true })
  assert.equal(validMatch.ok, true)
  assert.equal(validMatch.match, 'match')
  for (const match of ['mismatch', 'uncertain']) {
    const validRejection = validateVisualStepResponse(recallStep(match, []), { verifyRecall: true })
    assert.equal(validRejection.ok, true, match + ' must allow an empty reply')
  }
  assert.equal(validateVisualStepResponse(recallStep('match', []), { verifyRecall: true }).ok, false)
  // A rejected candidate's draft reply is ignored by the host, so it cannot
  // accidentally appear in chat even if the local model fills the field.
  assert.equal(validateVisualStepResponse(recallStep('mismatch', ['可能是这张。']), { verifyRecall: true }).ok, true)
  assert.equal(validateVisualStepResponse(recallStep('uncertain', ['应该是这张。']), { verifyRecall: true }).ok, true)
  const missingMatch = recallStep('match', ['确认是这张。'])
  delete missingMatch.match
  assert.equal(validateVisualStepResponse(missingMatch, { verifyRecall: true }).ok, false)
  console.log('VISUAL_RECALL_VERIFY_BEFORE_SHOW=PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}
