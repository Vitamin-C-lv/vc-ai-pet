import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  VisualExperienceStore,
} from '../src/vision/visual-experience-store.js'
import {
  LongTermVisualResolver,
} from '../src/vision/long-term-visual-recall.js'
import {
  cjkTerms,
  contentQueryTerms,
  ownerExactPhraseBonus,
  visualTermsFor,
} from '../src/vision/visual-keywords.js'

const PRODUCTION_DB = '/tmp/vm-triage-1.2/visual-experience.db'
const FIG_ATTACHMENT = '047fba61-b59e-46f5-a36e-e10c9143d5c8'
const TOM_JERRY_ATTACHMENT = '2c910ee2-fc52-48eb-90b0-eb5456b7af35'
const SHINCHAN_ATTACHMENTS = new Set(['bb87fc0c-5038-4ed0-a94d-a92daa9b2eed', 'd85f70b2-9866-4d24-9f9a-461d5c1a028c'])
const tokenize = (text, { boost }) => visualTermsFor(text, { boost })

async function productionStore() {
  const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-vm-p12-production-copy-'))
  await copyFile(PRODUCTION_DB, join(root, 'visual-experience.db'))
  return { root, store: new VisualExperienceStore(root) }
}

async function fixtureStore(label) {
  const root = await mkdtemp(join(tmpdir(), `vc-ai-pet-vm-p12-${label}-`))
  return { root, store: new VisualExperienceStore(root) }
}

async function addImage(store, id, attachmentId, text) {
  return store.syncMessage({
    id,
    role: 'user',
    text,
    timestamp: 1000,
    attachment: { id: attachmentId, mimeType: 'image/png', assetPath: `${attachmentId}.png` },
  }, { tokenizeText: tokenize })
}

