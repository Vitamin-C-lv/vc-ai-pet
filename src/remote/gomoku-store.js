import { mkdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

export class GomokuStore {
  constructor(sandboxRoot) {
    if (typeof sandboxRoot !== 'string' || !sandboxRoot.trim()) {
      throw new TypeError('GOMOKU_SANDBOX_ROOT_REQUIRED')
    }
    this.dbPath = join(resolve(sandboxRoot), 'runtime', 'gomoku-games.db')
    this.database = null
    this.initializing = null
  }

  async initialize() {
    if (this.database) return this
    if (!this.initializing) this.initializing = this.#open()
    try {
      return await this.initializing
    } finally {
      this.initializing = null
    }
  }

  async #open() {
    await mkdir(join(this.dbPath, '..'), { recursive: true })
    const database = new DatabaseSync(this.dbPath)
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS game (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          finished_at INTEGER
        )
      `)
    } catch (error) {
      database.close()
      throw error
    }
    this.database = database
    return this
  }

  save(game) {
    const database = this.#requireDatabase()
    if (!game || typeof game.id !== 'string' || !game.id) throw new TypeError('GOMOKU_GAME_ID_REQUIRED')
    const snapshot = clone(game)
    database.prepare(`
      INSERT INTO game (id, payload, finished_at) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, finished_at = excluded.finished_at
    `).run(snapshot.id, JSON.stringify(snapshot), snapshot.finishedAt ?? null)
    return clone(snapshot)
  }

  get(id) {
    const row = this.#requireDatabase().prepare('SELECT payload FROM game WHERE id = ?').get(String(id))
    return row ? clone(JSON.parse(row.payload)) : null
  }

  history(limit = 30, offset = 0) {
    const pageSize = Math.max(0, Math.floor(Number(limit) || 0))
    const pageOffset = Math.max(0, Math.floor(Number(offset) || 0))
    const rows = this.#requireDatabase().prepare(`
      SELECT payload FROM game
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC, rowid DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, pageOffset)

    return rows.map(({ payload }) => {
      const game = JSON.parse(payload)
      return {
        id: game.id,
        winner: game.winner,
        draw: game.draw,
        finishedAt: game.finishedAt,
        moveCount: Array.isArray(game.history) ? game.history.length : 0,
        reviewStatus: game.review?.summary ? 'ready'
          : game.reviewError || game.reviewStatus === 'thinking' ? 'failed' : 'pending',
      }
    })
  }

  close() {
    if (!this.database) return
    this.database.close()
    this.database = null
  }

  #requireDatabase() {
    if (!this.database) throw new Error('GOMOKU_STORE_NOT_INITIALIZED')
    return this.database
  }
}
