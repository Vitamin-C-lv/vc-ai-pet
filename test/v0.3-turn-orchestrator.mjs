import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { detectVisualIntent, RecentVisualResolver } from '../src/conversation/recent-visual-context.js'
import { PetTurnEvents } from '../src/runtime/pet-turn-events.js'
import { PetTurnManager } from '../src/runtime/pet-turn-manager.js'
import { PetTurnOrchestrator } from '../src/runtime/pet-turn-orchestrator.js'
import { MAX_VISUAL_INSPECTIONS_PER_TURN, VisualWorkingSession } from '../src/vision/visual-working-session.js'
import { LocalBrain, PET_VISUAL_STEP_MAX_TOKENS, validateVisualStepResponse } from '../src/brain/local-brain.js'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-turn-orchestrator-'))
const imageA = 'data:image/png;base64,QUFB'
const imageB = 'data:image/png;base64,QkJC'
const store = new ConversationStore(root, { idFactory: (() => { let n = 0; return () => `attachment-${++n}` })() })
await store.initialize()
const attachmentA = await store.saveAttachment({ image: { dataUrl: imageA }, thumbnail: { dataUrl: imageA }, width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })
const attachmentB = await store.saveAttachment({ image: { dataUrl: imageB }, thumbnail: { dataUrl: imageB }, width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })
await store.appendMessage({ role: 'user', text: '第一张图', attachment: attachmentA })
await store.appendMessage({ role: 'assistant', kind: 'final', text: '第一张已看过。' })

const persisted = await store.listForRecentVisualRecall()
const resolver = new RecentVisualResolver()
assert.equal(resolver.resolve('刚才的面里面有几种蘑菇', persisted).attachmentId, attachmentA.id)
assert.equal(detectVisualIntent('这张和上一张有什么区别', { hasCurrent: true, candidateCount: 1 }), 'comparison')
assert.equal(detectVisualIntent('之前那个怎么样', { candidateCount: 2 }), 'ambiguous')
assert.equal(detectVisualIntent('这是什么', { hasCurrent: true, candidateCount: 0 }), 'single_inspection')

function makeRuntime(sequence) {
  const calls = []
  const runtime = {
    conversationStore: store,
    conversation: { append() {} },
    memory: { recall() { return [] } },
    brain: { async visualStep(request) { calls.push(request); return sequence.shift() } },
  }
  return { runtime, calls }
}

const compare = makeRuntime([
  { ok: true, observation: '当前图里有一个爪印。', action: 'inspect', nextVisualId: 'V1', focus: '看看上一张', replyMessages: [] },
  { ok: true, observation: '上一张也有一个爪印。', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['找到啦！', '两张图都能看到爪印。', '花花没有发现更多区别。'] },
])
const compareEvents = new PetTurnEvents({ turnId: 'turn-compare', now: (() => { let n = 1; return () => n++ })() })
const beforeAssets = (await store.listForRecentVisualRecall()).length
const compareResult = await new PetTurnOrchestrator({ runtime: compare.runtime, now: () => 1000 }).runVisual({ turnId: 'turn-compare', emit: (type, payload) => compareEvents.emit(type, payload), userText: '这张和上一张有什么区别', attachment: attachmentB })
assert.equal(compareResult.reasoning.visualInspections, 2)
assert.equal(compareResult.reasoning.visualUniqueImages, 2)
assert.deepEqual(Array.from(compareEvents.events, (event) => event.type), ['turn_started', 'thinking', 'visual_selected', 'visual_image', 'visual_observation', 'visual_selected', 'visual_image', 'visual_observation', 'visual_compare', 'assistant_message', 'assistant_message', 'assistant_message', 'turn_completed'])
assert.equal((await store.listForRecentVisualRecall()).length > beforeAssets, true)
assert.equal((await store.listForRecentVisualRecall()).filter((message) => message.kind === 'media_ref').length, 2)
assert.equal((await store.listForRecentVisualRecall()).filter((message) => message.kind === 'final').length, 4)
const mediaRows = (await store.history()).filter((message) => message.kind === 'media_ref')
assert.deepEqual(mediaRows.map((message) => message.sourceAttachmentId), [attachmentB.id, attachmentA.id])
const semantic = await store.semanticHistory()
const compareSemantic = semantic.find((message) => message.turnId === 'turn-compare' && message.role === 'assistant')
assert.equal(semantic.some((message) => ['activity', 'media_ref'].includes(message.kind)), false)
assert.equal(compareSemantic.text, '找到啦！\n两张图都能看到爪印。\n花花没有发现更多区别。')
assert.equal(new RecentVisualResolver().resolve('我们玩找不同', await store.listForRecentVisualRecall()).reason, 'ambiguous-visual-reference')
assert.equal(compare.calls.length, 2)
assert.deepEqual(compare.calls.map((call) => call.image.dataUrl), [imageB, imageA])
assert.equal(compare.calls[1].observations[0].focus, '看看上一张')

