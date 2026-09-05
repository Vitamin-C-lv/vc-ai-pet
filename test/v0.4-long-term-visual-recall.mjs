import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  detectLongTermVisualIntent,
  LongTermVisualResolver,
} from '../src/vision/long-term-visual-recall.js'
import {
  VISUAL_OBSERVATION_TERM_BOOST,
  VISUAL_USER_TEXT_TERM_BOOST,
  visualTermsFor,
} from '../src/vision/visual-keywords.js'

const root = await mkdtemp(join(tmpdir(), 'vc-ai-pet-long-term-visual-'))

try {
  const shouldTrigger = [
    '以前给你看的那张照片',
    '你还记得那张图片吗',
    '上个月那盆植物',
    '之前很久以前……',
    '以前那只猫',
  ]
  for (const text of shouldTrigger) assert.deepEqual(detectLongTermVisualIntent(text), { mode: 'long-term-visual' }, text)

  const shouldNotTrigger = [
    '刚才的面',
    '上一张',
    '刚才那碗面',
    '现在这张',
    '花花你好',
    '今天天气不错',
    '以前你说过你喜欢什么颜色',
    '',
  ]
  for (const text of shouldNotTrigger) assert.equal(detectLongTermVisualIntent(text), null, text)

  const userTerms = visualTermsFor('植物', {
    boost: VISUAL_USER_TEXT_TERM_BOOST,
    sourceKind: 'user_text',
    sourceRef: 'message-1',
  })
  const observationTerms = visualTermsFor('植物', {
    boost: VISUAL_OBSERVATION_TERM_BOOST,
    sourceKind: 'observation',
    sourceRef: 'event-1',
  })
  assert.equal(userTerms.find(({ term }) => term === '植物').weight, 9)
  assert.equal(observationTerms.find(({ term }) => term === '植物').weight, 3)

  const rows = [{
    experienceId: 'experience-a',
    attachmentId: 'attachment-a',
    sourceMessageId: 'message-a',
    userText: '以前发过的植物照片',
    occurredAt: 100,
    score: 12,
    matchedTerms: [
      { term: '植物', weight: 9, sourceKind: 'user_text' },
      { term: '照片', weight: 3, sourceKind: 'observation' },
    ],
    image: { dataUrl: 'data:image/png;base64,QUFB' },
    assistantReply: '这是一盆植物。',
  }]
  let calls = 0
  let lastQuery = null
  const experienceStore = {
    async searchByTerms(queryTerms, options) {
      calls += 1
      lastQuery = { queryTerms, options }
      return rows
    },
  }
  const resolver = new LongTermVisualResolver({ experienceStore, candidateLimit: 8, minScore: 1 })
  const matched = await resolver.resolve('以前发过的植物照片')
  assert.equal(matched.status, 'matched')
  assert.equal(matched.winner.experienceId, 'experience-a')
  assert.equal(matched.candidates.length, 1)
  assert.deepEqual(matched.winner.provenanceHints, { userTextTermMatches: 1, observationTermMatches: 1 })
  assert.equal(JSON.stringify(matched).includes('data:image'), false)
  assert.equal(JSON.stringify(matched).includes('assistantReply'), false)
  assert.equal(calls, 1)
  assert.equal(lastQuery.options.limit, 8)
  assert.equal(lastQuery.options.minScore, 1)

  const ambiguousStore = {
    async searchByTerms() {
      return [
        { ...rows[0], experienceId: 'experience-a', score: 5, matchedTerms: [] },
        { ...rows[0], experienceId: 'experience-b', attachmentId: 'attachment-b', score: 5, matchedTerms: [] },
      ]
    },
  }
  const ambiguous = await new LongTermVisualResolver({ experienceStore: ambiguousStore }).resolve('以前发过的植物照片')
  assert.equal(ambiguous.status, 'ambiguous')
  assert.equal(ambiguous.winner, null)
  assert.equal(ambiguous.candidates.length, 2)

  const noHitStore = {
    async searchByTerms() {
      return []
    },
  }
  const noHit = await new LongTermVisualResolver({ experienceStore: noHitStore }).resolve('以前发过的植物照片')
  assert.deepEqual(noHit, { status: 'none', candidates: [], winner: null })

  const lowScoreStore = {
    async searchByTerms() {
      return [{ ...rows[0], score: 0 }]
    },
  }
  const lowScore = await new LongTermVisualResolver({ experienceStore: lowScoreStore, minScore: 1 }).resolve('以前发过的植物照片')
  assert.deepEqual(lowScore, { status: 'none', candidates: [], winner: null })

  let unrelatedCalls = 0
  const noCallStore = {
    async searchByTerms() {
      unrelatedCalls += 1
      return rows
    },
  }
  const noCallResolver = new LongTermVisualResolver({ experienceStore: noCallStore })
  assert.deepEqual(await noCallResolver.resolve(''), { status: 'none', candidates: [], winner: null })
  assert.deepEqual(await noCallResolver.resolve('刚才的面'), { status: 'none', candidates: [], winner: null })
  assert.deepEqual(await noCallResolver.resolve('花花你好'), { status: 'none', candidates: [], winner: null })
  assert.equal(unrelatedCalls, 0)
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('LONG_TERM_VISUAL_RECALL=PASS')
