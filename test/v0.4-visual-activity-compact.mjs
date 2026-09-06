import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { ConversationStore } from '../src/conversation/conversation-store.js'
import { PetTurnEvents } from '../src/runtime/pet-turn-events.js'
import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'
import { VisualWorkingSession } from '../src/vision/visual-working-session.js'
import { visualTermsFor } from '../src/vision/visual-keywords.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-activity-compact-'))
const image = 'data:image/png;base64,QUFB'
const conversationStore = new ConversationStore(root, {
  idFactory: (() => { let n = 0; return () => `message-${++n}` })(),
})
const experienceStore = new VisualExperienceStore(root, {
  idFactory: (() => { let n = 0; return () => `experience-${++n}` })(),
})
await conversationStore.initialize()
await experienceStore.initialize()

async function saveImage(text) {
  const attachment = await conversationStore.saveAttachment({
    image: { dataUrl: image },
    thumbnail: { dataUrl: image },
    width: 64,
    height: 64,
    thumbnailWidth: 64,
    thumbnailHeight: 64,
    requireThumbnail: true,
  })
  const message = await conversationStore.appendMessage({ role: 'user', text, attachment })
  await experienceStore.syncMessage(message, { tokenizeText: (value) => visualTermsFor(value, { boost: 3 }) })
  return attachment
}

async function runSession({ candidatePool, firstVisualId, steps, comparison = false, turnId }) {
  const events = new PetTurnEvents({ turnId })
  let stepIndex = 0
  const result = await new VisualWorkingSession({
    turnId,
    userText: '你记得之前那盆无花果吗？',
    candidatePool,
    comparison,
    comparisonPair: comparison ? candidatePool.map(({ visualId, attachmentId }) => ({ visualId, attachmentId })) : [],
    conversationStore,
    brain: { async visualStep() { return steps[stepIndex++] } },
    emit: (type, payload) => events.emit(type, payload),
    experienceStore,
  }).run(firstVisualId)
  return { result, events: events.events }
}

// J1/J2: recalled observations are compact in the public trace, while the
// complete inferred observation remains in VisualExperienceStore.
const recalledAttachment = await saveImage('以前的无花果照片')
const recalledExperience = await experienceStore.findExperienceByAttachmentId(recalledAttachment.id)
const recalledSummary = '这是以前那盆无花果，画面中书架上还有一本蓝色的书。'
const recalled = await runSession({
  turnId: 'turn-recalled-compact',
  candidatePool: [{ visualId: 'V0', attachmentId: recalledAttachment.id, relation: 'recalled' }],
  firstVisualId: 'V0',
  steps: [{ ok: true, observation: recalledSummary, action: 'answer', nextVisualId: '', focus: '无花果', replyMessages: ['我记得这盆无花果。', '书架上那本书也看到了。', '这是第三条重复观察。'] }],
})
assert.equal(recalled.result.ok, true)
assert.equal(recalled.result.final.replyMessages.length, 1)
const recalledActivities = (await conversationStore.listForRecentVisualRecall()).filter((message) => message.turnId === 'turn-recalled-compact' && message.kind === 'activity')
assert.deepEqual(recalledActivities.map((message) => message.text), ['↩️ 花花翻到以前的一张照片', '👀 花花重新看了看'])
assert.equal(recalledActivities.some((message) => /书架上|这是|画面中/u.test(message.text)), false)
assert.equal(recalled.events.some((event) => event.type === 'visual_observation' && event.payload.summary === '👀 花花重新看了看'), true)
const recalledObservations = await experienceStore.recentObservationsFor(recalledExperience.experienceId, { limit: 10 })
assert.equal(recalledObservations.some((event) => event.evidence === 'inferred' && event.summary === recalledSummary), true)
console.log('J1_RECALLED_ACTIVITY_COMPACT=PASS')
console.log('J2_RECALLED_FINAL_COMPACT=PASS')

// K3: ordinary visual observations keep both their persisted summary and the
// old public "看到：" activity wording.
const currentAttachment = await saveImage('当前无花果照片')
const currentExperience = await experienceStore.findExperienceByAttachmentId(currentAttachment.id)
const currentSummary = '当前照片里有一盆无花果。'
const current = await runSession({
  turnId: 'turn-current-baseline',
  candidatePool: [{ visualId: 'V0', attachmentId: currentAttachment.id, relation: 'current' }],
  firstVisualId: 'V0',
  steps: [{ ok: true, observation: currentSummary, action: 'answer', nextVisualId: '', focus: '无花果', replyMessages: ['当前看到了。'] }],
})
assert.equal(current.result.ok, true)
const currentActivities = (await conversationStore.listForRecentVisualRecall()).filter((message) => message.turnId === 'turn-current-baseline' && message.activityType === 'visual_observation')
assert.deepEqual(currentActivities.map((message) => message.text), [`看到：${currentSummary}`])
const currentObservations = await experienceStore.recentObservationsFor(currentExperience.experienceId, { limit: 10 })
assert.equal(currentObservations.some((event) => event.evidence === 'inferred' && event.summary === currentSummary), true)
console.log('K3_ORDINARY_VISUAL_UNCHANGED=PASS')

await rm(root, { recursive: true, force: true })
console.log('VISUAL_ACTIVITY_COMPACT=PASS')
