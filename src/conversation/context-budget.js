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
