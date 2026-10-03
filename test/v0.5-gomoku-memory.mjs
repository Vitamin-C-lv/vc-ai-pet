import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PetMemory } from '../src/memory/pet-memory.js'
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
      summary: '模型复盘语句不得进入原始证据。',
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
  assert.equal(first.memoryIds.length, 2, 'style and lesson are separate inferred memories')

  const anchor = memory.db.list('fact').find(row => row.id === first.anchorId)
  assert.ok(anchor, 'the completed board and rules result need one raw anchor')
  const anchorProvenance = memory.provenanceStore.resolve(anchor)
  assert.equal(anchorProvenance.source, 'SYSTEM_EVENT')
  assert.equal(anchorProvenance.evidence, 'confirmed')
  assert.equal(anchorProvenance.gameId, game.id)
  assert.match(anchor.content, /规则确认结果：主人获胜/)
  assert.match(anchor.content, /主人黑棋\(8,8\)/)
  assert.doesNotMatch(anchor.content, /模型复盘语句|模型复盘播报|模型白棋播报|主人真实黑棋落子/,
    'raw evidence contains only the real move coordinates and rules result, never speech')

  const style = memory.db.list('user').find(row => first.memoryIds.includes(row.id))
  const lesson = memory.db.list('lesson').find(row => first.memoryIds.includes(row.id))
  assert.ok(style, 'the style inference belongs at user level')
  assert.ok(lesson, 'the strategy inference belongs at lesson level')

  for (const row of [style, lesson]) {
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

  const firstIds = [...first.memoryIds].sort()
  const second = rememberGomokuReview(memory, games.get(game.id))
  assert.equal(second.anchorId, first.anchorId)
  assert.deepEqual([...second.memoryIds].sort(), firstIds, 'retrying the review must reuse its memories')
  assert.equal(memory.db.list('fact').filter(row => row.title === `五子棋棋局 ${game.id}`).length, 1)
  assert.equal(memory.db.list('user').filter(row => firstIds.includes(row.id)).length, 1)
  assert.equal(memory.db.list('lesson').filter(row => firstIds.includes(row.id)).length, 1)

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
  const brain = new LocalBrain({
    memory,
    client: {
      async chat(request) {
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

  console.log('V0.5_GOMOKU_MEMORY=PASS')
} finally {
  memory?.close()
  games?.close()
  await rm(ROOT, { recursive: true, force: true })
}
