import { CJK_STOP_CHARACTERS, visualKeywordTerms } from '../vision/visual-keywords.js'

export const VISUAL_RECALL_CONTEXT_TTL_MS = 30 * 60 * 1000
export const VISUAL_RECALL_CONTEXT_MAX_USES = 3

const MAX_FOLLOW_UP_LENGTH = 24
const LONG_TERM_TRIGGER_PATTERN = /(以前|之前|过去|曾经|那时候|从前|上次|上回|上个月|上礼拜|上月|好久|很久|早先|最初|最早|记得|给你看|给你看的|发过|看过)/u
const STRONG_VISUAL_TRIGGER_PATTERN = /(照片|图片|图像|截图|画面|图里|图中|看一下|再看看|看看|重新看看|仔细看看|仔细看|看清楚|你再看|找不同|比较|对比|区别|不同)/u
const COMPARISON_PATTERN = /(两张|这两个|这两幅|比较|区别|不同|哪里不一样|找不同|对比|相比|(?:和|跟|与).{0,8}(?:区别|不同|比较))/u
const GREETING_PATTERN = /^(?:(?:花花)?(?:你好|嗨|哈喽|hello|hi|早上好|晚上好|晚安)|谢谢|感谢)[。！!？?]?$/iu
const TRAILING_PUNCTUATION_PATTERN = /[？?！!。．.，,、；;：:]+$/u

function normalizedText(text) {
  return String(text ?? '').normalize('NFKC').trim()
}

function isShortText(text) {
  return [...text].length > 0 && [...text].length <= MAX_FOLLOW_UP_LENGTH
}

function hasContentTerms(text) {
  return [...visualKeywordTerms(text).keys()].some((term) => [...term].some((character) => !CJK_STOP_CHARACTERS.has(character)))
}

function isGreeting(text) {
  return GREETING_PATTERN.test(text)
}

function isStrongVisualOrLongTerm(text) {
  return LONG_TERM_TRIGGER_PATTERN.test(text) || STRONG_VISUAL_TRIGGER_PATTERN.test(text)
}

function stripTopicShape(text) {
  let subject = text.replace(TRAILING_PUNCTUATION_PATTERN, '').trim()
  subject = subject.replace(/^(?:那再|还有|再|那)/u, '').trim()
  subject = subject.replace(/^那个/u, '').trim()
  subject = subject.replace(/那个$/u, '').trim()
  subject = subject.replace(/(?:呢|呀|啊)$/u, '').trim()
  return subject
}

function clone(value) {
  if (value === undefined) return undefined
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

export function detectEllipticalFollowUp(text) {
  const normalized = normalizedText(text)
  if (!isShortText(normalized) || isGreeting(normalized) || isStrongVisualOrLongTerm(normalized)) return null

  const subject = stripTopicShape(normalized)
  const hasTopicPrefix = /^(?:那再|还有|再|那)/u.test(normalized)
  const hasTopicSuffix = /(?:呢|呀|啊)[？?！!。．.]?$/u.test(normalized)
  if ((hasTopicPrefix || hasTopicSuffix) && subject && hasContentTerms(subject)) {
    return { kind: 'topic_shift', subject }
  }

  if (COMPARISON_PATTERN.test(normalized)) return null
  return { kind: 'refine' }
}

export class VisualRecallContext {
  constructor({ now = () => Date.now(), ttlMs = VISUAL_RECALL_CONTEXT_TTL_MS, maxUses = VISUAL_RECALL_CONTEXT_MAX_USES } = {}) {
    this.now = now
    this.ttlMs = ttlMs
    this.maxUses = maxUses
    this.state = null
  }

  record({ mode, query, result } = {}) {
    const normalizedQuery = normalizedText(query)
    if (!normalizedQuery || !['long_term_visual_recall', 'visual_recall_ambiguous'].includes(mode)) {
      this.clear()
      return null
    }
    this.state = {
      mode,
      query: normalizedQuery,
      result: clone(result ?? null),
      createdAt: this.now(),
      uses: 0,
    }
    return this.snapshot()
  }

  active() {
    if (!this.state) return false
    const age = this.now() - this.state.createdAt
    if (age >= this.ttlMs || this.state.uses >= this.maxUses) {
      this.clear()
      return false
    }
    return true
  }

  buildFollowUpQuery(followUp) {
    if (!this.active() || !followUp || !this.state) return null
    if (followUp.kind === 'topic_shift') {
      const subject = normalizedText(followUp.subject).replace(/^那个/u, '').trim()
      if (!subject || !hasContentTerms(subject)) return null
      return `你还记得我以前给你看的${subject}吗`
    }
    if (followUp.kind === 'refine') {
      const text = normalizedText(followUp.text)
      if (!text || !isShortText(text)) return null
      return `${this.state.query} ${text}`.trim()
    }
    return null
  }

  consume(text) {
    if (!this.active()) return null
    const followUp = typeof text === 'string'
      ? detectEllipticalFollowUp(text)
      : text
    const query = this.buildFollowUpQuery({ ...followUp, text: typeof text === 'string' ? text : followUp?.text })
    if (!query) return null
    this.state.uses += 1
    return query
  }

  clear() {
    this.state = null
  }

  snapshot() {
    return clone(this.state)
  }
}
