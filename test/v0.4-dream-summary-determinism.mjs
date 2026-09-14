import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DreamEngine } from '../src/dream/dream-engine.js'
import { PetMemory } from '../src/memory/pet-memory.js'

const NOW = 2_100_000_000_000
const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-dream-summary-'))
const memory = new PetMemory(root)

try {
  const source = memory.remember('fact', '主人今天带花花去公园。', 2, {
    created_at: NOW,
    keywords: ['公园'],
  })
  memory.ensureDreamTracking()
  memory.finishDream(NOW - 1)
  const engine = new DreamEngine({
    memory,
    now: () => NOW,
    brain: {
      dreamCompletion: async () => ({
        ok: true,
        rawText: JSON.stringify({
          summary: '模型说：我生成了三条理解。',
          memories: [],
        }),
      }),
    },
  })

  const result = await engine.run({ now: NOW })
  assert.equal(result.status, 'completed')
  assert.equal(result.derivedCount, 0)
  const log = memory.db.db.prepare('SELECT summary, changes FROM dream_log ORDER BY id DESC LIMIT 1').get()
  assert.equal(log.summary, '花花睡了一会儿，这次没有形成新的长期理解。')
  assert.doesNotMatch(log.summary, /3|三条/u)
  const changes = JSON.parse(log.changes)
  assert.equal(changes.modelSummary, '模型说：我生成了三条理解。')
  assert.deepEqual(changes.derived, [])
  assert.equal(source.content, '主人今天带花花去公园。')
  console.log('MODEL_SUMMARY_SAYS_3_FINAL_DERIVED_0=PASS')
  console.log('DREAM_PUBLIC_SUMMARY_DETERMINISTIC=PASS')
} finally {
  memory.close()
  await rm(root, { recursive: true, force: true })
}

console.log('VC_AI_PET_V0_4_DREAM_SUMMARY_DETERMINISM=PASS')
