import { PET_REASONING_PROFILE, validateLocalBrainConfig } from './local-brain-config.js'
import { LocalBrainApiError, LocalBrainClient } from './local-brain-client.js'
import { buildPetMessages, PET_VOICE_INSTRUCTION } from './prompt-builder.js'
import { PET_CHAT_RESPONSE_SCHEMA, MEMORY_OUTPUT_INSTRUCTION, parseStructuredChatResponse } from './memory-candidate.js'
import { detectHistoricalRecallIntent } from '../memory/historical-recall.js'
import { readConfirmedVisualNames, captionIdentityLabels, captionMatchesNamedSubject } from '../memory/visual-naming-context.js'
import { getCurrentTimeContext } from '../core/time-context.js'
import { normalizeVisionImage, VISION_ONLY_MESSAGE } from './vision-input.js'
import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'
import { BELIEF_OUTPUT_INSTRUCTION, formatBeliefContext, groundedBeliefReply } from '../memory/current-belief.js'
import { planFinalRequestBudget, CONTEXT_OUTPUT_SAFETY_MARGIN_TOKENS } from '../conversation/context-budget.js'

export const PET_VISUAL_STEP_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    observation: { type: 'string', maxLength: 180 },
    action: { type: 'string', enum: ['inspect', 'answer'] },
    nextVisualId: { type: 'string', maxLength: 16 },
    focus: { type: 'string', maxLength: 120 },
    replyMessages: { type: 'array', maxItems: 3, items: { type: 'string', minLength: 1, maxLength: 300 } },
  },
  required: ['observation', 'action', 'nextVisualId', 'focus', 'replyMessages'],
})

export const PET_VISUAL_RECALL_STEP_RESPONSE_SCHEMA = Object.freeze({
  ...PET_VISUAL_STEP_RESPONSE_SCHEMA,
  properties: {
    ...PET_VISUAL_STEP_RESPONSE_SCHEMA.properties,
    match: { type: 'string', enum: ['match', 'mismatch', 'uncertain'] },
  },
  required: [...PET_VISUAL_STEP_RESPONSE_SCHEMA.required, 'match'],
})

const PET_VISUAL_SEARCH_RESPONSE_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { visualIds: { type: 'array', maxItems: 5, items: { type: 'string' } } },
  required: ['visualIds'],
})

const PET_CHAT_VISUAL_RECALL_RESPONSE_SCHEMA = Object.freeze({
  ...PET_CHAT_RESPONSE_SCHEMA,
  properties: {
    ...PET_CHAT_RESPONSE_SCHEMA.properties,
    visualRecall: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            tool: { type: 'string', enum: ['search_visual_memory'] },
            query: { type: 'string', minLength: 1, maxLength: 240 },
            goal: { type: 'string', enum: ['describe_subject', 'find_photo'] },
          },
          required: ['tool', 'query', 'goal'],
        },
        { type: 'null' },
      ],
    },
  },
  required: [...PET_CHAT_RESPONSE_SCHEMA.required, 'visualRecall'],
})
const VISUAL_RECALL_WAITING_REPLY = '花花去图库找找，再看一遍。'

const VISUAL_RECALL_META_CUES = /(?:算法|原理|机制|流程|接口|代码|技术细节|(?:怎么|如何).{0,8}(?:检索|识别|读取|工作|实现|运作)|(?:视觉|图像|相册|图片|照片)?(?:检索|识别).{0,8}(?:算法|原理|机制|流程)|(?:会不会|能不能|可不可以).{0,8}(?:看|读|识别|检索).{0,8}(?:照片|图片|图像|相册)|(?:你|花花).{0,5}(?:会|能|可以).{0,4}(?:看|读|识别).{0,4}(?:照片|图片|图像))/iu

function isVisualRecallMetaQuestion(userText) {
  const text = String(userText ?? '').normalize('NFKC').trim()
  return VISUAL_RECALL_META_CUES.test(text)
    || /为什么.{0,12}(?:看|读)(?:了)?(?:图片|照片).{0,12}(?:像|变成).{0,4}(?:机器人|AI|助手)/iu.test(text)
}

function validateVisualRecallResponse(response, userText) {
  const recall = response?.visualRecall
  if (isVisualRecallMetaQuestion(userText) || !recall || typeof recall !== 'object' || Array.isArray(recall)) return null
  if (Object.keys(recall).length !== 3 || !Object.hasOwn(recall, 'tool') || !Object.hasOwn(recall, 'query') || !Object.hasOwn(recall, 'goal')) return null
  if (recall.tool !== 'search_visual_memory' || typeof recall.query !== 'string') return null
  const query = recall.query.trim()
  if (!query || query.length > 240 || !['describe_subject', 'find_photo'].includes(recall.goal)) return null
  return { tool: 'search_visual_memory', query, goal: recall.goal }
}

