import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetRuntime } from '../src/runtime/pet-runtime.js'

const IMAGE_FIG = 'data:image/png;base64,RklH'
const IMAGE_BOILERPLATE = 'data:image/png;base64,Qk9JTA=='

function visualStepAnswer(observation = '看到了一盆无花果。', reply = '那是一盆无花果，花花重新看过了。') {
  return () => ({ ok: true, observation, action: 'answer', nextVisualId: '', focus: '', replyMessages: [reply] })
}

function fakeVisualBrain(calls, step) {
  return {
    visualStep: async (request) => { calls.push(request); return step(request, calls.length) },
    reply: async () => ({ ok: true, text: '你好呀主人。', replyMessages: ['你好呀主人。'] }),
  }
}

async function saveImage(store, dataUrl, width = 64, height = 64) {
  return store.saveAttachment({ image: { dataUrl }, thumbnail: { dataUrl }, width, height, thumbnailWidth: width, thumbnailHeight: height, requireThumbnail: true })
}

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

const roots = []

{
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-routing-1.2-'))
  roots.push(root)
  const runtime = new PetRuntime({ sandboxRoot: root })
  await runtime.initialize()
  const calls = []
  runtime.brain = fakeVisualBrain(calls, visualStepAnswer())
  const store = runtime.conversationStore

  // Long-term fig experience (old timestamp, outside the 10-image recent window).
  const fig = await saveImage(store, IMAGE_FIG)
  await store.appendMessage({ role: 'user', text: '你看，无花果到了', attachment: fig, timestamp: 1000 })

  // Fill the recent window with generic-boilerplate image turns. One of them
  // shares the routing boilerplate (给你/你发/一张图片) that previously made the
  // recent resolver short-circuit a long-term query.
  for (let index = 0; index < 11; index += 1) {
    const image = await saveImage(store, IMAGE_BOILERPLATE)
    await store.appendMessage({
      role: 'user',
      text: index === 5 ? '我们来玩找不同吧，我先给你发一张图片' : `找不同第 ${index} 张图`,
      attachment: image,
      timestamp: 2000 + index,
    })
  }

  const figDataUrl = (await store.readAttachmentDataUrl(fig.id)).dataUrl

  let longTermSearches = 0
  const searchByTerms = runtime.visualExperience.searchByTerms.bind(runtime.visualExperience)
  runtime.visualExperience.searchByTerms = async (...args) => { longTermSearches += 1; return searchByTerms(...args) }

  const turn = await runTurn(runtime, '你记得我之前给你发的那盆无花果吗 有很多无花果')
  assert.equal(turn?.status, 'done')
  assert.equal(turn.result.replyMessages[0], '那是一盆无花果，花花重新看过了。')
  assert.equal(calls.length, 1, 'routing: long-term recall must reopen the original fig image')
  assert.equal(calls[0].image.dataUrl, figDataUrl, 'routing: must inspect the fig, not a boilerplate 找不同 image')
  assert.ok(longTermSearches > 0, 'routing: long-term resolver must run')
  assert.equal(turn.events.some((event) => event.type === 'visual_recall'), true, 'routing: should emit visual_recall')
  console.log('ROUTING_LONG_TERM_BEATS_RECENT_BOILERPLATE=PASS')

  runtime.close()
}

for (const root of roots) await rm(root, { recursive: true, force: true })
console.log('VISUAL_ROUTING_PHASE1.2=PASS')
