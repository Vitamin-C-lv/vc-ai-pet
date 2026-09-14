import { detectExplicitMemoryRequest } from '../brain/memory-candidate.js'
import {
  CONTEXT_BUDGET_CHARS_DEFAULT,
  SHORT_TERM_CONTEXT_TURNS_DEFAULT,
} from '../memory/memory-pipeline-config.js'

// Single source of truth: the pipeline config owns both numbers. Keeping a
// second copy here meant the selector's fallback could silently disagree with
// the budget the runtime actually passes — and it did (18,000 vs 24,000) after
// the Local Brain calibration.
export const SHORT_TERM_CONTEXT_TURNS = SHORT_TERM_CONTEXT_TURNS_DEFAULT
export const CONTEXT_BUDGET_DEFAULT_CHARS = CONTEXT_BUDGET_CHARS_DEFAULT
export const CONTEXT_PRIORITY = Object.freeze({ HIGH: 3, MEDIUM: 2, LOW: 1 })
export const CONTEXT_WINDOW_TOKENS_FALLBACK = 16_384
export const CONTEXT_OUTPUT_SAFETY_MARGIN_TOKENS = 256

const INVALID_TURNS_REASON = 'invalid-turns-input'
const INVALID_OPTION_REASON = 'invalid-option-fallback'

function textOf(value) {
  try {
    return String(value ?? '').trim()
  } catch {
    return ''
  }
}

function isTurn(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.user === 'string'
    && typeof value.assistant === 'string'
}

function turnChars(turn) {
  return turn.user.length + turn.assistant.length
}

function emptyResult(reason) {
  return {
    turns: [],
    dropped: 0,
    reasons: {
      droppedByMaxTurns: 0,
      droppedByPriority: { HIGH: 0, MEDIUM: 0, LOW: 0 },
      droppedByReserve: 0,
      reservedTurns: 0,
      reservedChars: 0,
      reservedExceedsBudget: false,
      invalidInput: reason,
      invalidOptions: [],
    },
    approxChars: 0,
    approxTokens: 0,
  }
}

function normalizeOption(value, fallback, { allowZero = true } = {}) {
  if (value === undefined) return { value: fallback, reason: null }
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value < 1)) {
    return { value: fallback, reason: INVALID_OPTION_REASON }
  }
  return { value, reason: null }
}

/**
 * Resolve the process setting without allowing a malformed environment value
 * to widen the in-memory context beyond the frozen short-term limit.
 */
export function resolveShortTermContextTurns(env = process.env) {
  let raw
  try {
    raw = env && typeof env === 'object' ? env.SHORT_TERM_CONTEXT_TURNS : undefined
  } catch {
    raw = undefined
  }

  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { turns: SHORT_TERM_CONTEXT_TURNS, source: 'default', reason: 'env-not-set' }
  }

  const value = String(raw).trim()
  if (!/^\d+$/u.test(value)) {
    return { turns: SHORT_TERM_CONTEXT_TURNS, source: 'default', reason: 'invalid-value' }
  }

  const turns = Number(value)
  if (!Number.isInteger(turns) || turns < 1 || turns > SHORT_TERM_CONTEXT_TURNS) {
    return { turns: SHORT_TERM_CONTEXT_TURNS, source: 'default', reason: 'invalid-value' }
  }

  return { turns, source: 'env', reason: null }
}

function hasIdentitySignal(text) {
  const identity = /(?:名字|名叫|叫|生日|出生|年龄|岁|性别|公狗|母狗|男生|女生|品种|习惯|爱吃|喜欢|不喜欢|讨厌)/u
  const petOrOwner = /(?:我(?:的|家)|我们家|猫猫|狗狗|猫|狗|宠物|花花|主人|家人)/u
  return identity.test(text) && petOrOwner.test(text)
}

function hasRelationshipAssertion(text) {
  const relationship = /(?:主人|家人|爸爸|妈妈|猫猫|狗狗|猫|狗|宠物|我家|我们家)/u
  const assertion = /(?:是|叫|喜欢|不喜欢|最爱|讨厌|关系|属于|养|照顾|陪|住|有)/u
  return relationship.test(text) && assertion.test(text)
}

function hasRecentBehaviorSignal(text) {
  const timeOrFrequency = /(?:又|还是|每天|经常|总是|常常|一直|反复|再一次|重复|最近|这几天|刚刚|刚才|今天|昨晚|现在)/u
  const behavior = /(?:吃|睡|玩|跑|等|叫|回来|散步|叼|蹭|趴|门口|做|出现|去了|回来)/u
  return timeOrFrequency.test(text) && behavior.test(text)
}