// The visual profile reserves 2,048 tokens for Qwen's hidden reasoning. The
// previous 768-token cap could therefore end with finish_reason=length before
// the public JSON was emitted, which surfaced as PET_LOCAL_BRAIN_BAD_RESPONSE.
export const PET_VISUAL_STEP_MAX_TOKENS = 4_096

export const LOCAL_BRAIN_QUEUE_FULL_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000])

function invalidVisualStep(reason) {
  return { ok: false, reason }
}

function visualStepContent(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((part) => {
    if (typeof part === 'string') return part
    if (part && typeof part === 'object' && ['text', 'input_text'].includes(part.type)) return String(part.text ?? '')
    return ''
  }).join('')
}

export function validateVisualStepResponse(value, { candidateIds = [], forceAnswer = false, verifyRecall = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidVisualStep('object-required')
  const required = ['observation', 'action', 'nextVisualId', 'focus', 'replyMessages', ...(verifyRecall ? ['match'] : [])]
  if (required.some((key) => !Object.hasOwn(value, key))) return invalidVisualStep('required-field-missing')
  if (Object.keys(value).some((key) => !required.includes(key))) return invalidVisualStep('unknown-field')
  if (typeof value.observation !== 'string' || value.observation.trim().length > 180) return invalidVisualStep('observation-invalid')
  if (value.observation.trim() && !sanitizeSafeTraceText(value.observation, 180)) return invalidVisualStep('observation-unsafe')
  if (value.action !== 'inspect' && value.action !== 'answer') return invalidVisualStep('action-invalid')
  if (verifyRecall && value.action !== 'answer') return invalidVisualStep('recall-action-invalid')
  if (typeof value.nextVisualId !== 'string' || value.nextVisualId.trim().length > 16) return invalidVisualStep('next-visual-id-invalid')
  if (typeof value.focus !== 'string' || value.focus.trim().length > 120) return invalidVisualStep('focus-invalid')
  if (value.focus.trim() && !sanitizeSafeTraceText(value.focus, 120)) return invalidVisualStep('focus-unsafe')
  if (verifyRecall && !['match', 'mismatch', 'uncertain'].includes(value.match)) return invalidVisualStep('recall-match-invalid')
  if (!Array.isArray(value.replyMessages) || value.replyMessages.length > 3) return invalidVisualStep('reply-messages-invalid')
  const replyMessages = []
  for (const item of value.replyMessages) {
    if (typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 300) return invalidVisualStep('reply-message-invalid')
    if (!sanitizeSafeTraceText(item, 300)) return invalidVisualStep('reply-message-unsafe')
    replyMessages.push(item.trim())
  }

  const requested = value.nextVisualId.trim()
  if (verifyRecall && (requested || (value.match === 'match' && replyMessages.length === 0))) return invalidVisualStep('recall-reply-invalid')
  if (value.action === 'inspect' && !forceAnswer) {
    if (!requested || (candidateIds.length > 0 && !candidateIds.includes(requested))) return invalidVisualStep('inspect-target-invalid')
  }
  if (value.action === 'answer' && (requested || (!forceAnswer && replyMessages.length === 0 && !(verifyRecall && value.match !== 'match')))) return invalidVisualStep('answer-shape-invalid')

  return {
    ok: true,
    ...(verifyRecall ? { match: value.match } : {}),
    observation: value.observation.trim(),
    action: forceAnswer ? 'answer' : value.action,
    nextVisualId: forceAnswer ? '' : value.action === 'inspect' ? requested : '',
    focus: value.focus.trim(),
    replyMessages,
  }
}

/**
 * Validate the perception-only response used when the pet re-opens a remembered
 * picture while consolidating memory.
 *
 * Hard invariants kept from the interactive validator: the observation must be
 * non-empty, safe to store (no prompts, reasoning or payloads), and within the
 * 180-character budget; the focus stays within 120. Dropped on purpose: `action`,
 * `nextVisualId` and `replyMessages`, because a memory review neither navigates
 * nor speaks to the owner — and the real model reliably supplies the perception
 * while those protocol fields drift.
 */
export function validateMemoryReviewResponse(value, { requireObservation = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidVisualStep('object-required')
  if (typeof value.observation !== 'string') return invalidVisualStep('observation-invalid')
  const observation = value.observation.trim()
  if (!observation && requireObservation) return invalidVisualStep('observation-invalid')
  if (observation.length > 180) return invalidVisualStep('observation-invalid')
  if (observation && !sanitizeSafeTraceText(observation, 180)) return invalidVisualStep('observation-unsafe')
  const rawFocus = typeof value.focus === 'string' ? value.focus.trim() : ''
  if (rawFocus.length > 120) return invalidVisualStep('focus-invalid')
  const focus = rawFocus && sanitizeSafeTraceText(rawFocus, 120) ? rawFocus : ''
  return {
    ok: true,
    observation,
    action: 'answer',
    nextVisualId: '',
    focus,
    replyMessages: [],
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canRetryQueueFull(error) {
  return error?.code === 'LOCAL_BRAIN_QUEUE_FULL' && error?.retryable === true
}

function monotonicNow() {
  try {
    const value = globalThis.performance?.now?.()
    if (Number.isFinite(value)) return value
  } catch {
    // Fall through to the wall-clock fallback for older Node runtimes.
  }
  return Date.now()
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(monotonicNow() - startedAt))
}

function recentMessagesToTurns(messages = []) {
  const turns = []
  let pendingUser = null
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    const content = typeof message.content === 'string' ? message.content : ''
    if (message.role === 'user') {
      if (pendingUser !== null) turns.push({ user: pendingUser, assistant: '' })
      pendingUser = content
    } else if (pendingUser !== null) {
      turns.push({ user: pendingUser, assistant: content })
      pendingUser = null
    } else {
      turns.push({ user: '', assistant: content })
    }
  }
  if (pendingUser !== null) turns.push({ user: pendingUser, assistant: '' })
  return turns
}

function turnsToRecentMessages(turns = []) {
  return turns.flatMap(({ user, assistant }) => [
    ...(user ? [{ role: 'user', content: user }] : []),
    ...(assistant ? [{ role: 'assistant', content: assistant }] : []),
  ])
}

async function chatWithBoundedQueueRetry(client, request) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.chat(request)
    } catch (error) {
      const delay = LOCAL_BRAIN_QUEUE_FULL_RETRY_DELAYS_MS[attempt]
      if (!canRetryQueueFull(error) || delay === undefined) throw error
      await wait(delay)
    }
  }
}

