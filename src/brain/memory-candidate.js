import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'
import { BELIEF_OUTPUT_SCHEMA } from '../memory/current-belief.js'

export const MEMORY_WRITE_LEVELS = Object.freeze(['user', 'project', 'fact', 'lesson', 'topic'])

export const PET_CHAT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    beliefs: BELIEF_OUTPUT_SCHEMA,
    reply: {
      type: 'string',
      minLength: 1,
      maxLength: 600,
    },
    replyMessages: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', minLength: 1, maxLength: 300 },
    },
    memory: {
      type: 'object',
      additionalProperties: false,
      properties: {
        remember: { type: 'boolean' },
        level: { type: 'string', enum: MEMORY_WRITE_LEVELS },
        content: { type: 'string', maxLength: 160 },
        importance: { type: 'integer', minimum: 1, maximum: 3 },
        keywords: {
          type: 'array',
          maxItems: 6,
          items: { type: 'string', maxLength: 24 },
        },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        evidence: { type: 'string', maxLength: 120 },
      },
      required: ['remember', 'level', 'content', 'importance', 'keywords', 'confidence', 'evidence'],
    },
  },
  required: ['reply', 'memory', 'beliefs'],
})

export const MEMORY_OUTPUT_INSTRUCTION = `

你每次只进行一次回复，同时判断主人当前这句话是否包含值得长期记住的信息。
最终输出必须符合给定 JSON Schema。

reply：
- 就是李花花正常对主人的短回复。
- 保持原来的宠物口吻，通常 1~3 句话。

memory：
- 只能依据“主人当前这一句话”判断，不能把你自己的推测、回复内容或旧记忆重新写成新记忆。
- remember=true 只适用于较稳定、以后再次聊天仍有价值的信息。
- 稳定偏好、主人身份/习惯、长期目标可用 user。
- 长期项目/持续事项可用 project。
- 值得长期保留的共同经历可用 fact。
- 明确学到的相处经验可用 lesson。
- 主人长期反复关心的主题可用 topic。
- 禁止写 soul 或 rules。
- 临时心情、一次性指令、寒暄、夸奖、表情、摸摸头、玩耍、普通问句、短期日程通常 remember=false。
- 如果主人明确说“不要记住 / 别记 / 不要保存”等，必须 remember=false。
- 不要保存密码、token、密钥或认证凭据。
- content 必须是压缩后的单条原子事实，不复制整段聊天。
- evidence 必须逐字来自主人当前消息，是支持该记忆的最短原文片段。
- confidence 表示“当前消息明确支持这条长期记忆”的置信度。
- remember=false 时仍输出完整 memory 对象：level 用 fact，content/evidence 为空字符串，importance=1，keywords=[]，confidence=0。
`.trim()

const LEVELS = new Set(MEMORY_WRITE_LEVELS)

export const EXPLICIT_MEMORY_PHRASES = Object.freeze([
  '记住',
  '记下来',
  '不要忘',
  '别忘了',
  '以后叫',
  '以后知道',
  '记一下',
  '记着',
  '记好',
])

// "别记" / "不用记" are the short forms of "别记住" / "不用记住" and were
// already covered by the previous opt-out rule; keeping them matters because an
// opt-out that stops matching silently turns "forget this" into "store this".
const EXPLICIT_MEMORY_OPT_OUT = /(?:不要|别|不用|不必|不需要|不许)[^忘]{0,8}(?:记住|记下来|记一下|记着|记好|记(?!者|错|混|反|岔)|保存|存下来|存储|存)/iu
const EXPLICIT_MEMORY_QUESTION = /[?？]/u
const EXPLICIT_MEMORY_COMPLETION = /^(?:了|啦|喽|过|吗|么|呢|没有|了吗)/u
const LEADING_MEMORY_DIRECTIVE = /^(?:(?:请|帮我)?(?:你)?(?:要|一定要|千万|务必)?(?:记住|记下来|记一下|记着|记好|不要忘|不要忘记|别忘了|别忘记)(?:一下|哦|吧|啊|呀)?)[，,、:：\s]*/u
const TRAILING_MEMORY_DIRECTIVE = /[，,、；;。\s]+(?:(?:请|帮我)?(?:你)?(?:要|一定要|千万|务必)?(?:记住|记下来|记一下|记着|记好|不要忘|不要忘记|别忘了|别忘记)(?:一下|哦|吧|啊|呀)?)[。！？!?，,、\s]*$/u
/** "你以后知道猫叫黑莓" — the pet is the directive's subject, not the fact. */
const LEADING_PET_DIRECTIVE = /^(?:你|花花|李花花)?(?:以后|今后)(?:要|会|得)?(?:知道|记住|记得)[，,、\s]*/u

