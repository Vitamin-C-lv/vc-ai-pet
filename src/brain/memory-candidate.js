import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'

export const MEMORY_WRITE_LEVELS = Object.freeze(['user', 'project', 'fact', 'lesson', 'topic'])

export const PET_CHAT_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
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
  required: ['reply', 'memory'],
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

export function userOptedOutOfMemory(userText) {
  const text = String(userText ?? '')
  return /(?:不要|别|不用|不许).{0,8}(?:记住|记下来|记|保存|存下来)/u.test(text)
}

export function userExplicitlyRequestsMemory(userText) {
  if (userOptedOutOfMemory(userText)) return false
  return /(?:帮我)?(?:你)?(?:记住|记下来|记一下|记着|记好)/u.test(String(userText ?? ''))
}

export function containsSensitiveMemoryText(text) {
  return /密码|password|token|api\s*key|apikey|密钥|secret|验证码/iu.test(String(text ?? ''))
}

function explicitMemoryStatement(userText) {
  return String(userText ?? '')
    .trim()
    .replace(/^(?:花花|李花花)[，,、\s]*/u, '')
    .replace(/^(?:(?:请|帮我)?(?:你)?(?:记住|记下来|记一下|记着|记好)(?:一下|哦|吧)?)[，,:：\s]*/u, '')
    .trim()
}

export function createExplicitMemoryFallbackCandidate(userText) {
  if (userOptedOutOfMemory(userText) || !userExplicitlyRequestsMemory(userText)) return null

  const evidence = explicitMemoryStatement(userText)
  if (!evidence || containsSensitiveMemoryText(evidence)) return null

  const isOwnerStatement = /^(?:我|我的)/u.test(evidence)
  const content = evidence.startsWith('我的')
    ? `主人${evidence.slice(1)}`
    : evidence.startsWith('我')
      ? `主人${evidence.slice(1)}`
      : `主人明确要求记住：${evidence}`

  return {
    level: isOwnerStatement ? 'user' : 'fact',
    content,
    importance: 3,
    keywords: [],
    confidence: 1,
    evidence,
  }
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

  const keywords = Array.isArray(raw.keywords)
    ? [...new Set(raw.keywords
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6))]
    : []

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
