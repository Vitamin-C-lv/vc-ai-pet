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
    for (let n = 2; n <= 4; n += 1) {
      const weight = 3 ** (n - 1)
      for (let index = 0; index + n <= run.length; index += 1) {
        const term = run.slice(index, index + n)
        const characters = [...term]
        if (characters.every((character) => CJK_STOP_CHARACTERS.has(character))) continue
        terms.set(term, weight)
      }
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

// Routing boilerplate is useful for detecting a visual request, but it is not
// useful evidence for choosing among long-term visual experiences.
export const GENERIC_RECALL_TERMS = new Set([
  '给', '发', '记', '得', '之', '前', '还', '请', '帮', '看', '张', '图', '片',
  '记得', '之前', '前给', '以前', '给你', '你看', '看的', '图片', '照片',
  '那张', '这张', '一张', '第一', '第二', '上次', '发过', '看过', '给我', '发给',
  '很多', '这个', '里面', '这里', '画面', '看到', '东西', '内容', '很', '多', '内', '里',
  '画', '照', '有',
])

export function suppressGenericTerms(terms) {
  if (!Array.isArray(terms)) return []
  return terms.filter(({ term }) => !GENERIC_RECALL_TERMS.has(term))
}

export function contentQueryTerms(text) {
  return suppressGenericTerms(visualTermsFor(text, { boost: 1 }))
}

// A stop character can still be part of a meaningful compound (花 in 无花果).
// Phrase quality therefore rejects boilerplate and all-stop phrases, while
// allowing a semantic compound to retain its full raw substring.
const GENERIC_PHRASE_CHARACTERS = new Set([
  ...CJK_STOP_CHARACTERS,
  '很', '多', '内', '里', '画', '看', '张', '照', '片', '有',
])
GENERIC_PHRASE_CHARACTERS.delete('花')

function highInformationCjkPhrases(text) {
  const phrases = new Set()
  const runs = cleanVisualText(text).match(/[\u3400-\u9fff]+/gu) ?? []
  for (const run of runs) {
    for (let n = 4; n >= 3; n -= 1) {
      for (let index = 0; index + n <= run.length; index += 1) {
        const phrase = run.slice(index, index + n)
        if (GENERIC_RECALL_TERMS.has(phrase)) continue
        const characters = [...phrase]
        if (characters.every((character) => CJK_STOP_CHARACTERS.has(character))) continue
        const contentCharacters = characters.filter((character) => !GENERIC_PHRASE_CHARACTERS.has(character))
        if (contentCharacters.length < 3) continue
        phrases.add(phrase)
      }
    }
  }
  return [...phrases]
}

export function ownerExactPhrases(queryText) {
  return highInformationCjkPhrases(queryText)
}

export function ownerExactPhraseMatches(queryText, userText) {
  const ownerText = cleanVisualText(userText)
  if (!ownerText) return []
  return ownerExactPhrases(queryText)
    .filter((phrase) => ownerText.includes(phrase))
}

export function ownerExactPhraseBonus(queryText, userText) {
  return ownerExactPhraseMatches(queryText, userText).length * 50
}