// T1: the old production index has no 无花/花果 entries, so this exercises
// the raw owner-text phrase path as well as the legacy indexed terms.
{
  const { root, store } = await productionStore()
  try {
    const resolver = new LongTermVisualResolver({ experienceStore: store, candidateLimit: 8, minScore: 1 })
    const result = await resolver.resolve('你记得我之前给你发的那盆无花果吗 有很多无花果')
    assert.equal(result.status, 'matched')
    assert.equal(result.candidates[0].attachmentId, FIG_ATTACHMENT)
    assert.equal(result.winner.attachmentId, FIG_ATTACHMENT)
    assert.notEqual(result.winner.attachmentId, TOM_JERRY_ATTACHMENT)
    const margin = result.candidates[0].score - (result.candidates[1]?.score ?? 0)
    assert.ok(margin >= 10)
    assert.ok(result.winner.scoreBreakdown.owner_text_exact > 0)
    console.log(`FIG_TOP1_SCORE=${result.candidates[0].score}`)
    console.log(`FIG_TOP2_SCORE=${result.candidates[1]?.score ?? 0}`)
    console.log(`FIG_MARGIN=${margin}`)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

// T2 + T3: repeated observation evidence is bounded, while an exact owner
// phrase remains decisive and is visible in the score breakdown.
{
  const { root, store } = await fixtureStore('owner-exact')
  try {
    const owner = await addImage(store, 'owner', 'owner-fig', '无花果')
    const noisy = await addImage(store, 'noisy', 'noisy-image', '看好哦这是第一张图片')
    await store.recordEvent({
      eventId: 'noisy-observation',
      experienceId: noisy.experienceId,
      kind: 'observation',
      summary: '无花果无花果无花果 很多这个里面这里画面看到一张照片东西内容',
      terms: visualTermsFor('无花果无花果 很多这个里面这里画面看到一张照片东西内容', { boost: 1 }),
    })
    const query = '以前给你看的无花果'
    const resolver = new LongTermVisualResolver({ experienceStore: store, candidateLimit: 8, minScore: 1 })
    const result = await resolver.resolve(query)
    const ownerCandidate = result.candidates.find(({ experienceId }) => experienceId === owner.experienceId)
    const noisyCandidate = result.candidates.find(({ experienceId }) => experienceId === noisy.experienceId)
    assert.ok(ownerCandidate && noisyCandidate)
    assert.ok(ownerCandidate.score > noisyCandidate.score)
    assert.ok(noisyCandidate.scoreBreakdown.observation_ngram <= 12)

    const exact = await store.searchByTerms(contentQueryTerms('无花果'), {
      limit: 8,
      minScore: 1,
      queryText: '无花果',
    })
    const exactCandidate = exact.find(({ experienceId }) => experienceId === owner.experienceId)
    assert.ok(exactCandidate)
    assert.ok(exactCandidate.scoreBreakdown.owner_text_exact > 0)
    assert.ok(exactCandidate.score > noisyCandidate.score)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

// T4: an owner boilerplate message can still recall a visual identity carried
// only by observation terms.
{
  const { root, store } = await fixtureStore('observation-only')
  try {
    const image = await addImage(store, 'shinchan-observation', 'shinchan-observation-image', '看好哦这是第一张图片')
    await store.recordEvent({
      eventId: 'shinchan-observation-event',
      experienceId: image.experienceId,
      kind: 'observation',
      summary: '这张图是蜡笔小新在公园里玩耍。',
      terms: visualTermsFor('蜡笔小新', { boost: 1 }),
    })
    const result = await new LongTermVisualResolver({ experienceStore: store }).resolve('以前给你看的蜡笔小新')
    assert.equal(result.status, 'matched')
    assert.equal(result.winner.attachmentId, 'shinchan-observation-image')
    assert.equal(result.winner.scoreBreakdown.owner_text_exact, 0)
    assert.ok(result.winner.scoreBreakdown.observation_ngram > 0)
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

// T5: the production index contains two related Shinchan images; neither an
// unrelated image nor boilerplate may become the winner.
{
  const { root, store } = await productionStore()
  try {
    const result = await new LongTermVisualResolver({ experienceStore: store, margin: 8 }).resolve('以前给你看的蜡笔小新')
    assert.equal(result.status, 'matched')
    assert.ok(SHINCHAN_ATTACHMENTS.has(result.winner.attachmentId))
    assert.ok(result.candidates.some(({ attachmentId }) => attachmentId === 'bb87fc0c-5038-4ed0-a94d-a92daa9b2eed'))
    assert.ok(result.candidates.some(({ attachmentId }) => attachmentId === 'd85f70b2-9866-4d24-9f9a-461d5c1a028c'))
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

// T6: two weak, equally relevant-looking candidates must not be promoted to
// a confident match.
{
  const { root, store } = await fixtureStore('weak-ambiguous')
  try {
    const first = await addImage(store, 'weak-a', 'weak-a-image', '看好哦这是第一张图片')
    const second = await addImage(store, 'weak-b', 'weak-b-image', '好呀这是第二张图片')
    for (const [experienceId, eventId] of [[first.experienceId, 'weak-a-observation'], [second.experienceId, 'weak-b-observation']]) {
      await store.recordEvent({
        eventId,
        experienceId,
        kind: 'observation',
        summary: '只有很弱的重叠线索。',
        terms: [{ term: '无花', weight: 3 }],
      })
    }
    const result = await new LongTermVisualResolver({ experienceStore: store }).resolve('以前给你看的无花果')
    assert.notEqual(result.status, 'matched')
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
}

// T7 + T8: public keyword and raw phrase invariants.
assert.equal(cjkTerms('无花果').get('无花果'), 9)
assert.equal(cjkTerms('蜡笔小新').get('蜡笔小新'), 27)
assert.equal(cjkTerms('蜡笔小新').get('小新'), 3)
assert.ok(ownerExactPhraseBonus('你记得我之前给你发的那盆无花果吗 有很多无花果', '你看，无花果到了') > 0)
assert.equal(ownerExactPhraseBonus('…蜡笔小新…', '看好哦这是第一张图片'), 0)

console.log('VISUAL_SCORER_PHASE1_2=PASS')
