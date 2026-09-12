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
- 它们不能作为 source_ids 引用，也不能单独证明某个长期事实成立。
- 不要因为一条经历出现过一次就把它写成长期记忆；反复出现才可以形成理解。`

const SOURCE_LABELS = Object.freeze({
  explicit_memory: '主人明确要求记住',
  owner_chat: '主人日常',
  pet_vision: '花花看到的',
  repeated_behavior: '反复出现',
  emotion_event: '情绪事件',
  system: '系统事件',
})

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function labelFor(sourceType) {
  return SOURCE_LABELS[sourceType] ?? '经历'
}

function scoreText(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(2) : '-'
}

/** One line per experience; deterministic ordering is the caller's business. */
export function formatExperienceEntry(entry) {
  const time = Number.isFinite(Number(entry?.createdAt)) ? new Date(Number(entry.createdAt)).toISOString() : 'unknown'
  return [
    `- [${time}]`,
    `[source_type=${cleanText(entry?.sourceType ?? 'owner_chat', 32)}]`,
    `[importance=${scoreText(entry?.importanceScore)}]`,
    `[label=${labelFor(entry?.sourceType)}]`,
    cleanText(entry?.content, 240) || '(empty experience)',
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

export function withExperienceDeclaration(section) {
  return section ? `${section}\n\n${EXPERIENCE_DREAM_CONTEXT_DECLARATION}` : ''
}
