import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { PetTurnOrchestrator } from '../src/runtime/pet-turn-orchestrator.js'
import { MAX_VISUAL_INSPECTIONS_PER_TURN, VisualWorkingSession } from '../src/vision/visual-working-session.js'



const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-multi-photo-'))
const store = new ConversationStore(root)
let imageIndex = 0

async function saveCandidate(caption) {
  const dataUrl = 'data:image/png;base64,' + Buffer.from('multi-photo-' + imageIndex).toString('base64')
  imageIndex += 1
  const attachment = await store.saveAttachment({
    image: { dataUrl },
    thumbnail: { dataUrl },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
  })
  await store.appendMessage({ role: 'user', text: caption, attachment })
  return { attachmentId: attachment.id, relation: 'recalled', userText: caption, dataUrl }
}

function visualCandidate(source, index) {
  return {
    visualId: 'V' + index,
    attachmentId: source.attachmentId,
    relation: 'recalled',
    userText: source.userText,
  }
}

function makeStep(status, request) {
  const verified = status === 'match'
  return {
    ok: true,
    observation: verified ? '已确认观察：' + request.ownerCaption : '不得总结的未确认观察：' + request.ownerCaption,
    action: 'answer',
    nextVisualId: '',
    focus: verified ? '主体与场景相符' : '',
    replyMessages: ['不能提前发送的单图答案：' + request.ownerCaption],
    match: status,
  }
}

function makeSessionBrain({ statusByAttachment, stepCalls, summaryCalls, summaryReply = '三张照片的共同点是猫咪在熟悉的环境里。' }) {
  return {
    async visualStep(request) {
      stepCalls.push({ ...request, observations: request.observations.map((item) => ({ ...item })) })
      const status = statusByAttachment.get(request.image.dataUrl) ?? 'mismatch'
      return makeStep(status, request)
    },
    async summarizeVisualRecall(request) {
      summaryCalls.push({ ...request, observations: request.observations.map((item) => ({ ...item })) })
      return {
        ok: true,
        replyMessages: [summaryReply],
        reasoning: { effort: 'off', durationMs: 7 },
      }
    },
  }
}

async function runSession({
  turnId,
  candidates,
  statusByAttachment,
  userText = '帮我总结以前的照片',
  recallGoal = 'summarize_photos',
  recallQuery,
  photoCount,
  summaryReply,
}) {
  const events = []
  const stepCalls = []
  const summaryCalls = []
  const brain = makeSessionBrain({ statusByAttachment, stepCalls, summaryCalls, summaryReply })
  const options = {
    turnId,
    userText,
    candidatePool: candidates,
    conversationStore: store,
    brain,
    recallGoal,
    emit(type, payload) {
      events.push({ type, payload })
      return { seq: events.length, at: events.length }
    },
  }
  if (recallQuery !== undefined) options.recallQuery = recallQuery
  if (photoCount !== undefined) options.photoCount = photoCount
  const result = await new VisualWorkingSession(options).run(candidates[0]?.visualId)
  return { result, events, stepCalls, summaryCalls }
}

async function mediaRefsFor(turnId) {
  return (await store.listForRecentVisualRecall(1000))
    .filter((message) => message.turnId === turnId && message.kind === 'media_ref')
}

await store.initialize()

