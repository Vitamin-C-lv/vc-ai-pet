import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { RecentVisualResolver } from '../src/conversation/recent-visual-context.js'
import { PetTurnEvents } from '../src/runtime/pet-turn-events.js'
import { PetTurnOrchestrator } from '../src/runtime/pet-turn-orchestrator.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'
import { visualTermsFor } from '../src/vision/visual-keywords.js'
import { LongTermVisualResolver, detectLongTermVisualIntent } from '../src/vision/long-term-visual-recall.js'
import { VisualWorkingSession } from '../src/vision/visual-working-session.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-memory-orchestrator-'))
const imageA = 'data:image/png;base64,QUFB'
const imageB = 'data:image/png;base64,QkJC'
const tokenizeUserText = (text) => visualTermsFor(text, { boost: 3 })
const store = new ConversationStore(root, {
  idFactory: (() => { let n = 0; return () => `message-${++n}` })(),
})
const experienceStore = new VisualExperienceStore(root, {
  idFactory: (() => { let n = 0; return () => `experience-${++n}` })(),
})
await store.initialize()
await experienceStore.initialize()

async function saveImage(image, text) {
  const attachment = await store.saveAttachment({
    image: { dataUrl: image },
    thumbnail: { dataUrl: image },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
  })
  const message = await store.appendMessage({ role: 'user', text, attachment })
  await experienceStore.syncMessage(message, { tokenizeText: tokenizeUserText })
  return { attachment, message }
}

// Keep the historical root outside the ten-image Recent Visual window.
const historical = await saveImage(imageA, '以前那盆植物照片')
for (let index = 0; index < 10; index += 1) await saveImage(imageB, `普通记录 ${index + 1}`)
const historicalExperience = await experienceStore.findExperienceByAttachmentId(historical.attachment.id)
assert.ok(historicalExperience)
await experienceStore.recordEvent({
  experienceId: historicalExperience.experienceId,
  kind: 'observation',
  summary: '蘑菇',
  evidence: 'inferred',
  terms: visualTermsFor('蘑菇'),
})

function makeRuntime(calls, observation = '原图里是一盆绿色植物。') {
  return {
    conversationStore: store,
    conversation: { append() {} },
    memory: { recall() { return [] } },
    brain: {
      async visualStep() {
        calls.push(arguments[0])
        return { ok: true, observation, action: 'answer', nextVisualId: '', focus: '植物', replyMessages: ['花花重新确认到了。'] }
      },
    },
  }
}

const matchedCalls = []
const matchedEvents = new PetTurnEvents({ turnId: 'turn-long-matched' })
const matchedOrchestrator = new PetTurnOrchestrator({
  runtime: makeRuntime(matchedCalls),
  resolver: new RecentVisualResolver(),
  longTermResolver: new LongTermVisualResolver({ experienceStore }),
  experienceStore,
  now: () => 1000,
})
const matchedResult = await matchedOrchestrator.runVisual({
  turnId: 'turn-long-matched',
  emit: (type, payload) => matchedEvents.emit(type, payload),
  userText: '以前那盆植物',
  attachment: null,
})
assert.equal(matchedResult.ok, true)
assert.equal(matchedCalls.length, 1)
const reopened = await store.readAttachmentDataUrl(historical.attachment.id)
assert.equal(matchedCalls[0].image.dataUrl, reopened.dataUrl)
assert.equal(matchedEvents.events.some((event) => event.type === 'visual_recall'), true)
assert.equal((await store.listForRecentVisualRecall()).some((message) => message.activityType === 'visual_recall'), true)
assert.equal((await experienceStore.findExperienceByAttachmentId(historical.attachment.id)).inspectionCount, 1)
const firstObservations = await experienceStore.recentObservationsFor(historicalExperience.experienceId, { limit: 10 })
assert.equal(firstObservations.some((event) => event.kind === 'observation' && event.evidence === 'inferred' && event.summary === '原图里是一盆绿色植物。'), true)

// K: a metadata-only match with no ConversationStore asset must never reach Vision.
const missingCalls = []
const missingOrchestrator = new PetTurnOrchestrator({
  runtime: makeRuntime(missingCalls),
  resolver: new RecentVisualResolver(),
  longTermResolver: { async resolve() { return { status: 'matched', candidates: [], winner: { attachmentId: 'missing-original', userText: '以前那盆植物', occurredAt: 1 } } } },
})
const missingResult = await missingOrchestrator.runVisual({ turnId: 'turn-long-missing', emit: () => {}, userText: '以前那盆植物', attachment: null })
assert.equal(missingCalls.length, 0)
assert.match(missingResult.text, /原图找不到/u)

