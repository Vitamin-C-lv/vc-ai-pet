import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { detectLongTermVisualIntent } from '../src/vision/long-term-visual-recall.js'
import { PetTurnOrchestrator } from '../src/runtime/pet-turn-orchestrator.js'
import { detectEllipticalFollowUp, VisualRecallContext } from '../src/runtime/visual-recall-context.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-visual-recall-followup-'))
const messages = []
const attachment = { id: 'fig-attachment', width: 64, height: 64 }
const metadata = { ...attachment }
const fakeStore = {
  async listForRecentVisualRecall() { return messages },
  async appendMessage(message) { messages.push(message); return message },
  async attachment(id) { return id === attachment.id ? metadata : null },
  async readAttachmentDataUrl(id) {
    if (id !== attachment.id) return null
    return { dataUrl: 'data:image/png;base64,QUFB', attachment: metadata }
  },
  publicAttachment(value) { return { id: value.id, width: value.width, height: value.height } },
}

function makeRuntime(calls) {
  return {
    conversationStore: fakeStore,
    conversation: { append() {} },
    memory: { recall() { return [] } },
    brain: {
      async visualStep(request) {
        calls.push(request)
        return { ok: true, observation: '原图里有很多无花果。', action: 'answer', nextVisualId: '', focus: '果实', replyMessages: ['花花重新确认到了。'] }
      },
    },
  }
}

for (const [text, kind] of [
  ['那蜡笔小新呢', 'topic_shift'],
  ['还有那个猫呢', 'topic_shift'],
  ['有很多无花果', 'refine'],
  ['是很多果子的那张', 'refine'],
  ['第一张', 'refine'],
  ['不是这个', 'refine'],
]) assert.equal(detectEllipticalFollowUp(text)?.kind, kind, text)
assert.equal(detectEllipticalFollowUp('花花你好'), null)

let resolverCalls = 0
const resolverQueries = []
const longTermResolver = {
  async resolve(query) {
    resolverCalls += 1
    resolverQueries.push(query)
    return { status: 'ambiguous', candidates: [{ score: 6 }, { score: 6 }], winner: null }
  },
}
const calls = []
const orchestrator = new PetTurnOrchestrator({ runtime: makeRuntime(calls), longTermResolver })

// TEST_F: an ambiguous long-term recall seeds the context; a refine follow-up
// reuses its query and consumes the pre-resolved matched result.
const firstResult = await orchestrator.runVisual({
  turnId: 'turn-followup-q1',
  emit: () => {},
  userText: '你还记得我以前给你看的无花果吗',
  attachment: null,
})
assert.match(firstResult.text, /哪一张/u)
assert.equal(orchestrator.recallContextActive(), true)
assert.equal(resolverCalls, 1)

const refinePlan = orchestrator.planFollowUp('有很多无花果')
assert.equal(refinePlan?.kind, 'refine')
assert.match(refinePlan.query, /有很多无花果/u)
const matchedFollowUp = {
  query: refinePlan.query,
  preResolve: { status: 'matched', candidates: [], winner: { attachmentId: attachment.id, userText: '无花果', occurredAt: 1 } },
}
const followUpResult = await orchestrator.runVisual({
  turnId: 'turn-followup-q2',
  emit: () => {},
  userText: '有很多无花果',
  attachment: null,
  followUp: matchedFollowUp,
})
assert.equal(followUpResult.ok, true)
assert.equal(calls.length, 1)
assert.equal(orchestrator.recallContextActive(), false)
assert.equal(resolverCalls, 1, 'pre-resolved follow-up must skip resolver.resolve')

// TEST_G: a topic shift is rewritten into a complete long-term trigger.
const topicContext = new VisualRecallContext({ now: () => 10 })
const topicOrchestrator = new PetTurnOrchestrator({ runtime: makeRuntime([]), recallContext: topicContext })
topicContext.record({ mode: 'visual_recall_ambiguous', query: '你还记得我以前给你看的无花果吗', result: { status: 'ambiguous' } })
const topicPlan = topicOrchestrator.planFollowUp('那蜡笔小新呢')
assert.equal(topicPlan?.kind, 'topic_shift')
assert.match(topicPlan.query, /蜡笔小新/u)
assert.deepEqual(detectLongTermVisualIntent(topicPlan.query), { mode: 'long-term-visual' })

// TEST_H: no active context cannot route the ordinary short question. With an
// active context, the rewrite has no visual cue; the runtime gate must reject it.
const noContextOrchestrator = new PetTurnOrchestrator({ runtime: makeRuntime([]) })
assert.equal(noContextOrchestrator.planFollowUp('那晚饭呢'), null)
topicContext.record({ mode: 'visual_recall_ambiguous', query: '你还记得我以前给你看的无花果吗', result: { status: 'ambiguous' } })
const dinnerPlan = topicOrchestrator.planFollowUp('那晚饭呢')
assert.equal(dinnerPlan?.kind, 'topic_shift')
assert.match(dinnerPlan.query, /晚饭/u)
assert.doesNotMatch(dinnerPlan.query, /(?:照片|图片|植物|猫|狗|花|宠物|截图|那张|那盆|那碗|那盘|那棵|那只)/u)
const dinnerResult = await topicOrchestrator.runVisual({
  turnId: 'turn-followup-dinner',
  emit: () => {},
  userText: '那晚饭呢',
  attachment: null,
  followUp: { query: dinnerPlan.query, preResolve: { status: 'none', candidates: [], winner: null } },
})
assert.match(dinnerResult.text, /没有找到和这个有关/u)
assert.equal(topicOrchestrator.recallContextActive(), false)
topicOrchestrator.clearVisualRecallContext()
assert.equal(topicOrchestrator.planFollowUp('那晚饭呢'), null)

// Lifecycle: TTL, maxUses, and explicit clear all disable planning.
let clock = 0
const lifecycleContext = new VisualRecallContext({ now: () => clock, ttlMs: 100, maxUses: 3 })
const lifecycleOrchestrator = new PetTurnOrchestrator({ runtime: makeRuntime([]), recallContext: lifecycleContext })
lifecycleContext.record({ mode: 'visual_recall_ambiguous', query: '你还记得以前那盆植物吗', result: { status: 'ambiguous' } })
clock = 101
assert.equal(lifecycleOrchestrator.planFollowUp('第一张'), null)

clock = 0
lifecycleContext.record({ mode: 'visual_recall_ambiguous', query: '你还记得以前那盆植物吗', result: { status: 'ambiguous' } })
for (let index = 0; index < 3; index += 1) assert.ok(lifecycleContext.consume('第一张'))
assert.equal(lifecycleOrchestrator.planFollowUp('第一张'), null)

lifecycleContext.record({ mode: 'visual_recall_ambiguous', query: '你还记得以前那盆植物吗', result: { status: 'ambiguous' } })
lifecycleOrchestrator.clearVisualRecallContext()
assert.equal(lifecycleOrchestrator.planFollowUp('第一张'), null)

console.log('VISUAL_RECALL_FOLLOWUP=PASS')
await rm(root, { recursive: true, force: true })
