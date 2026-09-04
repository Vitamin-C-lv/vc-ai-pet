import { PET_REASONING_PROFILE, validateLocalBrainConfig } from './local-brain-config.js'
import { LocalBrainApiError, LocalBrainClient } from './local-brain-client.js'
import { buildPetMessages } from './prompt-builder.js'
import { PET_CHAT_RESPONSE_SCHEMA, MEMORY_OUTPUT_INSTRUCTION, parseStructuredChatResponse } from './memory-candidate.js'
import { detectHistoricalRecallIntent } from '../memory/historical-recall.js'
import { getCurrentTimeContext } from '../core/time-context.js'
import { normalizeVisionImage, VISION_ONLY_MESSAGE } from './vision-input.js'

export const LOCAL_BRAIN_QUEUE_FULL_RETRY_DELAYS_MS = Object.freeze([250, 500, 1000])

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

  async reply({ identity, state, userText, image = null, recentMessages = [], now = Date.now() }) {
    const ownerText = String(userText ?? '')
    const visionImage = normalizeVisionImage(image)
    const reasoningEffort = visionImage
      ? PET_REASONING_PROFILE.vision
      : PET_REASONING_PROFILE.chat
    const promptText = ownerText.trim() || (visionImage ? VISION_ONLY_MESSAGE : ownerText)
    const timeContext = this.timeProvider(now)
    const historicalIntent = detectHistoricalRecallIntent(ownerText)
    const related = ownerText.trim() ? this.memory?.recall?.(ownerText, 5, {
      bumpHits: !historicalIntent.deep,
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
      now,
      timeContext,
    })

    // Keep one inference per turn. The same structured response contains the
    // visible reply and at most one memory candidate.
    messages[0] = {
      ...messages[0],
      content: `${messages[0].content}\n\n${MEMORY_OUTPUT_INSTRUCTION}`,
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
        maxTokens: 256,
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

      return {
        ok: true,
        unavailable: false,
        text: parsed.text,
        reasoning: {
          effort: reasoningEffort,
          durationMs,
        },
        memoryCandidate: parsed.memoryCandidate,
        rawMemoryCandidate: parsed.rawMemoryCandidate,
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
