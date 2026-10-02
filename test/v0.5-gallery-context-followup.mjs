import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { needsVisualRecallTaskPlan } from '../src/conversation/recent-visual-context.js'

const FIRST_OWNER_TEXT = '花花你知道黑莓的品种吗'
const GALLERY_FOLLOW_UP = '你去图库里面看看呗'
const BREAKFAST_FOLLOW_UP = '去图库找早餐'
const GALLERY_FUNCTION_QUESTION = '图库里的图片是怎么保存的'
const PLANNER_QUERY = '伯恩山犬黑莓品种外观特征'
const CANDIDATE_CAPTIONS = ['黑莓在窗边', '黑莓在纸箱里']

function chatReply(text, visualRecall = null) {
  return {
    ok: true,
    text,
    replyMessages: [text],
    visualRecall,
    memoryCandidate: null,
    rawMemoryCandidate: null,
    beliefCandidates: [],
  }
}

function recallPlan(query) {
  return { tool: 'search_visual_memory', goal: 'describe_subject', query }
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-gallery-context-'))
const runtime = new PetRuntime({ sandboxRoot: root })
const replyRequests = []
const searchRequests = []
const visualSteps = []
const recentShortcutCalls = []
let longTermShortcutCalls = 0
let visualSearchCalls = 0

async function runTurn(userText) {
  const started = runtime.startChatTurn({ userText })
  let poll = null
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  assert.notEqual(poll?.status, 'running', 'chat turn must finish: ' + userText)
  assert.equal(poll?.status, 'done', JSON.stringify(poll?.error ?? poll))
  return poll
}

try {
  await runtime.initialize()
  assert.equal(needsVisualRecallTaskPlan(GALLERY_FOLLOW_UP), true)
  assert.equal(needsVisualRecallTaskPlan(GALLERY_FUNCTION_QUESTION), true)

  runtime.memory.remember('fact', '我们家的猫叫黑莓', 2, {
    provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' },
  })

  const targets = []
  for (let index = 0; index < CANDIDATE_CAPTIONS.length; index += 1) {
    const dataUrl = 'data:image/png;base64,' + Buffer.from('gallery-target-' + index).toString('base64')
    const attachment = await runtime.conversationStore.saveAttachment({
      image: { dataUrl }, thumbnail: { dataUrl },
      width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64,
      requireThumbnail: true,
    })
    targets.push({ attachmentId: attachment.id, userText: CANDIDATE_CAPTIONS[index], occurredAt: index + 1 })
  }

  const galleryTexts = new Set([GALLERY_FOLLOW_UP, BREAKFAST_FOLLOW_UP, GALLERY_FUNCTION_QUESTION])
  runtime.recentVisualResolver.resolveFromStore = async (_store, userText) => {
    if (!galleryTexts.has(userText)) return null
    recentShortcutCalls.push(userText)
    return { matched: false, reason: 'ambiguous-visual-reference', candidates: [] }
  }
  const ambiguousLongTermResolver = {
    async resolve() {
      longTermShortcutCalls += 1
      return { status: 'ambiguous', candidates: [], winner: null }
    },
  }
  runtime.longTermVisualResolver = ambiguousLongTermResolver
  runtime.turnOrchestrator.longTermResolver = ambiguousLongTermResolver

  runtime.brain = {
    async reply(request) {
      replyRequests.push(request)
      if (galleryTexts.has(request.userText)) assert.equal(request.allowVisualRecall, true)
      if (request.userText === FIRST_OWNER_TEXT) return chatReply('花花听到了。')
      if (request.userText === GALLERY_FOLLOW_UP) return chatReply('花花去图库里看看。', recallPlan(PLANNER_QUERY))
      if (request.userText === BREAKFAST_FOLLOW_UP) return chatReply('花花去找早餐的照片。', recallPlan('早餐'))
      if (request.userText === GALLERY_FUNCTION_QUESTION) return chatReply('图片会保存在花花的图库里。')
      assert.fail('unexpected model reply request: ' + request.userText)
    },
    async visualSearch() {
      visualSearchCalls += 1
      throw new Error('semantic retrieval should inspect indexed originals directly')
    },
    async visualStep(request) {
      visualSteps.push(request)
      assert.equal(request.verifyRecall, true)
      assert.equal(request.recallGoal, 'describe_subject')
      return {
        ok: true,
        observation: '黑莓在熟悉的居家环境中。',
        action: 'answer', nextVisualId: '', focus: '黑莓和所在环境',
        replyMessages: ['花花确认了这张照片。'],
        match: request.ownerCaption === CANDIDATE_CAPTIONS[0] ? 'mismatch' : 'match',
      }
    },
  }

  runtime.visualSemanticIndex.search = async (query, options) => {
    searchRequests.push({ query, options })
    if (query.includes('早餐')) return { status: 'matched', candidates: [], winner: null }
    return { status: 'matched', candidates: targets, winner: targets[0] }
  }

  const first = await runTurn(FIRST_OWNER_TEXT)
  assert.equal(first.status, 'done')
  assert.equal(replyRequests.filter((request) => request.userText === FIRST_OWNER_TEXT).length, 1)
  assert.equal(searchRequests.length, 0)

  const followUp = await runTurn(GALLERY_FOLLOW_UP)
  assert.equal(followUp.status, 'done')
  const plannerRequest = replyRequests.find((request) => request.userText === GALLERY_FOLLOW_UP)
  assert.ok(plannerRequest, 'the elliptical gallery turn must reach the reply planner')
  assert.ok(plannerRequest.recentMessages.some((message) =>
    message.role === 'user' && message.content === FIRST_OWNER_TEXT),
  'the planner sees the exact earlier owner wording')

  assert.equal(searchRequests.length, 1)
  const plannedSearch = searchRequests[0]
  assert.equal(plannedSearch.options.recallGoal, 'describe_subject')
  assert.ok(plannedSearch.query.includes(FIRST_OWNER_TEXT), 'retrieval keeps the earlier owner statement verbatim')
  assert.ok(plannedSearch.query.includes(GALLERY_FOLLOW_UP))
  assert.ok(!plannedSearch.query.includes('伯恩山犬'), 'planner-invented appearance constraints are not executed')

  assert.equal(visualSteps.length, targets.length, 'each retrieved target is checked until one matches')
  assert.deepEqual(visualSteps.map((request) => request.currentVisualId), ['V0', 'V1'])
  assert.deepEqual(visualSteps.map((request) => request.ownerCaption), CANDIDATE_CAPTIONS)
  assert.ok(visualSteps.every((request) => request.userText === GALLERY_FOLLOW_UP))
  assert.ok(visualSteps.every((request) => request.recallQuery === plannedSearch.query))
  assert.ok(visualSteps.every((request) => !request.recallQuery.includes('伯恩山犬')))
  assert.ok(visualSteps.every((request) =>
    request.candidatePool.map((candidate) => candidate.attachmentId).join(',')
      === targets.map((target) => target.attachmentId).join(',')),
  'each verification call retains the full target pool')
  console.log('GALLERY_FOLLOWUP_CONTEXT_AND_TARGETS=PASS')

  const breakfast = await runTurn(BREAKFAST_FOLLOW_UP)
  assert.equal(breakfast.status, 'done')
  assert.equal(searchRequests.length, 2)
  assert.ok(searchRequests[1].query.includes('早餐'))
  assert.ok(!searchRequests[1].query.includes('黑莓'))
  assert.ok(!searchRequests[1].query.includes(FIRST_OWNER_TEXT))
  console.log('GALLERY_SUBJECT_CHANGE_STAYS_SEPARATE=PASS')

  const searchesBeforeFunctionQuestion = searchRequests.length
  const functionQuestion = await runTurn(GALLERY_FUNCTION_QUESTION)
  assert.equal(functionQuestion.status, 'done')
  assert.equal(replyRequests.filter((request) => request.userText === GALLERY_FUNCTION_QUESTION).length, 1)
  assert.equal(searchRequests.length, searchesBeforeFunctionQuestion)
  assert.equal(recentShortcutCalls.length, 0, 'gallery turns bypass the fixed ambiguous Recent shortcut')
  assert.equal(longTermShortcutCalls, 0, 'gallery turns bypass the fixed ambiguous Long-Term shortcut')
  assert.equal(visualSearchCalls, 0)
  console.log('GALLERY_FUNCTION_QUESTION_DOES_NOT_SEARCH=PASS')
} finally {
  runtime.close()
  await rm(root, { recursive: true, force: true })
}

console.log('V0.5_GALLERY_CONTEXT_FOLLOWUP=PASS')