try {
  // A first-match answer is still only a draft for summary mode. The session
  // checks later candidates, skips mismatch and uncertain observations, and
  // summarizes exactly the three confirmed originals.
  const originalUserText = '帮我总结黑莓过去看过的照片，并说说它们有什么共同点。'
  const sources = []
  for (const caption of [
    '黑莓在窗边',
    '黑莓在院子里',
    '黑莓在纸箱里',
    '黑莓趴在垫子上',
    '黑莓在椅子上',
  ]) sources.push(await saveCandidate(caption))
  const statuses = new Map([
    [sources[0].dataUrl, 'match'],
    [sources[1].dataUrl, 'mismatch'],
    [sources[2].dataUrl, 'uncertain'],
    [sources[3].dataUrl, 'match'],
    [sources[4].dataUrl, 'match'],
  ])
  const multi = await runSession({
    turnId: 'multi-photo-default-three',
    candidates: sources.map(visualCandidate),
    statusByAttachment: statuses,
    userText: originalUserText,
    recallQuery: '黑莓',
  })
  assert.equal(multi.result.ok, true)
  assert.equal(multi.stepCalls.length, 5, 'default photoCount is three, so search continues through wrong candidates')
  assert.deepEqual(multi.stepCalls.map((request) => request.image.dataUrl), sources.map((source) => source.dataUrl))
  assert.ok(multi.stepCalls.every((request) => request.userText === originalUserText))
  assert.ok(multi.stepCalls.every((request) => request.recallQuery === '黑莓'))
  assert.deepEqual(multi.stepCalls.map((request) => request.ownerCaption), sources.map((source) => source.userText))
  assert.deepEqual(multi.stepCalls.map((request) => request.observations.map((item) => item.attachmentId)), [
    [],
    [sources[0].attachmentId],
    [sources[0].attachmentId],
    [sources[0].attachmentId],
    [sources[0].attachmentId, sources[3].attachmentId],
  ], 'only earlier verified observations are carried forward')
  assert.equal(multi.summaryCalls.length, 1)
  const summary = multi.summaryCalls[0]
  assert.equal(summary.userText, originalUserText)
  assert.equal(summary.recallQuery, '黑莓')
  assert.deepEqual(summary.observations.map((item) => item.attachmentId), [
    sources[0].attachmentId,
    sources[3].attachmentId,
    sources[4].attachmentId,
  ])
  assert.ok(summary.observations.every((item) => item.summary.startsWith('已确认观察：')))
  assert.deepEqual(multi.events.filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [
      sources[0].attachmentId,
      sources[3].attachmentId,
      sources[4].attachmentId,
    ])
  assert.equal(multi.events.some(({ type, payload }) =>
    type === 'assistant_message' && payload.text.startsWith('不能提前发送的单图答案：')), false)
  assert.deepEqual((await mediaRefsFor('multi-photo-default-three'))
    .map((message) => message.sourceAttachmentId), [
      sources[0].attachmentId,
      sources[3].attachmentId,
      sources[4].attachmentId,
    ], 'mismatch and uncertain attachments do not enter conversation media history')

  // A requested count stops inspection as soon as that many different photos
  // have matched, even if more candidates remain.
  const requestedTwoSources = []
  for (const caption of ['黑莓照片 A', '黑莓照片 B', '黑莓照片 C', '黑莓照片 D']) {
    requestedTwoSources.push(await saveCandidate(caption))
  }
  const allRequestedTwoMatch = new Map(requestedTwoSources.map((source) => [source.dataUrl, 'match']))
  const requestedTwo = await runSession({
    turnId: 'multi-photo-request-two',
    candidates: requestedTwoSources.map(visualCandidate),
    statusByAttachment: allRequestedTwoMatch,
    userText: '请总结两张黑莓照片',
    recallQuery: '黑莓',
    photoCount: 2,
  })
  assert.equal(requestedTwo.stepCalls.length, 2)
  assert.equal(requestedTwo.summaryCalls.length, 1)
  assert.equal(requestedTwo.summaryCalls[0].requestedImages, 2)
  assert.deepEqual(requestedTwo.events.filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [
      requestedTwoSources[0].attachmentId,
      requestedTwoSources[1].attachmentId,
    ])

  // A duplicated occurrence of the same attachment cannot satisfy two slots.
  const duplicateSources = []
  for (const caption of ['黑莓重复原图 A', '黑莓原图 B', '黑莓原图 C']) {
    duplicateSources.push(await saveCandidate(caption))
  }
  const duplicatePool = [
    visualCandidate(duplicateSources[0], 0),
    visualCandidate(duplicateSources[0], 1),
    visualCandidate(duplicateSources[1], 2),
    visualCandidate(duplicateSources[2], 3),
  ]
  const duplicateStatuses = new Map(duplicateSources.map((source) => [source.dataUrl, 'match']))
  const duplicate = await runSession({
    turnId: 'multi-photo-duplicate-attachment',
    candidates: duplicatePool,
    statusByAttachment: duplicateStatuses,
    recallQuery: '黑莓',
    photoCount: 3,
  })
  assert.equal(duplicate.stepCalls.length, 3)
  assert.deepEqual(duplicate.stepCalls.map((request) => request.image.dataUrl), duplicateSources.map((source) => source.dataUrl))
  assert.equal(new Set(duplicate.summaryCalls[0].observations.map((item) => item.attachmentId)).size, 3)
  assert.deepEqual(duplicate.events.filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), duplicateSources.map((source) => source.attachmentId))

  // Candidate traversal respects the existing five-inspection ceiling.
  const cappedSources = []
  for (const caption of ['黑莓候选 1', '黑莓候选 2', '黑莓候选 3', '黑莓候选 4', '黑莓候选 5', '黑莓候选 6']) {
    cappedSources.push(await saveCandidate(caption))
  }
  const cappedStatuses = new Map(cappedSources.map((source, index) => [
    source.dataUrl,
    index === 0 || index === 2 ? 'match' : (index === 3 ? 'uncertain' : 'mismatch'),
  ]))
  const capped = await runSession({
    turnId: 'multi-photo-five-inspection-cap',
    candidates: cappedSources.map(visualCandidate),
    statusByAttachment: cappedStatuses,
    recallQuery: '黑莓',
    photoCount: 3,
  })
  assert.equal(capped.stepCalls.length, MAX_VISUAL_INSPECTIONS_PER_TURN)
  assert.equal(capped.summaryCalls.length, 1, 'partial summary runs after the five-inspection ceiling')
  assert.equal(capped.summaryCalls[0].requestedImages, 3)
  assert.equal(capped.summaryCalls[0].inspectionLimitReached, true)
  assert.deepEqual(capped.summaryCalls[0].observations.map((item) => item.attachmentId), [
    cappedSources[0].attachmentId,
    cappedSources[2].attachmentId,
  ])
  assert.equal(capped.events.filter(({ type }) => type === 'visual_image').length, 2)

  // The ordinary find-photo goal remains a one-match fast path, and omitted
  // recallQuery falls back to the original owner text.
  const singleSource = await saveCandidate('黑莓以前在纸箱里的照片')
  const singleEvents = []
  const singleSteps = []
  let singleSummaryCalls = 0
  const singleBrain = {
    async visualStep(request) {
      singleSteps.push(request)
      return makeStep('match', request)
    },
    async summarizeVisualRecall() { singleSummaryCalls += 1; return { ok: true, replyMessages: ['unexpected'] } },
  }
  const single = await new VisualWorkingSession({
    turnId: 'single-photo-fast-path',
    userText: '你记得黑莓以前在纸箱里的照片吗？',
    candidatePool: [visualCandidate(singleSource, 0)],
    conversationStore: store,
    brain: singleBrain,
    emit(type, payload) { singleEvents.push({ type, payload }); return { seq: singleEvents.length, at: singleEvents.length } },
    recallGoal: 'find_photo',
  }).run('V0')
  assert.equal(single.ok, true)
  assert.equal(singleSteps.length, 1)
  assert.equal(singleSteps[0].userText, '你记得黑莓以前在纸箱里的照片吗？')
  assert.equal(singleSteps[0].recallQuery, '你记得黑莓以前在纸箱里的照片吗？')
  assert.equal(singleSummaryCalls, 0)
  assert.deepEqual(singleEvents.filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [singleSource.attachmentId])

  // Exercise toolRecall routing against real archive and attachment storage.
  // The first semantic result names another confirmed cat and must be removed;
  // the final three results are matches and remain available after candidate 3.
  const routedSources = []
  const routedCaptions = [
    '这只猫叫小橘，在窗台上',
    '黑莓在院子里',
    '黑莓在纸箱里',
    '黑莓趴在软垫上',
    '黑莓坐在椅子上',
  ]
  for (const caption of routedCaptions) routedSources.push(await saveCandidate(caption))
  const behaviorByAttachment = new Map()
  let semanticCandidates = []
  const semanticRequests = []
  const routedStepCalls = []
  const routedSummaryCalls = []
  const routedBrain = {
    visualSearch() { assert.fail('semantic-index routing does not need another VLM candidate gate') },
    async visualStep(request) {
      routedStepCalls.push({ ...request, observations: request.observations.map((item) => ({ ...item })) })
      const status = behaviorByAttachment.get(request.image.dataUrl) ?? 'mismatch'
      return makeStep(status, request)
    },
    async summarizeVisualRecall(request) {
      routedSummaryCalls.push({ ...request, observations: request.observations.map((item) => ({ ...item })) })
      return {
        ok: true,
        replyMessages: ['确认照片的共同点是它们都记录了黑莓在家里的日常。'],
        reasoning: { effort: 'off', durationMs: 3 },
      }
    },
  }
  const runtime = {
    conversationStore: store,
    conversation: { append() {} },
    memory: {
      recall(query, count, options = {}) {
        const facts = [{
          level: 'fact',
          content: '我们家的猫叫黑莓',
          provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' },
        }]
        return facts.filter((item) => !options.filter || options.filter(item)).slice(0, count)
      },
    },
    brain: routedBrain,
  }
  const orchestrator = new PetTurnOrchestrator({
    runtime,
    semanticIndex: {
      async search(query, options) {
        semanticRequests.push({ query, options })
        return { candidates: semanticCandidates }
      },
    },
  })

  async function runToolRecall({ turnId, userText, query, photoCount, candidates, statuses }) {
    semanticCandidates = candidates
    behaviorByAttachment.clear()
    for (const [attachmentId, status] of statuses) {
      const source = routedSources.find((item) => item.attachmentId === attachmentId)
      if (source) behaviorByAttachment.set(source.dataUrl, status)
    }
    semanticRequests.length = 0
    routedStepCalls.length = 0
    routedSummaryCalls.length = 0
    const events = []
    await store.appendMessage({ role: 'user', text: userText, turnId })
    const result = await orchestrator.runVisual({
      turnId,
      userText,
      attachment: null,
      emit(type, payload) {
        events.push({ type, payload })
        return { seq: events.length, at: events.length }
      },
      toolRecall: {
        goal: 'summarize_photos',
        photoCount,
        query,
        ownerMessageStored: true,
        preamble: '花花去图库里找找，再总结确认的照片～',
      },
    })
    return { result, events }
  }

  const routedCaptionsAndIds = routedSources.map((source) => ({
    caption: source.userText,
    attachmentId: source.attachmentId,
  }))
  const routedStatuses = [
    [routedSources[0].attachmentId, 'match'], // Must be excluded by the confirmed name filter.
    [routedSources[1].attachmentId, 'mismatch'],
    [routedSources[2].attachmentId, 'match'],
    [routedSources[3].attachmentId, 'match'],
    [routedSources[4].attachmentId, 'match'],
  ]
  const routedUserText = '帮我总结黑莓过去的照片，并说说它们有什么共同点。'
  const routed = await runToolRecall({
    turnId: 'multi-photo-tool-recall',
    userText: routedUserText,
    query: '黑莓',
    photoCount: 3,
    candidates: routedCaptionsAndIds.map((candidate) => ({
      attachmentId: candidate.attachmentId,
      userText: candidate.caption,
    })),
    statuses: routedStatuses,
  })
  assert.equal(routed.result.ok, true)
  assert.equal(semanticRequests.length, 1)
  assert.equal(semanticRequests[0].query, '黑莓')
  assert.equal(semanticRequests[0].options.limit, MAX_VISUAL_INSPECTIONS_PER_TURN)
  assert.equal(semanticRequests[0].options.recallGoal, 'summarize_photos')
  assert.deepEqual(routedStepCalls.map((request) => request.ownerCaption), routedCaptions.slice(1))
  assert.ok(routedStepCalls.every((request) => request.userText === routedUserText))
  assert.ok(routedStepCalls.every((request) => request.recallQuery === '黑莓'))
  assert.equal(routedStepCalls.length, 4, 'candidates three through five still supply three matches after a mismatch')
  assert.equal(routedSummaryCalls.length, 1)
  assert.equal(routedSummaryCalls[0].userText, routedUserText)
  assert.equal(routedSummaryCalls[0].recallQuery, '黑莓')
  assert.equal(routedSummaryCalls[0].requestedImages, 3)
  assert.deepEqual(routedSummaryCalls[0].observations.map((item) => item.attachmentId), [
    routedSources[2].attachmentId,
    routedSources[3].attachmentId,
    routedSources[4].attachmentId,
  ])
  assert.deepEqual(routed.events.filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [
      routedSources[2].attachmentId,
      routedSources[3].attachmentId,
      routedSources[4].attachmentId,
    ])
  assert.deepEqual((await mediaRefsFor('multi-photo-tool-recall')).map((message) => message.sourceAttachmentId), [
    routedSources[2].attachmentId,
    routedSources[3].attachmentId,
    routedSources[4].attachmentId,
  ])

  // An exhausted one-photo search must state the verified count even if the
  // summarizer's draft omits it.
  const onlyOne = await runToolRecall({
    turnId: 'multi-photo-only-one',
    userText: '帮我总结黑莓过去的照片。',
    query: '黑莓',
    photoCount: 3,
    candidates: [{ attachmentId: routedSources[2].attachmentId, userText: routedSources[2].userText }],
    statuses: [[routedSources[2].attachmentId, 'match']],
  })
  assert.equal(routedSummaryCalls.length, 1)
  assert.equal(routedSummaryCalls[0].observations.length, 1)
  assert.equal(routedSummaryCalls[0].requestedImages, 3)
  const partialText = onlyOne.result.replyMessages.join('\n')
  assert.ok(/(?:只|仅|目前).*?[1一]张|[1一]张.*?(?:只|仅|确认)/u.test(partialText),
    'the host must explicitly say that only one photo was confirmed')
  assert.deepEqual(onlyOne.events.filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [routedSources[2].attachmentId])

  // With no verified match, the brain is not asked to summarize and no image
  // can enter public events or stored conversation media.
  const none = await runToolRecall({
    turnId: 'multi-photo-zero-match',
    userText: '帮我总结黑莓过去的照片。',
    query: '黑莓',
    photoCount: 3,
    candidates: [{ attachmentId: routedSources[1].attachmentId, userText: routedSources[1].userText }],
    statuses: [[routedSources[1].attachmentId, 'uncertain']],
  })
  assert.equal(routedSummaryCalls.length, 0)
  assert.equal(none.events.some(({ type }) => type === 'visual_image'), false)
  assert.equal((await mediaRefsFor('multi-photo-zero-match')).length, 0)
  assert.match(none.result.text, /不能确认|没法确认|无法确认|没找到|不确定/u)

  console.log('V0.5_MULTI_PHOTO_RECALL=PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}