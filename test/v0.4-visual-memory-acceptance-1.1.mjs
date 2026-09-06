import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { VisualExperienceStore } from '../src/vision/visual-experience-store.js'
import { importLegacyObservations } from '../src/vision/legacy-observation-importer.js'
import { visualTermsFor } from '../src/vision/visual-keywords.js'
import { detectLongTermVisualIntent, LongTermVisualResolver } from '../src/vision/long-term-visual-recall.js'

// Production read-only copy. Migration and dry-run mutate this COPY only.
const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-accept-1.1-'))
const prod = '/tmp/vm-triage-1.1'
await copyFile(join(prod, 'visual-experience.db'), join(root, 'visual-experience.db'))
await copyFile(join(prod, 'conversation-archive.db'), join(root, 'conversation-archive.db'))

const archiveDb = new DatabaseSync(join(root, 'conversation-archive.db'), { readOnly: true })
const readBatch = (afterSequence, limit) => archiveDb.prepare('SELECT sequence, payload FROM raw_messages WHERE sequence > ? ORDER BY sequence LIMIT ?')
  .all(afterSequence, limit).map((row) => ({ archiveSequence: row.sequence, ...JSON.parse(row.payload) }))
const readMaxSequence = () => Number(archiveDb.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM raw_messages').get().n)

const store = new VisualExperienceStore(root)
await store.initialize()

const FIG_ATT = '047fba61-b59e-46f5-a36e-e10c9143d5c8'
const SHINCHAN_ATTS = new Set(['0be078bf-7128-4b1c-918d-2fdd20a8f8bd', 'd85f70b2-9866-4d24-9f9a-461d5c1a028c', 'bb87fc0c-5038-4ed0-a94d-a92daa9b2eed'])

// Coverage BEFORE: experiences with any indexed term (user_text only at this point).
const countAllExperiences = () => Number(store.db.prepare('SELECT COUNT(*) AS n FROM visual_experiences').get().n)
const countWithTerms = () => Number(store.db.prepare(`
  SELECT COUNT(*) AS n FROM visual_experiences e
  WHERE EXISTS (SELECT 1 FROM visual_terms t WHERE t.experience_id = e.experience_id)
`).get().n)
const totalExperiences = countAllExperiences()
const coverageBefore = countWithTerms()
const eventsBefore = Number(store.db.prepare('SELECT COUNT(*) AS n FROM visual_events').get().n)

// ---------------------------------------------------------------- migration
const migration1 = await importLegacyObservations({
  store,
  readBatch,
  readMaxSequence,
  tokenizeText: (text, { boost }) => visualTermsFor(text, { boost }),
})
console.log('LEGACY_OBSERVATIONS_TOTAL=' + migration1.total)
console.log('LEGACY_OBSERVATIONS_MAPPED=' + migration1.mapped)
console.log('LEGACY_OBSERVATIONS_SKIPPED_AMBIGUOUS=' + migration1.skippedAmbiguous)
console.log('MODEL_CALLS_DURING_MIGRATION=' + migration1.modelCalls)
assert.equal(migration1.modelCalls, 0, 'TEST_A: zero model calls during migration')
assert.ok(migration1.mapped > 0, 'legacy observations must actually map')

const eventsAfter1 = Number(store.db.prepare('SELECT COUNT(*) AS n FROM visual_events').get().n)
const termsAfter1 = Number(store.db.prepare("SELECT COUNT(*) AS n FROM visual_terms WHERE source_kind='observation'").get().n)
console.log('VISUAL_EVENTS_IMPORTED=' + (eventsAfter1 - eventsBefore))
console.log('OBSERVATION_TERMS_IMPORTED=' + termsAfter1)
assert.ok(eventsAfter1 - eventsBefore >= migration1.mapped, 'one event per mapped observation (or more from counters)')
assert.ok(termsAfter1 > 0, 'observation terms must be indexed')

// Idempotency: second run must not add events.
const migration2 = await importLegacyObservations({ store, readBatch, readMaxSequence, tokenizeText: (text, { boost }) => visualTermsFor(text, { boost }) })
const eventsAfter2 = Number(store.db.prepare('SELECT COUNT(*) AS n FROM visual_events').get().n)
assert.equal(eventsAfter2, eventsAfter1, 'TEST_B: no duplicate events on re-migration')
console.log('MIGRATION_IDEMPOTENT=YES')

const coverageAfter = countWithTerms()
console.log('SEMANTIC_COVERAGE_BEFORE=' + coverageBefore + '/' + totalExperiences)
console.log('SEMANTIC_COVERAGE_AFTER=' + coverageAfter + '/' + totalExperiences)
assert.ok(coverageAfter >= coverageBefore, 'coverage must not shrink')

// ---------------------------------------------------------------- TEST_D fig
const resolver = new LongTermVisualResolver({ experienceStore: store, candidateLimit: 8, minScore: 1 })
const Q1 = '你记得我之前给你发的那盆无花果吗'
assert.equal(detectLongTermVisualIntent(Q1).mode, 'long-term-visual')
const fig = await resolver.resolve(Q1, { limit: 8 })
console.log('FIG_QUERY_RESOLUTION=' + fig.status)
console.log('FIG_QUERY_TOP1=' + (fig.candidates[0]?.attachmentId ?? 'none'))
console.log('FIG_SCORING=' + JSON.stringify(fig.candidates.map((c) => ({ att: c.attachmentId.slice(0, 12), score: c.score, hints: c.provenanceHints }))))
assert.equal(fig.candidates[0].attachmentId, FIG_ATT, 'TEST_D: fig root must be unique top1')
assert.equal(fig.status, 'matched', 'TEST_D: fig resolution must be matched')
const noise = fig.candidates.filter((c) => c.attachmentId === 'f0f9cea0-f543-4d81-9cf8-71177bef89f4' || c.attachmentId === '2c910ee2-fc52-48eb-90b0-eb5456b7af35')
assert.deepEqual(noise, [], 'TEST_D: generic 给/发 noise candidates must be demoted out of top')
console.log('FIG_NOISE_CANDIDATES_DEMOTED=YES')

// ---------------------------------------------------------------- TEST_E shinchan
const Q2 = '你还记得我之前给你看的蜡笔小新吗'
assert.equal(detectLongTermVisualIntent(Q2).mode, 'long-term-visual')
const shinchan = await resolver.resolve(Q2, { limit: 8 })
console.log('SHINCHAN_RESOLUTION=' + shinchan.status)
console.log('SHINCHAN_CANDIDATES=' + JSON.stringify(shinchan.candidates.map((c) => ({ att: c.attachmentId.slice(0, 12), score: c.score, hints: c.provenanceHints }))))
assert.notEqual(shinchan.status, 'none', 'TEST_E: shinchan must not be NONE after observation import')
const shinchanTop = shinchan.candidates[0]
assert.ok(shinchanTop && SHINCHAN_ATTS.has(shinchanTop.attachmentId), 'TEST_E: winner must be a shinchan image')
const unrelatedAtOrAbove = shinchan.candidates.filter((c) => !SHINCHAN_ATTS.has(c.attachmentId) && c.score >= shinchanTop.score)
assert.equal(unrelatedAtOrAbove.length, 0, 'TEST_E: unrelated images must not tie/outrank the shinchan winner')
const relatedCount = shinchan.candidates.filter((c) => SHINCHAN_ATTS.has(c.attachmentId)).length
console.log('SHINCHAN_RELATED_CANDIDATES=' + relatedCount)
console.log('SHINCHAN_UNRELATED_TOP_CANDIDATES=' + (shinchan.candidates.length - relatedCount))

store.close()
archiveDb.close()
await rm(root, { recursive: true, force: true })

console.log('VISUAL_MEMORY_ACCEPTANCE_1.1=PASS')
