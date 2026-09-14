#!/usr/bin/env node
/**
 * Experience Buffer migration. Default mode is DRY-RUN; --apply is required
 * before this script creates or updates anything in the supplied sandbox.
 */

import { DatabaseSync } from 'node:sqlite'
import { access, chmod, mkdir, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  EXPERIENCE_BUFFER_DB_FILENAME,
  EXPERIENCE_BUFFER_SCHEMA_VERSION,
  EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY,
  EXPERIENCE_BUFFER_TABLE,
  EXPERIENCE_BUFFER_META_TABLE,
  EXPERIENCE_EVENT_COLUMNS,
  experienceBufferSchemaDdl,
} from '../src/experience/experience-buffer-schema.js'

export {
  EXPERIENCE_BUFFER_DB_FILENAME,
  EXPERIENCE_BUFFER_SCHEMA_VERSION,
  EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY,
  EXPERIENCE_BUFFER_TABLE,
  EXPERIENCE_BUFFER_META_TABLE,
  EXPERIENCE_EVENT_COLUMNS,
  experienceBufferSchemaDdl,
}

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
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name))
}

function metaSchemaVersion(db) {
  const exists = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(EXPERIENCE_BUFFER_META_TABLE)
  if (!exists) return null
  const row = db.prepare(
    `SELECT value FROM ${EXPERIENCE_BUFFER_META_TABLE} WHERE key = ?`,
  ).get(EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY)
  return row?.value === undefined ? null : String(row.value)
}

/** Read-only inspection. Opening an existing database readOnly prevents a dry
 * run from creating a WAL or changing any archive/runtime data. */
export async function inspect({ sandboxRoot }) {
  const dbPath = join(sandboxRoot, EXPERIENCE_BUFFER_DB_FILENAME)
  const sandboxExists = await pathExists(sandboxRoot)
  const dbExists = await pathExists(dbPath)
  const result = {
    sandboxRoot,
    dbPath,
    db: dbPath,
    sandboxExists,
    dbExists,
    dbSizeBytes: null,
    tableExists: false,
    existingColumns: [],
    columns: [],
    missingColumns: [...EXPERIENCE_EVENT_COLUMNS],
    extraColumns: [],
    // Columns this script is allowed to ADD to an older store. Taken from the
    // shared schema, minus `id`, which is the table's primary key and can never be
    // added to an existing table.
    upgradableColumns: experienceBufferSchemaDdl().addableColumns.map((column) => column.name),
    rowCount: null,
    schemaVersion: null,
    schemaMatch: false,
    needsCreate: false,
    blocker: null,
  }

  if (dbExists) result.dbSizeBytes = Number((await stat(dbPath)).size)
  if (!sandboxExists) {
    result.needsCreate = true
    result.blocker = 'SANDBOX_MISSING'
    return result
  }
  if (!dbExists) {
    result.needsCreate = true
    return result
  }

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const exists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(EXPERIENCE_BUFFER_TABLE)
    if (!exists) {
      result.needsCreate = true
      return result
    }

    result.tableExists = true
    result.existingColumns = tableColumns(db, EXPERIENCE_BUFFER_TABLE)
    result.columns = [...result.existingColumns]
    const existing = new Set(result.existingColumns)
    const expected = new Set(EXPERIENCE_EVENT_COLUMNS)
    result.missingColumns = EXPERIENCE_EVENT_COLUMNS.filter((column) => !existing.has(column))
    result.extraColumns = result.existingColumns.filter((column) => !expected.has(column))
    result.schemaMatch = result.missingColumns.length === 0 && result.extraColumns.length === 0
    result.schemaVersion = metaSchemaVersion(db)
    // Two very different situations were previously reported as one drift:
    //
    //   - a pure v1 store (the original 12 columns, nothing else) that simply
    //     predates the six visual/session fields. Every missing column is a known
    //     additive upgrade, so `--apply` can ALTER TABLE ADD COLUMN and keep every
    //     recorded experience — exactly what the runtime's `initialize()` does. A
    //     migration script that refuses this leaves operators without a working
    //     entry point while startup silently does the upgrade anyway.
    //   - a table with columns we do not know about. That is real drift: guessing
    //     at it could destroy life data, so it stays refused.
    const additiveOnly = result.extraColumns.length === 0
      && result.missingColumns.every((column) => result.upgradableColumns.includes(column))
    if (result.schemaMatch) {
      result.rowCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${EXPERIENCE_BUFFER_TABLE}`).get()?.n ?? 0)
    } else if (additiveOnly) {
      result.blocker = 'ADDITIVE_UPGRADE'
      result.rowCount = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${EXPERIENCE_BUFFER_TABLE}`).get()?.n ?? 0)
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
    const ddl = experienceBufferSchemaDdl()
    db.exec('PRAGMA busy_timeout = 2000;')
    db.exec('BEGIN IMMEDIATE;')
    try {
      db.exec(ddl.table)
      // SQLite has no `ADD COLUMN IF NOT EXISTS`, so inspect before adding. This
      // is the same additive upgrade the runtime performs; doing it here means an
      // operator can upgrade a store without starting the pet first.
      const existing = new Set(tableColumns(db, EXPERIENCE_BUFFER_TABLE))
      for (const { name, definition } of ddl.addableColumns) {
        if (existing.has(name)) continue
        db.exec(`ALTER TABLE ${EXPERIENCE_BUFFER_TABLE} ADD COLUMN ${name} ${definition}`)
        existing.add(name)
      }
      for (const statement of ddl.indexes) db.exec(statement)
      db.exec(ddl.meta)
      db.prepare(`
        INSERT INTO ${EXPERIENCE_BUFFER_META_TABLE} (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE ${EXPERIENCE_BUFFER_META_TABLE}.value IS NOT excluded.value
      `).run(EXPERIENCE_BUFFER_SCHEMA_VERSION_KEY, String(EXPERIENCE_BUFFER_SCHEMA_VERSION))
      db.exec('COMMIT;')
    } catch (error) {
      try { db.exec('ROLLBACK;') } catch {}
      throw error
    }

    const columns = tableColumns(db, EXPERIENCE_BUFFER_TABLE)
    const expected = new Set(EXPERIENCE_EVENT_COLUMNS)
    const missingColumns = EXPERIENCE_EVENT_COLUMNS.filter((column) => !columns.includes(column))
    const extraColumns = columns.filter((column) => !expected.has(column))
    if (missingColumns.length > 0 || extraColumns.length > 0) {
      throw new Error(`EXPERIENCE_BUFFER_SCHEMA_DRIFT:missing=${missingColumns.join(',')}:extra=${extraColumns.join(',')}`)
    }
    return { columns, schemaVersion: metaSchemaVersion(db) }
  } finally {
    db.close()
  }
}

