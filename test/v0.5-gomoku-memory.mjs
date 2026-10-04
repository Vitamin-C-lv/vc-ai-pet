import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetMemory } from '../src/memory/pet-memory.js'
import { LI_HUAHUA_IDENTITY } from '../src/core/pet-identity.js'
import { GomokuStore } from '../src/remote/gomoku-store.js'
import { rememberGomokuReview } from '../src/runtime/gomoku-memory.js'
import { LocalBrain } from '../src/brain/local-brain.js'
import '../src/remote/mobile-ui/gomoku-engine.js'

const { createGame, play } = globalThis.VcAiPetGomokuEngine
const ROOT = await mkdtemp(join(tmpdir(), 'vc-ai-pet-gomoku-memory-'))
let memory
let games

function completedGame() {
  const game = {
    ...createGame(),
    id: 'gomoku-memory-fixture',
    startedAt: 100,
    finishedAt: 200,
    review: {
      summary: '模型复盘总结：主人这局通过横向连子形成威胁，花花没有及时阻挡。',
      speech: '模型复盘播报不得进入原始证据。',
      observations: [
        { kind: 'style', content: '主人偏好在中央稳健落子，并通过连续进攻形成威胁。', moveNumbers: [1, 3, 5, 7, 9] },
        { kind: 'lesson', content: '先限制对手连线，再扩展自己的优势。', moveNumbers: [1, 3, 5, 7, 9] },
      ],
    },
  }

  for (let index = 0; index < 5; index += 1) {
    assert.equal(play(game, 7, index + 3), true)
    Object.assign(game.history.at(-1), {
      source: 'owner',
      speech: `主人真实黑棋落子 ${index + 1}`,
    })
    if (game.winner) break

    assert.equal(play(game, 0, index * 2), true)
    Object.assign(game.history.at(-1), {
      source: 'local-model',
      speech: `模型白棋播报 ${index + 1}`,
    })
  }

  assert.equal(game.winner, 1, 'the fixture must be completed by the real Gomoku rules engine')
  assert.equal(game.draw, false)
  assert.equal(game.history.length, 9)
  return game
}

