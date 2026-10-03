import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LocalBrain } from '../src/brain/local-brain.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const OWNER_REQUESTS = [
  { text: '你要去图库多看几张黑莓的照片总结一下哦', photoCount: 3 },
  { text: '帮我找两张以前黑莓的照片总结一下', photoCount: 2 },
]
const waitingReply = '花花去图库找找，再看一遍。'
const emptyMemory = {
  remember: false,
  level: 'fact',
  content: '',
  importance: 1,
  keywords: [],
  confidence: 0,
  evidence: '',
}
const chatValue = (visualRecall) => ({
  reply: waitingReply,
  replyMessages: [waitingReply],
  memory: emptyMemory,
  beliefs: [],
  visualRecall,
})

function makeBrain(responses) {
  const requests = []
  const brain = new LocalBrain({
    memory: { recall: () => [] },
    client: {
      async chat(request) {
        requests.push(request)
        return { payload: { choices: [{ message: { content: JSON.stringify(responses.shift()) } }] } }
      },
    },
  })
  return { brain, requests }
}

function recallValue({ query = '黑莓照片', photoCount, goal = 'summarize_photos' } = {}) {
  return {
    tool: 'search_visual_memory',
    originalQuestion: '',
    query,
    goal,
    ...(photoCount === undefined ? {} : { photoCount }),
  }
}

const metaQuestion = '图库里的多张照片总结功能是怎么实现的？'

const { brain: plannerBrain, requests: plannerRequests } = makeBrain([
  chatValue(recallValue()),
  chatValue(recallValue({ query: '以前黑莓的照片', photoCount: 2 })),
  chatValue(null),
  chatValue(recallValue({ photoCount: 1 })),
])

const plannedDefault = await plannerBrain.reply({
  identity: { name: '李花花', birthday: '2026-08-31' }, state: {},
  userText: OWNER_REQUESTS[0].text, allowVisualRecall: true,
})
assert.deepEqual(plannedDefault.visualRecall, recallValue({ photoCount: 3 }), '“多看几张” defaults to three photos')

const plannedTwo = await plannerBrain.reply({
  identity: { name: '李花花', birthday: '2026-08-31' }, state: {},
  userText: OWNER_REQUESTS[1].text, allowVisualRecall: true,
})
assert.deepEqual(plannedTwo.visualRecall, recallValue({ query: '以前黑莓的照片', photoCount: 2 }))

const metaResult = await plannerBrain.reply({
  identity: { name: '李花花', birthday: '2026-08-31' }, state: {},
  userText: metaQuestion, allowVisualRecall: true,
})
assert.equal(metaResult.visualRecall, null, 'a photo-summary capability question must not invoke retrieval')

const invalidCount = await plannerBrain.reply({
  identity: { name: '李花花', birthday: '2026-08-31' }, state: {},
  userText: OWNER_REQUESTS[1].text, allowVisualRecall: true,
})
assert.equal(invalidCount.visualRecall, null, 'photoCount below the supported minimum is rejected')

const plannerSchema = plannerRequests[0].responseFormat.schema.properties.visualRecall.anyOf[0]
assert.deepEqual(plannerSchema.properties.goal.enum, ['describe_subject', 'find_photo', 'summarize_photos'])
assert.deepEqual(plannerSchema.properties.photoCount, { type: 'integer', minimum: 2, maximum: 5 })
assert.equal(plannerSchema.required.includes('photoCount'), false, 'photoCount stays optional for the default')
const plannerPrompt = plannerRequests[0].messages[0].content
assert.match(plannerPrompt, /summarize_photos/u)
assert.match(plannerPrompt, /未指定数量默认3/u)
assert.match(plannerPrompt, /photoCount 指定2到5张/u)

