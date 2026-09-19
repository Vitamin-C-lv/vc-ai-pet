/**
 * Dream / Reflection input — recent lived experience.
 *
 * The Experience Buffer holds what actually happened recently, including turns
 * that never became a memory row. Dream used to see only PetMemory, so anything
 * that had not yet been written was invisible to it. This module renders the
 * buffer as an explicitly labelled, non-evidence section so Dream and Reflection
 * can *consider* recent life without ever treating it as proof.
 *
 * The declaration mirrors the visual experience contract: a buffer entry is a
 * record of what was said and done, not a verified long-term memory, and it must
 * never be cited as a `source_id`.
 */

export const EXPERIENCE_DREAM_CONTEXT_DECLARATION = `RECENT EXPERIENCES 是最近真实发生的经历记录，不是长期记忆证据：
- 它们可以用来理解最近发生了什么、有没有反复出现的行为或明显的情绪事件。
- 它们不能作为 source_ids 引用，也不能单独证明某个长期事实成立；这整段内容不能作为 source_ids。
- 图片观察是感知记录，不是花花确认的事实；如果某行有 attachmentId，可以用该 attachmentId 重新查看原图。
- 不要因为一条经历出现过一次就把它写成长期记忆；反复出现才可以形成理解。`

export const RECENT_VISUAL_OBSERVATIONS_DECLARATION = '这些是花花曾经对图片做出的感知观察，不是主人确认事实，不能作为 source_ids，不能增加 evidenceCount，不能提高 confidence；最终事实真值仍以 raw owner evidence 为准。'

const SOURCE_LABELS = Object.freeze({
  explicit_memory: '主人明确要求记住',
  owner_chat: '主人日常',
  pet_vision: '花花看到的',
  embodied_visual_observation: '实体摄像头的短暂视觉经历',
  repeated_behavior: '反复出现',
  emotion_event: '情绪事件',
  system: '系统事件',
})

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/data:[^\s,;]+;base64,[A-Za-z0-9+/=]+/giu, '[图片]')
    .replace(/base64,[A-Za-z0-9+/=]+/giu, '[图片]')
    .replace(/(^|[\s"'([{])([A-Za-z0-9+/]{40,}={0,2})(?=$|[\s"')\]},.;])/gu, '$1[图片]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max)
}

function labelFor(sourceType) {
  return SOURCE_LABELS[sourceType] ?? '经历'
}

function scoreText(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(2) : '-'
}

function visualObservations(entry) {
  const raw = entry?.visualObservation
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw]
  return values.map((value) => cleanText(value, 180)).filter(Boolean)
}

/** One line per experience; deterministic ordering is the caller's business. */
export function formatExperienceEntry(entry) {
  const time = Number.isFinite(Number(entry?.createdAt)) ? new Date(Number(entry.createdAt)).toISOString() : 'unknown'
  const sourceType = cleanText(entry?.sourceType ?? 'owner_chat', 32)
  const isVision = sourceType === 'pet_vision' || sourceType === 'embodied_visual_observation'
  const observations = visualObservations(entry)
  const focus = cleanText(entry?.visualFocus, 120)
  const visualContent = observations.length > 0
    ? `感知记录：${observations.join('；')}${focus ? `；重点：${focus}` : ''}`
    : `感知记录：暂无真实观察记录${cleanText(entry?.visionSummary, 180) ? `；历史图片摘要（非观察）：${cleanText(entry.visionSummary, 180)}` : ''}${cleanText(entry?.content, 180) ? `；原始内容（非观察）：${cleanText(entry.content, 180)}` : ''}`
  const attachment = cleanText(entry?.attachmentId, 80)
  return [
    `- [${time}]`,
    `[source_type=${sourceType}]`,
    `[importance=${scoreText(entry?.importanceScore)}]`,
    `[label=${labelFor(sourceType)}]`,
    isVision
      ? `${visualContent}${attachment ? `；attachmentId=${attachment} 可重新查看原图` : ''}`
      : cleanText(entry?.content, 240) || '(empty experience)',
  ].join(' ')
}

/**
 * @param {{ entries?: object[], limit?: number }} [context]
 * @returns {string} an empty string when there is nothing recent, so callers can
 *   append it unconditionally without leaving empty sections in the prompt.
 */
export function formatExperienceSection(context = null, { limit = 12 } = {}) {
  const entries = Array.isArray(context) ? context : Array.isArray(context?.entries) ? context.entries : []
  const selected = entries.slice(0, limit)
  if (selected.length === 0) return ''
  return ['RECENT EXPERIENCES', selected.map(formatExperienceEntry).join('\n')].join('\n')
}

/**
 * Build the runtime-facing context object. Kept pure so it can be tested and so
 * the runtime only has to pass a buffer in.
 */
export function buildRecentExperienceContext({ entries = [], limit = 12 } = {}) {
  const selected = (Array.isArray(entries) ? entries : []).slice(0, Math.max(0, limit))
  return {
    entries: selected,
    count: selected.length,
    rendered: formatExperienceSection({ entries: selected }, { limit }),
  }
}

/**
 * Render visual observations from the Experience Buffer as Dream background
 * only. They are deliberately kept outside memory/source rows and carry no
 * evidence identity; attachmentId is only an internal re-inspection handle.
 */
export function formatRecentVisualObservations(
  rows = [],
  { limit = 3, windowMs = 24 * 60 * 60 * 1000, now = Date.now() } = {},
) {
  const upper = Number(now)
  const window = Number(windowMs)
  const count = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 3
  if (!Number.isFinite(upper) || !Number.isFinite(window) || window < 0 || count === 0) return ''

  const selected = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const createdAt = Number(row?.createdAt)
    if (!Number.isFinite(createdAt) || createdAt < upper - window || createdAt > upper) continue
    const observations = visualObservations(row)
    for (const observation of observations) {
      selected.push({
        createdAt,
        observation,
        attachmentId: cleanText(row?.attachmentId, 80),
        id: Number(row?.id),
      })
      if (selected.length >= count) break
    }
    if (selected.length >= count) break
  }
  if (selected.length === 0) return ''

  const lines = selected.map(({ createdAt, observation, attachmentId }) => [
    `- [INFERRED] ${new Date(createdAt).toISOString()}：${observation}`,
    attachmentId ? `(attachmentId=${attachmentId} 仅作内部关联)` : '',
  ].filter(Boolean).join(' '))
  return [
    'RECENT VISUAL OBSERVATIONS',
    '最近 24 小时，最多 3 条：',
    ...lines,
    `声明：${RECENT_VISUAL_OBSERVATIONS_DECLARATION}`,
  ].join('\n')
}

export function withExperienceDeclaration(section) {
  return section ? `${section}\n\n${EXPERIENCE_DREAM_CONTEXT_DECLARATION}` : ''
}