try {
  memory = new PetMemory(ROOT)
  games = new GomokuStore(ROOT)
  await games.initialize()

  const game = completedGame()
  games.save(game)

  const first = rememberGomokuReview(memory, games.get(game.id))
  assert.equal(first.status, 'saved')
  assert.equal(first.memoryIds.length, 3, 'summary, style, and lesson are separate inferred memories')

  const anchor = memory.db.list('fact').find(row => row.id === first.anchorId)
  assert.ok(anchor, 'the completed board and rules result need one raw anchor')
  const anchorProvenance = memory.provenanceStore.resolve(anchor)
  assert.equal(anchorProvenance.source, 'SYSTEM_EVENT')
  assert.equal(anchorProvenance.evidence, 'confirmed')
  assert.equal(anchorProvenance.gameId, game.id)
  assert.match(anchor.content, /规则确认结果：主人获胜/)
  assert.match(anchor.content, /主人黑棋\(8,8\)/)
  assert.doesNotMatch(anchor.content, /模型复盘总结|模型复盘播报|模型白棋播报|主人真实黑棋落子/,
    'raw evidence contains only the real move coordinates and rules result, never speech')

  const style = memory.db.list('user').find(row => first.memoryIds.includes(row.id))
  const lesson = memory.db.list('lesson').find(row => first.memoryIds.includes(row.id))
  const summary = memory.db.list('topic').find(row => first.memoryIds.includes(row.id))
  assert.ok(style, 'the style inference belongs at user level')
  assert.ok(lesson, 'the strategy inference belongs at lesson level')
  assert.ok(summary, 'the review summary is stored separately at topic level')
  assert.match(summary.content, /模型复盘总结：主人这局通过横向连子形成威胁/)

  for (const row of [style, lesson, summary]) {
    const provenance = memory.provenanceStore.resolve(row)
    assert.equal(provenance.source, 'REFLECTION_DERIVED')
    assert.equal(provenance.evidence, 'inferred', 'a model interpretation must not become confirmed fact')
    assert.ok(provenance.sourceIds.includes(anchor.id), 'derived memory must cite the raw game anchor')
    assert.ok(provenance.sourceRoots.includes(anchor.id), 'the source root must resolve to the raw game anchor')
    assert.equal(provenance.gameId, game.id)
  }

  const styleProvenance = memory.provenanceStore.resolve(style)
  assert.deepEqual(styleProvenance.moveNumbers, [1, 3, 5, 7, 9])
  assert.ok(styleProvenance.moveNumbers.every(number => game.history[number - 1]?.player === 1),
    'the style inference must cite the owner’s black moves')
  const summaryProvenance = memory.provenanceStore.resolve(summary)
  assert.deepEqual(summaryProvenance.moveNumbers, game.history.map((_, index) => index + 1),
    'the summary inference must reference the complete game')

  const firstIds = [...first.memoryIds].sort()
  const second = rememberGomokuReview(memory, games.get(game.id))
  assert.equal(second.anchorId, first.anchorId)
  assert.deepEqual([...second.memoryIds].sort(), firstIds, 'retrying the review must reuse its memories')
  assert.equal(memory.db.list('fact').filter(row => row.title === `五子棋棋局 ${game.id}`).length, 1)
  assert.equal(memory.db.list('user').filter(row => firstIds.includes(row.id)).length, 1)
  assert.equal(memory.db.list('lesson').filter(row => firstIds.includes(row.id)).length, 1)
  assert.equal(memory.db.list('topic').filter(row => firstIds.includes(row.id)).length, 1)

  memory.close()
  games.close()
  memory = new PetMemory(ROOT)
  games = new GomokuStore(ROOT)
  await games.initialize()
  const restoredGame = games.get(game.id)
  assert.equal(restoredGame.history.length, game.history.length)
  const afterRestart = rememberGomokuReview(memory, restoredGame)
  assert.deepEqual([...afterRestart.memoryIds].sort(), firstIds, 'restart must preserve the deduplicated derivation')
  assert.ok(memory.recall('主人下五子棋的风格', 5, { bumpHits: false })
    .some(row => row.id === style.id), 'ordinary recall must retrieve the inferred style')

  let capturedMoveRequest
  let capturedChatRequest
  const brain = new LocalBrain({
    memory,
    client: {
      async chat(request) {
        if (request.reasoningStage === 'reply') {
          capturedChatRequest = request
          return {
            payload: { choices: [{ message: { content: JSON.stringify({
              reply: '我们这局主人横向进攻很有压力，花花也记下了这次复盘。',
              memory: { remember: false, level: 'fact', content: '', importance: 1, keywords: [], confidence: 0, evidence: '' },
              beliefs: [],
            }) } }] },
            requestId: 'gomoku-memory-chat-fixture',
          }
        }
        capturedMoveRequest = request
        return {
          payload: { choices: [{ message: { content: JSON.stringify({ row: 8, col: 8, mood: 'focused', speech: '' }) } }] },
          requestId: 'gomoku-memory-consumption-fixture',
        }
      },
    },
  })
  const nextGame = createGame()
  assert.equal(play(nextGame, 0, 0), true)
  const nextMove = await brain.gomokuMove({ game: nextGame })
  assert.equal(nextMove.source, 'local-model')
  const systemPrompt = capturedMoveRequest.messages[0].content
  assert.ok(systemPrompt.includes(style.content), 'the next game prompt must receive the recalled style')
  assert.ok(systemPrompt.includes(`[inferred] ${style.content}`), 'the prompt must label the style as inferred')
  assert.ok(systemPrompt.includes(summary.content), 'the next game prompt can receive the cached review summary')

  const chatResult = await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: { mood: 0.8, energy: 0.8, boredom: 0.1, sleepiness: 0.1, attachment: 0.8 },
    userText: '花花，聊聊我们上次那局五子棋复盘吧。',
  })
  assert.equal(chatResult.ok, true)
  const chatSystemPrompt = capturedChatRequest.messages[0].content
  assert.ok(chatSystemPrompt.includes(anchor.content), 'the real reply request receives the confirmed game result and move coordinates')
  assert.ok(chatSystemPrompt.includes(summary.content), 'the real reply request receives the review summary')
  assert.ok(chatSystemPrompt.includes(style.content), 'the real reply request receives the owner-style interpretation')
  assert.ok(chatSystemPrompt.includes('[source=SYSTEM_EVENT] [evidence=confirmed]'))
  assert.ok(chatSystemPrompt.includes('[source=REFLECTION_DERIVED] [evidence=inferred]'),
    'daily chat labels model interpretations as inferred')

  const summaryOnlyGame = structuredClone(games.get(game.id))
  summaryOnlyGame.id = 'gomoku-memory-summary-only'
  summaryOnlyGame.review = {
    summary: '蓝月棋局里主人从边线连成五子并赢下对局。',
    mood: 'happy',
    speech: '模型复盘播报不能进入原始证据。',
    observations: [],
  }
  games.save(summaryOnlyGame)
  const summaryOnlySaved = rememberGomokuReview(memory, games.get(summaryOnlyGame.id))
  assert.equal(summaryOnlySaved.memoryIds.length, 1, 'a summary without observations is still remembered')
  const summaryOnly = memory.db.list('topic').find(row => summaryOnlySaved.memoryIds.includes(row.id))
  assert.ok(summaryOnly)
  assert.equal(memory.db.list('user').some(row => summaryOnlySaved.memoryIds.includes(row.id)), false)
  assert.equal(memory.db.list('lesson').some(row => summaryOnlySaved.memoryIds.includes(row.id)), false)
  await brain.reply({
    identity: LI_HUAHUA_IDENTITY,
    state: { mood: 0.8, energy: 0.8, boredom: 0.1, sleepiness: 0.1, attachment: 0.8 },
    userText: '花花，蓝月那局五子棋总结是什么？',
  })
  assert.ok(capturedChatRequest.messages[0].content.includes(summaryOnly.content),
    'daily chat can retrieve a summary even when the review has no observations')

  console.log('V0.5_GOMOKU_MEMORY=PASS')
} finally {
  memory?.close()
  games?.close()
  await rm(ROOT, { recursive: true, force: true })
}