/** Classify one turn using only local text; malformed values safely become LOW. */
export function classifyTurnPriority(input = {}) {
  try {
    const { user = '', assistant = '' } = input && typeof input === 'object' ? input : {}
    const userText = textOf(user)
    const text = `${userText}\n${textOf(assistant)}`.trim()
    if (!text) return 'LOW'

    let explicit = false
    try {
      explicit = detectExplicitMemoryRequest(userText).explicit === true
    } catch {
      explicit = false
    }

    if (explicit || hasIdentitySignal(text) || hasRelationshipAssertion(text)) return 'HIGH'
    if (hasRecentBehaviorSignal(text)) return 'MEDIUM'
    return 'LOW'
  } catch {
    return 'LOW'
  }
}

function priorityName(priority) {
  return Object.entries(CONTEXT_PRIORITY).find(([, value]) => value === priority)?.[0] ?? 'LOW'
}

/**
 * Keep the newest bounded window, then spend the character budget by semantic
 * priority. Reserved turns are never candidates for removal, even if they
 * alone exceed the requested budget.
 */
export function selectContextTurns(turns, options = {}) {
  if (!Array.isArray(turns)) return emptyResult(INVALID_TURNS_REASON)
  if (turns.some((turn) => !isTurn(turn))) return emptyResult('invalid-turn-entry')

  let maxTurns
  let maxChars
  let reservedTurns = 6
  try {
    ({ maxTurns, maxChars, reservedTurns = 6 } = options ?? {})
  } catch {
    return emptyResult('invalid-options-input')
  }

  const maxTurnsOption = normalizeOption(maxTurns, SHORT_TERM_CONTEXT_TURNS)
  const maxCharsOption = normalizeOption(maxChars, CONTEXT_BUDGET_DEFAULT_CHARS)
  const reservedOption = normalizeOption(reservedTurns, 6)
  const invalidOptions = [maxTurnsOption, maxCharsOption, reservedOption]
    .filter(({ reason }) => reason)
    .map(() => INVALID_OPTION_REASON)

  const boundedTurns = maxTurnsOption.value === 0
    ? []
    : turns.slice(-Math.min(maxTurnsOption.value, turns.length))
  const reserveCount = Math.min(reservedOption.value, boundedTurns.length)
  const reservedStart = boundedTurns.length - reserveCount
  const reservedChars = boundedTurns.slice(reservedStart).reduce((total, turn) => total + turnChars(turn), 0)
  const keep = new Set(Array.from({ length: reserveCount }, (_, offset) => reservedStart + offset))
  let totalChars = boundedTurns.reduce((total, turn) => total + turnChars(turn), 0)

  const candidates = boundedTurns
    .map((turn, index) => ({ index, priority: CONTEXT_PRIORITY[classifyTurnPriority(turn)] }))
    .filter(({ index }) => !keep.has(index))
    // Lower priority is discarded first; older turns come first within a tier.
    .sort((left, right) => left.priority - right.priority || left.index - right.index)

  const droppedByPriority = { HIGH: 0, MEDIUM: 0, LOW: 0 }
  const droppedIndexes = new Set()
  let candidateIndex = 0
  while (totalChars > maxCharsOption.value && candidateIndex < candidates.length) {
    const candidate = candidates[candidateIndex]
    candidateIndex += 1
    droppedIndexes.add(candidate.index)
    totalChars -= turnChars(boundedTurns[candidate.index])
    droppedByPriority[priorityName(candidate.priority)] += 1
  }

  const selected = boundedTurns.filter((_, index) => !droppedIndexes.has(index))
  const droppedByMaxTurns = turns.length - boundedTurns.length
  const result = {
    turns: selected,
    dropped: turns.length - selected.length,
    reasons: {
      droppedByMaxTurns,
      droppedByPriority,
      droppedByReserve: 0,
      reservedTurns: reserveCount,
      reservedChars,
      reservedExceedsBudget: reservedChars > maxCharsOption.value,
      invalidInput: null,
      invalidOptions,
    },
    approxChars: totalChars,
    approxTokens: Math.ceil(totalChars / 2),
  }
  return result
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      if (typeof item.text === 'string') return item.text
      if (typeof item.content === 'string') return item.content
      if (Array.isArray(item.content)) return contentText(item.content)
      if (item.type === 'image_url' || item.image_url || item.type === 'image') return '\u0000PET_IMAGE_CONTEXT\u0000'
      return ''
    }).join(' ')
  }
  if (content && typeof content === 'object') return contentText([content])
  return textOf(content)
}

/**
 * Conservative, dependency-free Qwen planning estimate. It intentionally
 * overestimates CJK and short fragments, then adds message framing overhead;
 * the Local Brain tokenizer remains the source of truth for measurement.
 */
