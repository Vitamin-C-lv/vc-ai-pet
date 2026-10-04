import { randomUUID } from 'node:crypto'
import './mobile-ui/gomoku-engine.js'
import { GomokuStore } from './gomoku-store.js'
import { rememberGomokuReview } from '../runtime/gomoku-memory.js'

const { createGame, play } = globalThis.VcAiPetGomokuEngine

function gameError(code, statusCode = 409) {
  const error = new Error(code)
  error.code = code
  error.statusCode = statusCode
  return error
}

export function createGomokuSessions({ getBrain, getMemory = () => null, getPetContext = () => ({}), sandboxRoot = null }) {
  const games = new Map()
  const store = sandboxRoot ? new GomokuStore(sandboxRoot) : null
  let ready
  const save = game => store?.save(game)
  const finish = game => {
    if (game.winner || game.draw) game.finishedAt = Date.now()
    save(game)
  }
  const publicGame = game => JSON.parse(JSON.stringify(game))
  const find = id => {
    let game = games.get(id)
    if (!game && store) {
      game = store.get(id)
      if (game) {
        // A persisted thinking marker cannot resume an interrupted inference.
        if (game.modelStatus === 'thinking') {
          game.modelStatus = 'failed'
          game.modelError = '上次思考中断了，可以让花花重新看棋盘。'
        }
        if (game.reviewStatus === 'thinking') { game.reviewStatus = 'failed'; game.reviewError = '上次复盘中断了，可以重试。' }
        games.set(id, game)
        save(game)
      }
    }
    if (!game) throw gameError('gomoku-not-found', 404)
    return game
  }

  async function modelMove(game) {
    game.modelStatus = 'thinking'
    game.modelError = null
    save(game)
    try {
      const brain = getBrain()
      if (typeof brain?.gomokuMove !== 'function') throw gameError('gomoku-model-unavailable', 503)
      const decision = await brain.gomokuMove({ ...getPetContext(), game: publicGame(game) })
      if (!play(game, decision.row, decision.col)) throw gameError('GOMOKU_MODEL_INVALID_MOVE')
      Object.assign(game.history.at(-1), { source: 'local-model', mood: decision.mood, speech: decision.speech, requestId: decision.requestId ?? null })
      game.mood = decision.mood
      game.speech = decision.speech
      game.modelStatus = 'idle'
      finish(game)
      return { ok: true, game: publicGame(game) }
    } catch (error) {
      game.modelStatus = 'failed'
      game.modelError = error?.code === 'GOMOKU_MODEL_INVALID_MOVE'
        ? '花花这次没有选出合法落点，点“重试”让它重新看棋盘。'
        : '花花的本地模型暂时没能完成这一步，稍后可以重试。'
      save(game)
      return { ok: false, error: 'gomoku-model-failed', game: publicGame(game) }
    }
  }

  return {
    initialize() { return ready ??= store?.initialize() ?? Promise.resolve() },
    close() { store?.close() },
    start() {
      const game = { ...createGame(), id: randomUUID(), modelStatus: 'idle', modelError: null,
        startedAt: Date.now(), finishedAt: null, mood: null, speech: '', review: null, reviewStatus: 'pending', reviewError: null }
      games.set(game.id, game)
      save(game)
      // Keep recent device games without retaining every abandoned new game.
      if (games.size > 20) games.delete(games.keys().next().value)
      return { ok: true, game: publicGame(game) }
    },
    get(id) { return { ok: true, game: publicGame(find(id)) } },
    history({ limit = 30, offset = 0 } = {}) {
      const list = store ? store.history(limit, offset) : [...games.values()].filter(game => game.finishedAt)
        .sort((a, b) => b.finishedAt - a.finishedAt).slice(offset, offset + limit)
        .map(game => ({ id: game.id, winner: game.winner, draw: game.draw, finishedAt: game.finishedAt,
          moveCount: game.history.length, reviewStatus: game.reviewStatus }))
      return { ok: true, games: list.map(record => ({ ...record,
        reviewStatus: games.get(record.id)?.reviewStatus ?? record.reviewStatus })) }
    },
    async move(id, row, col) {
      const game = find(id)
      if (game.modelStatus === 'thinking' || game.currentPlayer !== 1 || !play(game, row, col)) {
        return { ok: false, error: 'gomoku-move-not-allowed', game: publicGame(game), statusCode: 409 }
      }
      game.history.at(-1).source = 'owner'
      if (game.winner || game.draw) { finish(game); return { ok: true, game: publicGame(game) } }
      return modelMove(game)
    },
    async retry(id) {
      const game = find(id)
      if (game.modelStatus !== 'failed' || game.currentPlayer !== 2 || game.winner || game.draw) {
        return { ok: false, error: 'gomoku-retry-not-allowed', game: publicGame(game), statusCode: 409 }
      }
      return modelMove(game)
    },
    undo(id) {
      const game = find(id)
      if (game.modelStatus === 'thinking' || game.finishedAt) return { ok: false, error: 'gomoku-undo-not-allowed', game: publicGame(game), statusCode: 409 }
      const history = game.history.slice(0, -(game.history.at(-1)?.player === 2 ? 2 : 1))
      const next = { ...createGame(), id: game.id, startedAt: game.startedAt, finishedAt: null,
        modelStatus: 'idle', modelError: null, mood: null, speech: '', review: null, reviewStatus: 'pending', reviewError: null }
      for (const move of history) {
        play(next, move.row, move.col)
        Object.assign(next.history.at(-1), move)
        if (move.player === 2) { next.mood = move.mood; next.speech = move.speech }
      }
      games.set(id, next)
      save(next)
      return { ok: true, game: publicGame(next) }
    },
    async review(id) {
      const game = find(id)
      if (!game.finishedAt || game.reviewStatus === 'thinking') return { ok: false, error: 'gomoku-review-not-allowed', game: publicGame(game), statusCode: 409 }
      if (!game.review) {
        game.reviewStatus = 'thinking'
        game.reviewError = null
        save(game)
        try {
          const brain = getBrain()
          if (typeof brain?.gomokuReview !== 'function') throw gameError('gomoku-model-unavailable', 503)
          game.review = await brain.gomokuReview({ ...getPetContext(), game: publicGame(game) })
          game.mood = game.review.mood
          game.speech = game.review.speech
          game.reviewStatus = 'ready'
        } catch {
          game.reviewStatus = 'failed'
          game.reviewError = '这次没能完成模型复盘，可以稍后重试。'
          save(game)
          return { ok: false, error: 'gomoku-review-failed', game: publicGame(game) }
        }
      }
      if (game.review.memoryStatus !== 'saved') {
        try {
          const remembered = rememberGomokuReview(getMemory(), game)
          game.review.memoryStatus = remembered.status
          game.review.memoryIds = remembered.memoryIds ?? []
          game.review.anchorId = remembered.anchorId ?? null
        } catch { game.review.memoryStatus = 'failed' }
      }
      save(game)
      return { ok: true, game: publicGame(game) }
    },
  }
}