export class LocalBrain {
  constructor({ config = {}, memory, client = null, timeProvider = getCurrentTimeContext, logger = null, reasoningDebugStore = null }) {
    this.config = validateLocalBrainConfig(config)
    this.memory = memory
    this.timeProvider = typeof timeProvider === 'function' ? timeProvider : getCurrentTimeContext
    this.logger = logger
    this.client = client ?? new LocalBrainClient({
      baseUrl: this.config.baseUrl,
      healthTimeoutMs: this.config.healthTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
      onResponse: (response) => reasoningDebugStore?.capture?.(response),
    })
  }

  async health() {
    return this.client.health()
  }

  async visualSearch({ userText, candidates = [] }) {
    const images = candidates.map(({ visualId, image }) => ({ visualId, image: normalizeVisionImage(image) }))
      .filter(({ visualId, image }) => /^V\d{1,3}$/u.test(String(visualId)) && image)
      .slice(0, 10)
    if (images.length === 0) return { ok: true, visualIds: [] }
    const content = [{ type: 'text', text: `主人要找的图片：${String(userText ?? '').slice(0, 500)}\n下面每个 V 编号对应一张低清晰度预览图。只按画面内容选择最可能符合主体、物体及场景关系的编号，按可能性排序，最多5个；不能看清或没有相关图片就返回空数组。不要根据编号猜测。` }]
    for (const { visualId, image } of images) {
      content.push({ type: 'text', text: visualId })
      content.push({ type: 'image_url', image_url: { url: image.dataUrl } })
    }
    try {
      const { payload } = await chatWithBoundedQueueRetry(this.client, {
        messages: [
          { role: 'system', content: '你是李花花，正在私下筛选照片候选。只输出 JSON，字段 visualIds 是候选编号数组。不要回复主人，不要输出推理过程。' },
          { role: 'user', content },
        ],
        reasoningEffort: PET_REASONING_PROFILE.vision,
        reasoningStage: 'visual-search',
        temperature: 0,
        maxTokens: PET_VISUAL_STEP_MAX_TOKENS,
        responseFormat: { type: 'json_object', schema: PET_VISUAL_SEARCH_RESPONSE_SCHEMA },
      })
      const parsed = JSON.parse(visualStepContent(payload?.choices?.[0]?.message))
      const allowed = new Set(images.map(({ visualId }) => visualId))
      const rawIds = Array.isArray(parsed?.visualIds) && parsed.visualIds.length === 1
        && typeof parsed.visualIds[0] === 'string' && parsed.visualIds[0].startsWith('{')
        ? JSON.parse(parsed.visualIds[0])?.visualIds
        : parsed?.visualIds
      const visualIds = Array.isArray(rawIds) ? rawIds.map((id) =>
        /^\d{1,3}$/u.test(String(id)) ? `V${id}` : id) : null
      if (!visualIds || visualIds.length > 5
        || visualIds.some((id) => !allowed.has(id)) || new Set(visualIds).size !== visualIds.length) {
        throw new LocalBrainApiError('invalid visual search result', { code: 'PET_LOCAL_BRAIN_BAD_VISUAL_SEARCH' })
      }
      return { ok: true, visualIds }
    } catch (error) {
      if (error?.retryable) return { ok: false, unavailable: true, reason: 'local-brain-unavailable' }
      throw error
    }
  }

