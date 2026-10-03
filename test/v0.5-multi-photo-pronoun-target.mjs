import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'
import { MAX_VISUAL_INSPECTIONS_PER_TURN } from '../src/vision/visual-working-session.js'

const OWNER_TEXTS = [
  '那你可以告诉我猫猫体重多少算正常吗',
  '你不知道黑莓的品种吗，我说的猫猫就是黑莓',
  '那你去图库里面看看总结一下他呗',
]
const expectedQuery = '黑莓的照片 外观 品种'
const expectedTask = `主人此前尚待回答的问题：${OWNER_TEXTS[1]}\n主人本轮补充：${OWNER_TEXTS[2]}`

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-multi-photo-routing-'))
const runtime = new PetRuntime({ sandboxRoot: root })
const indexRequests = []
const visualSteps = []
const summaries = []
const candidates = []

async function addCandidate(label) {
  const dataUrl = 'data:image/png;base64,' + Buffer.from('task-routing-' + candidates.length).toString('base64')
  const attachment = await runtime.conversationStore.saveAttachment({
    image: { dataUrl },
    thumbnail: { dataUrl },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
  })
  candidates.push({
    attachmentId: attachment.id,
    userText: label,
    dataUrl,
  })
}

async function runTurn(userText) {
  const started = runtime.startChatTurn({ userText })
  let poll = null
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  assert.notEqual(poll?.status, 'running', 'owner chat turn should finish')
  assert.equal(poll?.status, 'done', JSON.stringify(poll?.error ?? null))
  return poll
}

try {
  await runtime.initialize()

  // Confirmed owner identity remains evidence for model verification.
  runtime.memory.remember('fact', '我们家的猫叫黑莓', 2, {
    provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' },
  })

  for (const label of [
    '海绵宝宝主题壁纸',
    '这只猫叫小橘，在窗台上',
    '黑莓在窗边',
    '黑莓在纸箱里',
    '黑莓趴在沙发上',
  ]) await addCandidate(label)

  let replyCount = 0
  runtime.brain = {
    async reply(request) {
      replyCount += 1
      if (replyCount < 3) {
        return {
          ok: true,
          text: '花花听到了。',
          replyMessages: ['花花听到了。'],
          memoryCandidate: null,
          rawMemoryCandidate: null,
          beliefCandidates: [],
        }
      }
      assert.equal(request.userText, OWNER_TEXTS[2])
      assert.equal(request.allowVisualRecall, true)
      assert.deepEqual(
        request.recentMessages.filter((message) => message.role === 'user').map((message) => message.content),
        OWNER_TEXTS.slice(0, 2),
        'the real recent conversation supplies the owner antecedent',
      )
      return {
        ok: true,
        text: '花花去图库里看看再总结～',
        replyMessages: ['花花去图库里看看再总结～'],
        visualRecall: {
          tool: 'search_visual_memory',
          goal: 'summarize_photos',
          photoCount: 3,
          query: expectedQuery,
          originalQuestion: OWNER_TEXTS[1],
        },
        memoryCandidate: null,
        rawMemoryCandidate: null,
        beliefCandidates: [],
      }
    },
    async visualSearch() {
      assert.fail('semantic retrieval already supplies candidate captions')
    },
    async visualStep(request) {
      const accepted = request.ownerCaption.startsWith('黑莓')
      visualSteps.push({
        userText: request.userText,
        recallQuery: request.recallQuery,
        ownerCaption: request.ownerCaption,
        attachmentId: request.inspections.at(-1)?.attachmentId,
      })
      return {
        ok: true,
        observation: '已确认黑莓在熟悉的居家环境中。',
        action: 'answer',
        nextVisualId: '',
        focus: '黑莓和所在环境',
        replyMessages: accepted ? ['单图回复不能提前成为总结。'] : [],
        match: accepted ? 'match' : 'mismatch',
      }
    },
    async summarizeVisualRecall(request) {
      summaries.push(request)
      return {
        ok: true,
        replyMessages: ['确认的照片都记录了黑莓在家里的日常。'],
        reasoning: { effort: 'off', durationMs: 1 },
      }
    },
  }

  runtime.visualSemanticIndex.search = async (query, options) => {
    indexRequests.push({ query, options })
    return { candidates }
  }

  const first = await runTurn(OWNER_TEXTS[0])
  const second = await runTurn(OWNER_TEXTS[1])
  assert.equal(first.status, 'done')
  assert.equal(second.status, 'done')
  assert.equal(indexRequests.length, 0, 'the earlier weight and breed questions are ordinary conversation')

  const final = await runTurn(OWNER_TEXTS[2])
  assert.equal(final.status, 'done')
  assert.equal(indexRequests.length, 1)
  assert.equal(indexRequests[0].query, expectedQuery)
  assert.ok(indexRequests[0].query.includes('黑莓'))
  assert.equal(indexRequests[0].options.recallGoal, 'summarize_photos')
  assert.equal(indexRequests[0].options.limit, MAX_VISUAL_INSPECTIONS_PER_TURN)

  assert.equal(visualSteps.length, 5)
  assert.deepEqual(visualSteps.map((request) => request.ownerCaption), candidates.map((candidate) => candidate.userText),
    'the model inspects and rejects unrelated candidates, without a caption keyword filter')
  assert.ok(visualSteps.every((request) => request.userText === expectedTask))
  assert.ok(visualSteps.every((request) => request.recallQuery === expectedQuery))
  assert.equal(summaries.length, 1)
  assert.equal(summaries[0].userText, expectedTask)
  assert.equal(summaries[0].recallQuery, expectedQuery)
  assert.deepEqual(summaries[0].observations.map((item) => item.attachmentId),
    candidates.slice(2).map((candidate) => candidate.attachmentId))
  assert.equal(final.events.filter((event) => event.type === 'visual_image').length, 3)
  assert.equal(final.events.some((event) =>
    event.type === 'assistant_message' && event.payload.text === '单图回复不能提前成为总结。'), false)

  const media = (await runtime.conversationStore.listForRecentVisualRecall(1000))
    .filter((message) => message.turnId === final.turnId && message.kind === 'media_ref')
  assert.deepEqual(media.map((message) => message.sourceAttachmentId),
    candidates.slice(2).map((candidate) => candidate.attachmentId))

  console.log('V0.5_MULTI_PHOTO_TASK_ROUTING=PASS')
} finally {
  runtime.close()
  await rm(root, { recursive: true, force: true })
}