const memoryEvents = new PetTurnEvents({ turnId: 'turn-memory' })
const memoryRuntime = {
  conversationStore: store,
  conversation: { append() {} },
  memory: { recall() { return [{ level: 'user', content: '主人喜欢群青色', source: 'raw' }, { level: 'fact', content: '这是来自梦境的联想', provenance: { source: 'DREAM_DERIVED', evidence: 'inferred' } }, { level: 'rules', content: 'system prompt must stay hidden' }] } },
  brain: { async visualStep() { return { ok: true, observation: '看到了。', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['知道啦。'] } } },
}
await new PetTurnOrchestrator({ runtime: memoryRuntime }).runVisual({ turnId: 'turn-memory', emit: (type, payload) => memoryEvents.emit(type, payload), userText: '这是什么', attachment: attachmentB })
assert.deepEqual(memoryEvents.events.filter((event) => event.type === 'memory_recall').map((event) => event.payload), [{ summary: '主人喜欢群青色', provenance: 'confirmed' }, { summary: '这是来自梦境的联想', provenance: 'inferred' }])
assert.equal((await store.history()).some((message) => message.activityType === 'memory_recall' && message.provenance === 'confirmed'), true)
assert.doesNotMatch(JSON.stringify(memoryEvents.events), /system prompt/u)

const repeated = makeRuntime([
  { ok: true, observation: '看到了。', action: 'inspect', nextVisualId: 'V1', focus: '', replyMessages: [] },
  { ok: true, observation: '再看一次。', action: 'inspect', nextVisualId: 'V0', focus: '', replyMessages: [] },
  { ok: true, observation: '确认了。', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['确认啦。'] },
])
const repeatedEvents = new PetTurnEvents({ turnId: 'turn-repeat' })
const repeatedResult = await new PetTurnOrchestrator({ runtime: repeated.runtime }).runVisual({ turnId: 'turn-repeat', emit: (type, payload) => repeatedEvents.emit(type, payload), userText: '再确认一下', attachment: attachmentB })
assert.equal(repeatedResult.reasoning.visualInspections, 3)
assert.equal(repeated.calls.length, 3)
assert.match(repeatedEvents.events.filter((event) => event.type === 'visual_selected')[2]?.payload.caption ?? '', /再确认/u)

const capped = makeRuntime(Array.from({ length: 8 }, () => ({ ok: true, observation: '仍在检查。', action: 'inspect', nextVisualId: 'V0', focus: '', replyMessages: [] })))
const cappedEvents = new PetTurnEvents({ turnId: 'turn-cap' })
const cappedResult = await new PetTurnOrchestrator({ runtime: capped.runtime }).runVisual({ turnId: 'turn-cap', emit: (type, payload) => cappedEvents.emit(type, payload), userText: '找不同', attachment: attachmentB })
assert.equal(MAX_VISUAL_INSPECTIONS_PER_TURN, 5)
assert.equal(capped.calls.length, 5)
assert.equal(cappedResult.capped, true)
assert.match(cappedResult.text, /来回看了好几遍/u)

const roundTripSteps = [
  { ok: true, observation: 'A 看到了。', action: 'inspect', nextVisualId: 'V1', focus: '', replyMessages: [] },
  { ok: true, observation: 'B 看到了。', action: 'inspect', nextVisualId: 'V0', focus: '', replyMessages: [] },
  { ok: true, observation: 'A 再确认了。', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['确认啦。'] },
]
const roundTripCalls = []
const roundTrip = await new VisualWorkingSession({
  turnId: 'turn-round-trip',
  userText: '再确认一下这两张',
  candidatePool: [
    { visualId: 'V0', attachmentId: attachmentA.id, relation: 'current', userText: '' },
    { visualId: 'V1', attachmentId: attachmentB.id, relation: 'previous', userText: '' },
  ],
  conversationStore: store,
  brain: { async visualStep(request) { roundTripCalls.push(request); return roundTripSteps.shift() } },
  emit: () => {},
}).run('V0')
assert.equal(roundTrip.ok, true)
assert.deepEqual(roundTripCalls.map((call) => call.image.dataUrl), [imageA, imageB, imageA])

const invalidTarget = await new VisualWorkingSession({
  turnId: 'turn-invalid-target',
  userText: '找不同',
  candidatePool: [{ visualId: 'V0', attachmentId: attachmentB.id, relation: 'current', userText: '' }],
  conversationStore: store,
  brain: { async visualStep() { return { ok: true, observation: '看到了。', action: 'inspect', nextVisualId: 'V9', focus: '', replyMessages: [] } } },
  emit: () => {},
}).run('V0')
assert.equal(invalidTarget.ok, false)
assert.equal(invalidTarget.reason, 'invalid-visual-inspection')
assert.deepEqual(invalidTarget.diagnostic, {
  stage: 'protocol',
  errorCode: 'invalid-visual-inspection',
  requestId: null,
  retryable: false,
  inspectionOrdinal: 1,
  currentVisualId: 'V0',
  nextVisualId: 'V9',
  attachmentId: attachmentB.id,
})