// Exercise the dedicated text-only summary call and its bounded request shape.
const summaryRequests = []
const confirmedBlackberryFact = {
  content: '我们家的猫叫黑莓',
  provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' },
}
const summaryBrain = new LocalBrain({
  memory: {
    recall(_query, _limit, { filter } = {}) {
      return [confirmedBlackberryFact].filter((fact) => !filter || filter(fact))
    },
  },
  client: {
    async chat(request) {
      summaryRequests.push(request)
      const photoCount = Number(/计划查看(\d+)张/u.exec(request.messages[0].content)?.[1] ?? 0)
      return { payload: { choices: [{ message: { content: JSON.stringify({ replyMessages: [`我综合看了${photoCount}张，黑莓的黑白花纹都很清楚。`] }) } }] } }
    },
  },
})
const summaryResult = await summaryBrain.summarizeVisualRecall({
  userText: OWNER_REQUESTS[0].text,
  recallQuery: '黑莓照片',
  requestedImages: 3,
  observations: [
    { visualId: 'V0', summary: '猫趴在纸箱上，黑白毛色清楚。', ownerCaption: '黑莓在纸箱里' },
    { visualId: 'V1', summary: '猫坐在窗边，脸上的白色花纹清楚。', ownerCaption: '你看黑莓在晒太阳诶' },
    { visualId: 'V2', summary: '黑莓侧身躺着，背部有大片黑色毛发。' },
  ],
  inspectionLimitReached: true,
})
assert.equal(summaryResult.ok, true)
assert.equal(summaryResult.replyMessages.length, 1)
assert.equal(summaryResult.reasoning.effort, 'medium')
assert.equal(summaryRequests[0].reasoningEffort, 'medium')
assert.equal(summaryRequests[0].maxTokens, 1792)
assert.equal(summaryRequests[0].reasoningStage, 'visual-summary')
assert.equal(summaryRequests[0].responseFormat.schema.properties.replyMessages.maxItems, 1)
const summaryPrompt = summaryRequests[0].messages[0].content
assert.match(summaryPrompt, /你要去图库多看几张黑莓的照片总结一下哦/u)
assert.match(summaryPrompt, /计划查看3张，实际确认3张/u)
assert.match(summaryPrompt, /本轮最多检查5张候选/u)
assert.match(summaryPrompt, /V0: 猫趴在纸箱上/u)
assert.ok(summaryPrompt.includes('黑莓在纸箱里'))
assert.ok(summaryPrompt.includes('你看黑莓在晒太阳诶'))
assert.ok(summaryPrompt.includes('我们家的猫叫黑莓'), 'the summary retains the confirmed name when observations omit it')

const ownerCaptions = ['黑莓在纸箱里', '你看黑莓在晒太阳诶', '黑莓在窗台上']
const contextSummary = await summaryBrain.summarizeVisualRecall({
  userText: OWNER_REQUESTS[1].text,
  recallQuery: '黑莓',
  requestedImages: 2,
  observations: [
    { visualId: 'V0', summary: '一只黑白相间的猫在纸箱里。', ownerCaption: ownerCaptions[0] },
    { visualId: 'V1', summary: '一只黑白相间的猫在阳光下。', ownerCaption: ownerCaptions[1] },
  ],
})
assert.equal(contextSummary.ok, true)
const contextSummaryPrompt = summaryRequests[1].messages[0].content
assert.match(contextSummaryPrompt, /主人确认的称呼说明：我们家的猫叫黑莓/u)
assert.match(contextSummaryPrompt, /本图主人原话："黑莓在纸箱里"/u)
assert.match(contextSummaryPrompt, /本图主人原话："你看黑莓在晒太阳诶"/u)
assert.match(contextSummaryPrompt, /V0: 一只黑白相间的猫在纸箱里。/u)
assert.match(contextSummaryPrompt, /V1: 一只黑白相间的猫在阳光下。/u)
assert.doesNotMatch(contextSummaryPrompt, /V[01]:[^\n]*黑莓/u, 'the public observations can omit the name when raw owner captions and the confirmed name fact are present')