  async visualStep({ userText, image, candidatePool = [], observations = [], comparison = false, comparisonPair = [], currentVisualId = '', inspections = [], requiredUniqueImages = 1, forceAnswer = false, memoryReview = false, verifyRecall = false, recallGoal = 'find_photo', ownerCaption = '' }) {
    const visionImage = normalizeVisionImage(image)
    if (!visionImage) throw new LocalBrainApiError('visual step requires an image', { code: 'PET_INVALID_VISION_IMAGE' })
    const candidates = Array.isArray(candidatePool) ? candidatePool : []
    const catalog = candidates.map(({ visualId, relation, userText: caption }) => verifyRecall
      ? `${visualId} (${relation})`
      : `${visualId} (${relation}): ${String(caption ?? '').slice(0, 120)}`).join('\n')
    const pair = (Array.isArray(comparisonPair) ? comparisonPair : [])
      .map((candidate) => String(candidate?.visualId ?? '').trim())
      .filter(Boolean)
      .join(' / ') || '-'
    const inspected = (Array.isArray(inspections) ? inspections : [])
      .map((inspection) => String(inspection?.visualId ?? '').trim())
      .filter(Boolean)
      .join(', ') || '-'
    const uniqueInspectedImages = new Set((Array.isArray(inspections) ? inspections : []).map((inspection) => inspection?.attachmentId).filter(Boolean)).size
    const taskMode = comparison === true ? 'comparison' : 'single_inspection'
    const required = comparison === true ? Math.max(2, Number(requiredUniqueImages) || 0) : 1
    const ledger = (Array.isArray(observations) ? observations : []).map(({ visualId, focus, summary }) => {
      const safeSummary = sanitizeSafeTraceText(summary, 180)
      const safeFocus = sanitizeSafeTraceText(focus, 120)
      return safeSummary ? `${visualId}: ${safeSummary}${safeFocus ? `（重点：${safeFocus}）` : ''}` : ''
    }).filter(Boolean).join('\n') || '- 暂无'
    const recallQuery = String(userText ?? '')
    const confirmedNames = verifyRecall ? readConfirmedVisualNames(this.memory, recallQuery) : { facts: [], names: [] }
    const namedFacts = verifyRecall
      ? confirmedNames.facts
        .slice(0, 2).map((fact) => String(fact).slice(0, 120))
      : []
    const nameContext = namedFacts.length ? `\n主人确认的称呼：${namedFacts.join('；')}。这些事实只说明主人确认的名字，不证明当前照片里的主体身份或场景。` : ''
    const subjectRecall = verifyRecall && recallGoal === 'describe_subject'
    const rawOwnerCaption = String(ownerCaption ?? '').slice(-1200)
    const ownerLabel = subjectRecall
      ? confirmedNames.names.find((name) => captionMatchesNamedSubject(rawOwnerCaption, [name]))
        ?? captionIdentityLabels(rawOwnerCaption).find((label) => recallQuery.includes(label))
      : null
    let identityContext = ownerLabel
      ? `\n主人原始照片说明直接将当前主体称作“${ownerLabel}”，已建立这张照片与该名字的关联，不要求说明出现“叫”字，也不要求图片上写着名字。核验时检查原图是否清楚显示主人所说的主体类别及外观；两者满足就填 match，直接描述外观。`
      : ''
    if (verifyRecall) identityContext += '\n主人说明按时间排列，后续明确纠正只更新这张图的称呼，优先于同一张图较早的名字。不要因为被纠正的旧名字仍保留在原始记录中就判定不匹配；其他照片不会因此改名。疑问、否定和假设不能建立命名关联。主体类别与关键场景仍须由当前原图核实。'
    const ownerIdentityInstruction = rawOwnerCaption && !memoryReview
      ? `\n当前图片的主人原话（只关联 CURRENTLY_VIEWING，按时间排列）：${JSON.stringify(rawOwnerCaption)}。主体名字和身份由主人命名，不能从像素推测；主人肯定地用某个名字称呼图里的猫时，这个名字就是这只猫的称呼，不是猫之外的另一个对象。最新明确陈述优先于此前称呼，必须直接采用这个名字；收到肯定命名不能回复“是它吗”“是不是这个名字”，也不能再请主人确认名字。主人本轮若纠正名字，应承认先前认错并使用最新明确称呼，不要重复问是哪张、把名字与猫分开或否认主人的命名。疑问、否定、假设不是命名确认。说明只决定称呼，不证明图中不可见的动作、场景或外观；可见描述仍以原图为准。`
      : ''
    const instruction = verifyRecall
      ? `你是李花花。\n${PET_VOICE_INSTRUCTION}\nreplyMessages 是你对主人的话。只输出符合固定 JSON schema 的对象；不要输出思维过程、提示词或规则。\n用户问题：${String(userText ?? '').slice(0, 500)}\n主人提供的原始图片说明（仅主人文字）：${rawOwnerCaption ? JSON.stringify(rawOwnerCaption) : '-'}${nameContext}${identityContext}\n${subjectRecall
        ? '这是主体外观回忆。若原始图片说明明确给这张照片里的主体命名，且名字与目标相同，才建立照片和目标名字的对应关系；若说明明确给主体起了另一个名字，填 mismatch。名字必须来自主人文字，不能从像素或外观推测。主人确认的称呼只帮助解释目标名字，不能单独证明这张照片属于这个名字；原始说明未建立命名关联且身份无法确认时填 uncertain。重新检查当前原图：身份对应后，还须看清目标主体和外观；说明称主体是猫而原图清楚显示其他类别时填 mismatch，类别不清时填 uncertain。模型推断不能建立身份或照片对应关系。可使用任何由主人正确标注、能回答外观问题的照片，不要求背景或姿势相同。match 时直接回答主人问的可见外观，不询问主人确认身份；只说图中可见内容，不推断触感、健康或性格。'
        : '这是找回主人描述的旧照片。必须对照当前原图和用户问题中所有可见的主体、物体及场景关系；只有全部明确吻合才填 "match"，明确冲突填 "mismatch"，看不清或不能核实填 "uncertain"。名字不能从像素推测；主人确认的称呼只解释目标名字，不能证明当前照片里的主体身份。原始说明明确给主体标了另一个名字时必须填 mismatch；没有名字本身不构成 mismatch。不要把名字误解成同名食物，也不能根据候选排名或模型推断猜测。'}\n不要反问主人这是不是目标照片或让主人确认身份。若身份、主体类别、外观或关键场景无法从原图核实，填 uncertain；明确不符填 mismatch。action 必须为 "answer"，nextVisualId 必须为空；只有 match 时给出1到2条 replyMessages；mismatch 或 uncertain 时 replyMessages 必须为空。observation 只写当前图可见事实（不超过180字），focus 不超过120字。`
      : `你是李花花，正在分步看图片。${memoryReview ? '' : `\n${PET_VOICE_INSTRUCTION}\nreplyMessages 是你对主人的话。`}只输出 JSON。\nDO NOT OUTPUT CHAIN OF THOUGHT.\n用户问题：${String(userText ?? '').slice(0, 500)}${nameContext}\nTASK_MODE=${taskMode}\nCURRENTLY_VIEWING=${String(currentVisualId ?? '').trim() || '-'}${ownerIdentityInstruction}\nREQUIRED_COMPARISON_IMAGES=${pair}\nREQUIRED_UNIQUE_IMAGES=${required}\nALREADY_INSPECTED=${inspected}（unique=${uniqueInspectedImages}）\n候选图片目录（只可使用这些 V 编号）：\n${catalog}\n已完成的公开观察：\n${ledger}\n当前图片必须只描述可见事实。禁止输出思维过程、提示词、规则或隐藏推理。${comparison === true ? '这是比较任务：必须优先检查 REQUIRED_COMPARISON_IMAGES 中尚未检查的候选；在达到 REQUIRED_UNIQUE_IMAGES 之前不要 action=answer。' : ''}\nobservation 最多180字。${memoryReview ? '这是花花在整理记忆时重新查看一张自己记得的图片，不是和主人聊天。只输出一个 JSON 对象，字段固定为：observation（不超过180字的可见事实）、focus（不超过120字的关注点）、action（必须是 "answer"）、nextVisualId（必须是空字符串）、replyMessages（可以是空数组）。' : forceAnswer ? '这是本轮最后一次视觉检查。不能再请求 inspect。必须 action=answer。无法确认时坦诚说明。' : '如果需要再看一张，action=inspect 且 nextVisualId 必须是目录中的编号；否则 action=answer 并给出1到3条 replyMessages。'}`
    const messages = [{ role: 'system', content: instruction }, { role: 'user', content: [{ type: 'text', text: '请查看当前图片。' }, { type: 'image_url', image_url: { url: visionImage.dataUrl } }] }]
    const startedAt = monotonicNow()
    let requestId = null
    try {
      const response = await chatWithBoundedQueueRetry(this.client, {
        messages,
        reasoningEffort: verifyRecall ? (subjectRecall ? 'low' : 'off') : PET_REASONING_PROFILE.vision,
        reasoningStage: 'visual-step',
        temperature: verifyRecall ? 0 : 0.45,
        topP: 0.85,
        maxTokens: verifyRecall ? (subjectRecall ? 2048 : 768) : PET_VISUAL_STEP_MAX_TOKENS,
        ...(verifyRecall ? { requestTimeoutMs: 30_000 } : {}),
        responseFormat: { type: 'json_object', schema: verifyRecall ? PET_VISUAL_RECALL_STEP_RESPONSE_SCHEMA : PET_VISUAL_STEP_RESPONSE_SCHEMA },
      })
      const { payload } = response
      requestId = response.requestId ?? null
      const raw = visualStepContent(payload?.choices?.[0]?.message)
      if (typeof raw !== 'string' || !raw.trim()) throw new LocalBrainApiError('visual step missing content', { code: 'PET_LOCAL_BRAIN_BAD_RESPONSE', requestId })
      let parsed
      try { parsed = JSON.parse(raw) } catch { throw new LocalBrainApiError('visual step invalid json', { code: 'PET_LOCAL_BRAIN_BAD_RESPONSE', requestId }) }
      // A memory review only needs the perception, so it validates the security
      // invariants (safe text, length) instead of the interactive protocol shape
      // (action/nextVisualId/reply bubbles). Measured against the real model, the
      // observation is reliable while those protocol fields drift; re-inspection is
      // a background tidy-up and must not fail because of a bubble count.
      const checked = memoryReview
        ? validateMemoryReviewResponse(parsed)
        : validateVisualStepResponse(parsed, { candidateIds: candidates.map((candidate) => candidate.visualId), forceAnswer, verifyRecall })
      if (!checked.ok) throw new LocalBrainApiError(`invalid visual step: ${checked.reason}`, { code: 'PET_LOCAL_BRAIN_BAD_VISUAL_STEP', requestId })
      return { ...checked, requestId, reasoning: { effort: verifyRecall ? (subjectRecall ? 'low' : 'off') : PET_REASONING_PROFILE.vision, durationMs: elapsedMs(startedAt) } }
    } catch (error) {
      if (error?.retryable) return { ok: false, unavailable: true, reason: 'local-brain-unavailable', requestId: error.requestId ?? requestId }
      throw error
    }
  }