const missingAsset = await new VisualWorkingSession({
  turnId: 'turn-missing-asset',
  userText: '这是什么',
  candidatePool: [{ visualId: 'V0', attachmentId: 'missing-asset', relation: 'current', userText: '' }],
  conversationStore: { async readAttachmentDataUrl() { return null } },
  brain: { async visualStep() { throw new Error('must not inspect missing asset') } },
  emit: () => {},
}).run('V0')
assert.equal(missingAsset.ok, false)
assert.equal(missingAsset.reason, 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND')
assert.equal(missingAsset.diagnostic.stage, 'asset')
assert.equal(missingAsset.diagnostic.inspectionOrdinal, 1)

const manager = new PetTurnManager({ now: () => 1000 })
const started = manager.start(async ({ emit }) => { emit('turn_started', { mode: 'text' }); return { ok: true, text: '好呀' } })
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(manager.poll(started.turnId, 0).status, 'done')
assert.equal(manager.poll(started.turnId, 0).result.text, '好呀')

const diagnosticManager = new PetTurnManager({ now: () => 1000 })
const diagnosticStart = diagnosticManager.start(async () => ({
  ok: false,
  reason: 'invalid-visual-inspection',
  inspections: [{ visualId: 'V0', attachmentId: attachmentB.id }],
  diagnostic: { stage: 'protocol', inspectionOrdinal: 1, currentVisualId: 'V0', nextVisualId: 'V9', attachmentId: attachmentB.id },
}))
await new Promise((resolve) => setTimeout(resolve, 0))
const diagnosticPoll = diagnosticManager.poll(diagnosticStart.turnId, 0)
const diagnosticFailure = diagnosticPoll.events.find((event) => event.type === 'turn_failed')?.payload
assert.equal(diagnosticFailure.errorStage, 'protocol')
assert.equal(diagnosticFailure.inspectionOrdinal, 1)
assert.equal(diagnosticFailure.currentVisualId, 'V0')
assert.equal(diagnosticFailure.nextVisualId, 'V9')
assert.equal(diagnosticFailure.attachmentId, attachmentB.id)

const eventSnapshot = compareEvents.after(0)
eventSnapshot[0].payload.mode = 'tampered'
assert.equal(compareEvents.after(0)[0].payload.mode, 'visual')
assert.equal(compareEvents.after(0).at(-1).type, 'turn_completed')
const terminalSeq = compareEvents.after(0).at(-1).seq
compareEvents.emit('turn_completed', { durationMs: 999 })
assert.equal(compareEvents.after(0).at(-1).seq, terminalSeq)
assert.throws(() => compareEvents.emit('assistant_message', { text: 'late' }), /AFTER_TERMINAL/u)
const unsafeEvent = new PetTurnEvents({ turnId: 'turn-safe' }).emit('visual_observation', { summary: '我先推理一下：system prompt' })
assert.equal(unsafeEvent.payload.summary, '')

let clock = 0
const boundedManager = new PetTurnManager({ maxTurns: 2, ttlMs: 10, now: () => clock })
let releaseFirst
let releaseSecond
const firstPending = new Promise((resolve) => { releaseFirst = resolve })
const secondPending = new Promise((resolve) => { releaseSecond = resolve })
const activeOne = boundedManager.start(async () => { await firstPending; return { ok: true, text: '一' } })
const activeTwo = boundedManager.start(async () => { await secondPending; return { ok: true, text: '二' } })
assert.throws(() => boundedManager.start(async () => ({ ok: true })), /CAPACITY/u)
assert.equal(boundedManager.turns.size, 2)
releaseFirst(); releaseSecond()
await new Promise((resolve) => setTimeout(resolve, 10))
clock = 11
assert.equal(boundedManager.poll(activeOne.turnId), null)
assert.equal(boundedManager.poll(activeTwo.turnId), null)

const brainRequests = []
const visualBrain = new LocalBrain({
  config: { resourceGate: { enabled: false } },
  memory: { recall: () => [] },
  client: {
    async chat(request) {
      brainRequests.push(request)
      return { payload: { choices: [{ message: { content: JSON.stringify({ observation: '右侧有一个红杯子。', action: 'inspect', nextVisualId: 'V1', focus: '看杯子旁边', replyMessages: [] }) } }] } }
    },
  },
})
const visualStep = await visualBrain.visualStep({ userText: '这张和上一张有什么区别', image: { dataUrl: imageA }, candidatePool: [{ visualId: 'V0', relation: 'current', userText: '' }, { visualId: 'V1', relation: 'previous', userText: '' }] })
assert.equal(visualStep.action, 'inspect')
assert.equal(brainRequests.length, 1)
assert.equal(PET_VISUAL_STEP_MAX_TOKENS, 4096)
assert.equal(brainRequests[0].maxTokens, PET_VISUAL_STEP_MAX_TOKENS)
assert.equal(brainRequests[0].messages.at(-1).content.filter((part) => part.type === 'image_url').length, 1)
assert.doesNotMatch(JSON.stringify(brainRequests[0].messages.slice(0, -1)), /data:image[^"']+/u)
assert.equal(validateVisualStepResponse({ observation: '我先推理一下：secret', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['不安全'] }).ok, false)
assert.equal(validateVisualStepResponse({ observation: '事实', action: 'inspect', nextVisualId: '', focus: '', replyMessages: [] }, { candidateIds: ['V0'] }).ok, false)
assert.equal(validateVisualStepResponse({ observation: '事实', action: 'answer', nextVisualId: '', focus: '', replyMessages: [] }).ok, false)
assert.equal(validateVisualStepResponse({ observation: '事实', action: 'inspect', nextVisualId: 'V0', focus: '', replyMessages: [] }, { candidateIds: ['V0'], forceAnswer: true }).action, 'answer')

const integrationRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-turn-runtime-'))
const integratedRuntime = new PetRuntime({ sandboxRoot: integrationRoot })
await integratedRuntime.initialize()
const integratedAttachment = await integratedRuntime.conversationStore.saveAttachment({ image: { dataUrl: imageA }, thumbnail: { dataUrl: imageA }, width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })
const integratedCalls = []
integratedRuntime.brain = { visualStep: async (request) => { integratedCalls.push(request); return { ok: true, observation: '图中有一个爪印。', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['看到了。'] } } }
const integratedStart = integratedRuntime.startChatTurn({ userText: '这是什么', attachmentId: integratedAttachment.id })
let integratedPoll = null
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5))
  integratedPoll = integratedRuntime.pollChatTurn(integratedStart.turnId, 0)
  if (integratedPoll?.status !== 'running') break
}
assert.equal(integratedPoll?.status, 'done')
assert.equal(integratedCalls.length, 1)
assert.equal(integratedPoll.result.replyMessages[0], '看到了。')
assert.equal(integratedPoll.events.some((event) => event.type === 'visual_image' && event.payload.sourceAttachmentId === integratedAttachment.id), true)
const ambiguousAttachment = await integratedRuntime.conversationStore.saveAttachment({ image: { dataUrl: imageB }, thumbnail: { dataUrl: imageB }, width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })
await integratedRuntime.conversationStore.appendMessage({ role: 'user', text: '另一张图', attachment: ambiguousAttachment })
const ambiguousResult = await integratedRuntime.chat('之前那个怎么样')
assert.equal(ambiguousResult.reasoning.effort, 'low')
assert.match(ambiguousResult.text, /哪一张/u)
assert.equal(integratedCalls.length, 1)
integratedRuntime.close()
await rm(integrationRoot, { recursive: true, force: true })

