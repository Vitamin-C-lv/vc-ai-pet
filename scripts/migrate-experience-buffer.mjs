#!/usr/bin/env node
/**
 * Experience Buffer migration — create the `experience_events` store without
 * ever touching PetMemory, the conversation archive, or any production data.
 *
 * Default mode is DRY-RUN: it inspects the target sandbox and prints exactly
 * what would change. Nothing is written until `--apply` is passed.
 *
 * The migration is deliberately self-contained instead of importing
 * `src/experience/experience-buffer.js`: a migration must be runnable even
 * when the runtime module is absent or was rolled back, and the DDL below is
 * the single frozen source of truth for the on-disk schema.
 *
 * Usage:
 *   node scripts/migrate-experience-buffer.mjs --sandbox <dir>            # dry-run
 *   node scripts/migrate-experience-buffer.mjs --sandbox <dir> --apply    # write
 *   node scripts/migrate-experience-buffer.mjs --sandbox <dir> --json     # machine readable
 */

import { DatabaseSync } from 'node:sqlite'
import { access, mkdir, stat, chmod } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'

export const EXPERIENCE_BUFFER_DB_FILENAME = 'experience-buffer.sqlite'
export const EXPERIENCE_BUFFER_TABLE = 'experience_events'
export const EXPERIENCE_BUFFER_SCHEMA_VERSION = 1

/**
 * Frozen column contract. Order matters only for readability: SQLite column
 * order is fixed at creation time, so drift detection must compare sets.
 */
export const EXPERIENCE_EVENT_COLUMNS = Object.freeze([
  'id',
  'created_at',
  'source_type',
  'conversation_id',
  'message_id',
  'actor_id',
  'content',
  'importance_score',
  'emotion_score',
  'memory_candidate',
  'processed',
  'processed_at',
])

const DDL = Object.freeze({
  table: `CREATE TABLE IF NOT EXISTS ${EXPERIENCE_BUFFER_TABLE} (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at         INTEGER NOT NULL,
    source_type        TEXT NOT NULL,
    conversation_id    TEXT,
    message_id         TEXT,
    actor_id           TEXT,
    content            TEXT NOT NULL,
    importance_score   REAL NOT NULL DEFAULT 0,
    emotion_score      REAL,
    memory_candidate   TEXT,
    processed          INTEGER NOT NULL DEFAULT 0,
    processed_at       INTEGER
  );`,
  indexes: [
    `CREATE INDEX IF NOT EXISTS experience_events_created_at_idx ON ${EXPERIENCE_BUFFER_TABLE}(created_at);`,
    `CREATE INDEX IF NOT EXISTS experience_events_processed_idx ON ${EXPERIENCE_BUFFER_TABLE}(processed, id);`,
    `CREATE INDEX IF NOT EXISTS experience_events_source_type_idx ON ${EXPERIENCE_BUFFER_TABLE}(source_type);`,
    `CREATE INDEX IF NOT EXISTS experience_events_conversation_idx ON ${EXPERIENCE_BUFFER_TABLE}(conversation_id);`,
  ],
  meta: `CREATE TABLE IF NOT EXISTS experience_buffer_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
})

function parseArgs(argv) {
  const options = { apply: false, json: false, sandbox: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') options.apply = true
    else if (arg === '--json') options.json = true
    else if (arg === '--sandbox') options.sandbox = argv[index += 1] ?? null
    else if (arg.startsWith('--sandbox=')) options.sandbox = arg.slice('--sandbox='.length)
  }
  return options
}

async function pathExists(target) {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  return rows.map((row) => String(row.name))
}

/**
 * Inspect the target without mutating it. A missing database file is a normal
 * first-run condition, not an error; a present file with a drifted table is an
 * error because silently "fixing" it could destroy life data.
 */
async function inspect({ sandboxRoot }) {
  const dbPath = join(sandboxRoot, EXPERIENCE_BUFFER_DB_FILENAME)
  const sandboxExists = await pathExists(sandboxRoot)
  const dbExists = await pathExists(dbPath)
  const result = {
    sandboxRoot,
    dbPath,
    sandboxExists,
    dbExists,
    dbSizeBytes: null,
    tableExists: false,
    existingColumns: [],
    missingColumns: [...EXPERIENCE_EVENT_COLUMNS],
    extraColumns: [],
    rowCount: null,
    schemaMatch: false,
    needsCreate: false,
    blocker: null,
  }

  if (dbExists) {
    const info = await stat(dbPath)
    result.dbSizeBytes = Number(info.size)
  }

  if (!sandboxExists) {
    result.needsCreate = true
    result.blocker = 'SANDBOX_MISSING'
    return result
  }

  if (!dbExists) {
    result.needsCreate = true
    return result
  }

  // Read-only inspection: a dry run must never create WAL files or trigger a
  // write transaction against an existing sandbox.
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(EXPERIENCE_BUFFER_TABLE)
    if (!exists) {
      result.needsCreate = true
      return result
    }
    result.tableExists = true
    result.existingColumns = tableColumns(db, EXPERIENCE_BUFFER_TABLE)
    const existing = new Set(result.existingColumns)
    const expected = new Set(EXPERIENCE_EVENT_COLUMNS)
    result.missingColumns = EXPERIENCE_EVENT_COLUMNS.filter((column) => !existing.has(column))
    result.extraColumns = result.existingColumns.filter((column) => !expected.has(column))
    result.schemaMatch = result.missingColumns.length === 0 && result.extraColumns.length === 0
    if (result.schemaMatch) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${EXPERIENCE_BUFFER_TABLE}`).get()
      result.rowCount = Number(row?.n ?? 0)
    } else {
      result.blocker = 'SCHEMA_DRIFT'
    }
    return result
  } finally {
    db.close()
  }
}