function matchingExplicitPhrase(text) {
  return [...EXPLICIT_MEMORY_PHRASES]
    .sort((left, right) => right.length - left.length)
    .find((phrase) => text.includes(phrase)) ?? null
}

function isQuestionLike(text) {
  return EXPLICIT_MEMORY_QUESTION.test(text) || /(?:吗|么)\s*$/u.test(text)
}

function hasSubstantiveClaim(claim, utterance) {
  const remaining = String(claim ?? '')
    .replace(/记住|记下来|记一下|记着|记好|不要忘|不要忘记|别忘了|别忘记|以后叫|以后知道|以后|知道|记得/gu, '')
    .replace(/[，,。:：;；!！？?\s]+/gu, '')
  return remaining.length >= 2
    && /[\u4e00-\u9fffA-Za-z0-9]/u.test(remaining)
    && String(utterance ?? '').length > remaining.length
}

/**
 * Possessive 我-forms that may be rewritten to "主人…". "我们家的" is a household
 * possessive ("我们家的猫叫黑莓" means the household cat). A bare "我们" is
 * deliberately absent: "我们一起去过海边" is a shared experience, not ownership.
 */
const OWNER_POSSESSIVE_FORMS = Object.freeze(['我们家的', '我家的', '我的'])

/**
 * Render the durable content conservatively.
 *
 * A first-person claim ("我的猫叫黑莓", "我最喜欢的颜色是群青色") becomes
 * "主人…": the leading 我 is dropped and, when it was acting as a possessive
 * (我的/我家的), one 的 is kept so the result stays grammatical.
 *
 * 我们-forms are excluded on purpose. "我们家的猫叫黑莓" is about the household
 * cat, and slicing one character off produced the corrupted
 * "主人们家的猫猫叫黑莓" that shipped before. Anything not positively
 * understood keeps the owner's verbatim words behind an explicit prefix, so a
 * mis-parse can never silently invent a different subject.
 */
export function explicitMemoryContent(claim) {
  const text = String(claim ?? '').trim()
  if (!text) return ''
  if (/^我(?!们)/u.test(text)) {
    // "我的X" / "我家的X" keep their 的; "我叫X" simply gains the prefix.
    return `主人${text.slice(1)}`
  }
  return `主人明确要求记住：${text}`
}

/**
 * The single content normalisation shared by every write path.
 *
 * Precedence, in order:
 *   1. a verbatim owner quote — the gate's invariant is that only what the
 *      owner actually said may become a raw fact, so a verified quote always
 *      wins and always lands as "主人说：<quote>";
 *   2. an explicit request that was recognised by rule but had no quotable
 *      claim ("以后叫它黑莓") — keep its explicit phrasing;
 *   3. the model's own summary, used only when nothing else exists.
 */
export function formatMemoryContent({ evidence = '', content = '', explicitContent = '' } = {}) {
  const quote = String(evidence ?? '').trim()
  if (quote) return `主人说：${quote}`
  const explicit = String(explicitContent ?? '').trim()
  if (explicit) return explicit
  return String(content ?? '').trim()
}

/**
 * Explicit requests describe a stable fact about the owner or the household,
 * so they are promoted to `user` level rather than a one-off `fact`.
 *
 * Any first-person claim starting with 我 qualifies ("我的猫叫黑莓",
 * "我最喜欢的颜色是群青色") — except 我们-forms, where the subject is plural
 * and the claim is about a shared experience rather than the owner: that would
 * be a `fact`, and rewriting it to "主人…" would misstate who it is about.
 */
