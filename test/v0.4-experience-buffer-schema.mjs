import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import {
  ExperienceBuffer,
  EXPERIENCE_BUFFER_META_TABLE,
  EXPERIENCE_BUFFER_SCHEMA_VERSION,
  EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY,
  EXPERIENCE_BUFFER_TABLE,
  EXPERIENCE_EVENT_COLUMNS,
} from '../src/experience/experience-buffer.js'
import { EXPERIENCE_BUFFER_DB_FILENAME } from '../src/experience/experience-buffer-schema.js'

const execFileAsync = promisify(execFile)
const migration = resolve(new URL('../scripts/migrate-experience-buffer.mjs', import.meta.url).pathname)

function schemaSnapshot(db) {
  return {
    columns: db.prepare(`PRAGMA table_info(${EXPERIENCE_BUFFER_TABLE})`).all().map((row) => row.name),
    indexes: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'experience_events' ORDER BY name").all().map((row) => ({ name: row.name, sql: row.sql })),
    meta: db.prepare(`SELECT key, value FROM ${EXPERIENCE_BUFFER_META_TABLE} ORDER BY key`).all().map((row) => ({ key: row.key, value: row.value })),
  }
}

async function runMigration(root, ...args) {
  return execFileAsync(process.execPath, [migration, '--sandbox', root, ...args], { encoding: 'utf8' })
}

const freshRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-experience-schema-'))
const legacyRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-experience-schema-legacy-'))
try {
  const buffer = new ExperienceBuffer({ root: freshRoot, now: () => 1000 })
  await Promise.all([buffer.initialize(), buffer.initialize(), buffer.initialize()])
  const freshDbPath = join(freshRoot, EXPERIENCE_BUFFER_DB_FILENAME)
  let firstSnapshot
  const db = new DatabaseSync(freshDbPath)
  try {
    firstSnapshot = schemaSnapshot(db)
    assert.deepEqual(firstSnapshot.columns, EXPERIENCE_EVENT_COLUMNS)
    assert.deepEqual(firstSnapshot.meta, [{ key: EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY, value: String(EXPERIENCE_BUFFER_SCHEMA_VERSION) }])
  } finally {
    db.close()
  }
  await buffer.close()

  const reopened = new ExperienceBuffer({ root: freshRoot, now: () => 1000 })
  await reopened.initialize()
  const dbAgain = new DatabaseSync(freshDbPath)
  try {
    assert.deepEqual(schemaSnapshot(dbAgain), firstSnapshot, 'second initialize must not change schema, indexes, or meta')
  } finally {
    dbAgain.close()
    await reopened.close()
  }
  assert.equal((await stat(freshDbPath)).mode & 0o777, 0o600)
  console.log('FRESH_RUNTIME_META_AND_SCHEMA=PASS')

  const legacyDb = new DatabaseSync(join(legacyRoot, EXPERIENCE_BUFFER_DB_FILENAME))
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
    INSERT INTO experience_events(created_at, source_type, conversation_id, content, importance_score)
    VALUES (77, 'owner_chat', 'legacy-conversation', '历史行不能丢', 0.2);
  `)
  legacyDb.close()
  const legacyBuffer = new ExperienceBuffer({ root: legacyRoot, now: () => 2000 })
  await legacyBuffer.initialize()
  const legacyRows = await legacyBuffer.recent({ limit: 10 })
  assert.equal(legacyRows.length, 1)
  assert.equal(legacyRows[0].content, '历史行不能丢')
  assert.equal(legacyRows[0].conversationId, 'legacy-conversation')
  assert.equal(legacyRows[0].conversationKey, null)
  assert.equal(await legacyBuffer.count(), 1)
  const legacyCheck = new DatabaseSync(join(legacyRoot, EXPERIENCE_BUFFER_DB_FILENAME))
  try {
    assert.deepEqual(new Set(schemaSnapshot(legacyCheck).columns), new Set(EXPERIENCE_EVENT_COLUMNS))
    assert.equal(legacyCheck.prepare(`SELECT value FROM ${EXPERIENCE_BUFFER_META_TABLE} WHERE key = ?`).get(EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY).value, String(EXPERIENCE_BUFFER_SCHEMA_VERSION))
  } finally {
    legacyCheck.close()
    await legacyBuffer.close()
  }
  console.log('LEGACY_12_COLUMN_ADDITIVE_UPGRADE=PASS')

  const dryRoot = await mkdtemp(join(tmpdir(), 'vc-ai-pet-experience-migrate-'))
  try {
    const dryDb = join(dryRoot, EXPERIENCE_BUFFER_DB_FILENAME)
    const dry = await runMigration(dryRoot)
    assert.match(dry.stdout, /action=WOULD_CREATE/)
    assert.match(dry.stdout, /EXPERIENCE_SCHEMA_VERSION=2/)
    assert.match(dry.stdout, /EXPERIENCE_DB_MODE=0600/)
    assert.equal(await readFile(dryDb).catch(() => null), null)
    console.log('MIGRATION_DRY_RUN_NO_WRITE=PASS')

    const applied = await runMigration(dryRoot, '--apply')
    assert.match(applied.stdout, /schemaMatch=true/)
    assert.match(applied.stdout, /schemaVersion=2/)
    const appliedAgain = await runMigration(dryRoot, '--apply')
    assert.match(appliedAgain.stdout, /schemaMatch=true/)
    const migratedDb = new DatabaseSync(dryDb)
    try {
      assert.deepEqual(migratedDb.prepare(`PRAGMA table_info(${EXPERIENCE_BUFFER_TABLE})`).all().map((row) => row.name), EXPERIENCE_EVENT_COLUMNS)
      assert.equal(migratedDb.prepare(`SELECT value FROM ${EXPERIENCE_BUFFER_META_TABLE} WHERE key = ?`).get(EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY).value, '2')
    } finally {
      migratedDb.close()
    }
    assert.equal((await stat(dryDb)).mode & 0o777, 0o600)
    console.log('MIGRATION_APPLY_AND_SECOND_APPLY=PASS')
  } finally {
    await rm(dryRoot, { recursive: true, force: true })
  }
} finally {
  await rm(freshRoot, { recursive: true, force: true })
  await rm(legacyRoot, { recursive: true, force: true })
}

console.log('VC_AI_PET_V0_4_EXPERIENCE_BUFFER_SCHEMA=PASS')
