import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  EXPERIENCE_BUFFER_SESSION_IDLE_TIMEOUT_MS,
  ExperienceBuffer,
} from '../src/experience/experience-buffer.js'
import { EXPERIENCE_BUFFER_DB_FILENAME } from '../src/experience/experience-buffer-schema.js'
import {
  EXPERIENCE_CONSOLIDATION_MIN_DAY_SPAN_MS,
  ExperienceConsolidator,
} from '../src/experience/experience-consolidator.js'

const DAY_MS = 24 * 60 * 60 * 1000

function memoryStub() {
  const rows = []
  return {
    rows,
    findEquivalentMemory: () => null,
    remember(level, content, importance, extra) {
      const row = { id: rows.length + 1, level, content, importance, ...extra }
      rows.push(row)
      return row
    },
  }
}

async function analyzeRows(root, times, options = {}) {
  let now = times[0]
  const buffer = new ExperienceBuffer({ root, now: () => now })
  await buffer.initialize()
  const rows = []
  for (const [index, time] of times.entries()) {
    now = time
    rows.push(buffer.record({
      turnId: `turn-${index}`,
      ownerText: '黑莓睡沙发',
    }))
  }
  const pending = await buffer.pendingExperience({ limit: 20 })
  const memory = memoryStub()
  const result = await new ExperienceConsolidator({ buffer, memory, ...options }).analyze()
  return { buffer, rows, pending, result }
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-experience-session-guard-'))
  const base = 1_900_000_000_000
  const dayBoundary = base + (23 * 60 + 50) * 60 * 1000
  try {
    assert.equal(EXPERIENCE_BUFFER_SESSION_IDLE_TIMEOUT_MS, 30 * 60 * 1000)
    assert.equal(EXPERIENCE_CONSOLIDATION_MIN_DAY_SPAN_MS, DAY_MS)

    // Per-turn conversationId values do not split a continuous chat. The
    // automatic session key remains stable inside the idle threshold.
    const sameSession = await analyzeRows(join(root, 'same-session'), [base, base + 10 * 60 * 1000])
    assert.equal(sameSession.pending[0].conversationId, 'turn-0')
    assert.equal(sameSession.pending[1].conversationId, 'turn-1')
    assert.equal(sameSession.pending[0].conversationKey, sameSession.pending[1].conversationKey)
    assert.equal(sameSession.result.candidates.length, 0)

    // Crossing both the idle threshold and a full day creates a durable
    // candidate even though the old conversationId values are unique.
    const crossSession = await analyzeRows(join(root, 'cross-session'), [
      base,
      base + EXPERIENCE_BUFFER_SESSION_IDLE_TIMEOUT_MS + DAY_MS,
    ])
    assert.notEqual(crossSession.pending[0].conversationKey, crossSession.pending[1].conversationKey)
    const crossCandidate = crossSession.result.candidates.find((candidate) => candidate.term === '睡沙发')
    assert.ok(crossCandidate)
    assert.equal(crossCandidate.turns, 2)

    // Crossing a calendar day is not enough: a 20-minute continuation is one
    // session and must remain guarded even if its date changes.
    const sameSessionAcrossDate = await analyzeRows(join(root, 'same-date-session'), [
      dayBoundary,
      dayBoundary + 20 * 60 * 1000,
    ])
    assert.equal(sameSessionAcrossDate.pending[0].conversationKey, sameSessionAcrossDate.pending[1].conversationKey)
    assert.equal(sameSessionAcrossDate.result.candidates.length, 0)

    // An explicitly supplied stable key remains stable even after idle time;
    // conversationId is preserved as its legacy per-turn identifier.
    let explicitNow = base
    const explicitBuffer = new ExperienceBuffer({ root: join(root, 'explicit'), now: () => explicitNow })
    await explicitBuffer.initialize()
    explicitBuffer.record({ turnId: 'explicit-turn-1', conversationKey: 'chat-stable', ownerText: '黑莓睡沙发' })
    explicitNow += EXPERIENCE_BUFFER_SESSION_IDLE_TIMEOUT_MS + DAY_MS
    explicitBuffer.record({ turnId: 'explicit-turn-2', conversationKey: 'chat-stable', ownerText: '黑莓睡沙发' })
    const explicitRows = await explicitBuffer.pendingExperience({ limit: 20 })
    assert.deepEqual(explicitRows.map((row) => row.conversationKey), ['chat-stable', 'chat-stable'])
    assert.equal((await new ExperienceConsolidator({ buffer: explicitBuffer, memory: memoryStub() }).analyze()).candidates.length, 0)
    await explicitBuffer.close()

    // A new buffer instance models a process restart: automatic keys never
    // join the previous process/session namespace.
    let restartedNow = base + DAY_MS
    const firstProcess = new ExperienceBuffer({ root: join(root, 'restart'), now: () => restartedNow })
    await firstProcess.initialize()
    firstProcess.record({ turnId: 'old-process-turn', ownerText: '黑莓睡沙发' })
    const oldKey = (await firstProcess.pendingExperience({ limit: 1 }))[0].conversationKey
    await firstProcess.close()
    const secondProcess = new ExperienceBuffer({ root: join(root, 'restart'), now: () => restartedNow })
    await secondProcess.initialize()
    secondProcess.record({ turnId: 'new-process-turn', ownerText: '黑莓睡沙发' })
    const newKey = (await secondProcess.pendingExperience({ limit: 20 }))[1].conversationKey
    assert.notEqual(oldKey, newKey)
    await secondProcess.close()

    // Upgrade an old schema, then repeat initialization/reopen to prove the
    // migration is idempotent and keeps old rows readable.
    const legacyRoot = join(root, 'legacy')
    await mkdir(legacyRoot, { recursive: true })
    const legacyPath = join(legacyRoot, EXPERIENCE_BUFFER_DB_FILENAME)
    const legacyDb = new DatabaseSync(legacyPath)
    legacyDb.exec(`
      CREATE TABLE experience_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        conversation_id TEXT,
        message_id TEXT,
        actor_id TEXT,
        content TEXT NOT NULL,
        importance_score REAL NOT NULL DEFAULT 0,
        emotion_score REAL,
        memory_candidate TEXT,
        processed INTEGER NOT NULL DEFAULT 0,
        processed_at INTEGER
      );
      INSERT INTO experience_events(created_at, source_type, conversation_id, content)
      VALUES (1, 'owner_chat', 'legacy-turn', '旧行');
    `)
    legacyDb.close()
    const upgraded = new ExperienceBuffer({ root: legacyRoot, now: () => base })
    await upgraded.initialize()
    await upgraded.close()
    const reopened = new ExperienceBuffer({ root: legacyRoot, now: () => base })
    await assert.doesNotReject(() => reopened.initialize())
    const columns = reopened.db.prepare('PRAGMA table_info(experience_events)').all().map((row) => row.name)
    assert.equal(columns.filter((name) => name === 'conversation_key').length, 1)
    assert.equal((await reopened.recent({ limit: 5 }))[0].conversationKey, null)
    await reopened.close()

    console.log('EXPERIENCE_SESSION_GUARD=PASS')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()
