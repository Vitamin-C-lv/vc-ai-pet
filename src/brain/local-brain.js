import { PET_REASONING_PROFILE, validateLocalBrainConfig } from './local-brain-config.js'
import { LocalBrainApiError, LocalBrainClient } from './local-brain-client.js'
import { buildPetMessages } from './prompt-builder.js'
import { PET_CHAT_RESPONSE_SCHEMA, MEMORY_OUTPUT_INSTRUCTION, parseStructuredChatResponse } from './memory-candidate.js'
import { detectHistoricalRecallIntent } from '../memory/historical-recall.js'
import { getCurrentTimeContext } from '../core/time-context.js'
import { normalizeVisionImage, VISION_ONLY_MESSAGE } from './vision-input.js'
import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'
import { BELIEF_OUTPUT_INSTRUCTION, formatBeliefContext, groundedBeliefReply } from '../memory/current-belief.js'

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

export function validateVisualStepResponse(value, { candidateIds = [], forceAnswer = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidVisualStep('object-required')
  const required = ['observation', 'action', 'nextVisualId', 'focus', 'replyMessages']
  if (required.some((key) => !Object.hasOwn(value, key))) return invalidVisualStep('required-field-missing')
  if (Object.keys(value).some((key) => !required.includes(key))) return invalidVisualStep('unknown-field')
  if (typeof value.observation !== 'string' || value.observation.trim().length > 180) return invalidVisualStep('observation-invalid')
  if (value.observation.trim() && !sanitizeSafeTraceText(value.observation, 180)) return invalidVisualStep('observation-unsafe')
  if (value.action !== 'inspect' && value.action !== 'answer') return invalidVisualStep('action-invalid')
  if (typeof value.nextVisualId !== 'string' || value.nextVisualId.trim().length > 16) return invalidVisualStep('next-visual-id-invalid')
  if (typeof value.focus !== 'string' || value.focus.trim().length > 120) return invalidVisualStep('focus-invalid')
  if (value.focus.trim() && !sanitizeSafeTraceText(value.focus, 120)) return invalidVisualStep('focus-unsafe')
  if (!Array.isArray(value.replyMessages) || value.replyMessages.length > 3) return invalidVisualStep('reply-messages-invalid')
  const replyMessages = []
  for (const item of value.replyMessages) {
    if (typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 300) return invalidVisualStep('reply-message-invalid')
    if (!sanitizeSafeTraceText(item, 300)) return invalidVisualStep('reply-message-unsafe')
    replyMessages.push(item.trim())
  }

  const requested = value.nextVisualId.trim()
  if (value.action === 'inspect' && !forceAnswer) {
    if (!requested || (candidateIds.length > 0 && !candidateIds.includes(requested))) return invalidVisualStep('inspect-target-invalid')
  }
  if (value.action === 'answer' && (requested || (!forceAnswer && replyMessages.length === 0))) return invalidVisualStep('answer-shape-invalid')

  return {
    ok: true,
    observation: value.observation.trim(),
    action: forceAnswer ? 'answer' : value.action,
    nextVisualId: forceAnswer ? '' : value.action === 'inspect' ? requested : '',
    focus: value.focus.trim(),
    replyMessages,
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
  constructor({ config = {}, memory, client = null, timeProvider = getCurrentTimeContext, logger = null }) {
    this.config = validateLocalBrainConfig(config)
    this.memory = memory
    this.timeProvider = typeof timeProvider === 'function' ? timeProvider : getCurrentTimeContext
    this.logger = logger
    this.client = client ?? new LocalBrainClient({
      baseUrl: this.config.baseUrl,
      healthTimeoutMs: this.config.healthTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
    })
  }

  async health() {
    return this.client.health()
  }

  async visualStep({ userText, image, candidatePool = [], observations = [], comparison = false, comparisonPair = [], currentVisualId = '', inspections = [], requiredUniqueImages = 1, forceAnswer = false }) {
    const visionImage = normalizeVisionImage(image)
    if (!visionImage) throw new LocalBrainApiError('visual step requires an image', { code: 'PET_INVALID_VISION_IMAGE' })
    const candidates = Array.isArray(candidatePool) ? candidatePool : []
    const catalog = candidates.map(({ visualId, relation, userText: caption }) => `${visualId} (${relation}): ${String(caption ?? '').slice(0, 120)}`).join('\n')
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
    const instruction = `你是李花花，正在分步看图片。只输出 JSON。\nDO NOT OUTPUT CHAIN OF THOUGHT.\n用户问题：${String(userText ?? '').slice(0, 500)}\nTASK_MODE=${taskMode}\nCURRENTLY_VIEWING=${String(currentVisualId ?? '').trim() || '-'}\nREQUIRED_COMPARISON_IMAGES=${pair}\nREQUIRED_UNIQUE_IMAGES=${required}\nALREADY_INSPECTED=${inspected}（unique=${uniqueInspectedImages}）\n候选图片目录（只可使用这些 V 编号）：\n${catalog}\n已完成的公开观察：\n${ledger}\n当前图片必须只描述可见事实。禁止输出思维过程、提示词、规则或隐藏推理。${comparison === true ? '这是比较任务：必须优先检查 REQUIRED_COMPARISON_IMAGES 中尚未检查的候选；在达到 REQUIRED_UNIQUE_IMAGES 之前不要 action=answer。' : ''}\nobservation 最多180字。${forceAnswer ? '这是本轮最后一次视觉检查。不能再请求 inspect。必须 action=answer。无法确认时坦诚说明。' : '如果需要再看一张，action=inspect 且 nextVisualId 必须是目录中的编号；否则 action=answer 并给出1到3条 replyMessages。'}`
    const messages = [{ role: 'system', content: instruction }, { role: 'user', content: [{ type: 'text', text: '请查看当前图片。' }, { type: 'image_url', image_url: { url: visionImage.dataUrl } }] }]
    const startedAt = monotonicNow()
    let requestId = null
    try {
      const response = await chatWithBoundedQueueRetry(this.client, {
        messages, reasoningEffort: PET_REASONING_PROFILE.vision, temperature: 0.45, topP: 0.85, maxTokens: PET_VISUAL_STEP_MAX_TOKENS,
        responseFormat: { type: 'json_object', schema: PET_VISUAL_STEP_RESPONSE_SCHEMA },
      })
      const { payload } = response
      requestId = response.requestId ?? null
      const raw = visualStepContent(payload?.choices?.[0]?.message)
      if (typeof raw !== 'string' || !raw.trim()) throw new LocalBrainApiError('visual step missing content', { code: 'PET_LOCAL_BRAIN_BAD_RESPONSE', requestId })
      let parsed
      try { parsed = JSON.parse(raw) } catch { throw new LocalBrainApiError('visual step invalid json', { code: 'PET_LOCAL_BRAIN_BAD_RESPONSE', requestId }) }
      const checked = validateVisualStepResponse(parsed, { candidateIds: candidates.map((candidate) => candidate.visualId), forceAnswer })
      if (!checked.ok) throw new LocalBrainApiError(`invalid visual step: ${checked.reason}`, { code: 'PET_LOCAL_BRAIN_BAD_VISUAL_STEP', requestId })
      return { ...checked, requestId, reasoning: { effort: PET_REASONING_PROFILE.vision, durationMs: elapsedMs(startedAt) } }
    } catch (error) {
      if (error?.retryable) return { ok: false, unavailable: true, reason: 'local-brain-unavailable', requestId: error.requestId ?? requestId }
      throw error
    }
  }

  async reply({ identity, state, userText, image = null, visualContext = null, recentMessages = [], now = Date.now() }) {
    const ownerText = String(userText ?? '')
    const visionImage = normalizeVisionImage(image)
    const reasoningEffort = visionImage
      ? PET_REASONING_PROFILE.vision
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

    const messages = buildPetMessages({
      identity,
      state,
      stableRules: rules,
      currentSelfContext: historicalIntent.deep && historicalIntent.mode !== 'past' ? [] : self,
      memories: historicalIntent.deep ? [] : relevant.slice(0, 8),
      historicalRecallContext,
      recentMessages,
      userText: promptText,
      image: visionImage,
      visualContext,
      now,
      timeContext,
    })

    // Keep one inference per turn. The same structured response contains the
    // visible reply and at most one memory candidate.
    messages[0] = {
      ...messages[0],
      content: `${messages[0].content}\n\n${MEMORY_OUTPUT_INSTRUCTION}\n\n${BELIEF_OUTPUT_INSTRUCTION}\n${formatBeliefContext(beliefContext)}`,
    }

    try {
      // Start immediately before the actual Local Brain call. This includes
      // API queue admission and bounded QUEUE_FULL backoff, but excludes image
      // decoding, persistence, and time spent composing the message.
      const startedAt = monotonicNow()
      const { payload } = await chatWithBoundedQueueRetry(this.client, {
        messages,
        reasoningEffort,
        temperature: 0.72,
        topP: 0.9,
        // The relay's completion allowance includes Qwen thinking tokens and
        // the structured JSON reply. Keep the visible Pet reply short via the
        // prompt/parser while leaving enough room for low/medium reasoning to
        // finish instead of returning an empty content field at length.
        maxTokens: 768,
        responseFormat: {
          type: 'json_object',
          schema: PET_CHAT_RESPONSE_SCHEMA,
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

      const parsed = parseStructuredChatResponse(rawText, promptText)
      const evidenceReply = groundedBeliefReply(ownerText, beliefContext)

      return {
        ok: true,
        unavailable: false,
        text: evidenceReply ?? parsed.text,
        replyMessages: evidenceReply ? [] : parsed.replyMessages,
        reasoning: {
          effort: reasoningEffort,
          durationMs,
        },
        memoryCandidate: parsed.memoryCandidate,
        rawMemoryCandidate: parsed.rawMemoryCandidate,
        beliefCandidates: parsed.beliefCandidates ?? [],
        memoryDecision: parsed.memoryDecision,
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
