import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DreamEngine } from '../src/dream/dream-engine.js'
import { PetMemory, PET_SEED_SOURCE_SESSION } from '../src/memory/pet-memory.js'

const NOW = 2_200_000_000_000
const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-seed-eligibility-'))
const memory = new PetMemory(root)

try {
  assert.equal(memory.seedIfFresh(NOW), true)
  const seedRows = ['soul', 'fact', 'rules'].flatMap((level) => memory.db.list(level))
  assert.ok(seedRows.length > 0)
  assert.ok(seedRows.filter((row) => row.level !== 'rules').every((row) => row.source_session === PET_SEED_SOURCE_SESSION))
  assert.deepEqual(memory.dreamSourceRows({ after: 0, before: NOW + 1 }), [])
  assert.equal(memory.ensureDreamTracking(), 0)

  const dream = new DreamEngine({
    memory,
    now: () => NOW,
    brain: { dreamCompletion: async () => ({ ok: true, rawText: JSON.stringify({ summary: '不应调用', memories: [] }) }) },
  })
  const emptyDream = await dream.run({ now: NOW })
  assert.equal(emptyDream.status, 'skipped')
  assert.equal(emptyDream.reason, 'no-new-sources')
  console.log('SEED_ROWS_DREAM_ELIGIBLE=NO')

  // A known old bootstrap row is ignored only when it has legacy/system
  // provenance. The row is not rewritten or deleted.
  const legacy = memory.db.insert({
    level: 'fact',
    content: '李花花的生日是 2026-08-31；这一天 VC_AI_PET_V0_1_PASS 正式通过，作为出生纪念日。',
    importance: 3,
    source_session: 'vc-ai-pet',
    created_at: NOW + 1,
  })
  assert.deepEqual(memory.dreamSourceRows({ after: 0, before: NOW + 2 }).map((row) => row.id), [])
  assert.ok(memory.db.list('fact').some((row) => row.id === legacy.id))

  const owner = memory.remember('user', '主人说：我的生日是 3 月 5 日。', 2, {
    created_at: NOW + 2,
    provenance: { source: 'USER_STATEMENT', evidence: 'confirmed' },
  })
  assert.deepEqual(memory.dreamSourceRows({ after: 0, before: NOW + 3 }).map((row) => row.id), [owner.id])
  console.log('LEGACY_BOOTSTRAP_FILTERED_WITHOUT_REWRITE=PASS')
  console.log('OWNER_BIRTHDAY_REMAINS_DREAM_SOURCE=PASS')
} finally {
  memory.close()
  await rm(root, { recursive: true, force: true })
}

console.log('VC_AI_PET_V0_4_SEED_DREAM_ELIGIBILITY=PASS')
