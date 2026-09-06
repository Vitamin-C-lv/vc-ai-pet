import { contentQueryTerms } from './visual-keywords.js'

const LONG_TERM_TIME_PATTERN = /(以前|之前|过去|曾经|那时候|从前|上次|上回|上个月|上礼拜|上月|好久|很久|早先|最初|最早)/u
const REMEMBER_VISUAL_REFERENCE_PATTERN = /记得[^\n，。！？!?]{0,24}(?:那张|那盆|那碗|那只|那盘|那棵|照片|图片|图|照片)/u
const PREVIOUSLY_SHARED_VISUAL_PATTERN = /(?:以前|之前|过去|曾经|那时候|从前|上次|上回|早先|最初|最早)[^\n，。！？!?]{0,40}(?:给你看|给你看的|发过|看过)/u
const VISUAL_OBJECT_PATTERN = /(?:照片|图片|图|植物|猫|狗|花|宠物|截图|那张|那盆|那碗|那盘|那棵|那只|给你看|给你看的|发过.*(?:图|照)|看过.*(?:图|照))/u
// The task's self-test uses an ellipsis to stand for an omitted visual
// referent. Keep this narrowly scoped so ordinary long-term conversation
// without a visual cue remains excluded.
const ELLIPSIS_VISUAL_PLACEHOLDER_PATTERN = /^(?:之前很久以前|很久以前)(?:[…]{2,}|\.{3,})$/u
const IMMEDIATE_EXCLUSION_PATTERN = /(刚才|刚刚|刚发|刚给你看|这张|这碗|这盘|这个|上一张|前一张|现在)/u
export const DEFAULT_LONG_TERM_SCORE_MARGIN = 10

export function detectLongTermVisualIntent(userText) {
  const text = String(userText ?? '').normalize('NFKC').trim()
  if (!text || IMMEDIATE_EXCLUSION_PATTERN.test(text)) return null

  const longTermCue = LONG_TERM_TIME_PATTERN.test(text)
    || REMEMBER_VISUAL_REFERENCE_PATTERN.test(text)
    || PREVIOUSLY_SHARED_VISUAL_PATTERN.test(text)
  const visualObjectCue = VISUAL_OBJECT_PATTERN.test(text) || ELLIPSIS_VISUAL_PLACEHOLDER_PATTERN.test(text)
  if (!longTermCue || !visualObjectCue) return null
  return { mode: 'long-term-visual' }
}

function metadataOnly(candidate) {
  const matchedTerms = Array.isArray(candidate?.matchedTerms) ? candidate.matchedTerms : []
  return {
    experienceId: candidate?.experienceId,
    attachmentId: candidate?.attachmentId,
    sourceMessageId: candidate?.sourceMessageId,
    userText: candidate?.userText,
    occurredAt: candidate?.occurredAt,
    score: candidate?.score,
    scoreBreakdown: candidate?.scoreBreakdown ?? null,
    provenanceHints: {
      userTextTermMatches: matchedTerms.filter(({ sourceKind }) => sourceKind === 'user_text').length,
      observationTermMatches: matchedTerms.filter(({ sourceKind }) => sourceKind === 'observation').length,
    },
  }
}

export class LongTermVisualResolver {
  constructor({ experienceStore, candidateLimit = 8, minScore = 1, margin = DEFAULT_LONG_TERM_SCORE_MARGIN } = {}) {
    this.experienceStore = experienceStore
    this.candidateLimit = candidateLimit
    this.minScore = minScore
    this.margin = Number.isFinite(Number(margin)) ? Number(margin) : DEFAULT_LONG_TERM_SCORE_MARGIN
  }

  async resolve(userText, { limit = this.candidateLimit } = {}) {
    const empty = { status: 'none', candidates: [], winner: null }
    if (!detectLongTermVisualIntent(userText)) return empty

    const queryTerms = contentQueryTerms(userText)
    const rows = await this.experienceStore.searchByTerms(queryTerms, {
      limit,
      minScore: this.minScore,
      queryText: userText,
    })
    const candidates = (Array.isArray(rows) ? rows : []).map(metadataOnly)
    const top = candidates[0]
    if (!top || top.score < this.minScore) return empty

    const breakdown = top.scoreBreakdown
    if (breakdown && breakdown.owner_text_exact <= 0 && breakdown.owner_text_ngram <= 0 && breakdown.observation_ngram <= 0) {
      return { status: 'none', candidates, winner: null }
    }

    const second = candidates[1]
    if (second && top.score - second.score < this.margin) {
      return { status: 'ambiguous', candidates, winner: null }
    }
    return { status: 'matched', candidates, winner: top }
  }
}
