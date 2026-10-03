import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { readConfirmedVisualNames } from '../src/memory/visual-naming-context.js'

const root = await mkdtemp(join(tmpdir(), 'pet-recall-tool-'))
const runtime = new PetRuntime({ sandboxRoot: root })
try {
  await runtime.initialize()
  const name = runtime.memory.remember('fact', '我们家的猫叫黑莓', 2,
    { provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' } })
  for (let i = 0; i < 24; i++) runtime.memory.remember('fact', `黑莓的名字是黑莓，在纸箱子里的照片，推断记录${i}`, 3,
    { provenance: { source: 'VISUAL_OBSERVATION', evidence: 'inferred' } })
  const confirmedNames = runtime.memory.recall('找黑莓在纸箱子里的照片', 2, { bumpHits: false,
    filter: (row) => row.provenance?.evidence === 'confirmed' && /(叫|名字)/u.test(row.content) })
  assert.equal(confirmedNames[0].id, name.id, 'filter before top K keeps confirmed names despite many inferred observations')
  assert.deepEqual(readConfirmedVisualNames(runtime.memory, '黑莓长什么样子').names, ['黑莓'])
  const image = 'data:image/png;base64,QUFB'
  const attachment = await runtime.conversationStore.saveAttachment({ image: { dataUrl: image }, thumbnail: { dataUrl: image },
    width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })
  await runtime.conversationStore.appendMessage({ role: 'user', text: '我们家的猫黑莓在纸箱里', attachment })
const originalTask = '昨天晚上黑莓在干什么呀'
const timestampFollowup = '你可以看看图片的拍摄时间'
const activityQuery = '黑莓 昨晚 活动'
const appearanceQuery = '黑莓 外观 毛色'
runtime.conversation.append(originalTask, '我不太确定。')
  const order = []
  let match = 'match'
  let inspectCount = 0
  let indexUnavailable = false
  let candidateCaption = '我们家的猫黑莓在纸箱里'
  let conflictOnly = false
  let modelFailure = false
let expectedQuery = ''
let expectedTaskUserText = ''
  const beforeRecallAnchors = runtime.memory.db.listSearchable('fact').filter((row) => row.content.startsWith('主人给花花看过')).length
  runtime.brain = {
    async reply({ allowVisualRecall, userText, toolResultContext }) {
      if (toolResultContext) { order.push('tool-result'); return {ok:true,text:'图库暂时没准备好，尚未确认。',visualRecall:null} }
      assert.equal(allowVisualRecall, true)
      order.push('plan')
      expectedQuery = userText === timestampFollowup ? activityQuery : appearanceQuery
      return { ok: true, text: '花花去图库里找找黑莓～', visualRecall: {
        tool: 'search_visual_memory', query: expectedQuery,
        goal: userText === timestampFollowup ? 'find_photo' : 'describe_subject',
        originalQuestion: userText === timestampFollowup ? originalTask : '' } }
    },
    async visualStep(request) {
      if (modelFailure) throw Object.assign(new Error('invalid response'), { code: 'PET_LOCAL_BRAIN_BAD_RESPONSE' })
      order.push('original')
      inspectCount++
      assert.equal(request.verifyRecall, true)
      assert.equal(request.recallGoal, expectedQuery === activityQuery ? 'find_photo' : 'describe_subject')
      assert.equal(request.userText, expectedTaskUserText, 'the grounded owner task reaches original-image verification separately from the retrieval query')
      assert.equal(request.recallQuery, expectedQuery, 'visual verification receives the model-selected semantic query unchanged')
      assert.equal(request.ownerCaption, candidateCaption)
      return { ok: true, observation: match === 'match' ? '黑白色的猫。' : '', action: 'answer', nextVisualId: '', focus: '', match,
        replyMessages: match === 'match' ? ['黑莓是黑白毛色，脸上有白色的花纹～'] : [] }
    },
  }
  runtime.turnOrchestrator.semanticIndex = { async search(query) {
    if (indexUnavailable) throw new Error('encoder offline')
    assert.equal(query, expectedQuery, 'execute the model-selected semantic query without replacing it')
    order.push('index')
    return { candidates: [{ attachmentId: 'wrong-cat', userText: '这只猫叫小橘' },
      ...(!conflictOnly ? [{ attachmentId: attachment.id, userText: candidateCaption }] : [])] }
  } }
  async function turn(text, taskUserText = text) {
    expectedTaskUserText = taskUserText
    const start = runtime.startChatTurn({ userText: text })
    let poll
    for (let i = 0; i < 1000; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      poll = runtime.pollChatTurn(start.turnId)
      if (poll.status !== 'running') break
    }
    assert.equal(poll.status, 'done', JSON.stringify({ order, error: poll.error }))
    return { ...poll, turnId: start.turnId }
  }
  const groundedTask = `主人此前尚待回答的问题：${originalTask}\n主人本轮补充：${timestampFollowup}`
  const result = await turn(timestampFollowup, groundedTask)
  assert.deepEqual(order, ['plan', 'index', 'original'])
  assert.equal(inspectCount, 1, 'subject description stops at first verified photo')
  const publicOrder = result.events.filter(({ type }) => ['assistant_message', 'visual_image'].includes(type))
  assert.deepEqual(publicOrder.map(({ type }) => type), ['assistant_message', 'visual_image', 'assistant_message'])
  assert.match(publicOrder[0].payload.text, /去图库/)
  assert.equal(result.events.filter(({ type }) => type === 'turn_completed').length, 1)
  assert.equal(result.events.filter(({ type }) => type === 'turn_started').length, 1)
  const messages = (await runtime.conversationStore.list(100)).filter((row) => row.turnId === result.turnId)
  assert.equal(messages.filter(({ role }) => role === 'user').length, 1)
  assert.equal(messages.filter(({ kind }) => kind === 'media_ref').length, 1)
  assert.equal(result.events.some(({ type }) => type === 'memory_recall'), false, 'photo recall does not display unrelated text-memory summaries')
  assert.equal(runtime.memory.db.listSearchable('fact').filter((row) => row.content.startsWith('主人给花花看过')).length, beforeRecallAnchors, 'recall questions cannot become confirmed photo-upload memories')
  conflictOnly = true
  const beforeConflict = inspectCount
  const conflict = await turn('你知不知道我们家的猫黑莓，长什么样子？')
  assert.equal(conflict.events.some(({ type }) => type === 'visual_image'), false)
  assert.equal(inspectCount, beforeConflict, 'a candidate without a readable original cannot reach verification')
  conflictOnly = false
  candidateCaption = '这只猫叫小橘'
  match = 'mismatch'
  const beforeMismatch = inspectCount
  const mismatch = await turn('你知不知道我们家的猫黑莓，长什么样子？')
  assert.equal(mismatch.events.some(({ type }) => type === 'visual_image'), false)
  assert.equal(inspectCount, beforeMismatch + 1, 'the original image reaches visualStep and the model rejects a conflicting owner caption')
  candidateCaption = '给花花看看这只猫'
  match = 'uncertain'
  const unknown = await turn('你知不知道我们家的猫黑莓，长什么样子？')
  assert.equal(unknown.events.some(({ type }) => type === 'visual_image'), false)
  assert.equal(inspectCount, beforeMismatch + 2, 'unlabelled candidates reach visualStep and remain uncertain')
  candidateCaption = '我们家的猫黑莓在纸箱里'
  match = 'match'
  indexUnavailable = true
  const offline = await turn('你知不知道我们家的猫黑莓，长什么样子？')
  assert.equal(offline.events.some(({ type }) => type === 'visual_image'), false)
  assert.ok(offline.events.some(({ type, payload }) => type === 'assistant_message' && /没准备好/u.test(payload.text)))
  indexUnavailable = false
  match = 'match'
  const recovered = await turn('你知不知道我们家的猫黑莓，长什么样子？')
  assert.equal(recovered.events.some(({ type }) => type === 'visual_image'), true)
  modelFailure = true
  const failedQuestion = '你知不知道我们家的猫黑莓，长什么样子？'
  expectedTaskUserText = failedQuestion
  const failedStart = runtime.startChatTurn({ userText: failedQuestion })
  let failed
  for (let i = 0; i < 1000; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    failed = runtime.pollChatTurn(failedStart.turnId)
    if (failed.status !== 'running') break
  }
  assert.equal(failed.status, 'error')
  assert.equal(failed.events.some(({ type }) => type === 'visual_image'), false)
  assert.ok(failed.events.some(({ type, payload }) => type === 'assistant_message' && /没能完成照片核对/u.test(payload.text)))
  assert.ok(failed.events.some(({ type, payload }) => type === 'turn_failed' && payload.code === 'PET_LOCAL_BRAIN_BAD_RESPONSE'))
  const failedMessages = (await runtime.conversationStore.list(100)).filter((row) => row.turnId === failedStart.turnId)
  assert.ok(failedMessages.some((row) => row.kind === 'final' && /没能完成照片核对/u.test(row.text)), 'failure survives app history reload')
  console.log('VISUAL_RECALL_TOOL_RUNTIME=PASS')
} finally {
  runtime.close()
  await rm(root, { recursive: true, force: true })
}
