import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { PetMemory } from '../src/memory/pet-memory.js'

const execFileAsync = promisify(execFile)
const script = resolve(new URL('../scripts/backfill-explicit-memory-from-archive.mjs', import.meta.url).pathname)

function run(root, ...args) {
  return execFileAsync(process.execPath, [script, '--sandbox', root, ...args], { encoding: 'utf8' })
}

function countMemories(root) {
  const memory = new PetMemory(root)
  try {
    return ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
      .reduce((count, level) => count + memory.db.list(level).length, 0)
  } finally {
    memory.close()
  }
}

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-explicit-backfill-'))
const archivePath = join(root, 'conversation-archive.db')
try {
  const archive = new DatabaseSync(archivePath)
  archive.exec(`
    CREATE TABLE raw_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      payload TEXT NOT NULL
    );
  `)
  const insert = archive.prepare('INSERT INTO raw_messages(id, role, payload) VALUES (?, ?, ?)')
  insert.run('archive-blackberry', 'user', JSON.stringify({ id: 'archive-blackberry', role: 'user', text: '记住我们家的猫猫叫黑莓', timestamp: 100 }))
  insert.run('archive-question', 'user', JSON.stringify({ id: 'archive-question', role: 'user', text: '今天会下雨吗？', timestamp: 101 }))
  insert.run('archive-optout', 'user', JSON.stringify({ id: 'archive-optout', role: 'user', text: '不要记住我喜欢榴莲', timestamp: 102 }))
  insert.run('archive-sensitive', 'user', JSON.stringify({ id: 'archive-sensitive', role: 'user', text: '记住我的密码是hunter2', timestamp: 103 }))
  insert.run('archive-assistant', 'assistant', JSON.stringify({ id: 'archive-assistant', role: 'assistant', text: '黑莓是一只猫', timestamp: 104 }))
  archive.close()

  const beforeBytes = await readFile(archivePath)
  const beforeStat = await stat(archivePath)
  const beforeArchive = new DatabaseSync(archivePath)
  const beforeRows = Number(beforeArchive.prepare('SELECT COUNT(*) AS n FROM raw_messages').get().n)
  beforeArchive.close()
  const beforeMemoryCount = countMemories(root)

  const dry = await run(root)
  assert.equal(dry.stdout, [
    'SCANNED_USER_MESSAGES=4',
    'EXPLICIT_CANDIDATES=1',
    'WOULD_WRITE=1',
    'DUPLICATES=0',
    'SENSITIVE_REJECTED=1',
    'OTHER_SKIPPED=2',
    '',
  ].join('\n'))
  assert.equal(countMemories(root), beforeMemoryCount)
  assert.deepEqual(await readFile(archivePath), beforeBytes)
  assert.equal((await stat(archivePath)).mtimeMs, beforeStat.mtimeMs)
  const dryArchive = new DatabaseSync(archivePath)
  assert.equal(Number(dryArchive.prepare('SELECT COUNT(*) AS n FROM raw_messages').get().n), beforeRows)
  dryArchive.close()
  console.log('BACKFILL_DRY_RUN_NO_MEMORY_OR_ARCHIVE_WRITE=PASS')

  const applied = await run(root, '--apply')
  assert.match(applied.stdout, /WOULD_WRITE=1/)
  assert.match(applied.stdout, /IDEMPOTENT=NO/)
  const memory = new PetMemory(root)
  try {
    const row = memory.db.list('fact').find((item) => item.content === '主人说：我们家的猫猫叫黑莓')
    assert.ok(row, 'backfill must create the literal explicit-memory raw fact')
    const provenance = memory.provenanceForMemory(row.id)
    assert.equal(provenance.evidence, 'confirmed')
    assert.equal(provenance.messageId, 'archive-blackberry')
    // MemoryGate marks the successful explicit path as USER_EXPLICIT; the
    // persisted PetMemory provenance remains the repository's accepted-gate
    // source for compatibility with the existing provenance vocabulary.
  } finally {
    memory.close()
  }
  assert.deepEqual(await readFile(archivePath), beforeBytes)
  assert.equal((await stat(archivePath)).mtimeMs, beforeStat.mtimeMs)
  const afterApplyArchive = new DatabaseSync(archivePath)
  assert.equal(Number(afterApplyArchive.prepare('SELECT COUNT(*) AS n FROM raw_messages').get().n), beforeRows)
  afterApplyArchive.close()
  console.log('BACKFILL_APPLY_RAW_FACT_AND_PROVENANCE=PASS')

  const second = await run(root, '--apply')
  assert.match(second.stdout, /WOULD_WRITE=0/)
  assert.match(second.stdout, /DUPLICATES=1/)
  assert.match(second.stdout, /IDEMPOTENT=YES/)
  assert.equal(countMemories(root), beforeMemoryCount + 1)
  assert.deepEqual(await readFile(archivePath), beforeBytes)
  assert.equal((await stat(archivePath)).mtimeMs, beforeStat.mtimeMs)
  console.log('BACKFILL_SECOND_APPLY_IDEMPOTENT=PASS')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('VC_AI_PET_V0_4_EXPLICIT_MEMORY_BACKFILL=PASS')