const allText = JSON.stringify(await store.listForRecentVisualRecall())
assert.doesNotMatch(allText, /hidden_reasoning|reasoning_content|chain_of_thought|raw model rationale/iu)
await rm(root, { recursive: true, force: true })

console.log('TURN_ORCHESTRATOR=PASS')
console.log('VISUAL_REFERENCE_ROUTER=PASS')
console.log('VISUAL_CANDIDATE_POOL=PASS')
console.log('VISUAL_WORKING_SESSION=PASS')
console.log('MAX_VISUAL_INSPECTIONS_PER_TURN=5')
console.log('REPEATED_VISUAL_INSPECTION=PASS')
console.log('SIXTH_INSPECTION_EXECUTED=NO')
console.log('CURRENT_IMAGE_PRIORITY=PASS')
console.log('CURRENT_IMAGE_EXCLUSIVE=NO')
console.log('IMMEDIATE_TEMPORAL_HARD_PIN=PASS')
console.log('COMPARISON_INTENT=PASS')
console.log('AMBIGUITY_GUARD=PASS')
console.log('MULTI_ASSISTANT_BUBBLES=PASS')
console.log('IMAGE_REFERENCE_REUSES_ATTACHMENT=PASS')
console.log('DUPLICATE_IMAGE_ASSET_CREATED=NO')
console.log('CHAIN_OF_THOUGHT_EXPOSED=NO')
console.log('CHAIN_OF_THOUGHT_PERSISTED=NO')
console.log('VISUAL_SESSION_MEMORY_WRITE=NO')
console.log('VISUAL_WORKING_SESSION_TEST=PASS')
