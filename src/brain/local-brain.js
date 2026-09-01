import { validateLocalBrainConfig } from './local-brain-config.js'
import { LocalBrainApiError, LocalBrainClient } from './local-brain-client.js'
import { buildPetMessages } from './prompt-builder.js'
import { PET_CHAT_RESPONSE_SCHEMA, MEMORY_OUTPUT_INSTRUCTION, parseStructuredChatResponse } from './memory-candidate.js'
import { evaluateLocalBrainAvailability, busyPetLine } from './resource-gate.js'
import { BrainAvailabilityTracker } from './brain-availability.js'

export class LocalBrain {
  constructor({ config = {}, memory, sandbox = null, client = null }) {
    this.config = validateLocalBrainConfig(config)
    this.memory = memory
    this.sandbox = sandbox
    this.availability = sandbox ? new BrainAvailabilityTracker({ sandbox }) : null
    this.client = client ?? new LocalBrainClient({
      baseUrl: this.config.baseUrl,
      healthTimeoutMs: this.config.healthTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
    })
  }

  async health() {
    return this.client.health()
  }

  async checkAvailability() {
    const result = await evaluateLocalBrainAvailability(this.config.resourceGate)
    if (this.availability) await this.availability.record(result)

    return {
      ...result,
      petLine: result.available ? null : busyPetLine(result.reason),
    }
  }

  async reply({ identity, state, userText, recentMessages = [] }) {
    const availability = await this.checkAvailability()

    if (!availability.available) {
      return {
        ok: false,
        unavailable: true,
        reason: availability.reason,
        petLine: availability.petLine,
        sample: availability.sample,
      }
    }

    const related = this.memory?.recall?.(userText, 5) ?? []
    const stable = this.memory?.stableIdentityContext?.() ?? []
    const dedup = new Map()

    for (const item of [...stable, ...related]) {
      const key = `${item.level}:${item.content}`
      if (!dedup.has(key)) dedup.set(key, item)
    }

    const messages = buildPetMessages({
      identity,
      state,
      memories: [...dedup.values()].slice(0, 8),
      recentMessages,
      userText,
    })

    // Keep one inference per turn. The same structured response contains the
    // visible reply and at most one memory candidate.
    messages[0] = {
      ...messages[0],
      content: `${messages[0].content}\n\n${MEMORY_OUTPUT_INSTRUCTION}`,
    }

    try {
      const { payload } = await this.client.chat({
        messages,
        reasoningEffort: this.config.reasoningEffort,
        temperature: 0.72,
        topP: 0.9,
        maxTokens: 256,
        responseFormat: {
          type: 'json_object',
          schema: PET_CHAT_RESPONSE_SCHEMA,
        },
      })

      const rawText = payload?.choices?.[0]?.message?.content
      if (typeof rawText !== 'string' || rawText.length === 0) {
        throw new LocalBrainApiError('Local Brain response did not contain assistant text', {
          code: 'PET_LOCAL_BRAIN_BAD_RESPONSE',
          retryable: false,
        })
      }

      const parsed = parseStructuredChatResponse(rawText, userText)

      return {
        ok: true,
        unavailable: false,
        text: parsed.text,
        memoryCandidate: parsed.memoryCandidate,
        rawMemoryCandidate: parsed.rawMemoryCandidate,
        memoryDecision: parsed.memoryDecision,
      }
    } catch (error) {
      // Retryable Local Brain failures are an availability condition for the
      // pet UI, not a reason for Pet to manage/restart the shared model.
      if (error instanceof LocalBrainApiError && error.retryable) {
        return {
          ok: false,
          unavailable: true,
          reason: 'local-brain-unavailable',
          petLine: busyPetLine('local-brain-unavailable'),
          sample: null,
        }
      }
      throw error
    }
  }
}
