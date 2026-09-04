import assert from 'node:assert/strict'
import { readFile, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import { ConversationStore } from '../src/conversation/conversation-store.js'
import {
  RECENT_VISUAL_MAX_ATTACHMENTS,
  RECENT_VISUAL_WINDOW,
  RecentVisualResolver,
  collectRecentVisualCandidates,
} from '../src/conversation/recent-visual-context.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-recent-visual-'))
let runtime = null
let restarted = null

function state() {
  return { mood: .8, energy: .8, boredom: .1, sleepiness: .1, attachment: .8 }
}

function memory() {
  return {
    recall: () => [],
    stableRulesContext: () => [],
    currentSelfContext: () => [],
  }
}

function response(text = '看到了。') {
  return {
    payload: {
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ reply: text, memory: null }) } }],
    },
  }
}

const pawBytes = await readFile(join(process.cwd(), 'assets/runtime/icon-paw.png'))
const currentBytes = await readFile(join(process.cwd(), 'assets/runtime/avatar.png'))
const pawDataUrl = `data:image/png;base64,${pawBytes.toString('base64')}`
const currentDataUrl = `data:image/png;base64,${currentBytes.toString('base64')}`

try {
  const store = new ConversationStore(root)
  await store.initialize()
  const attachments = []
  const topics = ['猫咪', '水杯', '玩具', '窗边', '零食', '球', '猫咪', '天空', '碗', '植物叶子', '植物叶子']
  for (let index = 0; index < 11; index += 1) {
    const imageNumber = String(index + 1).padStart(2, '0')
    const attachment = await store.saveAttachment({
      image: { dataUrl: pawDataUrl },
      thumbnail: { dataUrl: pawDataUrl },
      width: 64,
      height: 64,
      thumbnailWidth: 64,
      thumbnailHeight: 64,
      timestamp: index + 1,
    })
    attachments.push(attachment)
    await store.appendMessage({
      role: 'user',
      text: `IMAGE_${imageNumber} ${topics[index]}`,
      timestamp: index * 2 + 1,
      attachment,
    })
    await store.appendMessage({
      role: 'assistant',
      text: `花花看到了 IMAGE_${imageNumber} ${topics[index]}`,
      timestamp: index * 2 + 2,
    })
  }

  const persistedMessages = await store.listForRecentVisualRecall()
  const candidates = collectRecentVisualCandidates(persistedMessages)
  assert.equal(RECENT_VISUAL_MAX_ATTACHMENTS, 10)
  assert.equal(RECENT_VISUAL_WINDOW, '10_IMAGE_MESSAGES')
  assert.deepEqual(candidates.map(({ userText }) => userText.split(' ')[0]), [
    'IMAGE_02', 'IMAGE_03', 'IMAGE_04', 'IMAGE_05', 'IMAGE_06',
    'IMAGE_07', 'IMAGE_08', 'IMAGE_09', 'IMAGE_10', 'IMAGE_11',
  ])
  assert.equal(candidates.some(({ attachmentId }) => attachmentId === attachments[0].id), false)
  console.log('RECENT_VISUAL_MAX_ATTACHMENTS=10')
  console.log('RECENT_VISUAL_WINDOW=10_IMAGE_MESSAGES')

  const resolver = new RecentVisualResolver()
  assert.deepEqual(resolver.resolve('上一张', persistedMessages), {
    matched: true,
    attachmentId: attachments[10].id,
    reason: 'recent-visual-reference',
  })
  assert.equal(resolver.resolve('你再仔细看看猫咪', persistedMessages).attachmentId, attachments[6].id)
  assert.equal(resolver.resolve('你仔细看看这个是真的吃的吗', persistedMessages).attachmentId, attachments[10].id)
  assert.equal(resolver.resolve('这是真的吗？', persistedMessages).attachmentId, attachments[10].id)
  assert.deepEqual(resolver.resolve('花花今天开心吗？', persistedMessages), {
    matched: false,
    attachmentId: null,
    reason: 'no-recent-visual-candidate',
  })
  const noImmediateImage = [
    { role: 'user', text: 'IMAGE_01', attachment: { id: attachments[0].id } },
    { role: 'assistant', text: '看到了。' },
    { role: 'user', text: '普通聊天' },
    { role: 'assistant', text: '好呀。' },
    { role: 'user', text: '又聊一句' },
    { role: 'assistant', text: '汪。' },
  ]
  assert.equal(resolver.resolve('这个怎么样？', noImmediateImage).matched, false)
  console.log('LATEST_IMAGE_FOLLOWUP=PASS')
  console.log('STRONG_VISUAL_REFERENCE=PASS')
  console.log('WEAK_IMMEDIATE_REFERENCE=PASS')
  console.log('UNRELATED_CHAT_NO_VISUAL_RECALL=PASS')

  const restoredStore = new ConversationStore(root)
  await restoredStore.initialize()
  const restoredVisual = await new RecentVisualResolver().resolveFromStore(restoredStore, '你再仔细看看刚才那张')
  assert.equal(restoredVisual.attachmentId, attachments[10].id)
  const restoredAsset = await restoredStore.readAttachmentDataUrl(restoredVisual.attachmentId)
  assert.equal(restoredAsset.dataUrl, pawDataUrl)
  console.log('RECENT_VISUAL_RECALL_AFTER_RESTART=PASS')
  console.log('RECENT_VISUAL_SOURCE=CONVERSATION_STORE')
  console.log('RECENT_VISUAL_BASE64_PERSISTED_IN_CONTEXT=NO')

  runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  const brainCalls = []
  const gateCalls = []
  runtime.memoryGate = {
    consider: (...args) => {
      gateCalls.push(args)
      return { status: 'written', reason: 'should-not-run-for-vision' }
    },
  }
  runtime.brain = {
    reply: async (requestData) => {
      brainCalls.push(requestData)
      return {
        ok: true,
        text: '花花真的看到了。',
        rawMemoryCandidate: { content: '不应写入' },
        reasoning: { effort: requestData.image ? 'medium' : 'low', durationMs: 42 },
      }
    },
  }
  const attachmentCountBeforeRecall = runtime.conversationStore.state.attachments.length
  const recalled = await runtime.chat('这是真的吗？')
  assert.equal(recalled.ok, true)
  assert.deepEqual(recalled.reasoning, { effort: 'medium', durationMs: 42 })
  assert.equal(brainCalls.length, 1)
  assert.equal(brainCalls[0].image.dataUrl, pawDataUrl)
  assert.deepEqual(brainCalls[0].visualContext, { source: 'recent-visual-recall' })
  assert.equal(gateCalls.length, 0)
  assert.equal(recalled.memoryWrite, 'skipped')
  assert.equal(runtime.conversationStore.state.attachments.length, attachmentCountBeforeRecall)
  const afterRecall = await runtime.conversationHistory()
  assert.equal(afterRecall.at(-2).attachment, null)
  assert.equal(afterRecall.at(-2).text, '这是真的吗？')
  assert.equal((await readFile(join(root, 'conversation-store.json'), 'utf8')).includes('data:image'), false)
  console.log('RECENT_IMAGE_RECALLED=YES')
  console.log('VISION_USED=YES')
  console.log('RECALLED_IMAGE_REASONING=medium')
  console.log('VISUAL_RECALL_MEMORY_WRITE=NO')
  console.log('HISTORICAL_IMAGE_DUPLICATED_IN_CONVERSATION=NO')
  console.log('MODEL_INFERENCES_PER_CHAT=1')

  runtime.close()
  runtime = null
  restarted = new PetRuntime({ sandboxRoot: root })
  await restarted.initialize()
  const restartCalls = []
  restarted.memoryGate = { consider: () => ({ status: 'written' }) }
  restarted.brain = {
    reply: async (requestData) => {
      restartCalls.push(requestData)
      return {
        ok: true,
        text: '重新看到了。',
        reasoning: { effort: requestData.image ? 'medium' : 'low', durationMs: 43 },
      }
    },
  }
  const recalledAfterRestart = await restarted.chat('你再仔细看看刚才那张')
  assert.equal(recalledAfterRestart.ok, true)
  assert.equal(restartCalls.length, 1)
  assert.equal(restartCalls[0].image.dataUrl, pawDataUrl)
  assert.deepEqual(restartCalls[0].visualContext, { source: 'recent-visual-recall' })

  const current = await restarted.chat('上一张', { dataUrl: currentDataUrl })
  assert.equal(current.ok, true)
  assert.equal(restartCalls.length, 2)
  assert.equal(restartCalls[1].image.dataUrl, currentDataUrl)
  assert.equal(restartCalls[1].visualContext, null)
  assert.equal(restarted.conversationStore.state.attachments.length, attachmentCountBeforeRecall + 1)
  console.log('CURRENT_IMAGE_PRIORITY=PASS')

  const normal = await restarted.chat('花花今天开心吗？')
  assert.equal(normal.ok, true)
  assert.equal(restartCalls.length, 3)
  assert.equal(restartCalls[2].image, null)
  assert.equal(normal.reasoning.effort, 'low')
  console.log('NORMAL_CHAT_AFTER_IMAGE_REASONING=low')

  const localCalls = []
  const localMemoryCalls = []
  const localBrain = new LocalBrain({
    memory: {
      ...memory(),
      recall: (...args) => {
        localMemoryCalls.push(args)
        return []
      },
    },
    client: {
      chat: async (requestData) => {
        localCalls.push(requestData)
        return response('本轮视觉回答')
      },
    },
  })
  const localResult = await localBrain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: state(),
    userText: '你再仔细看看',
    image: { dataUrl: pawDataUrl },
    visualContext: { source: 'recent-visual-recall' },
  })
  assert.equal(localResult.reasoning.effort, 'medium')
  assert.equal(localCalls.length, 1)
  assert.equal(localCalls[0].maxTokens, 768)
  assert.equal(localMemoryCalls[0][2].bumpHits, false)
  assert.match(localCalls[0].messages[0].content, /RECENT_VISUAL_RECALL/u)
  assert.equal(localCalls[0].messages.at(-1).content.filter(({ type }) => type === 'image_url').length, 1)
  console.log('RECALLED_VISION_REASONING=medium')
  console.log('VISUAL_MEMORY_READ_ONLY=PASS')
  console.log('MODEL_INFERENCES_PER_CHAT=1')
} finally {
  restarted?.close()
  runtime?.close()
  await rm(root, { recursive: true, force: true })
}

console.log('FINAL_STATUS=VC_AI_PET_RECENT_VISUAL_RECALL_PASS')
