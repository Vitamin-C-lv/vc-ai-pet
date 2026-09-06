import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'

const IMAGE_A = 'data:image/png;base64,QUFB'
const IMAGE_B = 'data:image/png;base64,QkJC'

async function runTurn(runtime, userText, attachmentId = null) {
  const started = runtime.startChatTurn({ userText, attachmentId })
  let poll = null
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  return poll
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-followup-runtime-'))
const runtime = new PetRuntime({ sandboxRoot: root })
await runtime.initialize()

const store = runtime.conversationStore
const attFig = await store.saveAttachment({ image: { dataUrl: IMAGE_A }, thumbnail: { dataUrl: IMAGE_A }, width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })
const attShinchan = await store.saveAttachment({ image: { dataUrl: IMAGE_B }, thumbnail: { dataUrl: IMAGE_B }, width: 64, height: 64, thumbnailWidth: 64, thumbnailHeight: 64, requireThumbnail: true })

const visualCalls = []
runtime.brain = {
  visualStep: async () => { visualCalls.push(1); return { ok: true, observation: '看到了。', action: 'answer', nextVisualId: '', focus: '', replyMessages: ['花花看到了。'] } },
  reply: async () => ({ ok: true, text: '这是普通文字回答。', replyMessages: ['这是普通文字回答。'] }),
}

// Deterministic stub resolver: matched only for queries carrying the content word.
function stubWinner(attachmentId) {
  return { status: 'matched', candidates: [{ experienceId: 'e-1', attachmentId, sourceMessageId: 'm-1', userText: 'x', occurredAt: 1, score: 9, provenanceHints: { userTextTermMatches: 0, observationTermMatches: 3 } }], winner: { experienceId: 'e-1', attachmentId, sourceMessageId: 'm-1', userText: 'x', occurredAt: 1, score: 9, provenanceHints: {} } }
}
const stubResolve = async (query) => {
  if (/无花果/.test(query)) return stubWinner(attFig.id)
  if (/蜡笔小新/.test(query)) return stubWinner(attShinchan.id)
  return { status: 'none', candidates: [], winner: null }
}
runtime.longTermVisualResolver = { resolve: stubResolve }
runtime.turnOrchestrator.longTermResolver = { resolve: stubResolve }

// Full long-term trigger → visual turn (matched) → context cleared after.
const q1 = await runTurn(runtime, '你记得我之前给你发的那盆无花果吗')
assert.equal(q1?.status, 'done')
assert.equal(visualCalls.length, 1, 'full long-term query must run Vision')
assert.equal(runtime.turnOrchestrator.recallContextActive(), false, 'matched recall clears context')

// Prime ambiguous recall context, then refine follow-up inherits it.
runtime.turnOrchestrator.recallContext.record({ mode: 'visual_recall_ambiguous', query: '你记得我之前给你发的那盆无花果吗', result: { status: 'ambiguous', candidates: [], winner: null } })
const q2 = await runTurn(runtime, '有很多无花果')
assert.equal(q2?.status, 'done')
assert.equal(visualCalls.length, 2, 'refine follow-up must re-run long-term Vision')
assert.equal(q2.events.some((event) => event.type === 'visual_recall'), true, 'follow-up must produce visual_recall event')
console.log('FOLLOWUP_MORE_FIGS=PASS')

// topic-shift follow-up ("那蜡笔小新呢") inside active recall context.
runtime.turnOrchestrator.recallContext.record({ mode: 'visual_recall_ambiguous', query: '你记得我之前给你发的那盆无花果吗', result: { status: 'ambiguous', candidates: [], winner: null } })
const q3 = await runTurn(runtime, '那蜡笔小新呢')
assert.equal(q3?.status, 'done')
assert.equal(visualCalls.length, 3, 'topic-shift follow-up must enter long-term Vision')
console.log('FOLLOWUP_SHINCHAN=PASS')

// Unrelated short follow-up with no candidate match must fall back to text (no Vision).
runtime.turnOrchestrator.recallContext.record({ mode: 'visual_recall_ambiguous', query: '你记得我之前给你发的那盆无花果吗', result: { status: 'ambiguous', candidates: [], winner: null } })
const q4 = await runTurn(runtime, '那晚饭呢')
assert.equal(q4?.status, 'done')
assert.equal(visualCalls.length, 3, 'unrelated short follow-up must NOT run Vision')
assert.equal(q4.events.some((event) => event.type === 'visual_recall'), false)
console.log('UNRELATED_SHORT_FOLLOWUP=PASS')

// Ordinary greeting never triggers Vision.
const q5 = await runTurn(runtime, '花花你好')
assert.equal(q5?.status, 'done')
assert.equal(visualCalls.length, 3, 'greeting must never run Vision')
console.log('GREETING_ZERO_VISION=PASS')

runtime.close()
await rm(root, { recursive: true, force: true })

console.log('VISUAL_RECALL_FOLLOWUP_RUNTIME=PASS')