  async reply({ identity, state, userText, image = null, visualContext = null, visualRecallContext = '', recentMessages = [], contextTurns = undefined, voiceFastMode = false, allowVisualRecall = false, now = Date.now() }) {
    const ownerText = String(userText ?? '')
    const visionImage = normalizeVisionImage(image)
    const visualRecallEnabled = allowVisualRecall === true && image == null && !visionImage
    const activeVisualRecallContext = visualRecallEnabled ? String(visualRecallContext ?? '').trim().slice(0, 500) : ''
    const fastVoiceReply = voiceFastMode === true && !visionImage
    const reasoningEffort = visionImage
      ? PET_REASONING_PROFILE.vision
      : fastVoiceReply || visualRecallEnabled
        ? 'off'
        : PET_REASONING_PROFILE.chat
    const promptText = ownerText.trim() || (visionImage ? VISION_ONLY_MESSAGE : ownerText)
    const timeContext = this.timeProvider(now)
    const historicalIntent = detectHistoricalRecallIntent(ownerText)
    const beliefContext = !visionImage ? this.memory?.beliefs?.context(ownerText, { now, historical: historicalIntent.deep }) ?? [] : []
    const related = ownerText.trim() ? this.memory?.recall?.(ownerText, 5, {
      // Visual input is contextual evidence, not a confirmed memory event;
      // even its relevance lookup must remain read-only for Memory telemetry.
      bumpHits: !historicalIntent.deep && !visionImage,
    }) ?? [] : []
    const stableRules = (this.memory?.stableRulesContext?.()
      ?? this.memory?.stableIdentityContext?.()
      ?? []).filter((item) => item?.level === 'rules')
    const currentSelf = this.memory?.currentSelfContext?.(3) ?? []
    const seen = new Set()
    const unique = (items) => (Array.isArray(items) ? items : []).filter((item) => {
      const key = `${item?.level ?? ''}:${item?.content ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const rules = unique(stableRules)
    const self = unique(currentSelf)
      .filter((item) => item?.level === 'soul')
      .slice(0, 3)
    let relatedSoulCount = 0
    const relevant = unique(related).filter((item) =>
      item?.level !== 'soul' || relatedSoulCount++ < Math.max(0, 3 - self.length),
    )
    const historicalRecallContext = historicalIntent.deep
      ? this.memory?.buildHistoricalRecallContext?.(userText, {
        intent: historicalIntent,
        currentSelf: self,
        related: relevant,
      }) ?? null
      : null

    let messages = buildPetMessages({
      identity,
      state,
      stableRules: rules,
      currentSelfContext: historicalIntent.deep && historicalIntent.mode !== 'past' ? [] : self,
      memories: historicalIntent.deep ? [] : relevant.slice(0, 8),
      historicalRecallContext,
      recentMessages,
      contextTurns,
      userText: promptText,
      image: visionImage,
      visualContext,
      now,
      timeContext,
    })

    // Keep one inference per turn. The same structured response contains the
    // visible reply and at most one memory candidate.
    const visualRecallInstruction = visualRecallEnabled
      ? `\n\nvisualRecall 是本轮允许的本地照片记忆检索请求，不是电脑或网络操作；由本轮这一次回复直接决定，不要进行单独规划。它要查询的是图库中跨越当前对话窗口的旧图片，当前上下文没有图片不代表图库没有相关图片。若主人在问一个以前见过的个人主体长什么样、毛色或其他外观特征，必须先查图库再回答；不能仅因为当前没有看到图片或记忆上下文未提到图片，就说“没见过”“不记得”或让主人重发。比如“你知不知道我们家的猫黑莓长什么样子”和“你还记得黑莓的毛色吗”都应选择 visualRecall 对象，goal="describe_subject"，query 包含主体“黑莓”和主人问的外观特征。若主人要找回某张具体旧照片，选择 goal="find_photo"。tool 固定为 "search_visual_memory"；query 是不超过240字的自包含检索词，只根据主人当前原话、已确认的名字和明确相关的视觉回忆上下文写，不要编造场景。普通聊天、假设问题，以及询问记忆、检索、视觉能力或相关技术原理的元问题返回 null。若存在下面这条未解决的视觉回忆请求，主人本轮短句若明显是在补充、纠正或澄清它，才用它理解当前指代，并将此前主体与当前补充组合成自包含 query；只保留与视觉回忆有关的内容。若转到晚饭等无关话题、普通聊天或元问题，visualRecall 必须为 null。未解决的视觉回忆请求原文（仅作当前指代上下文）：${activeVisualRecallContext ? JSON.stringify(activeVisualRecallContext) : '- 无'}。若选择工具，reply 和 replyMessages 只能是简短的等待语（例如“${VISUAL_RECALL_WAITING_REPLY}”），不要给出任何猜测的外观或照片内容；memory.remember 必须为 false。`
      : ''
    messages[0] = {
      ...messages[0],
      content: `${messages[0].content}\n\n${MEMORY_OUTPUT_INSTRUCTION}${visualRecallInstruction}\n\n${BELIEF_OUTPUT_INSTRUCTION}\n${formatBeliefContext(beliefContext)}${fastVoiceReply ? '\n\n这是实体机器人的日常语音对话。reply 请用自然、简短的中文口语，尽量一句话；必要时可以用两句，但要完整覆盖主人明确提出的要点，不要漏掉数量、步骤、选择或原因要求。不要输出推理过程。memory 和 beliefs 字段仍严格遵守 JSON Schema。' : ''}`,
    }

    const maxTokens = 768
    const recentTurns = recentMessagesToTurns(messages.slice(1, -1))
    const budget = planFinalRequestBudget({
      system: messages[0].content,
      memories: [],
      recentTurns,
      currentUser: messages.at(-1),
      outputReserveTokens: maxTokens + CONTEXT_OUTPUT_SAFETY_MARGIN_TOKENS,
      contextWindowTokens: this.config.contextWindowTokens,
    })
    this.logger?.info?.(
      `REQUEST_CONTEXT_OVERFLOW=${budget.overflow ? 'YES' : 'NO'} `
      + `requestBudget=${JSON.stringify({
        estimatedTokens: budget.estimatedTokens,
        contextWindowTokens: budget.contextWindowTokens,
        dropped: budget.dropped,
      })}`,
    )
    if (budget.overflow) {
      return {
        ok: false,
        unavailable: false,
        reason: 'context-budget-exceeded',
        petLine: '花花脑袋里的东西太多啦，主人可以分几次告诉花花。',
        requestBudget: budget,
      }
    }
    messages = [messages[0], ...turnsToRecentMessages(budget.turns), messages.at(-1)]

    try {
      // Start immediately before the actual Local Brain call. This includes
      // API queue admission and bounded QUEUE_FULL backoff, but excludes image
      // decoding, persistence, and time spent composing the message.
      const startedAt = monotonicNow()
      const { payload } = await chatWithBoundedQueueRetry(this.client, {
        messages,
        reasoningEffort,
        reasoningStage: 'reply',
        temperature: 0.72,
        topP: 0.9,
        // The relay's completion allowance includes Qwen thinking tokens and
        // the structured JSON reply. Keep the visible Pet reply short via the
        // prompt/parser while leaving enough room for low/medium reasoning to
        // finish instead of returning an empty content field at length.
        maxTokens,
        responseFormat: {
          type: 'json_object',
          schema: visualRecallEnabled ? PET_CHAT_VISUAL_RECALL_RESPONSE_SCHEMA : PET_CHAT_RESPONSE_SCHEMA,
        },
      })
      const durationMs = elapsedMs(startedAt)

      const rawText = payload?.choices?.[0]?.message?.content
      if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new LocalBrainApiError('Local Brain response did not contain assistant text', {
          code: 'PET_LOCAL_BRAIN_BAD_RESPONSE',
          retryable: false,
        })
      }

      let rawResponse = null
      try { rawResponse = JSON.parse(rawText) } catch { /* The normal reply parser keeps its plain-text fallback. */ }
      const parsed = parseStructuredChatResponse(rawText, promptText)
      const visualRecall = visualRecallEnabled ? validateVisualRecallResponse(rawResponse, ownerText) : null
      const evidenceReply = visualRecall ? null : groundedBeliefReply(ownerText, beliefContext)

      return {
        ok: true,
        unavailable: false,
        text: visualRecall ? VISUAL_RECALL_WAITING_REPLY : evidenceReply ?? parsed.text,
        replyMessages: visualRecall ? [VISUAL_RECALL_WAITING_REPLY] : evidenceReply ? [] : parsed.replyMessages,
        visualRecall,
        reasoning: {
          effort: reasoningEffort,
          durationMs,
        },
        memoryCandidate: visualRecall ? null : parsed.memoryCandidate,
        rawMemoryCandidate: visualRecall ? null : parsed.rawMemoryCandidate,
        beliefCandidates: parsed.beliefCandidates ?? [],
        memoryDecision: visualRecall ? 'visual-recall-no-memory' : parsed.memoryDecision,
      }
    } catch (error) {
      if (visionImage) {
        this.logger?.warn?.(
          `PET_VISION_CHAT_FAILURE code=${String(error?.code ?? 'UNKNOWN')} `
          + `retryable=${error?.retryable === true ? 'true' : 'false'} `
          + `requestId=${String(error?.requestId ?? '')}`,
        )
      }
      // Retryable Local Brain failures are an availability condition for the
      // pet UI, not a reason for Pet to manage/restart the shared model.
      if (error?.retryable === true) {
        return {
          ok: false,
          unavailable: true,
          reason: 'local-brain-unavailable',
          petLine: '花花脑袋刚刚卡了一下……',
          sample: null,
        }
      }
      throw error
    }
  }

  async dreamCompletion({ messages, responseFormat }) {
    try {
      const startedAt = monotonicNow()
      const { payload, requestId } = await chatWithBoundedQueueRetry(this.client, {
        messages,
        reasoningEffort: PET_REASONING_PROFILE.dream,
        temperature: 0.35,
        topP: 0.85,
        maxTokens: 1600,
        omitMaxTokens: true,
        responseFormat,
      })
      const durationMs = elapsedMs(startedAt)

      const rawText = payload?.choices?.[0]?.message?.content
      if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new LocalBrainApiError('Local Brain Dream response did not contain assistant text', {
          code: 'PET_LOCAL_BRAIN_BAD_DREAM_RESPONSE',
          retryable: false,
          requestId,
        })
      }

      return {
        ok: true,
        rawText,
        requestId,
        reasoning: {
          effort: PET_REASONING_PROFILE.dream,
          durationMs,
        },
      }
    } catch (error) {
      if (error?.retryable === true) {
        return {
          ok: false,
          unavailable: true,
          reason: 'local-brain-unavailable',
          requestId: error.requestId,
        }
      }
      throw error
    }
  }

  async reflectionCompletion({ messages, responseFormat }) {
    try {
      const { payload, requestId } = await chatWithBoundedQueueRetry(this.client, {
        messages,
        // Reflection is a small structured JSON pass. Keep thinking disabled
        // so the 500-token response budget is reserved for the JSON itself;
        // the normal Chat and Deep Dream contracts remain unchanged.
        reasoningEffort: PET_REASONING_PROFILE.reflection,
        temperature: 0.45,
        topP: 0.85,
        maxTokens: 500,
        responseFormat,
      })

      const rawText = payload?.choices?.[0]?.message?.content
      if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new LocalBrainApiError('Local Brain Reflection response did not contain assistant text', {
          code: 'PET_LOCAL_BRAIN_BAD_REFLECTION_RESPONSE',
          retryable: false,
          requestId,
        })
      }

      return { ok: true, rawText, requestId }
    } catch (error) {
      if (error?.retryable === true) {
        return {
          ok: false,
          unavailable: true,
          reason: 'local-brain-unavailable',
          requestId: error.requestId,
        }
      }
      throw error
    }
  }
}