function applyMigration({ dbPath }) {
  const db = new DatabaseSync(dbPath)
  try {
    db.exec('PRAGMA busy_timeout = 2000;')
    db.exec('BEGIN IMMEDIATE;')
    try {
      db.exec(DDL.table)
      for (const statement of DDL.indexes) db.exec(statement)
      db.exec(DDL.meta)
      db.prepare(
        `INSERT INTO experience_buffer_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(EXPERIENCE_BUFFER_SCHEMA_VERSION))
      db.exec('COMMIT;')
    } catch (error) {
      try { db.exec('ROLLBACK;') } catch {}
      throw error
    }
    const columns = tableColumns(db, EXPERIENCE_BUFFER_TABLE)
    const expected = new Set(EXPERIENCE_EVENT_COLUMNS)
    const drifted = columns.filter((column) => !expected.has(column))
    if (drifted.length > 0) throw new Error(`EXPERIENCE_BUFFER_SCHEMA_DRIFT:${drifted.join(',')}`)
    return { created: true, columns }
  } finally {
    db.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.sandbox) {
    const message = 'usage: node scripts/migrate-experience-buffer.mjs --sandbox <dir> [--apply] [--json]'
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: 'SANDBOX_REQUIRED' }, null, 2)}\n`)
    else process.stderr.write(`${message}\n`)
    process.exitCode = 2
    return
  }

  const sandboxRoot = resolve(options.sandbox)
  const report = await inspect({ sandboxRoot })

  if (!options.apply) {
    const payload = {
      ok: report.blocker !== 'SCHEMA_DRIFT',
      mode: 'DRY_RUN',
      ...report,
      action: report.blocker === 'SCHEMA_DRIFT'
        ? 'REFUSED'
        : report.needsCreate
          ? 'WOULD_CREATE'
          : report.schemaMatch && report.rowCount === 0
            ? 'WOULD_NOOP_EMPTY_TABLE'
            : 'WOULD_NOOP',
    }
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else {
      process.stdout.write([
        `mode=DRY_RUN`,
        `sandbox=${sandboxRoot}`,
        `db=${report.dbPath}`,
        `sandboxExists=${report.sandboxExists}`,
        `dbExists=${report.dbExists}`,
        `tableExists=${report.tableExists}`,
        `schemaMatch=${report.schemaMatch}`,
        `missingColumns=${JSON.stringify(report.missingColumns)}`,
        `rowCount=${report.rowCount}`,
        `blocker=${report.blocker ?? 'NONE'}`,
        `action=${payload.action}`,
        '',
        'nothing was written; re-run with --apply to create the store',
      ].join('\n') + '\n')
    }
    if (report.blocker === 'SCHEMA_DRIFT') process.exitCode = 3
    return
  }

  if (report.blocker === 'SCHEMA_DRIFT') {
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, mode: 'APPLY', ...report }, null, 2)}\n`)
    else process.stderr.write(`REFUSED: experience_events schema drift detected (missing=${JSON.stringify(report.missingColumns)} extra=${JSON.stringify(report.extraColumns)}); refusing to migrate automatically\n`)
    process.exitCode = 3
    return
  }

  await mkdir(sandboxRoot, { recursive: true })
  const created = applyMigration({ dbPath: report.dbPath })
  await chmod(report.dbPath, 0o600)
  const after = await inspect({ sandboxRoot })
  const payload = { ok: after.schemaMatch, mode: 'APPLY', ...after, created }
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else {
    process.stdout.write([
      `mode=APPLY`,
      `db=${report.dbPath}`,
      `table=${EXPERIENCE_BUFFER_TABLE}`,
      `schemaVersion=${EXPERIENCE_BUFFER_SCHEMA_VERSION}`,
      `schemaMatch=${after.schemaMatch}`,
      `rowCount=${after.rowCount}`,
      `columns=${JSON.stringify(after.existingColumns)}`,
      'petMemoryTouched=NO',
      'conversationArchiveTouched=NO',
    ].join('\n') + '\n')
  }
  if (!after.schemaMatch) process.exitCode = 4
}

// Only run when executed directly, so tests can import the pure helpers.
if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  await main()
}