// D: the stale inferred observation is only retrieval help; the new inspection is authoritative.
const secondCalls = []
const secondResult = await new PetTurnOrchestrator({
  runtime: makeRuntime(secondCalls, '原图里是叶子和花盆，不是蘑菇。'),
  resolver: new RecentVisualResolver(),
  longTermResolver: new LongTermVisualResolver({ experienceStore }),
  experienceStore,
}).runVisual({ turnId: 'turn-long-second-look', emit: () => {}, userText: '以前那盆植物', attachment: null })
assert.equal(secondResult.ok, true)
assert.equal(secondCalls.length, 1)
const allObservations = await experienceStore.recentObservationsFor(historicalExperience.experienceId, { limit: 10 })
assert.equal(allObservations.some((event) => event.summary === '蘑菇'), true)
assert.equal(allObservations.some((event) => event.summary === '原图里是叶子和花盆，不是蘑菇。'), true)

// G: immediate temporal language remains Recent Visual and never calls Long-Term.
await saveImage(imageB, '刚才的图片')
let longTermCalls = 0
const recentCalls = []
const recentOrchestrator = new PetTurnOrchestrator({
  runtime: makeRuntime(recentCalls, '刚才的图片里有植物。'),
  resolver: new RecentVisualResolver(),
  longTermResolver: { async resolve() { longTermCalls += 1; return { status: 'none', candidates: [], winner: null } } },
})
const recentResult = await recentOrchestrator.runVisual({ turnId: 'turn-recent-followup', emit: () => {}, userText: '刚才的面', attachment: null })
assert.equal(recentResult.ok, true)
assert.equal(recentCalls.length, 1)
assert.equal(longTermCalls, 0)

assert.equal(detectLongTermVisualIntent('花花你好'), null)

const ambiguousOrchestrator = new PetTurnOrchestrator({
  runtime: makeRuntime([]),
  resolver: new RecentVisualResolver(),
  longTermResolver: { async resolve() { return { status: 'ambiguous', candidates: [{ score: 2 }, { score: 2 }], winner: null } } },
})
const ambiguousResult = await ambiguousOrchestrator.runVisual({ turnId: 'turn-long-ambiguous', emit: () => {}, userText: '以前那盆植物', attachment: null })
assert.match(ambiguousResult.text, /哪一张/u)

const noneOrchestrator = new PetTurnOrchestrator({
  runtime: makeRuntime([]),
  resolver: new RecentVisualResolver(),
  longTermResolver: { async resolve() { return { status: 'none', candidates: [], winner: null } } },
})
const noneResult = await noneOrchestrator.runVisual({ turnId: 'turn-long-none', emit: () => {}, userText: '以前那盆植物', attachment: null })
assert.match(noneResult.text, /没有找到和这个有关/u)

// A comparison inspection stores a comparison event linked to the other root.
const comparisonA = await saveImage(imageA, '比较植物甲')
const comparisonB = await saveImage(imageB, '比较植物乙')
const comparisonSteps = [
  { ok: true, observation: '甲有绿叶。', action: 'inspect', nextVisualId: 'V1', focus: '', replyMessages: [] },
  { ok: true, observation: '乙有花盆。', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['看完两张啦。'] },
]
const comparisonResult = await new VisualWorkingSession({
  turnId: 'turn-comparison-events',
  userText: '比较两张植物',
  candidatePool: [
    { visualId: 'V0', attachmentId: comparisonA.attachment.id, relation: 'current' },
    { visualId: 'V1', attachmentId: comparisonB.attachment.id, relation: 'previous' },
  ],
  comparison: true,
  comparisonPair: [
    { visualId: 'V0', attachmentId: comparisonA.attachment.id },
    { visualId: 'V1', attachmentId: comparisonB.attachment.id },
  ],
  conversationStore: store,
  brain: { async visualStep() { return comparisonSteps.shift() } },
  emit: () => {},
  experienceStore,
}).run('V0')
assert.equal(comparisonResult.ok, true)
const comparisonExperience = await experienceStore.findExperienceByAttachmentId(comparisonB.attachment.id)
const comparisonEvents = await experienceStore.recentObservationsFor(comparisonExperience.experienceId, { limit: 5 })
assert.equal(comparisonEvents.some((event) => event.kind === 'comparison' && event.relatedExperienceId), true)

console.log('VISUAL_MEMORY_ORCHESTRATOR=PASS')
await rm(root, { recursive: true, force: true })