function looksLikeStableIdentityClaim(claim) {
  const text = String(claim ?? '').trim()
  if (!text) return false
  return /^我(?!们)/u.test(text)
}

export function detectExplicitMemoryRequest(userText) {
  const text = String(userText ?? '').trim()
  const optOut = EXPLICIT_MEMORY_OPT_OUT.test(text)
  const phrase = matchingExplicitPhrase(text)
  if (optOut || !phrase || isQuestionLike(text)) {
    return { explicit: false, phrase, optOut, stableIntent: false }
  }

  const phraseIndex = text.indexOf(phrase)
  const afterPhrase = text.slice(phraseIndex + phrase.length).trimStart()
  // Completed recollections such as "我记住了" are not requests to store memory.
  if (EXPLICIT_MEMORY_COMPLETION.test(afterPhrase)) {
    return { explicit: false, phrase, optOut: false, stableIntent: false }
  }

  const evidence = explicitMemoryStatement(text)
  if (!hasSubstantiveClaim(evidence, text)) {
    return { explicit: false, phrase, optOut: false, stableIntent: false }
  }

  return {
    explicit: true,
    phrase,
    optOut: false,
    stableIntent: looksLikeStableIdentityClaim(evidence),
  }
}

export function userOptedOutOfMemory(userText) {
  return EXPLICIT_MEMORY_OPT_OUT.test(String(userText ?? ''))
}

export function userExplicitlyRequestsMemory(userText) {
  return detectExplicitMemoryRequest(userText).explicit
}

export function containsSensitiveMemoryText(text) {
  return /密码|password|token|api\s*key|apikey|密钥|secret|验证码/iu.test(String(text ?? ''))
}

export function explicitMemoryStatement(userText) {
  let text = String(userText ?? '')
    .trim()
    .replace(/^(?:花花|李花花)[，,、\s]*/u, '')

  // Directives can stack ("花花，你记住哦，记住我的猫叫黑莓"), and removing the
  // outer one can expose another. Loop until stable rather than guessing a depth.
  for (let pass = 0; pass < 4; pass += 1) {
    const stripped = text
      .replace(LEADING_PET_DIRECTIVE, '')
      .replace(LEADING_MEMORY_DIRECTIVE, '')
      .trim()
    if (stripped === text) break
    text = stripped
  }

  return text.replace(TRAILING_MEMORY_DIRECTIVE, '').replace(/^[，,。:：;；!！\s]+/u, '').trim()
}

export function highPriorityMemoryCandidate(userText, { modelCandidate = null } = {}) {
  // Deliberately derive the candidate from the owner's words, never from a
  // model summary. The modelCandidate parameter keeps the gate call stable.
  void modelCandidate
  const detection = detectExplicitMemoryRequest(userText)
  if (!detection.explicit || detection.optOut || containsSensitiveMemoryText(userText)) return null

  const evidence = explicitMemoryStatement(userText)
  if (!evidence || containsSensitiveMemoryText(evidence)) return null

  return {
    level: detection.stableIntent ? 'user' : 'fact',
    content: explicitMemoryContent(evidence),
    importance: 3,
    keywords: [],
    confidence: 1,
    evidence,
  }
}

export function createExplicitMemoryFallbackCandidate(userText) {
  return highPriorityMemoryCandidate(userText)
}

