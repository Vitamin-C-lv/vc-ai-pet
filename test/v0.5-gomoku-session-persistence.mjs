import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GomokuStore } from '../src/remote/gomoku-store.js'
import { createGomokuSessions } from '../src/remote/gomoku-session.js'
import '../src/remote/mobile-ui/gomoku-engine.js'

// Deterministic Local Brain fixtures only; no live model or Pet data is used.
const Engine = globalThis.VcAiPetGomokuEngine
const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-gomoku-session-'))
const managers = []
const stores = []
const moveCounts = new Map()
let interruptedId
let undoId
let finishedId
let reviewCalls = 0

const cachedReview = {
  summary: '主人沿着横线形成五连，花花没能挡住。',
  mood: 'disappointed',
  speech: '下次我会早点留意。',
  observations: [
    { kind: 'style', content: '主人本局通过横向连子形成威胁。', moveNumbers: [1, 3, 5] },
    { kind: 'lesson', content: '花花第2手可以更靠近威胁。', moveNumbers: [2] },
  ],
}

function brainForSession() {
  return {
    async gomokuMove({ game }) {
      const moveNumber = moveCounts.get(game.id) ?? 0
      moveCounts.set(game.id, moveNumber + 1)

      if (game.id === interruptedId) {
        return { row: 7, col: 8, mood: 'curious', speech: '花花重新看了一下。', requestId: 'retry-request' }
      }
      if (game.id === undoId) {
        return moveNumber === 0
          ? { row: 7, col: 8, mood: 'confident', speech: '花花先挡住这里。' }
          : { row: 0, col: 1, mood: 'nervous', speech: '这一步有点紧张。' }
      }
      if (game.id === finishedId) {
        const columns = [0, 2, 4, 6]
        return { row: 14, col: columns[moveNumber], mood: 'focused', speech: '' }
      }
      assert.fail('unexpected fake model game ' + game.id)
    },
    async gomokuReview({ game }) {
      reviewCalls += 1
      assert.equal(game.id, finishedId)
      assert.equal(game.winner, 1)
      assert.ok(game.finishedAt)
      return structuredClone(cachedReview)
    },
  }
}

function createSessions() {
  const sessions = createGomokuSessions({
    sandboxRoot: root,
    getBrain: brainForSession,
    getMemory: () => null,
  })
  managers.push(sessions)
  return sessions
}

function createStore() {
  const store = new GomokuStore(root)
  stores.push(store)
  return store
}

