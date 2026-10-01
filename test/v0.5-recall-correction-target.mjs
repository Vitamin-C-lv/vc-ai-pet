import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { detectVisualRecallCorrection, isVisualIdentityStatement } from '../src/conversation/recent-visual-context.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { VisualSemanticIndex } from '../src/vision/visual-semantic-index.js'
import { VisualWorkingSession } from '../src/vision/visual-working-session.js'

const LIVING_ROOM = 'data:image/png;base64,QUFB'
const CAT = 'data:image/png;base64,QkJC'
const ROBOT = 'data:image/png;base64,Q0ND'
const BODY_QUESTION = '记得之前给你装的身体吗'
const GENERIC_ROBOT = '就是那个方脑袋的机器人'
const CORRECTION = '哎呀你图片找错了，不是客厅那张图，是方脑袋机器人'

function answerStep(match, replyMessages = []) {
  return {
    ok: true,
    observation: match === 'match' ? '主体与描述一致。' : '',
    action: 'answer',
    nextVisualId: '',
    focus: match === 'match' ? '主体' : '',
    replyMessages,
    match,
  }
}

async function saveImage(store, dataUrl, text, timestamp) {
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
  await store.appendMessage({ role: 'user', text, attachment, timestamp })
  return attachment
}

async function runTurn(runtime, userText, image = null) {
  const started = runtime.startChatTurn({ userText, image: image ? { dataUrl: image } : null })
  let poll = null
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  assert.equal(poll?.status, 'done', `turn did not finish: ${userText}; ${JSON.stringify(poll)}`)
  return poll
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-recall-correction-target-'))
const runtime = new PetRuntime({ sandboxRoot: root })

try {
  await runtime.initialize()
  runtime.visualSemanticIndex?.stop?.()

  const store = runtime.conversationStore
  const cat = await saveImage(store, CAT, '以前给你看的小猫', 100)
  const robot = await saveImage(store, ROBOT, '以前给你看的方脑袋机器人', 200)
  const replyCalls = []
  const visualCalls = []
  const visualSearchCalls = []
  const searchCalls = []
  runtime.brain = {
    async reply({ userText }) {
      replyCalls.push(userText)
      return {
        ok: true,
        text: '记得呀。',
        replyMessages: ['记得呀。'],
        visualRecall: null,
      }
    },
    async visualSearch(request) {
      visualSearchCalls.push(request)
      throw new Error('the semantic index already screens image candidates')
    },
    async visualStep(request) {
      visualCalls.push(request)
      if (!request.verifyRecall) {
        return {
          ok: true,
          observation: '客厅里有沙发。',
          action: 'answer',
          nextVisualId: '',
          focus: '客厅',
          replyMessages: ['客厅里有沙发。'],
        }
      }
      if (request.image.dataUrl === CAT) return answerStep('mismatch')
      if (request.image.dataUrl === ROBOT) return answerStep('match', ['花花找到你说的方脑袋机器人了。'])
      assert.fail(`unexpected correction candidate image: ${request.image.dataUrl}`)
    },
  }

  const livingRoomTurn = await runTurn(runtime, '这是刚拍的客厅', LIVING_ROOM)
  const livingRoomImage = livingRoomTurn.events.find(({ type }) => type === 'visual_image')
  assert.ok(livingRoomImage, 'the latest living room upload is displayed')
  const livingRoom = livingRoomImage.payload.sourceAttachmentId

  runtime.turnOrchestrator.semanticIndex = {
    async search(query, options) {
      searchCalls.push({ query, options })
      return {
        status: 'matched',
        candidates: searchCalls.length === 1
          ? [
              { attachmentId: livingRoom, userText: '客厅的照片', occurredAt: 300 },
              { attachmentId: cat.id, userText: '以前给你看的小猫', occurredAt: 100 },
              { attachmentId: robot.id, userText: '以前给你看的方脑袋机器人', occurredAt: 200 },
            ]
          : [
              { attachmentId: robot.id, userText: '以前给你看的方脑袋机器人', occurredAt: 200 },
              { attachmentId: cat.id, userText: '以前给你看的小猫', occurredAt: 100 },
            ],
      }
    },
  }

  assert.deepEqual(detectVisualRecallCorrection(CORRECTION), { query: '方脑袋机器人' })
  assert.deepEqual(detectVisualRecallCorrection('不是这张'), { query: null })
  assert.equal(isVisualIdentityStatement(GENERIC_ROBOT), false, 'a bare robot description does not name the displayed photo')

  const bodyTurn = await runTurn(runtime, BODY_QUESTION)
  const genericRobotTurn = await runTurn(runtime, GENERIC_ROBOT)
  assert.deepEqual(replyCalls, [BODY_QUESTION, GENERIC_ROBOT], 'both messages stay on the ordinary chat path')
  assert.equal(searchCalls.length, 0, 'ordinary context and the generic robot description do not search photos')
  assert.equal(visualCalls.length, 1, 'only the initial living room upload has been inspected')
  for (const turn of [bodyTurn, genericRobotTurn]) {
    assert.equal(turn.events.some(({ type }) => type === 'visual_image' || type === 'visual_recall'), false)
  }

  const correctionTurn = await runTurn(runtime, CORRECTION)
  assert.equal(searchCalls.length, 1)
  assert.equal(searchCalls[0].query, '方脑袋机器人', 'correction target drives semantic search')
  assert.equal(searchCalls[0].options.recallGoal, 'find_photo')
  assert.equal(searchCalls[0].options.limit, 5)
  assert.deepEqual(searchCalls[0].options.excludedAttachmentIds, [livingRoom])
  assert.equal(visualSearchCalls.length, 0)
  const correctionSteps = visualCalls.filter(({ userText }) => userText === CORRECTION)
  assert.deepEqual(correctionSteps.map(({ image, verifyRecall }) => ({ image: image.dataUrl, verifyRecall })), [
    { image: CAT, verifyRecall: true },
    { image: ROBOT, verifyRecall: true },
  ], 'the displayed living room is excluded, the cat is rejected, and the robot is verified')
  assert.deepEqual(correctionTurn.events
    .filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [robot.id])
  const correctionMediaRefs = (await store.listForRecentVisualRecall(1000))
    .filter((message) => message.turnId === correctionTurn.turnId && message.kind === 'media_ref')
    .map((message) => message.sourceAttachmentId)
  assert.deepEqual(correctionMediaRefs, [robot.id], 'only the verified robot photo is published')
  assert.equal(runtime.turnOrchestrator.recallContextActive(), true, 'a successful correction keeps its recall frame for follow-up')
  assert.equal(runtime.turnOrchestrator.recallContext.snapshot()?.query, '方脑袋机器人')
  console.log('RECALL_CORRECTION_TARGET_ROUTING=PASS')

  const retryTurn = await runTurn(runtime, '不是这张')
  assert.equal(searchCalls.length, 2)
  assert.equal(searchCalls[1].query, '方脑袋机器人', 'a targetless correction reuses the retained subject query')
  assert.ok(searchCalls[1].options.excludedAttachmentIds.includes(robot.id), 'the latest displayed robot is excluded from retry')
  assert.ok(searchCalls[1].options.excludedAttachmentIds.includes(livingRoom), 'the earlier excluded living room remains out of the retry')
  const retrySteps = visualCalls.filter(({ userText }) => userText === '不是这张')
  assert.deepEqual(retrySteps.map(({ image, verifyRecall }) => ({ image: image.dataUrl, verifyRecall })), [
    { image: CAT, verifyRecall: true },
  ], 'after excluding the displayed robot, the remaining cat candidate is rejected')
  assert.equal(retryTurn.events.some(({ type }) => type === 'visual_image'), false, 'a failed retry publishes no image')
  assert.equal((await store.listForRecentVisualRecall(1000))
    .some((message) => message.turnId === retryTurn.turnId && message.kind === 'media_ref'), false)
  assert.equal(runtime.turnOrchestrator.recallContextActive(), true, 'the unsuccessful retry preserves the recall frame')
  assert.equal(runtime.turnOrchestrator.recallContext.snapshot()?.query, '方脑袋机器人')
  console.log('TARGETLESS_RECALL_CORRECTION_RETRY=PASS')

  const preTopKIndex = new VisualSemanticIndex({
    experienceStore: {
      async semanticEmbeddings() {
        return [
          { experienceId: 'latest-room', attachmentId: livingRoom, userText: '客厅照片', imageVector: [1, 0], textVector: [1, 0] },
          { experienceId: 'robot-photo', attachmentId: robot.id, userText: '方脑袋机器人', imageVector: [0.99, 0.01], textVector: [0.99, 0.01] },
        ]
      },
    },
    client: {
      async embed() { return { model: 'fake-recall-correction', vectors: [[1, 0]] } },
    },
  })
  const preTopK = await preTopKIndex.search('方脑袋机器人', {
    limit: 1,
    excludedAttachmentIds: [livingRoom],
  })
  assert.deepEqual(preTopK.candidates.map(({ attachmentId }) => attachmentId), [robot.id], 'the index applies display exclusions before top K')
  console.log('DISPLAY_EXCLUSION_BEFORE_TOP_K=PASS')

  // Directly guard a previous-only working session: reject the cat, then wait
  // for the robot verification decision before publishing any image.
  const previousCalls = []
  const previousEvents = []
  let resolveRobotDecision
  let robotDecisionStarted = false
  const robotDecision = new Promise((resolve) => { resolveRobotDecision = resolve })
  const previousSession = new VisualWorkingSession({
    turnId: 'previous-only-recall-verification',
    userText: CORRECTION,
    candidatePool: [
      { visualId: 'V0', attachmentId: cat.id, relation: 'previous', userText: '以前给你看的小猫' },
      { visualId: 'V1', attachmentId: robot.id, relation: 'previous', userText: '以前给你看的方脑袋机器人' },
    ],
    conversationStore: store,
    brain: {
      async visualStep(request) {
        previousCalls.push(request)
        if (request.image.dataUrl === CAT) return answerStep('mismatch')
        if (request.image.dataUrl === ROBOT) {
          robotDecisionStarted = true
          return robotDecision
        }
        assert.fail(`unexpected previous-only image: ${request.image.dataUrl}`)
      },
    },
    emit(type, payload) {
      previousEvents.push({ type, payload })
      return { seq: previousEvents.length, at: previousEvents.length }
    },
  })
  const previousRun = previousSession.run('V0')
  for (let attempt = 0; attempt < 200 && !robotDecisionStarted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.equal(robotDecisionStarted, true, 'the session reaches the robot candidate after rejecting the cat')
  assert.deepEqual(previousCalls.map(({ image, verifyRecall }) => ({ image: image.dataUrl, verifyRecall })), [
    { image: CAT, verifyRecall: true },
    { image: ROBOT, verifyRecall: true },
  ])
  assert.equal(previousEvents.some(({ type }) => type === 'visual_image'), false, 'no previous image is shown while verification is pending')
  assert.equal((await store.listForRecentVisualRecall(1000))
    .some((message) => message.turnId === 'previous-only-recall-verification' && message.kind === 'media_ref'), false)

  resolveRobotDecision(answerStep('match', ['花花确认是方脑袋机器人了。']))
  const previousResult = await previousRun
  assert.equal(previousResult.verifiedAttachmentId, robot.id)
  assert.deepEqual(previousEvents
    .filter(({ type }) => type === 'visual_image')
    .map(({ payload }) => payload.sourceAttachmentId), [robot.id])
  console.log('PREVIOUS_ONLY_DEFERRED_RECALL_VERIFICATION=PASS')
} finally {
  runtime.close()
  await rm(root, { recursive: true, force: true })
}

console.log('V0_5_RECALL_CORRECTION_TARGET=PASS')
