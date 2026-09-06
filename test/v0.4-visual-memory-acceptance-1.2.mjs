import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'
import { detectLongTermVisualIntent, LongTermVisualResolver } from '../src/vision/long-term-visual-recall.js'

// Production read-only copy: post-migration state (31 experiences / 12 events /
// 1052 observation terms). The query runs against the REAL migrated index with
// the stale owner-user_text terms (fig has no 无花/花果 bigram because 花 was a
// stop char when the legacy index was built) — the exact-phrase owner bonus must
// still make the fig win.
const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-1.2-'))
const prod = '/tmp/vm-triage-1.2'
await copyFile(join(prod, 'visual-experience.db'), join(root, 'visual-experience.db'))
await copyFile(join(prod, 'conversation-archive.db'), join(root, 'conversation-archive.db'))

const archiveDb = new DatabaseSync(join(root, 'conversation-archive.db'), { readOnly: true })

const store = new VisualExperienceStore(root)
await store.initialize()

const FIG_ATT = '047fba61-b59e-46f5-a36e-e10c9143d5c8'
const TOM_JERRY_ATT = '2c910ee2-fc52-48eb-90b0-eb5456b7af35'
const SHINCHAN_ATTS = new Set(['0be078bf-7128-4b1c-918d-2fdd20a8f8bd', 'd85f70b2-9866-4d24-9f9a-461d5c1a028c', 'bb87fc0c-5038-4ed0-a94d-a92daa9b2eed'])

const resolver = new LongTermVisualResolver({ experienceStore: store, candidateLimit: 8, minScore: 1 })

// ---------------------------------------------------------------- TEST A fig
const Q1 = '你记得我之前给你发的那盆无花果吗 有很多无花果'
assert.equal(detectLongTermVisualIntent(Q1).mode, 'long-term-visual', 'A: fig query must trigger long-term intent')
const fig = await resolver.resolve(Q1, { limit: 8 })
console.log('FIG_RESOLUTION=' + fig.status)
console.log('FIG_TOP1=' + (fig.candidates[0]?.attachmentId ?? 'none'))
console.log('FIG_SCORING=' + JSON.stringify(fig.candidates.map((c) => ({
  att: c.attachmentId?.slice(0, 12),
  score: c.score,
  breakdown: c.scoreBreakdown,
  userText: c.userText,
}))))
assert.equal(fig.status, 'matched', 'A: fig resolution must be matched')
assert.equal(fig.candidates[0].attachmentId, FIG_ATT, 'A: fig must be unique top1')
assert.ok(fig.candidates.every((c) => c.attachmentId !== TOM_JERRY_ATT), 'A: Tom&Jerry must not be the winner')
const figTop = fig.candidates[0]
const figSecond = fig.candidates[1]
const figMargin = figSecond ? figTop.score - figSecond.score : Infinity
console.log('FIG_TOP1_SCORE=' + figTop.score)
console.log('FIG_TOP2_SCORE=' + (figSecond?.score ?? 'none'))
console.log('FIG_MARGIN=' + figMargin)
console.log('FIG_OWNER_EXACT_BONUS=' + (figTop.scoreBreakdown?.owner_text_exact ?? 0))
assert.ok(figMargin > 0, 'A: fig must have a positive semantic margin over second')
assert.ok((figTop.scoreBreakdown?.owner_text_exact ?? 0) > 0, 'A: owner exact-phrase bonus must fire for 无花果')
console.log('ACCEPTANCE_1_2_FIG_UNIQUE_WINNER=PASS')

// ---------------------------------------------------------------- TEST B shinchan
const Q2 = '你还记得我以前给你看的蜡笔小新吗'
assert.equal(detectLongTermVisualIntent(Q2).mode, 'long-term-visual', 'B: shinchan query must trigger long-term intent')
const shinchan = await resolver.resolve(Q2, { limit: 8 })
console.log('SHINCHAN_RESOLUTION=' + shinchan.status)
console.log('SHINCHAN_CANDIDATES=' + JSON.stringify(shinchan.candidates.map((c) => ({
  att: c.attachmentId?.slice(0, 12), score: c.score, breakdown: c.scoreBreakdown,
}))))
assert.notEqual(shinchan.status, 'none', 'B: shinchan must not be NONE (observation recall must survive)')
if (shinchan.status === 'matched') {
  const shinchanTop = shinchan.candidates[0]
  assert.ok(shinchanTop && SHINCHAN_ATTS.has(shinchanTop.attachmentId), 'B: winner must be a shinchan image')
  const unrelatedAtOrAbove = shinchan.candidates.filter((c) => !SHINCHAN_ATTS.has(c.attachmentId) && c.score >= shinchanTop.score)
  assert.equal(unrelatedAtOrAbove.length, 0, 'B: unrelated images must not tie/outrank the shinchan winner')
}
console.log('ACCEPTANCE_1_2_SHINCHAN_OBSERVATION_RECALL=PASS')

store.close()
archiveDb.close()
await rm(root, { recursive: true, force: true })

console.log('VISUAL_MEMORY_ACCEPTANCE_1.2=PASS')
