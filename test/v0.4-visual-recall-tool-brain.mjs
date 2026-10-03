import assert from 'node:assert/strict'

import { LocalBrain } from '../src/brain/local-brain.js'
import { PET_CHAT_RESPONSE_SCHEMA } from '../src/brain/memory-candidate.js'
import { PET_VOICE_INSTRUCTION } from '../src/brain/prompt-builder.js'

const image = { dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn' }
const state = { mood: .8, energy: .8, boredom: .1, sleepiness: .1, attachment: .8 }
const waitingReply = '花花去图库找找，再看一遍。'
const appearanceQuestion = '你知不知道我们家的猫黑莓长什么样子'
const recallValue = (overrides = {}) => ({
  tool: 'search_visual_memory',
  query: '我们家的猫黑莓 外观',
  goal: 'describe_subject',
  originalQuestion: '',
  ...overrides,
})
const emptyMemory = {
  remember: false,
  level: 'fact',
  content: '',
  importance: 1,
  keywords: [],
  confidence: 0,
  evidence: '',
}
const chatValue = (visualRecall = null) => ({
  reply: waitingReply,
  replyMessages: [waitingReply],
  memory: emptyMemory,
  beliefs: [],
  visualRecall,
})

function makeChatBrain(responses) {
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

async function ask(brain, userText, options = {}) {
  return brain.reply({ identity: { name: '李花花', birthday: '2026-08-31' }, state, userText, ...options })
}

const invalidRecalls = [
  recallValue({ query: '   ' }),
  recallValue({ query: '猫'.repeat(241) }),
  recallValue({ goal: 'remember_subject' }),
  recallValue({ tool: 'search_web' }),
  recallValue({ photoCount: 1 }),
  recallValue({ photoCount: 6 }),
  { ...recallValue(), extra: true },
]
const inspectedImageId = 'current-image'
const inspectImageValue = {
  tool: 'inspect_visual_memory',
  query: '这张猫的照片长什么样',
  goal: 'find_photo',
  originalQuestion: '',
  attachmentIds: [inspectedImageId],
  ownerCaption: false,
}
const { brain, requests } = makeChatBrain([
  chatValue(recallValue()),
  chatValue(recallValue({ query: '黑莓 毛色' })),
  ...invalidRecalls.map((value) => chatValue(value)),
  chatValue(null),
  chatValue(recallValue({ query: '视觉检索算法怎么工作的' })),
  chatValue(null),
  chatValue(null),
  chatValue(recallValue({ query: '我们家的猫黑莓 毛色', originalQuestion: appearanceQuestion })),
  chatValue(null),
  chatValue(recallValue()),
  chatValue(inspectImageValue),
])

const selected = await ask(brain, appearanceQuestion, { allowVisualRecall: true })
assert.equal(selected.ok, true)
assert.deepEqual(selected.visualRecall, recallValue())
assert.equal(selected.text, waitingReply, 'a tool selection returns only the safe waiting preamble')
assert.deepEqual(selected.replyMessages, [waitingReply])
assert.equal(selected.memoryCandidate, null, 'visual recall cannot create a memory write')
assert.equal(selected.rawMemoryCandidate, null, 'visual recall does not hand a model candidate to MemoryGate')
assert.equal(selected.memoryDecision, 'visual-recall-no-memory')
assert.equal(requests.length, 1, 'tool selection shares the normal Local Brain inference')
assert.equal(requests[0].reasoningEffort, 'low', 'tool-enabled phone chat keeps enough reasoning for recall-tool selection')
assert.equal(requests[0].maxTokens, 896, 'tool-enabled phone chat keeps the bounded structured reply allowance')

const paraphrase = await ask(brain, '你还记得黑莓的毛色吗？', { allowVisualRecall: true })
assert.deepEqual(paraphrase.visualRecall, recallValue({ query: '黑莓 毛色' }), 'the model can select a semantic query without matching a keyword allowlist')

const schema = requests[0].responseFormat.schema
assert.notStrictEqual(schema, PET_CHAT_RESPONSE_SCHEMA, 'the opt-in response schema is additive')
assert.equal(schema.properties.visualRecall.anyOf[1].type, 'null')
const recallObjectSchema = schema.properties.visualRecall.anyOf[0]
assert.deepEqual(recallObjectSchema.properties.tool.enum, ['search_visual_memory', 'inspect_visual_memory'])
assert.equal(recallObjectSchema.properties.query.maxLength, 240)
assert.deepEqual(recallObjectSchema.properties.goal.enum, ['describe_subject', 'find_photo', 'summarize_photos'])
assert.equal(recallObjectSchema.properties.photoCount.minimum, 2)
assert.equal(recallObjectSchema.properties.photoCount.maximum, 5)
assert.equal(recallObjectSchema.properties.originalQuestion.maxLength, 1200)
assert.equal(recallObjectSchema.required.includes('originalQuestion'), true)
assert.equal(recallObjectSchema.required.includes('excludeAttachmentIds'), true)
assert.equal(recallObjectSchema.required.includes('ownerCaption'), true)
assert.equal(schema.required.includes('resolvedRequest'), true)
assert.equal(schema.required.includes('replyMessages'), true)
assert.equal(Object.hasOwn(schema.properties, 'reply'), false, 'one authoritative list avoids dropping story opening or body')
assert.equal(schema.required.includes('visualRecall'), true, 'the enabled schema asks the model to return a tool choice or null')
const selectedPrompt = requests[0].messages[0].content
assert.match(selectedPrompt, /直接回答还是调用图片工具/u)
assert.match(selectedPrompt, /程序不会按关键词替你选工具/u)
assert.match(selectedPrompt, /inspect_visual_memory/u)
assert.match(selectedPrompt, /search_visual_memory/u)
assert.match(selectedPrompt, /originalQuestion/u)
assert.match(selectedPrompt, /普通聊天/u)
assert.match(selectedPrompt, /memory\.remember=false/u)
assert.match(selectedPrompt, /不提前猜图片内容/u)

for (const invalid of invalidRecalls) {
  const result = await ask(brain, appearanceQuestion, { allowVisualRecall: true })
  assert.equal(result.visualRecall, null, `reject invalid tool result: ${JSON.stringify(invalid).slice(0, 80)}`)
}

const capabilityMeta = await ask(brain, '你会看照片吗？', { allowVisualRecall: true })
assert.equal(capabilityMeta.visualRecall, null, 'the model can decline a capability question')

const technicalMeta = await ask(brain, '你的视觉检索算法是怎么工作的？', { allowVisualRecall: true })
assert.deepEqual(technicalMeta.visualRecall, recallValue({ query: '视觉检索算法怎么工作的' }), 'honor the model-selected tool for a technical meta question')

const responseMeta = await ask(brain, '为什么你看了图片以后像机器人？', { allowVisualRecall: true })
assert.equal(responseMeta.visualRecall, null, 'filter the known meta question about the pet response style')

const ordinary = await ask(brain, '黑莓好像饿了', { allowVisualRecall: true })
assert.equal(ordinary.visualRecall, null, 'mentioning a familiar photo subject while discussing current needs is ordinary chat')
assert.match(requests[12].messages[0].content, /黑莓好像饿了/u, 'the model prompt includes an ordinary-chat example')
assert.match(requests[12].messages[0].content, /普通聊天/u, 'ordinary chat is described for model selection')
assert.equal(requests[12].reasoningEffort, 'low', 'tool-enabled planner calls use the text-chat reasoning profile')
assert.equal(requests[12].maxTokens, 896)

const relevantFollowup = await ask(brain, '那毛色呢？', {
  allowVisualRecall: true,
  visualRecallContext: appearanceQuestion,
  recentMessages: [{ role: 'user', content: appearanceQuestion }],
})
assert.deepEqual(relevantFollowup.visualRecall, recallValue({ query: '我们家的猫黑莓 毛色', originalQuestion: appearanceQuestion }))
const followupPrompt = requests[13].messages[0].content
assert.match(followupPrompt, /未解决的视觉任务/u)
assert.match(followupPrompt, /你知不知道我们家的猫黑莓长什么样子/u)
assert.match(followupPrompt, /尚待回答的原始问题/u)
assert.match(followupPrompt, /新话题不继承/u)

const unrelatedFollowup = await ask(brain, '那晚饭呢？', {
  allowVisualRecall: true,
  visualRecallContext: appearanceQuestion,
})
assert.equal(unrelatedFollowup.visualRecall, null, 'an unrelated topic stays outside the active visual recall')
assert.match(requests[14].messages[0].content, /晚饭等新话题/u)

const disabled = await ask(brain, appearanceQuestion)
assert.equal(disabled.visualRecall, null)
assert.strictEqual(requests[15].responseFormat.schema, PET_CHAT_RESPONSE_SCHEMA, 'the base schema stays unchanged when disabled')
assert.doesNotMatch(requests[15].messages[0].content, /visualRecall/u, 'the tool instructions stay disabled')
assert.equal(requests[15].reasoningEffort, 'low', 'ordinary text chat keeps its existing profile')
assert.equal(requests[15].maxTokens, 896)

const imageTurn = await ask(brain, '这张猫的照片长什么样？', { image, allowVisualRecall: true,
  recentVisuals: [{ attachmentId: inspectedImageId, role: 'user', text: '这张猫的照片长什么样？', timestamp: Date.now(), current: true }] })
assert.deepEqual(imageTurn.visualRecall, inspectImageValue, 'the model may select the current image to inspect')
const imageSchema = requests[16].responseFormat.schema
assert.notStrictEqual(imageSchema, PET_CHAT_RESPONSE_SCHEMA, 'image input keeps the model-selected visual tool schema enabled')
assert.deepEqual(imageSchema.properties.visualRecall.anyOf[0].properties.tool.enum, ['search_visual_memory', 'inspect_visual_memory'])
assert.equal(requests[16].reasoningEffort, 'medium', 'image tool choice keeps the vision profile')
assert.equal(requests[16].maxTokens, 1792, 'image planning reserves 1024 reasoning tokens plus room for its structured answer')

const verifyRequests = []
const namedRecallCalls = []
const namedMemoryRows = [
  ...Array.from({ length: 24 }, (_, index) => ({
    content: `推测黑莓可能的身份线索 ${index}`,
    provenance: { evidence: 'inferred' },
  })),
  { content: '我们家的猫叫黑莓', provenance: { evidence: 'confirmed' } },
]
const verifyBrain = new LocalBrain({
  memory: {
    recall(query, k, options = {}) {
      namedRecallCalls.push({ query, k, filter: options.filter })
      const rows = typeof options.filter === 'function' ? namedMemoryRows.filter(options.filter) : namedMemoryRows
      return rows.slice(0, k)
    },
  },
  client: {
    async chat(request) {
      verifyRequests.push(request)
      return { payload: { choices: [{ message: { content: JSON.stringify({
        observation: '原图里有一只猫。',
        action: 'answer',
        nextVisualId: '',
        focus: '猫的外观',
        replyMessages: ['花花确认看到了这只猫。'],
        match: 'match',
      }) } }] } }
    },
  },
})

await verifyBrain.visualStep({
  userText: appearanceQuestion,
  image,
  verifyRecall: true,
  recallGoal: 'describe_subject',
  ownerCaption: '我们家的猫黑莓在沙发上',
  observations: [{ visualId: 'V0', summary: '之前的观察说画面里是黑莓。' }],
})
const subjectPrompt = verifyRequests[0].messages[0].content
assert.equal(verifyRequests[0].reasoningEffort, 'low', 'named subject verification retains limited reasoning for identity interpretation')
assert.equal(verifyRequests[0].maxTokens, 2048)
assert.equal(verifyRequests[0].requestTimeoutMs, 30_000, 'recall verification has a bounded response deadline')
assert.equal(namedRecallCalls[0].k, 2, 'confirmed naming retrieval asks only for the needed two facts')
assert.equal(typeof namedRecallCalls[0].filter, 'function', 'confirmed-topic filtering runs before the memory top-K')
assert.ok(subjectPrompt.includes(PET_VOICE_INSTRUCTION), 'the shorter verification prompt keeps the pet voice guidance')
assert.match(subjectPrompt, /"我们家的猫黑莓在沙发上"/u)
assert.match(subjectPrompt, /原始图片说明明确给这张照片里的主体命名/u)
assert.match(subjectPrompt, /若说明明确给主体起了另一个名字，填 mismatch/u)
assert.match(subjectPrompt, /名字必须来自主人文字，不能从像素或外观推测/u)
assert.match(subjectPrompt, /模型推断不能建立身份或照片对应关系/u)
assert.match(subjectPrompt, /任何由主人正确标注/u)
assert.match(subjectPrompt, /不要求背景或姿势相同/u)
assert.match(subjectPrompt, /match 时直接回答主人问的可见外观/u)
assert.match(subjectPrompt, /不询问主人确认身份/u)
assert.match(subjectPrompt, /不推断触感、健康或性格/u)
assert.match(subjectPrompt, /若身份、主体类别、外观或关键场景无法从原图核实，填 uncertain/u)
assert.doesNotMatch(subjectPrompt, /TASK_MODE=/u, 'verification does not carry irrelevant comparison mode boilerplate')
assert.doesNotMatch(subjectPrompt, /候选图片目录/u, 'verification checks the single attached original, not a catalog')
assert.doesNotMatch(subjectPrompt, /已完成的公开观察/u, 'verification does not include an observation ledger')
assert.match(subjectPrompt, /我们家的猫叫黑莓/u, 'confirmed naming facts remain available')
assert.doesNotMatch(subjectPrompt, /推测黑莓可能的身份线索/u, 'inferred naming distractors stay excluded before top-K')
assert.deepEqual(verifyRequests[0].messages[1].content[1], { type: 'image_url', image_url: { url: image.dataUrl } }, 'subject recall inspects the original image')
assert.strictEqual(verifyRequests[0].responseFormat.schema.properties.match.enum.join(','), 'match,mismatch,uncertain', 'recall decision schema remains unchanged')

await verifyBrain.visualStep({
  userText: '以前那张黑莓在纸箱里的照片',
  image,
  verifyRecall: true,
  ownerCaption: '这只猫叫小橘，在纸箱里',
})
const photoPrompt = verifyRequests[1].messages[0].content
assert.equal(verifyRequests[1].reasoningEffort, 'low', 'single-photo recall verification uses the text-chat reasoning profile')
assert.equal(verifyRequests[1].maxTokens, 1024)
assert.match(photoPrompt, /所有可见的主体、物体及场景关系/u)
assert.match(photoPrompt, /只有全部明确吻合才填 "match"/u, 'find_photo keeps strict scene matching')
assert.match(photoPrompt, /本轮原始需求是否确实需要这张历史照片/u)
assert.match(photoPrompt, /黑莓好像饿了/u, 'verification explicitly rejects identity-only matches for a current-state chat')
assert.match(photoPrompt, /match="uncertain" 且 replyMessages=\[\]/u)

await verifyBrain.visualStep({
  userText: '多看几张照片后总结黑莓的样子',
  recallQuery: '黑莓',
  image,
  verifyRecall: true,
  recallGoal: 'summarize_photos',
  ownerCaption: '黑莓在纸箱里',
})
assert.equal(verifyRequests[2].reasoningEffort, 'medium', 'each multi-photo summary inspection uses vision reasoning')
assert.equal(verifyRequests[2].maxTokens, 2048)
assert.match(verifyRequests[2].messages[0].content, /本轮原始需求是否确实需要这张历史照片/u, 'multi-photo verification keeps the same intent gate')
assert.match(photoPrompt, /"这只猫叫小橘，在纸箱里"/u, 'find_photo receives the raw owner caption')
assert.match(photoPrompt, /原始说明明确给主体标了另一个名字时必须填 mismatch/u)
assert.match(photoPrompt, /没有名字本身不构成 mismatch/u, 'a missing owner label does not reject a scene match')
assert.match(photoPrompt, /确认的称呼只解释目标名字，不能证明当前照片里的主体身份/u)
assert.match(photoPrompt, /不要反问主人.*让主人确认身份/u, 'strict recall never turns uncertainty into an identity question')
assert.match(photoPrompt, /mismatch 或 uncertain 时 replyMessages 必须为空/u)
assert.doesNotMatch(photoPrompt, /不要求与唯一一张旧照片/u)

const ordinaryVisionRequests = []
const ordinaryVisionBrain = new LocalBrain({
  client: {
    async chat(request) {
      ordinaryVisionRequests.push(request)
      return { payload: { choices: [{ message: { content: JSON.stringify({
        observation: '画面里有早餐。', action: 'answer', nextVisualId: '', focus: '食物', replyMessages: ['我看到了早餐。'],
      }) } }] } }
    },
  },
})
await ordinaryVisionBrain.visualStep({ userText: '这张早餐有什么？', image })
assert.equal(ordinaryVisionRequests[0].reasoningEffort, 'medium', 'ordinary visual inspection keeps the medium vision profile')
assert.equal(ordinaryVisionRequests[0].maxTokens, 4096, 'ordinary visual inspection keeps its existing completion allowance')
assert.equal(ordinaryVisionRequests[0].requestTimeoutMs, undefined, 'the new deadline is scoped to recall verification')
assert.match(ordinaryVisionRequests[0].messages[0].content, /候选图片目录/u, 'ordinary inspection keeps its multi-image workflow prompt')

const messagesOnlyBrain = makeChatBrain([{ resolvedRequest:'讲故事',replyMessages:['花花编个小故事，黑莓在阳台晒太阳。','一片叶子飘到它身上，它伸爪接住，又安心睡着了。'],memory:emptyMemory,beliefs:[],visualRecall:null }])
const story = await ask(messagesOnlyBrain.brain,'我要听！快讲讲',{allowVisualRecall:true})
assert.equal(story.ok,true)
assert.equal(story.replyMessages.length,2)
assert.match(story.replyMessages[0],/小故事/u)
assert.match(story.replyMessages[1],/伸爪/u)
console.log('VISUAL_RECALL_TOOL_BRAIN=PASS')
