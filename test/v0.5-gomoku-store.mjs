import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GomokuStore } from '../src/remote/gomoku-store.js'

function game(id, { finishedAt = null, review = null, reviewError = null, mood = 'curious' } = {}) {
  return {
    id,
    board: Array.from({ length: 15 }, () => Array(15).fill(0)),
    history: [
      { row: 7, col: 7, player: 1, source: 'owner', mood: 'focused', speech: '主人落在中心。' },
      { row: 7, col: 8, player: 2, source: 'local-model', mood: 'thoughtful', speech: '花花先挡住这一边。' },
    ],
    winner: finishedAt === null ? 0 : 1,
    draw: false,
    winningCells: finishedAt === null ? [] : [{ row: 7, col: 7 }, { row: 7, col: 8 }],
    mood,
    speech: '花花还在认真下棋。',
    review,
    reviewError,
    modelStatus: finishedAt === null ? 'thinking' : 'idle',
    startedAt: 100,
    finishedAt,
  }
}

assert.throws(() => new GomokuStore(), /GOMOKU_SANDBOX_ROOT_REQUIRED/)

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-gomoku-store-'))
const otherRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-gomoku-store-other-'))
let store
let otherStore

try {
  store = new GomokuStore(root)
  otherStore = new GomokuStore(otherRoot)
  await Promise.all([store.initialize(), otherStore.initialize()])
  assert.equal((await stat(join(root, 'runtime', 'gomoku-games.db'))).isFile(), true)

  const active = game('shared-id')
  assert.equal(store.save(active).id, active.id)
  assert.deepEqual(store.get(active.id), active)
  assert.equal(store.history().length, 0, 'unfinished games do not appear in completed history')

  const first = game('finished-old', {
    finishedAt: 200,
    review: { summary: '花花这局主要通过边线形成威胁。', style: '积极防守', notes: ['及时封堵'] },
  })
  const second = game('finished-middle', { finishedAt: 300 })
  const third = game('finished-new', { finishedAt: 400, reviewError: 'review-unavailable' })
  store.save(first)
  store.save(second)
  store.save(third)

  assert.deepEqual(store.history(2, 0), [
    { id: 'finished-new', winner: 1, draw: false, finishedAt: 400, moveCount: 2, reviewStatus: 'failed' },
    { id: 'finished-middle', winner: 1, draw: false, finishedAt: 300, moveCount: 2, reviewStatus: 'pending' },
  ])
  assert.deepEqual(store.history(2, 2), [
    { id: 'finished-old', winner: 1, draw: false, finishedAt: 200, moveCount: 2, reviewStatus: 'ready' },
  ])
  assert.deepEqual(store.history(30, 0).map(item => item.id), [
    'finished-new', 'finished-middle', 'finished-old',
  ])

  const retained = store.get('finished-old')
  assert.deepEqual(retained.history, first.history)
  assert.deepEqual(retained.review, first.review)
  assert.equal(retained.history[0].source, 'owner')
  assert.equal(retained.history[1].source, 'local-model')
  assert.equal(retained.history[0].speech, '主人落在中心。')
  assert.equal(retained.history[1].speech, '花花先挡住这一边。')
  assert.equal(retained.history[0].mood, 'focused')
  assert.equal(retained.mood, first.mood)
  assert.equal(retained.speech, first.speech)
  assert.equal(retained.startedAt, first.startedAt)
  assert.equal(retained.finishedAt, first.finishedAt)
  retained.history[0].speech = '已更改副本'
  assert.equal(store.get('finished-old').history[0].speech, first.history[0].speech)

  const updatedActive = { ...active, winner: 1, modelStatus: 'idle', finishedAt: 500,
    review: { summary: '终局复盘已完成。' } }
  store.save(updatedActive)
  assert.equal(store.get('shared-id').finishedAt, 500, 'saving the same id updates its snapshot')
  assert.ok(store.history().some(item => item.id === 'shared-id'))

  otherStore.save(game('finished-old', { finishedAt: 900, mood: 'independent' }))
  assert.equal(otherStore.get('finished-old').mood, 'independent')
  assert.equal(store.get('finished-old').mood, first.mood)

  store.close()
  store = new GomokuStore(root)
  await store.initialize()
  assert.deepEqual(store.get('finished-old'), first)
  assert.equal(store.get('shared-id').review.summary, '终局复盘已完成。')
  console.log('V0.5_GOMOKU_STORE=PASS')
} finally {
  store?.close()
  otherStore?.close()
  await rm(root, { recursive: true, force: true })
  await rm(otherRoot, { recursive: true, force: true })
}
