import { PetSandbox } from '../core/pet-sandbox.js'
import { createInitialState, advanceState, interact } from '../core/pet-state-engine.js'
import { assertPetPolicy } from '../core/pet-policy.js'
import { ensurePetIdentity } from '../core/pet-identity.js'
import { PetMemory } from '../memory/pet-memory.js'
import { MemoryGate } from '../memory/memory-gate.js'
import { LocalBrain } from '../brain/local-brain.js'
import { RecentConversation } from '../conversation/recent-conversation.js'
import { ConversationStore } from '../conversation/conversation-store.js'
import { DreamGate } from '../dream/dream-gate.js'
import { DreamEngine } from '../dream/dream-engine.js'
import { DreamScheduler } from '../dream/dream-scheduler.js'
import { ReflectionEngine, ReflectionGate } from '../dream/reflection-engine.js'
import { advanceEmotion, applyInteractionEmotion, createEmotionState, syncAttachment, visualFeedbackForInteraction } from '../client/emotion-state.js'
import { createPetEnvironment } from '../client/pet-environment.js'
import { normalizePetVisualConfig, resolvePetVisualState } from '../client/pet-visual-state.js'
import { spriteForAnimation } from '../client/pet-animation.js'
import { normalizeVisionImage, VISION_ONLY_MESSAGE } from '../brain/vision-input.js'

const DREAM_MIN_NEW_MEMORIES = 8
const DREAM_OLDEST_SOURCE_AGE_MS = 72 * 60 * 60 * 1000
const REFLECTION_MIN_NEW_MEMORIES = 2
const REFLECTION_OLDEST_SOURCE_AGE_MS = 60 * 60 * 1000

function dreamEligibility(memory, { now, minNewMemories = DREAM_MIN_NEW_MEMORIES, oldestSourceAgeMs = DREAM_OLDEST_SOURCE_AGE_MS } = {}) {
  const window = memory.dreamWindow()
  const after = Number.isFinite(Number(window?.last_dream_time)) ? Number(window.last_dream_time) : 0
  const sourceRows = memory.dreamSourceRows({ after, before: now })
  const oldestCreatedAt = sourceRows[0]?.created_at ?? null
  const oldEnough = oldestCreatedAt !== null && Number(now) - Number(oldestCreatedAt) >= oldestSourceAgeMs

  return {
    eligible: sourceRows.length >= minNewMemories || oldEnough,
    sourceCount: sourceRows.length,
    oldestCreatedAt,
    checkpoint: after,
    reason: sourceRows.length === 0
      ? 'no-new-sources'
      : sourceRows.length >= minNewMemories
        ? 'new-source-threshold'
        : oldEnough
          ? 'oldest-source-age'
          : 'eligibility-threshold-not-met',
  }
}

function deepDreamEligibility(memory, { now } = {}) {
  const window = memory.dreamWindow()
  const after = Number.isFinite(Number(window?.last_dream_time)) ? Number(window.last_dream_time) : 0
  const sourceRows = memory.dreamSourceRows({ after, before: now })
  return {
    eligible: sourceRows.length > 0,
    sourceCount: sourceRows.length,
    oldestCreatedAt: sourceRows[0]?.created_at ?? null,
    checkpoint: after,
    reason: sourceRows.length > 0 ? 'unprocessed-raw-source' : 'no-unprocessed-raw-sources',
  }
}

function reflectionEligibility(memory, { now, minNewMemories = REFLECTION_MIN_NEW_MEMORIES, oldestSourceAgeMs = REFLECTION_OLDEST_SOURCE_AGE_MS } = {}) {
  const window = memory.reflectionWindow()
  const after = Number.isFinite(Number(window?.last_dream_time)) ? Number(window.last_dream_time) : 0
  const sourceRows = memory.reflectionSourceRows({ after, before: now })
  const oldestCreatedAt = sourceRows[0]?.created_at ?? null
  const oldEnough = oldestCreatedAt !== null && Number(now) - Number(oldestCreatedAt) >= oldestSourceAgeMs

  return {
    eligible: sourceRows.length >= minNewMemories || oldEnough,
    sourceCount: sourceRows.length,
    oldestCreatedAt,
    checkpoint: after,
    reason: sourceRows.length === 0
      ? 'no-unreflected-raw-sources'
      : sourceRows.length >= minNewMemories
        ? 'new-raw-source-threshold'
        : oldEnough
          ? 'oldest-unreflected-age'
          : 'reflection-threshold-not-met',
  }
}

export class PetRuntime {
  constructor({ sandboxRoot, logger = null }) {
    this.sandbox = new PetSandbox(sandboxRoot)
    this.logger = logger
    this.memory = null
    this.memoryGate = null
    this.brain = null
    this.state = null
    this.identity = null
    this.conversation = new RecentConversation({ maxTurns: 12 })
    this.conversationStore = new ConversationStore(this.sandbox.root)
    this.conversationPersistenceReady = false
    this.dreamEngine = null
    this.reflectionEngine = null
    this.dreamScheduler = null
    this.chatInFlight = 0
    // Presentation telemetry is shared by every UI, kept only in host RAM,
    // and deliberately remains outside state.json and pet-memory.db.
    this.emotion = createEmotionState()
    this.lastInteractionFeedback = null
  }