export function estimateContextTokens(value) {
  const text = contentText(value)
  if (!text) return 0
  const imageCount = (text.match(/\u0000PET_IMAGE_CONTEXT\u0000/gu) ?? []).length
  const textWithoutImages = text.replace(/\u0000PET_IMAGE_CONTEXT\u0000/gu, '')
  let cjk = 0
  let ascii = 0
  let other = 0
  for (const character of textWithoutImages) {
    if (/\p{Script=Han}/u.test(character)) cjk += 1
    else if (/^[\x00-\x7F]$/u.test(character)) ascii += 1
    else other += 1
  }
  // A single Qwen vision input can occupy substantially more context than its
  // short JSON marker; reserve a conservative image budget for the final guard.
  return imageCount * 4_096 + Math.ceil(cjk * 1.15 + ascii / 3.5 + other * 1.1)
}

function messageTokens(message) {
  return estimateContextTokens(message?.content ?? message) + 8
}

function normalizeFinalTurns(turns) {
  if (!Array.isArray(turns)) return []
  return turns.filter((turn) => isTurn(turn)).map((turn) => ({
    user: textOf(turn.user),
    assistant: textOf(turn.assistant),
  }))
}

function finalTurnTokens(turn) {
  return estimateContextTokens(turn.user) + estimateContextTokens(turn.assistant) + 16
}

function finalPriority(turn) {
  return CONTEXT_PRIORITY[classifyTurnPriority(turn)]
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

/**
 * Plan the final request payload against the model's real context window.
 * Turns are removed in LOW -> MEDIUM -> HIGH / oldest-first order, while the
 * newest reserve is protected until every older candidate has been removed.
 * If even the system/current request cannot fit, `overflow` is true and the
 * caller must not send it.
 */
export function planFinalRequestBudget({
  system = '',
  memories = [],
  recentTurns = [],
  currentUser = '',
  outputReserveTokens = 1,
  contextWindowTokens = CONTEXT_WINDOW_TOKENS_FALLBACK,
  reservedTurns = 6,
} = {}) {
  const window = normalizePositiveInteger(contextWindowTokens, CONTEXT_WINDOW_TOKENS_FALLBACK)
  const outputReserve = normalizePositiveInteger(outputReserveTokens, CONTEXT_OUTPUT_SAFETY_MARGIN_TOKENS)
  const turns = normalizeFinalTurns(recentTurns)
  const reserveCount = Math.min(normalizePositiveInteger(reservedTurns, 6), turns.length)
  const reservedStart = turns.length - reserveCount
  const systemTokens = messageTokens({ content: system })
  const memoryTokens = (Array.isArray(memories) ? memories : [memories])
    .reduce((total, memory) => total + messageTokens({ content: memory?.content ?? memory }), 0)
  const currentTokens = messageTokens({ content: currentUser })
  const baseTokens = systemTokens + memoryTokens + currentTokens + outputReserve
  const turnEntries = turns.map((turn, index) => ({
    index,
    turn,
    priority: finalPriority(turn),
    tokens: finalTurnTokens(turn),
    reserved: index >= reservedStart,
  }))
  const dropped = []
  let promptTokens = baseTokens + turnEntries.reduce((total, entry) => total + entry.tokens, 0)

  const oldCandidates = turnEntries
    .filter((entry) => !entry.reserved)
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
  for (const entry of oldCandidates) {
    if (promptTokens <= window) break
    promptTokens -= entry.tokens
    dropped.push({ index: entry.index, priority: priorityName(entry.priority), reserved: false })
    entry.dropped = true
  }

  // Last resort: even the protected recent reserve may be reduced, oldest
  // HIGH first, then MEDIUM/LOW, so an oversized payload is never sent.
  if (promptTokens > window) {
    const reserveCandidates = turnEntries
      .filter((entry) => entry.reserved && !entry.dropped)
      .sort((left, right) => right.priority - left.priority || left.index - right.index)
    for (const entry of reserveCandidates) {
      if (promptTokens <= window) break
      promptTokens -= entry.tokens
      dropped.push({ index: entry.index, priority: priorityName(entry.priority), reserved: true })
      entry.dropped = true
    }
  }

  const kept = turnEntries
    .filter((entry) => !entry.dropped)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.turn)
  const overflow = promptTokens > window
  return {
    turns: kept,
    dropped,
    overflow,
    estimatedTokens: promptTokens,
    promptTokens: Math.max(0, promptTokens - outputReserve),
    outputReserveTokens: outputReserve,
    contextWindowTokens: window,
    reservedTurns: reserveCount,
  }
}
