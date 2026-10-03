import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PetRuntime } from '../src/runtime/pet-runtime.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-headpat-turn-'))
const runtime = new PetRuntime({ sandboxRoot: root })
const textReplies = ['第一段回答。', '第二段回答。']
const feedbackIds = []
const visualSearches = []

function reply(text, replyMessages = [text], extra = {}) {
  return {
    ok: true,
    text,
    replyMessages,
    memoryCandidate: null,
    rawMemoryCandidate: null,
    beliefCandidates: [],
    ...extra,
  }
}

async function finishTurn(userText) {
  const started = runtime.startChatTurn({ userText })
  let poll = null
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
    poll = runtime.pollChatTurn(started.turnId, 0)
    if (poll?.status !== 'running') break
  }
  assert.equal(poll?.status, 'done', JSON.stringify(poll?.error ?? poll))
  return poll
}

async function assertPersistedAndFeedback(turn, texts) {
  const events = turn.events.filter(event => event.type === 'assistant_message')
  assert.deepEqual(events.map(event => event.payload.text), texts)
  assert.equal(events.length, texts.length)

  for (const event of events) {
    const messageId = event.payload.messageId
    assert.equal(typeof messageId, 'string')
    assert.ok(messageId.length > 0)
    const stored = await runtime.conversationStore.sourceMessage(messageId)
    assert.ok(stored, 'event messageId resolves to a durable assistant answer')
    assert.equal(stored.id, messageId)
    assert.equal(stored.role, 'assistant')
    assert.equal(stored.text, event.payload.text)
    assert.equal(stored.turnId, turn.turnId)

    const feedback = await runtime.conversationStore.setMessageHeadpat(messageId, true)
    assert.deepEqual(feedback, { headpat: true })
    feedbackIds.push(messageId)
  }

  const history = await runtime.conversationStore.history(100)
  for (const messageId of events.map(event => event.payload.messageId)) {
    assert.equal(history.find(message => message.id === messageId)?.feedback?.headpat, true)
  }
}

try {
  await runtime.initialize()

  runtime.brain = {
    async reply(request) {
      if (request.toolResultContext) return reply('花花暂时没有找到可核验的照片。')
      if (request.userText === '请分两段回答。') {
        return reply(textReplies[0], textReplies)
      }
      if (request.userText === '请找一下以前那张花的照片。') {
        assert.equal(request.allowVisualRecall, true)
        return reply('花花去图库里找找看。', ['花花去图库里找找看。'], {
          visualRecall: {
            tool: 'search_visual_memory',
            query: '以前那张花的照片',
            goal: 'find_photo',
          },
        })
      }
      assert.fail('unexpected fake model request: ' + request.userText)
    },
  }
  runtime.visualSemanticIndex.search = async (query) => {
    visualSearches.push(query)
    return { status: 'none', candidates: [], winner: null }
  }

  const textTurn = await finishTurn('请分两段回答。')
  assert.deepEqual(textTurn.result.replyMessages, textReplies)
  await assertPersistedAndFeedback(textTurn, textReplies)

  const visualTurn = await finishTurn('请找一下以前那张花的照片。')
  assert.equal(visualSearches.length, 1)
  assert.equal(visualSearches[0], '以前那张花的照片')
  await assertPersistedAndFeedback(visualTurn, [
    '花花去图库里找找看。',
    '花花暂时没有找到可核验的照片。',
  ])

  assert.equal(new Set(feedbackIds).size, 4)
  console.log('V0.5_MESSAGE_HEADPAT_LIVE_TURN=PASS')
} finally {
  runtime.close()
  await rm(root, { recursive: true, force: true })
}