  async initialize() {
    assertPetPolicy()
    await this.sandbox.initialize()
    await this.conversationStore.initialize()
    this.conversationPersistenceReady = true
    this.state = await this.sandbox.readJson('world', 'state.json', null)
    if (!this.state) this.state = createInitialState()
    this.identity = await ensurePetIdentity(this.sandbox, this.state)
    await this.restoreRecentConversation()
    this.emotion = syncAttachment(this.emotion, this.state.attachment)
    this.memory = new PetMemory(this.sandbox.root)
    this.memory.seedIfFresh(this.state.bornAt)
    this.memory.migrateIdentity(this.identity)
    this.memory.ensureDreamTracking()
    this.memory.ensureReflectionTracking()
    this.brain = new LocalBrain({ memory: this.memory, sandbox: this.sandbox, logger: this.logger })
    this.memoryGate = new MemoryGate({ memory: this.memory })
    this.dreamEngine = new DreamEngine({
      memory: this.memory,
      brain: this.brain,
      gate: new DreamGate({ memory: this.memory }),
    })
    this.reflectionEngine = new ReflectionEngine({
      memory: this.memory,
      brain: this.brain,
      gate: new ReflectionGate({ memory: this.memory }),
    })
    this.dreamScheduler = new DreamScheduler({
      memory: this.memory,
      engine: this.dreamEngine,
      reflectionEngine: this.reflectionEngine,
      eligibility: (options) => dreamEligibility(this.memory, options),
      deepDreamEligibility: (options) => deepDreamEligibility(this.memory, options),
      reflectionEligibility: (options) => reflectionEligibility(this.memory, options),
    })
    await this.persist()
    return this.snapshot()
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state))
  }

  // This is intentionally RAM-only presentation telemetry. It does not alter
  // state, memory, Dream scheduling, or Local Brain requests.
  presenceSnapshot() {
    return {
      chatPending: this.chatInFlight > 0,
      dreamRunning: this.dreamEngine?.isInFlight?.() === true,
    }
  }

  /**
   * Public, read-only presentation data for the desktop and LAN companion.
   * This is the one source of emotion/visual truth; it never informs Brain,
   * Memory, Dream, or persistent pet state.
   */
  presentationSnapshot(config = {}, now = Date.now()) {
    const visualConfig = normalizePetVisualConfig(config)
    const emotion = advanceEmotion(this.emotion, now, {
      windowMs: visualConfig.interactionBurstWindowMs,
    })
    const presence = this.presenceSnapshot()
    const feedback = this.feedbackAt(now, visualConfig)
    const visualState = resolvePetVisualState({
      petState: this.state,
      environment: createPetEnvironment({
        petState: this.state,
        chatPending: presence.chatPending,
        dreamRunning: presence.dreamRunning,
        config: visualConfig,
        now,
      }),
      feedback,
      emotion,
      config: visualConfig,
      now,
    })

    return {
      visualState,
      emotion: {
        happiness: emotion.happiness,
        energy: emotion.energy,
      },
      dream: presence.dreamRunning,
      sprite: spriteForAnimation(visualState, Math.floor(now / 420)),
    }
  }

  identitySnapshot() {
    return JSON.parse(JSON.stringify(this.identity))
  }

  async tick(now = Date.now()) {
    this.state = advanceState(this.state, now)
    this.emotion = advanceEmotion(this.emotion, now)
    await this.persist()
    const schedulerState = {
      state: this.snapshot(),
      chatInFlight: this.chatInFlight > 0,
      dreamInFlight: this.dreamEngine?.isInFlight?.() ?? false,
      reflectionInFlight: this.reflectionEngine?.isInFlight?.() ?? false,
      now,
    }

    let deepResult = null
    if (typeof this.dreamScheduler?.maybeRunDeepDream === 'function') {
      deepResult = await this.dreamScheduler.maybeRunDeepDream(schedulerState)
    } else {
      // Preserve the v0.3-B single-Dream contract for a partially upgraded
      // scheduler; the bundled scheduler exposes the Deep Dream method.
      deepResult = await this.dreamScheduler?.maybeRun(schedulerState)
    }

    const deepStarted = deepResult?.schedulerStatus === 'started'
      || ['chat-in-flight', 'dream-in-flight', 'reflection-in-flight'].includes(deepResult?.reason)

    if (!deepStarted && typeof this.dreamScheduler?.maybeRunReflection === 'function') {
      await this.dreamScheduler.maybeRunReflection(schedulerState)
    }
    return this.snapshot()
  }

  async interact(kind = 'pet', now = Date.now()) {
    // Long press is a first-class shared presentation action, while the
    // established state-machine interaction remains the existing "pet" path.
    const persistentKind = kind === 'long-press' ? 'pet' : kind
    this.state = interact(this.state, persistentKind, now)
    this.emotion = applyInteractionEmotion(this.emotion, kind, { now })
    this.emotion = syncAttachment(this.emotion, this.state.attachment, now)
    this.lastInteractionFeedback = {
      kind: visualFeedbackForInteraction(this.emotion, kind, now),
      at: now,
    }
    this.memory.rememberInteraction(persistentKind, this.state.lifetimeInteractions)
    await this.persist()
    return this.snapshot()
  }

  feedbackAt(now, config) {
    const feedback = this.lastInteractionFeedback
    if (!feedback || !Number.isFinite(Number(feedback.at))) return null
    const duration = feedback.kind === 'excited'
      ? config.excitedDurationMs
      : feedback.kind === 'relaxed'
        ? config.relaxedDurationMs
        : feedback.kind === 'confused' || feedback.kind === 'curious'
          ? config.confusedDurationMs
          : config.happyDurationMs
    return { kind: feedback.kind, until: Number(feedback.at) + duration }
  }

  async chat(userText, image = null, attachment = null) {
    const ownerText = String(userText ?? '')
    const visionImage = normalizeVisionImage(image)
    const promptText = ownerText.trim() || (visionImage ? VISION_ONLY_MESSAGE : ownerText)
    this.chatInFlight += 1

    try {
      let persistedAttachment = null
      if (visionImage && this.conversationPersistenceReady) {
        persistedAttachment = attachment
          ? await this.conversationStore.attachment(attachment.id)
          : await this.conversationStore.saveAttachment({ image: visionImage })
        if (!persistedAttachment) {
          const error = new Error('conversation attachment not found')
          error.code = 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND'
          throw error
        }
      }

      if (this.conversationPersistenceReady) {
        await this.conversationStore.appendMessage({
          role: 'user',
          text: ownerText,
          timestamp: Date.now(),
          attachment: persistedAttachment,
        })
      }

      const result = await this.brain.reply({
        identity: this.identitySnapshot(),
        state: this.snapshot(),
        userText: promptText,
        image: visionImage,
        recentMessages: this.conversation.messages(),
      })

      if (!result?.ok) return result

      const gate = visionImage
        ? { status: 'skipped', reason: 'vision-input' }
        : ownerText.trim()
          ? this.memoryGate.consider(ownerText, result.rawMemoryCandidate ?? result.memoryCandidate)
          : { status: 'skipped', reason: 'empty-message' }

      const recentUserText = visionImage
        ? `[主人发送了一张图片]${ownerText.trim() ? ` ${ownerText.trim()}` : ''}`
        : ownerText
      this.conversation.append(recentUserText, result.text)
      if (this.conversationPersistenceReady) {
        await this.conversationStore.appendMessage({
          role: 'assistant',
          text: result.text,
          timestamp: Date.now(),
        })
      }

      // Never expose the candidate/evidence or internal gate details to the
      // browser. UI receives the same public reply shape as v0.2-C.
      return {
        ok: true,
        unavailable: false,
        text: result.text,
        memoryWrite: gate.status,
      }
    } finally {
      this.chatInFlight -= 1
    }
  }

  runDreamNow() {
    const options = {
      state: this.snapshot(),
      chatInFlight: this.chatInFlight > 0,
      reflectionInFlight: this.reflectionEngine?.isInFlight?.() ?? false,
      dreamInFlight: this.dreamEngine?.isInFlight?.() ?? false,
    }
    return typeof this.dreamScheduler.runDeepDreamNow === 'function'
      ? this.dreamScheduler.runDeepDreamNow(options)
      : this.dreamScheduler.runNow(options)
  }

  runReflectionNow() {
    if (typeof this.dreamScheduler?.runReflectionNow !== 'function') {
      return Promise.resolve({ status: 'skipped', reason: 'reflection-scheduler-unavailable' })
    }
    return this.dreamScheduler.runReflectionNow({
      state: this.snapshot(),
      chatInFlight: this.chatInFlight > 0,
      dreamInFlight: this.dreamEngine?.isInFlight?.() ?? false,
      reflectionInFlight: this.reflectionEngine?.isInFlight?.() ?? false,
    })
  }

  recall(query, k = 5) {
    return this.memory.recall(query, k)
  }

  async conversationHistory(limit = 50) {
    if (!this.conversationPersistenceReady) return []
    return this.conversationStore.history(limit)
  }

  async conversationAsset(id) {
    if (!this.conversationPersistenceReady) return null
    return this.conversationStore.readAttachmentDataUrl(id)
  }

  async restoreRecentConversation() {
    if (!this.conversationPersistenceReady) return
    const persisted = await this.conversationStore.list(24)
    let pendingUser = null
    this.conversation.clear()
    for (const message of persisted) {
      if (message.role === 'user') {
        pendingUser = message
        continue
      }
      if (message.role !== 'assistant' || !pendingUser) continue
      const userText = pendingUser.attachment
        ? `[主人发送了一张图片]${pendingUser.text ? ` ${pendingUser.text}` : ''}`
        : pendingUser.text
      this.conversation.append(userText, message.text)
      pendingUser = null
    }
  }

  async persist() {
    await this.sandbox.writeJson('world', 'state.json', this.state)
  }

  close() {
    // Local Brain is now a shared external service. Pet owns no model process.
    this.conversation?.clear()
    this.conversationPersistenceReady = false
    this.memory?.close()
  }
}
