import assert from 'node:assert/strict'

import {
  GENERIC_RECALL_TERMS,
  cjkTerms,
  contentQueryTerms,
  suppressGenericTerms,
  visualTermsFor,
} from '../src/vision/visual-keywords.js'
import { LongTermVisualResolver } from '../src/vision/long-term-visual-recall.js'

const asMap = (terms) => new Map(terms.map(({ term, weight }) => [term, weight]))

for (const term of ['花果', '无花', '小新', '蜡笔']) {
  assert.equal(cjkTerms(term).get(term), 3, `${term} should survive a single stop-side bigram`)
}
for (const term of ['看看', '这张']) {
  assert.equal(cjkTerms(term).has(term), false, `${term} should be filtered when both sides are stop`)
}

const forbiddenContentTerms = ['无', '果', '盆', '蜡', '笔', '小', '新', '花果', '无花', '蜡笔', '笔小', '小新', '盆无']
for (const term of forbiddenContentTerms) {
  assert.equal(GENERIC_RECALL_TERMS.has(term), false, `${term} must not be generic`)
}

const fruitQuery = '你记得我之前给你发的那盆无花果吗'
const fruitTerms = contentQueryTerms(fruitQuery)
const fruitTermMap = asMap(fruitTerms)
for (const term of ['给', '发', '记', '得', '之', '前', '记得', '之前', '前给']) {
  assert.equal(fruitTermMap.has(term), false, `${term} should be suppressed from long-term query`)
}
for (const term of ['无', '果', '盆', '盆无', '花果']) {
  assert.equal(fruitTermMap.has(term), true, `${term} should remain content`)
}

const shinchanQuery = '你还记得我之前给你看的蜡笔小新吗'
const shinchanTermMap = asMap(contentQueryTerms(shinchanQuery))
for (const term of ['蜡笔', '笔小', '小新']) assert.equal(shinchanTermMap.get(term), 3)

const makeCandidate = (experienceId, terms) => ({
  experienceId,
  attachmentId: `attachment-${experienceId}`,
  sourceMessageId: `message-${experienceId}`,
  userText: experienceId,
  occurredAt: 100,
  terms,
})

const candidates = [
  makeCandidate('fig-root', [
    { term: '无', weight: 3, sourceKind: 'user_text' },
    { term: '果', weight: 3, sourceKind: 'user_text' },
    { term: '花果', weight: 9, sourceKind: 'user_text' },
  ]),
  makeCandidate('give-different-root', [
    { term: '给', weight: 3, sourceKind: 'user_text' },
  ]),
  makeCandidate('send-different-root', [
    { term: '发', weight: 3, sourceKind: 'user_text' },
  ]),
  makeCandidate('shinchan-root', [
    { term: '蜡笔', weight: 3, sourceKind: 'observation' },
    { term: '笔小', weight: 3, sourceKind: 'observation' },
    { term: '小新', weight: 3, sourceKind: 'observation' },
  ]),
]

let lastBreakdown = null
const experienceStore = {
  async searchByTerms(queryTerms, { limit, minScore }) {
    const query = new Map(queryTerms.map(({ term, weight }) => [term, weight]))
    const scored = candidates.map((candidate) => {
      const matchedTerms = candidate.terms
        .filter(({ term }) => query.has(term))
        .map((storedTerm) => ({
          ...storedTerm,
          queryWeight: query.get(storedTerm.term),
          contribution: Math.min(query.get(storedTerm.term), storedTerm.weight),
        }))
      return {
        ...candidate,
        matchedTerms,
        score: matchedTerms.reduce((total, match) => total + match.contribution, 0),
      }
    }).sort((left, right) => right.score - left.score)
    lastBreakdown = { queryTerms, candidates: scored }
    return scored.filter(({ score }) => score >= minScore).slice(0, limit)
  },
}

const resolver = new LongTermVisualResolver({ experienceStore, candidateLimit: 8, minScore: 1 })
const fruitResult = await resolver.resolve(fruitQuery)
assert.equal(fruitResult.status, 'matched')
assert.equal(fruitResult.winner.experienceId, 'fig-root')
assert.equal(fruitResult.candidates[0].experienceId, 'fig-root')
assert.equal(lastBreakdown.candidates.find(({ experienceId }) => experienceId === 'fig-root').score, 5)
assert.equal(lastBreakdown.candidates.find(({ experienceId }) => experienceId === 'give-different-root').score, 0)
assert.equal(lastBreakdown.candidates.find(({ experienceId }) => experienceId === 'send-different-root').score, 0)
console.log('FRUIT_SCORE_BREAKDOWN=' + JSON.stringify(lastBreakdown))

const shinchanResult = await resolver.resolve(shinchanQuery)
assert.equal(shinchanResult.status, 'matched')
assert.equal(shinchanResult.winner.experienceId, 'shinchan-root')
assert.equal(lastBreakdown.candidates.find(({ experienceId }) => experienceId === 'shinchan-root').score, 9)
assert.equal(lastBreakdown.candidates.find(({ experienceId }) => experienceId === 'give-different-root').score, 0)
assert.equal(lastBreakdown.candidates.find(({ experienceId }) => experienceId === 'send-different-root').score, 0)
console.log('SHINCHAN_SCORE_BREAKDOWN=' + JSON.stringify(lastBreakdown))

assert.deepEqual(suppressGenericTerms(visualTermsFor('给发无花果')), contentQueryTerms('给发无花果'))
console.log('VISUAL_KEYWORD_SCORER=PASS')