try {
  const seedSession = createSessions()
  await seedSession.initialize()
  const interrupted = seedSession.start().game
  interruptedId = interrupted.id
  seedSession.close()

  const seedStore = createStore()
  await seedStore.initialize()
  const interruptedSnapshot = seedStore.get(interruptedId)
  assert.equal(Engine.play(interruptedSnapshot, 7, 7), true)
  interruptedSnapshot.history.at(-1).source = 'owner'
  interruptedSnapshot.modelStatus = 'thinking'
  seedStore.save(interruptedSnapshot)
  seedStore.close()

  const sessions = createSessions()
  await sessions.initialize()
  const recovered = sessions.get(interruptedId).game
  assert.equal(recovered.currentPlayer, 2)
  assert.equal(recovered.modelStatus, 'failed')
  assert.match(recovered.modelError, /重新看棋盘/)

  const retry = await sessions.retry(interruptedId)
  assert.equal(retry.ok, true)
  assert.equal(retry.game.modelStatus, 'idle')
  assert.equal(retry.game.history.length, 2)
  assert.equal(retry.game.history[0].source, 'owner')
  assert.equal(retry.game.history[1].source, 'local-model')
  assert.equal(retry.game.history[1].requestId, 'retry-request')
  assert.equal(retry.game.history[1].mood, 'curious')
  assert.equal(retry.game.history[1].speech, '花花重新看了一下。')

  const undoGame = sessions.start().game
  undoId = undoGame.id
  assert.equal((await sessions.move(undoId, 7, 7)).ok, true)
  assert.equal((await sessions.move(undoId, 0, 0)).ok, true)
  const beforeUndo = sessions.get(undoId).game
  assert.equal(beforeUndo.history.length, 4)
  assert.equal(beforeUndo.mood, 'nervous')
  assert.equal(beforeUndo.speech, '这一步有点紧张。')

  const undo = sessions.undo(undoId)
  assert.equal(undo.ok, true)
  assert.equal(undo.game.history.length, 2)
  assert.equal(undo.game.currentPlayer, 1)
  assert.equal(undo.game.history[0].source, 'owner')
  assert.equal(undo.game.history[1].source, 'local-model')
  assert.equal(undo.game.history[1].mood, 'confident')
  assert.equal(undo.game.history[1].speech, '花花先挡住这里。')
  assert.equal(undo.game.mood, 'confident')
  assert.equal(undo.game.speech, '花花先挡住这里。')

  const finishedGame = sessions.start().game
  finishedId = finishedGame.id
  for (let col = 0; col < 5; col += 1) {
    const turn = await sessions.move(finishedId, 0, col)
    assert.equal(turn.ok, true)
  }
  const ended = sessions.get(finishedId).game
  assert.equal(ended.winner, 1)
  assert.ok(ended.finishedAt)
  assert.equal(ended.history.length, 9)
  assert.equal(ended.reviewStatus, 'pending')
  assert.equal(sessions.undo(finishedId).error, 'gomoku-undo-not-allowed')
  assert.deepEqual(sessions.history().games, [
    { id: finishedId, winner: 1, draw: false, finishedAt: ended.finishedAt, moveCount: 9, reviewStatus: 'pending' },
  ])

  sessions.close()
  const markReviewInterrupted = createStore()
  await markReviewInterrupted.initialize()
  const reviewSnapshot = markReviewInterrupted.get(finishedId)
  reviewSnapshot.reviewStatus = 'thinking'
  reviewSnapshot.reviewError = null
  markReviewInterrupted.save(reviewSnapshot)
  markReviewInterrupted.close()

  const reviewSession = createSessions()
  await reviewSession.initialize()
  const recoveredReview = reviewSession.get(finishedId).game
  assert.equal(recoveredReview.reviewStatus, 'failed')
  assert.match(recoveredReview.reviewError, /上次复盘中断/)
  const reviewed = await reviewSession.review(finishedId)
  assert.equal(reviewed.ok, true)
  assert.equal(reviewCalls, 1)
  assert.equal(reviewed.game.reviewStatus, 'ready')
  assert.deepEqual(reviewed.game.review.observations, cachedReview.observations)
  assert.equal(reviewed.game.review.memoryStatus, 'unavailable')
  assert.equal(reviewed.game.mood, 'disappointed')
  assert.equal(reviewed.game.speech, '下次我会早点留意。')
  assert.equal(reviewSession.history().games[0].reviewStatus, 'ready')
  reviewSession.close()

  const reopened = createSessions()
  await reopened.initialize()
  assert.equal(reopened.get(interruptedId).game.history.length, 2)
  assert.equal(reopened.get(undoId).game.history.length, 2)
  assert.equal(reopened.get(undoId).game.mood, 'confident')
  assert.equal(reopened.get(undoId).game.speech, '花花先挡住这里。')
  const archivedReview = reopened.get(finishedId).game
  assert.deepEqual(archivedReview.review, reviewed.game.review)
  assert.equal(archivedReview.reviewStatus, 'ready')
  const cached = await reopened.review(finishedId)
  assert.equal(cached.ok, true)
  assert.equal(reviewCalls, 1, 'a persisted review is shown again without another model call')
  console.log('V0.5_GOMOKU_SESSION_PERSISTENCE=PASS')
} finally {
  for (const sessions of managers) sessions.close()
  for (const store of stores) store.close()
  await rm(root, { recursive: true, force: true })
}