export function validateMemoryCandidate(raw, userText) {
  if (!raw || typeof raw !== 'object' || raw.remember !== true) {
    return { accepted: false, reason: 'model-skip', candidate: null }
  }

  if (userOptedOutOfMemory(userText)) {
    return { accepted: false, reason: 'user-opt-out', candidate: null }
  }

  const level = typeof raw.level === 'string' ? raw.level : ''
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.trim() : ''
  const importance = Number(raw.importance)
  const confidence = Number(raw.confidence)

  if (!LEVELS.has(level)) return { accepted: false, reason: 'level-denied', candidate: null }
  if (content.length < 4 || content.length > 160) return { accepted: false, reason: 'content-invalid', candidate: null }
  if (!Number.isInteger(importance) || importance < 2 || importance > 3) return { accepted: false, reason: 'importance-low', candidate: null }
  if (!Number.isFinite(confidence) || confidence < 0.72 || confidence > 1) return { accepted: false, reason: 'confidence-low', candidate: null }
  if (evidence.length < 2 || evidence.length > 120 || !String(userText ?? '').includes(evidence)) {
    return { accepted: false, reason: 'evidence-invalid', candidate: null }
  }

  const normalizeGroundingText = (value) => String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\s]+/gu, '')
  const normalizedEvidence = normalizeGroundingText(evidence)
  const proposedKeywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
  const keywords = [...new Set(proposedKeywords
    .filter((item) => {
      const normalizedKeyword = normalizeGroundingText(item)
      return Boolean(normalizedKeyword && normalizedEvidence.includes(normalizedKeyword))
    })
    .slice(0, 6))]

  // A keyword is a retrieval handle, so a keyword that is not in the evidence was
  // invented. Accepting the candidate while silently dropping its handles would
  // store a row that can never be found again — and, worse, would treat a model
  // that hallucinated its citation as trustworthy. Refusing the whole candidate
  // instead hands the decision to `MemoryGate`, whose explicit-owner fallback
  // rebuilds the candidate from the owner's own words with no keywords at all.
  //
  // Measured consequence of the alternative (keep the candidate, drop the
  // keywords): a candidate whose evidence is the instruction "一定要记住哦" was
  // written to PetMemory as `主人说：一定要记住哦`, because that fallback only runs
  // when validation *fails*.
  if (proposedKeywords.length > 0 && keywords.length === 0) {
    return { accepted: false, reason: 'keywords-ungrounded', candidate: null }
  }

  return {
    accepted: true,
    reason: 'accepted',
    candidate: { level, content, importance, keywords, confidence, evidence },
  }
}

export function parseStructuredChatResponse(text, userText) {
  const rawText = String(text ?? '').trim()
  if (!rawText) throw new Error('PET_LOCAL_MODEL_EMPTY_REPLY')

  try {
    const parsed = JSON.parse(rawText)
    const reply = typeof parsed?.reply === 'string' ? parsed.reply.trim() : ''
    if (!reply) throw new Error('PET_LOCAL_MODEL_EMPTY_REPLY')
    if (!sanitizeSafeTraceText(reply, 600)) throw new Error('PET_LOCAL_MODEL_UNSAFE_REPLY')

    const rawMemoryCandidate = parsed?.memory ?? null
    const checked = validateMemoryCandidate(rawMemoryCandidate, userText)
    const replyMessages = Array.isArray(parsed?.replyMessages)
      && parsed.replyMessages.length >= 1
      && parsed.replyMessages.length <= 3
      && parsed.replyMessages.every((item) => typeof item === 'string' && item.trim().length >= 1 && item.trim().length <= 300 && sanitizeSafeTraceText(item, 300))
      ? parsed.replyMessages.map((item) => item.trim())
      : []
    return {
      text: reply,
      replyMessages,
      memoryCandidate: checked.accepted ? checked.candidate : null,
      rawMemoryCandidate,
      beliefCandidates: Array.isArray(parsed.beliefs) ? parsed.beliefs.slice(0, 2) : [],
      memoryDecision: checked.reason,
      structured: true,
    }
  } catch (error) {
    if (error?.message === 'PET_LOCAL_MODEL_EMPTY_REPLY' || error?.message === 'PET_LOCAL_MODEL_UNSAFE_REPLY') throw error
    // Chat stays usable if structured output is unexpectedly not honored.
    // Memory fails closed: never write from an unparsed response.
    return {
      text: sanitizeSafeTraceText(rawText, 600) || '花花刚才没整理好这句话，再问我一次吧。',
      replyMessages: [],
      memoryCandidate: null,
      rawMemoryCandidate: null,
      memoryDecision: 'structured-parse-failed',
      structured: false,
    }
  }
}
