// Lightweight, deterministic terms shared by Recent and Long-Term Visual.
// This module intentionally deals only with text and never loads image data.

export const CJK_STOP_CHARACTERS = new Set('这个些它那个刚才里面张的是吗呢啊呀我你主人花花再看一下重新仔细清楚图片照片图像截图画面什么真的'.split(''))

export const VISUAL_USER_TEXT_TERM_BOOST = 3
export const VISUAL_OBSERVATION_TERM_BOOST = 1

export function cleanVisualText(value, max = 1200) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max)
}

export function cjkTerms(text) {
  const terms = new Map()
  const runs = cleanVisualText(text).match(/[\u3400-\u9fff]+/gu) ?? []
  for (const run of runs) {
    for (const character of run) {
      if (!CJK_STOP_CHARACTERS.has(character)) terms.set(character, 1)
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const term = run.slice(index, index + 2)
      if ([...term].some((character) => CJK_STOP_CHARACTERS.has(character))) continue
      terms.set(term, 3)
    }
  }
  return terms
}

export function visualKeywordTerms(text) {
  const terms = cjkTerms(text)
  const ascii = cleanVisualText(text).toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]*/giu) ?? []
  for (const term of ascii) terms.set(term, 3)
  return terms
}

export function overlapScore(query, candidateText) {
  const queryTerms = visualKeywordTerms(query)
  const candidateValue = candidateText && typeof candidateText === 'object'
    ? candidateText.userText
    : candidateText
  const candidateTerms = visualKeywordTerms(candidateValue)
  let score = 0
  for (const [term, weight] of queryTerms) {
    if (candidateTerms.has(term)) score += Math.min(weight, candidateTerms.get(term))
  }
  return score
}

export function visualTermsFor(text, { boost = 1, sourceKind = null, sourceRef = null } = {}) {
  const terms = visualKeywordTerms(text)
  const normalizedBoost = Number(boost)
  const multiplier = Number.isFinite(normalizedBoost) ? normalizedBoost : 1
  return [...terms].map(([term, weight]) => ({
    term,
    weight: weight * multiplier,
    sourceKind,
    sourceRef,
  }))
}
