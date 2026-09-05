import { formatHistoricalTime } from '../memory/historical-recall.js'
import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'

export const VISUAL_DREAM_CONTEXT_MAX = 4
export const VISUAL_DREAM_OBSERVATIONS_PER_EXPERIENCE = 3

const DECLARATION = '上述 VISUAL EXPERIENCES 中：RAW 是事实；INFERRED 只是当时观察，不能当作新事实，也不能增加证据数。'
let visualTermsLoader

function fallbackTerms(text) {
  const words = String(text ?? '').normalize('NFKC').match(/[\p{L}\p{N}\u4e00-\u9fff]+/gu) ?? []
  const terms = [...new Set(words.map((word) => word.trim()).filter((word) => word.length > 1))]
    .slice(0, 24).map((term) => ({ term, weight: 1 }))
  terms.fallback = true
  return terms
}

async function defaultTermExtractor(text) {
  visualTermsLoader ??= import('../vision/visual-keywords.js').then((module) => module.visualTermsFor).catch(() => null)
  const visualTermsFor = await visualTermsLoader
  if (typeof visualTermsFor === 'function') return visualTermsFor(text, { boost: 1 })
  return fallbackTerms(text)
}

function safeLimit(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(VISUAL_DREAM_CONTEXT_MAX, Math.max(0, Math.floor(number))) : VISUAL_DREAM_CONTEXT_MAX
}

export async function buildVisualDreamContext({
  experienceStore,
  query,
  limit = VISUAL_DREAM_CONTEXT_MAX,
  termExtractor = defaultTermExtractor,
} = {}) {
  if (!experienceStore || typeof experienceStore.searchByTerms !== 'function' || typeof experienceStore.recentObservationsFor !== 'function') return null
  if (typeof termExtractor !== 'function') return null

  const queryTerms = await termExtractor(String(query ?? ''), { boost: 1 })
  const experiences = await experienceStore.searchByTerms(Array.isArray(queryTerms) ? queryTerms : [], {
    limit: safeLimit(limit), minScore: 1,
  })
  if (!Array.isArray(experiences) || experiences.length === 0) return null

  const bounded = experiences.slice(0, VISUAL_DREAM_CONTEXT_MAX)
  const result = []
  let inferredCount = 0
  for (const experience of bounded) {
    const experienceId = experience?.experienceId ?? experience?.experience_id ?? experience?.id
    if (experienceId === null || experienceId === undefined) continue
    const observations = await experienceStore.recentObservationsFor(experienceId, {
      limit: VISUAL_DREAM_OBSERVATIONS_PER_EXPERIENCE,
    })
    const safeObservations = (Array.isArray(observations) ? observations : []).slice(0, VISUAL_DREAM_OBSERVATIONS_PER_EXPERIENCE)
    inferredCount += safeObservations.filter((observation) => sanitizeSafeTraceText(observation?.summary ?? observation, 180)).length
    result.push({
      experienceId: String(experienceId),
      attachmentId: experience?.attachmentId ?? experience?.attachment_id ?? null,
      sourceMessageId: experience?.sourceMessageId ?? experience?.source_message_id ?? null,
      userText: experience?.userText ?? experience?.user_text ?? '',
      occurredAt: experience?.occurredAt ?? experience?.occurred_at ?? null,
      observations: safeObservations,
    })
  }
  if (result.length === 0) return null
  return {
    experiences: result,
    rawCount: result.length,
    inferredCount,
    termExtraction: queryTerms.fallback === true ? 'fallback' : 'visual-keywords',
  }
}

export function formatVisualExperienceSection(visualContext) {
  const experiences = Array.isArray(visualContext?.experiences)
    ? visualContext.experiences.slice(0, VISUAL_DREAM_CONTEXT_MAX) : []
  if (experiences.length === 0) return ''

  const lines = [
    'VISUAL EXPERIENCES',
    'RAW（主人发图事实与原话）：',
  ]
  for (const experience of experiences) {
    const time = formatHistoricalTime(experience?.occurredAt)
    const userText = sanitizeSafeTraceText(experience?.userText, 240) || '（主人未留下文字）'
    lines.push(`- 主人在 ${time} 发了一张图片，这是事实；主人原话：${userText}`)
  }
  lines.push('INFERRED（花花当时的观察，不是事实，只是当时的判断）：')
  for (const experience of experiences) {
    const observations = (Array.isArray(experience?.observations) ? experience.observations : [])
      .map((observation) => sanitizeSafeTraceText(observation?.summary ?? observation, 180))
      .filter(Boolean)
    if (observations.length === 0) lines.push('- 花花当时观察：（当时没有留下观察）')
    else for (const observation of observations.slice(0, VISUAL_DREAM_OBSERVATIONS_PER_EXPERIENCE)) lines.push(`- 花花当时观察：${observation}`)
  }
  return lines.join('\n').slice(0, 1200)
}

export { DECLARATION as VISUAL_DREAM_CONTEXT_DECLARATION }
