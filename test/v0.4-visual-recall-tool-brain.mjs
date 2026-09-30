import assert from 'node:assert/strict'

import { LocalBrain } from '../src/brain/local-brain.js'
import { PET_CHAT_RESPONSE_SCHEMA } from '../src/brain/memory-candidate.js'

const image = { dataUrl: 'data:image/jpeg;base64,ZmFrZS1qcGVn' }
const state = { mood: .8, energy: .8, boredom: .1, sleepiness: .1, attachment: .8 }
const waitingReply = '花花去图库找找，再看一遍。'
const appearanceQuestion = '你知不知道我们家的猫黑莓长什么样子'
const recallValue = (overrides = {}) => ({
  tool: 'search_visual_memory',
  query: '我们家的猫黑莓 外观',
  goal: 'describe_subject',
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
  { ...recallValue(), extra: true },
]
const { brain, requests } = makeChatBrain([
  chatValue(recallValue()),
  chatValue(recallValue({ query: '黑莓 毛色' })),
  ...invalidRecalls.map((value) => chatValue(value)),
  chatValue(recallValue()),
  chatValue(recallValue()),
  chatValue(recallValue()),
  chatValue(null),
  chatValue(recallValue({ query: '我们家的猫黑莓 毛色' })),
  chatValue(null),
  chatValue(recallValue()),
  chatValue(recallValue()),
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

const paraphrase = await ask(brain, '你还记得黑莓的毛色吗？', { allowVisualRecall: true })
assert.deepEqual(paraphrase.visualRecall, recallValue({ query: '黑莓 毛色' }), 'the model can select a semantic query without matching a keyword allowlist')

const schema = requests[0].responseFormat.schema
assert.notStrictEqual(schema, PET_CHAT_RESPONSE_SCHEMA, 'the opt-in response schema is additive')
assert.equal(schema.properties.visualRecall.anyOf[1].type, 'null')
const recallObjectSchema = schema.properties.visualRecall.anyOf[0]
assert.equal(recallObjectSchema.properties.tool.enum[0], 'search_visual_memory')
assert.equal(recallObjectSchema.properties.query.maxLength, 240)
assert.deepEqual(recallObjectSchema.properties.goal.enum, ['describe_subject', 'find_photo'])
assert.equal(schema.required.includes('visualRecall'), true, 'the enabled schema asks the model to return a tool choice or null')
const selectedPrompt = requests[0].messages[0].content
assert.match(selectedPrompt, /以前见过的个人主体长什么样/u)
assert.match(selectedPrompt, /find_photo/u)
assert.match(selectedPrompt, /普通聊天/u)
assert.match(selectedPrompt, /当前上下文没有图片不代表图库没有相关图片/u)
assert.match(selectedPrompt, /不能仅因为当前没有看到图片/u)
assert.match(selectedPrompt, /memory\.remember 必须为 false/u)
assert.match(selectedPrompt, /不要给出任何猜测的外观或照片内容/u)

for (const invalid of invalidRecalls) {
  const result = await ask(brain, appearanceQuestion, { allowVisualRecall: true })
  assert.equal(result.visualRecall, null, `reject invalid tool result: ${JSON.stringify(invalid).slice(0, 80)}`)
}

const capabilityMeta = await ask(brain, '你会看照片吗？', { allowVisualRecall: true })
assert.equal(capabilityMeta.visualRecall, null, 'filter a model-selected tool for a capability question')

const technicalMeta = await ask(brain, '你的视觉检索算法是怎么工作的？', { allowVisualRecall: true })
assert.equal(technicalMeta.visualRecall, null, 'filter a model-selected tool for a technical meta question')

const responseMeta = await ask(brain, '为什么你看了图片以后像机器人？', { allowVisualRecall: true })
assert.equal(responseMeta.visualRecall, null, 'filter the known meta question about the pet response style')

const ordinary = await ask(brain, '今天好困。', { allowVisualRecall: true })
assert.equal(ordinary.visualRecall, null, 'ordinary chat returns no tool choice')
assert.match(requests[10].messages[0].content, /普通聊天/u, 'ordinary chat is excluded by the model selection prompt')

const relevantFollowup = await ask(brain, '那毛色呢？', {
  allowVisualRecall: true,
  visualRecallContext: appearanceQuestion,
})
assert.deepEqual(relevantFollowup.visualRecall, recallValue({ query: '我们家的猫黑莓 毛色' }))
const followupPrompt = requests[11].messages[0].content
assert.match(followupPrompt, /未解决的视觉回忆请求原文/u)
assert.match(followupPrompt, /你知不知道我们家的猫黑莓长什么样子/u)
assert.match(followupPrompt, /组合成自包含 query/u)

const unrelatedFollowup = await ask(brain, '那晚饭呢？', {
  allowVisualRecall: true,
  visualRecallContext: appearanceQuestion,
})
assert.equal(unrelatedFollowup.visualRecall, null, 'an unrelated topic stays outside the active visual recall')
assert.match(requests[12].messages[0].content, /晚饭等无关话题/u)

const disabled = await ask(brain, appearanceQuestion)
assert.equal(disabled.visualRecall, null)
assert.strictEqual(requests[13].responseFormat.schema, PET_CHAT_RESPONSE_SCHEMA, 'the base schema stays unchanged when disabled')
assert.doesNotMatch(requests[13].messages[0].content, /visualRecall/u, 'the tool instructions stay disabled')

const imageTurn = await ask(brain, '这张猫的照片长什么样？', { image, allowVisualRecall: true })
assert.equal(imageTurn.visualRecall, null, 'image input uses the normal vision path without a memory search')
assert.strictEqual(requests[14].responseFormat.schema, PET_CHAT_RESPONSE_SCHEMA)

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
assert.equal(namedRecallCalls[0].k, 2, 'confirmed naming retrieval asks only for the needed two facts')
assert.equal(typeof namedRecallCalls[0].filter, 'function', 'confirmed-topic filtering runs before the memory top-K')
assert.match(subjectPrompt, /"我们家的猫黑莓在沙发上"/u)
assert.match(subjectPrompt, /原始图片说明明确给这张照片里的主体命名/u)
assert.match(subjectPrompt, /若说明明确给主体起了另一个名字，填 mismatch/u)
assert.match(subjectPrompt, /名字必须来自主人文字，不能从像素或外观推测/u)
assert.match(subjectPrompt, /已完成的公开观察和模型推断不能建立身份或照片对应关系/u)
assert.match(subjectPrompt, /候选可以是任何正确标注/u)
assert.match(subjectPrompt, /不要求与唯一一张旧照片/u)
assert.match(subjectPrompt, /match 时直接回答主人实际询问的外观特征/u)
assert.match(subjectPrompt, /不要反问“这是不是黑莓”或让主人再确认身份/u)
assert.match(subjectPrompt, /不推断触感、健康状况或性格/u)
assert.match(subjectPrompt, /不要在 replyMessages 里询问主人来确认身份/u)
assert.match(subjectPrompt, /按 uncertain 处理并令 replyMessages 为空/u)
assert.match(subjectPrompt, /我们家的猫叫黑莓/u, 'confirmed naming facts remain available')
assert.doesNotMatch(subjectPrompt, /推测黑莓可能的身份线索/u, 'inferred naming distractors stay excluded before top-K')
assert.deepEqual(verifyRequests[0].messages[1].content[1], { type: 'image_url', image_url: { url: image.dataUrl } }, 'subject recall inspects the original image')

await verifyBrain.visualStep({
  userText: '以前那张黑莓在纸箱里的照片',
  image,
  verifyRecall: true,
  ownerCaption: '这只猫叫小橘，在纸箱里',
})
const photoPrompt = verifyRequests[1].messages[0].content
assert.match(photoPrompt, /所有可见的主体、物体及场景关系/u)
assert.match(photoPrompt, /只有全部明确吻合才填 "match"/u, 'find_photo keeps strict scene matching')
assert.match(photoPrompt, /"这只猫叫小橘，在纸箱里"/u, 'find_photo receives the raw owner caption')
assert.match(photoPrompt, /如果原始图片说明明确把当前图里的主体命名为与目标不同的名字，必须填 mismatch/u)
assert.match(photoPrompt, /没有写名字本身不构成 mismatch/u, 'a missing owner label does not reject a scene match')
assert.match(photoPrompt, /确认的称呼只解释目标名字，不能证明当前图的主体身份/u)
assert.match(photoPrompt, /不要在 replyMessages 里询问主人来确认身份/u, 'strict recall never turns uncertainty into an identity question')
assert.match(photoPrompt, /按 uncertain 处理并令 replyMessages 为空/u)
assert.doesNotMatch(photoPrompt, /不要求与唯一一张旧照片/u)

console.log('VISUAL_RECALL_TOOL_BRAIN=PASS')