// Use only an isolated PetRuntime with fake planner, index, and vision steps.
const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-multi-photo-task-'))
const runtime = new PetRuntime({ sandboxRoot: root })
try {
  await runtime.initialize()
  runtime.visualSemanticIndex = { active: false, stop() {} }
  runtime.memory.remember('fact', '我们家的猫叫黑莓', 2,
    { provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' } })

  const attachments = []
  for (const [index, base64] of ['QUFB', 'QkJC', 'Q0ND'].entries()) {
    const dataUrl = `data:image/png;base64,${base64}`
    const attachment = await runtime.conversationStore.saveAttachment({
      image: { dataUrl }, thumbnail: { dataUrl },
      width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64,
      requireThumbnail: true,
    })
    attachments.push(attachment)
    await runtime.conversationStore.appendMessage({
      role: 'user', text: ownerCaptions[index], attachment,
      timestamp: index + 1,
    })
  }

  const expectedByRequest = new Map(OWNER_REQUESTS.map(({ text, photoCount }) => [text, photoCount]))
  const runtimeCalls = {
    replies: [],
    searches: [],
    visualSteps: new Map(),
    summaries: new Map(),
    previewCalls: 0,
    recentShortcutCalls: 0,
    longTermShortcutCalls: 0,
  }
  runtime.brain = {
    async reply({ userText, allowVisualRecall }) {
      runtimeCalls.replies.push(userText)
      assert.equal(allowVisualRecall, true)
      const photoCount = expectedByRequest.get(userText)
      assert.ok(photoCount, `unexpected planner request: ${userText}`)
      return {
        ok: true,
        text: '花花去图库多看几张，再整理给主人～',
        visualRecall: { tool: 'search_visual_memory', query: userText, goal: 'summarize_photos', photoCount },
      }
    },
    async visualSearch() {
      runtimeCalls.previewCalls += 1
      throw new Error('multi-photo recall should inspect indexed originals directly')
    },
    async visualStep(request) {
      assert.equal(request.verifyRecall, true)
      assert.equal(request.recallGoal, 'summarize_photos')
      assert.equal(request.comparison, false, 'a summary task is not a two-photo comparison')
      assert.equal(request.userText, request.recallQuery, 'the original request reaches each inspection')
      const list = runtimeCalls.visualSteps.get(request.userText) ?? []
      list.push(request)
      runtimeCalls.visualSteps.set(request.userText, list)
      return {
        ok: true,
        observation: `${request.currentVisualId}：黑白毛色和脸部白色花纹可见。`,
        action: 'answer', nextVisualId: '', focus: '毛色和花纹',
        replyMessages: ['单张核验草稿'], match: 'match',
      }
    },
    async summarizeVisualRecall(request) {
      const list = runtimeCalls.summaries.get(request.userText) ?? []
      list.push(request)
      runtimeCalls.summaries.set(request.userText, list)
      return summaryBrain.summarizeVisualRecall(request)
    },
  }

  runtime.recentVisualResolver.resolveFromStore = async () => {
    runtimeCalls.recentShortcutCalls += 1
    return { matched: true, reason: 'active-visual-reference', attachmentId: attachments[0].id }
  }
  const longTermResolver = {
    async resolve() {
      runtimeCalls.longTermShortcutCalls += 1
      return { status: 'none', candidates: [], winner: null }
    },
  }
  runtime.longTermVisualResolver = longTermResolver
  runtime.turnOrchestrator.longTermResolver = longTermResolver
  runtime.turnOrchestrator.semanticIndex = {
    async search(query, options) {
      runtimeCalls.searches.push({ query, options })
      const photoCount = expectedByRequest.get(query)
      assert.ok(photoCount, `unexpected semantic query: ${query}`)
      const candidates = attachments.slice(0, photoCount).map((attachment, index) => ({
        attachmentId: attachment.id,
        userText: ownerCaptions[index],
        occurredAt: index + 1,
      }))
      return { status: 'matched', candidates, winner: candidates[0] }
    },
  }

  async function runTurn(userText) {
    const started = runtime.startChatTurn({ userText })
    let poll = null
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      poll = runtime.pollChatTurn(started.turnId)
      if (poll?.status !== 'running') break
    }
    assert.equal(poll?.status, 'done', JSON.stringify({ userText, poll }))
    return poll
  }

  for (const { text, photoCount } of OWNER_REQUESTS) {
    const result = await runTurn(text)
    assert.equal(runtimeCalls.replies.filter((request) => request === text).length, 1, 'one model call plans the recall task')
    assert.equal(runtimeCalls.searches.filter(({ query }) => query === text).length, 1, 'the owner request drives one semantic search')
    assert.equal(runtimeCalls.searches.at(-1).options.recallGoal, 'summarize_photos')
    assert.equal(runtimeCalls.searches.at(-1).options.limit, 5)
    assert.equal(runtimeCalls.visualSteps.get(text)?.length, photoCount, 'inspect the planned number of unique photos')
    assert.equal(new Set(runtimeCalls.visualSteps.get(text).map(({ currentVisualId }) => currentVisualId)).size, photoCount)
    assert.equal(runtimeCalls.summaries.get(text)?.length, 1, 'summarize once after photo inspection')
    assert.equal(runtimeCalls.summaries.get(text)[0].requestedImages, photoCount)
    assert.equal(runtimeCalls.summaries.get(text)[0].userText, text, 'the final summary receives the original request')
    assert.equal(runtimeCalls.summaries.get(text)[0].observations.length, photoCount)
    assert.ok(runtimeCalls.summaries.get(text)[0].observations.every(({ summary }) => !summary.includes('黑莓')))
    assert.deepEqual(runtimeCalls.summaries.get(text)[0].observations.map(({ ownerCaption }) => ownerCaption), ownerCaptions.slice(0, photoCount))
    const actualSummaryPrompt = summaryRequests.at(-1).messages[0].content
    assert.match(actualSummaryPrompt, /主人确认的称呼说明：我们家的猫叫黑莓/u)
    assert.match(actualSummaryPrompt, /本图主人原话："黑莓在纸箱里"/u)
    assert.match(actualSummaryPrompt, /本图主人原话："你看黑莓在晒太阳诶"/u)
    assert.doesNotMatch(actualSummaryPrompt, /V[01]:[^\n]*黑莓/u)
    assert.equal(result.events.filter(({ type }) => type === 'visual_image').length, photoCount)
    assert.ok(result.events.some(({ type, payload }) => type === 'assistant_message' && payload.text.includes(`综合看了${photoCount}张`)))
  }

  assert.equal(runtimeCalls.previewCalls, 0)
  assert.equal(runtimeCalls.recentShortcutCalls, 0, 'multi-photo task planning bypasses the recent single-image shortcut')
  assert.equal(runtimeCalls.longTermShortcutCalls, 0, 'multi-photo task planning bypasses the direct long-term shortcut')
  console.log('MULTI_PHOTO_TASK_ROUTING=PASS')
} finally {
  runtime.close()
  await rm(root, { recursive: true, force: true })
}