function actionFor(report) {
  if (report.blocker === 'SCHEMA_DRIFT') return 'REFUSED'
  if (report.needsCreate) return report.blocker === 'SANDBOX_MISSING' ? 'BLOCKED_SANDBOX_MISSING' : 'WOULD_CREATE'
  if (report.blocker === 'ADDITIVE_UPGRADE') return 'WOULD_UPGRADE_ADDITIVE'
  if (report.schemaMatch && report.rowCount === 0 && report.schemaVersion === String(EXPERIENCE_BUFFER_SCHEMA_VERSION)) return 'WOULD_NOOP_EMPTY_TABLE'
  return 'WOULD_NOOP'
}

function outputPayload(mode, report, action, extra = {}) {
  return {
    ...report,
    ok: report.blocker !== 'SCHEMA_DRIFT' && (mode !== 'APPLY' || report.schemaMatch),
    mode,
    db: report.dbPath,
    table: EXPERIENCE_BUFFER_TABLE,
    schemaVersion: String(EXPERIENCE_BUFFER_SCHEMA_VERSION),
    schemaMatch: report.schemaMatch,
    rowCount: report.rowCount,
    columns: report.existingColumns,
    missingColumns: report.missingColumns,
    blocker: report.blocker ?? 'NONE',
    action,
    petMemoryTouched: 'NO',
    conversationArchiveTouched: 'NO',
    EXPERIENCE_SCHEMA_VERSION: EXPERIENCE_BUFFER_SCHEMA_VERSION,
    EXPERIENCE_DB_MODE: '0600',
    ...extra,
  }
}

function printReport(payload) {
  process.stdout.write([
    `mode=${payload.mode}`,
    `db=${payload.db}`,
    `table=${payload.table}`,
    `schemaVersion=${payload.schemaVersion}`,
    `schemaMatch=${payload.schemaMatch}`,
    `rowCount=${payload.rowCount}`,
    `columns=${JSON.stringify(payload.columns)}`,
    `missingColumns=${JSON.stringify(payload.missingColumns)}`,
    `blocker=${payload.blocker}`,
    `action=${payload.action}`,
    `petMemoryTouched=${payload.petMemoryTouched}`,
    `conversationArchiveTouched=${payload.conversationArchiveTouched}`,
    `EXPERIENCE_SCHEMA_VERSION=${payload.EXPERIENCE_SCHEMA_VERSION}`,
    `EXPERIENCE_DB_MODE=${payload.EXPERIENCE_DB_MODE}`,
    payload.mode === 'DRY_RUN' ? 'nothing was written; re-run with --apply to create the store' : '',
  ].join('\n') + '\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!options.sandbox) {
    const usage = 'usage: node scripts/migrate-experience-buffer.mjs --sandbox <dir> [--apply] [--json]'
    if (options.json) process.stdout.write(`${JSON.stringify({ ok: false, reason: 'SANDBOX_REQUIRED' }, null, 2)}\n`)
    else process.stderr.write(`${usage}\n`)
    process.exitCode = 2
    return
  }

  const sandboxRoot = resolve(options.sandbox)
  const report = await inspect({ sandboxRoot })
  if (!options.apply) {
    const payload = outputPayload('DRY_RUN', report, actionFor(report))
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else printReport(payload)
    if (report.blocker === 'SCHEMA_DRIFT') process.exitCode = 3
    return
  }

  if (report.blocker === 'SCHEMA_DRIFT') {
    const payload = outputPayload('APPLY', report, 'REFUSED')
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else printReport(payload)
    process.exitCode = 3
    return
  }

  await mkdir(sandboxRoot, { recursive: true })
  const upgrading = report.blocker === 'ADDITIVE_UPGRADE'
  const created = applyMigration({ dbPath: report.dbPath })
  await chmod(report.dbPath, 0o600)
  const after = await inspect({ sandboxRoot })
  const action = after.schemaMatch ? (upgrading ? 'UPGRADED_ADDITIVE' : 'APPLIED') : 'VERIFY_FAILED'
  const payload = outputPayload('APPLY', after, action, {
    created,
    // Distinguishes "we added the six newer columns to a v1 store and kept every
    // row" from "we created an empty store", so an operator reading the log can
    // tell which happened without comparing row counts by hand.
    upgradedFromVersion: upgrading ? (report.schemaVersion ?? '1') : null,
    rowsPreserved: upgrading ? report.rowCount : null,
  })
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else printReport(payload)
  if (!after.schemaMatch || after.schemaVersion !== String(EXPERIENCE_BUFFER_SCHEMA_VERSION)) process.exitCode = 4
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) await main()
