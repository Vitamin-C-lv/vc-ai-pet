import { PetSandbox } from '../core/pet-sandbox.js'
import { createInitialState, advanceState, interact } from '../core/pet-state-engine.js'
import { assertPetPolicy } from '../core/pet-policy.js'
import { ensurePetIdentity } from '../core/pet-identity.js'
import { PetMemory } from '../memory/pet-memory.js'
import { MemoryGate } from '../memory/memory-gate.js'
import { LocalBrain } from '../brain/local-brain.js'
import { RecentConversation } from '../conversation/recent-conversation.js'
import { ConversationStore } from '../conversation/conversation-store.js'
import { normalizeConversationReasoning } from '../conversation/reasoning-metadata.js'
import { RecentVisualResolver } from '../conversation/recent-visual-context.js'
import { PetTurnOrchestrator } from './pet-turn-orchestrator.js'
import { PetTurnManager } from './pet-turn-manager.js'
import { createTurnId } from './pet-turn-events.js'
import { DreamGate } from '../dream/dream-gate.js'
import { DreamEngine } from '../dream/dream-engine.js'
import { DreamScheduler } from '../dream/dream-scheduler.js'
import { ReflectionEngine, ReflectionGate } from '../dream/reflection-engine.js'
import { advanceEmotion, applyInteractionEmotion, createEmotionState, syncAttachment, visualFeedbackForInteraction } from '../client/emotion-state.js'
import { createPetEnvironment } from '../client/pet-environment.js'
import { normalizePetVisualConfig, resolvePetVisualState } from '../client/pet-visual-state.js'
import { spriteForAnimation } from '../client/pet-animation.js'
import { normalizeVisionImage, VISION_ONLY_MESSAGE } from '../brain/vision-input.js'
import { VisualExperienceStore } from '../vision/visual-experience-store.js'
import { visualTermsFor } from '../vision/visual-keywords.js'
import { importLegacyObservations } from '../vision/legacy-observation-importer.js'
import { detectLongTermVisualIntent, LongTermVisualResolver } from '../vision/long-term-visual-recall.js'
import { buildVisualDreamContext } from '../dream/visual-dream-context.js'

const DREAM_MIN_NEW_MEMORIES = 8
const DREAM_OLDEST_SOURCE_AGE_MS = 72 * 60 * 60 * 1000
const REFLECTION_MIN_NEW_MEMORIES = 2
const REFLECTION_OLDEST_SOURCE_AGE_MS = 60 * 60 * 1000

function publicReasoningMetadata(value) {
  return normalizeConversationReasoning(value)
}

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
    this.recentVisualResolver = new RecentVisualResolver()
    this.visualExperience = new VisualExperienceStore(this.sandbox.root)
    this.longTermVisualResolver = new LongTermVisualResolver({ experienceStore: this.visualExperience })
    this.turnManager = new PetTurnManager()
    this.turnOrchestrator = null
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
    await this.visualExperience.initialize()
    this.conversationPersistenceReady = true
    // Zero-inference backfill of the Visual Experience Index: walks raw user
    // messages with attachments, indexes the owner's original wording, and
    // checkpoints a restart-safe cursor. No model calls, no PetMemory writes,
    // no Dream; original images stay untouched under ConversationStore.
    await this.syncVisualExperiences()
    try {
      const migration = await importLegacyObservations({
        store: this.visualExperience,
        readBatch: (afterSequence, limit) => this.conversationStore.rawHistoryAfterSequence({ afterSequence, limit }),
        readMaxSequence: () => this.conversationStore.rawHistoryMaxSequence(),
        tokenizeText: (text, { boost }) => visualTermsFor(text, { boost }),
      })
      this.logger?.info?.(
        `vc-ai-pet: legacy observation migration completed `
        + `total=${migration.total} mapped=${migration.mapped} `
        + `skippedAmbiguous=${migration.skippedAmbiguous} `
        + `skippedNoAttachment=${migration.skippedNoAttachment} `
        + `skippedNoExperience=${migration.skippedNoExperience} `
        + `modelCalls=${migration.modelCalls}`,
      )
    } catch (error) {
      const code = String(error?.code ?? error?.name ?? 'UNKNOWN')
        .replace(/[^A-Z0-9_-]/giu, '_')
        .slice(0, 80) || 'UNKNOWN'
      this.logger?.warn?.(`vc-ai-pet: legacy observation migration failed code=${code}`)
    }
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
    this.turnOrchestrator = new PetTurnOrchestrator({
      runtime: this,
      longTermResolver: this.longTermVisualResolver,
      experienceStore: this.visualExperience,
    })
    this.memoryGate = new MemoryGate({ memory: this.memory })
    const visualContextProvider = ({ query }) => buildVisualDreamContext({
      experienceStore: this.visualExperience,
      query,
    })
    this.dreamEngine = new DreamEngine({
      memory: this.memory,
      brain: this.brain,
      gate: new DreamGate({ memory: this.memory }),
      visualContextProvider,
    })
    this.reflectionEngine = new ReflectionEngine({
      memory: this.memory,
      brain: this.brain,
      gate: new ReflectionGate({ memory: this.memory }),
      visualContextProvider,
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

  async chat(userText, image = null, attachment = null, { turnId = createTurnId() } = {}) {
    const ownerText = String(userText ?? '')
    const currentVisionImage = normalizeVisionImage(image)
    // D-022: explicit long-term visual references take priority over the recent
    // resolver's generic-boilerplate overlapScore, so they always reach the
    // long-term resolver instead of being short-circuited to a wrong recent image.
    if (!currentVisionImage && this.conversationPersistenceReady && detectLongTermVisualIntent(ownerText)) {
      return this.runVisualTurn({ turnId, emit: () => {}, userText: ownerText, attachment: null })
    }
    const recalled = !currentVisionImage && this.conversationPersistenceReady
      ? await this.recentVisualResolver.resolveFromStore(this.conversationStore, ownerText)
      : null
    if ((currentVisionImage || recalled?.matched || recalled?.reason === 'ambiguous-visual-reference') && typeof this.brain?.visualStep === 'function') {
      let currentAttachment = attachment
      if (currentVisionImage && !currentAttachment) currentAttachment = await this.conversationStore.saveAttachment({ image: currentVisionImage })
      return this.runVisualTurn({ turnId, emit: () => {}, userText: ownerText, attachment: currentAttachment })
    }
    // Long-Term Visual stage (elliptical follow-up within an active recall
    // context). A follow-up is only routed to Vision when its pre-resolve
    // actually finds candidates; otherwise the recall context is dropped and
    // the turn falls through to ordinary text.
    if (!currentVisionImage && this.conversationPersistenceReady) {
      const followUp = this.turnOrchestrator.planFollowUp(ownerText)
      if (followUp) {
        const preResolve = await this.longTermVisualResolver.resolve(followUp.query, { limit: 8 })
        if (preResolve.status !== 'none') {
          return this.runVisualTurn({ turnId, emit: () => {}, userText: ownerText, attachment: null, followUp: { query: followUp.query, preResolve } })
        }
        this.turnOrchestrator.clearVisualRecallContext()
      }
    }
    this.chatInFlight += 1

    try {
      let persistedAttachment = null
      let ownerMessage = null
      if (currentVisionImage && this.conversationPersistenceReady) {
        persistedAttachment = attachment
          ? await this.conversationStore.attachment(attachment.id)
          : await this.conversationStore.saveAttachment({ image: currentVisionImage })
        if (!persistedAttachment) {
          const error = new Error('conversation attachment not found')
          error.code = 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND'
          throw error
        }
      }

      let recalledVisionImage = null
      let recalledVisual = null
      if (!currentVisionImage && this.conversationPersistenceReady) {
        recalledVisual = await this.recentVisualResolver.resolveFromStore(this.conversationStore, ownerText)
        if (recalledVisual.matched) {
          try {
            const stored = await this.conversationStore.readAttachmentDataUrl(recalledVisual.attachmentId)
            if (stored?.dataUrl) recalledVisionImage = normalizeVisionImage({ dataUrl: stored.dataUrl })
          } catch (error) {
            this.logger?.warn?.(
              `PET_RECENT_VISUAL_RECALL_READ_FAILURE code=${String(error?.code ?? 'UNKNOWN')} `
              + `attachmentId=${String(recalledVisual.attachmentId)}`,
            )
          }
        }
      }

      // A newly uploaded image always wins. A recalled image is loaded only
      // when the current turn has no image, preserving the single-image
      // Local Brain contract.
      const effectiveVisionImage = currentVisionImage ?? recalledVisionImage
      const visualContext = effectiveVisionImage && !currentVisionImage && recalledVisual?.matched
        ? { source: 'recent-visual-recall' }
        : null
      const promptText = ownerText.trim() || (effectiveVisionImage ? VISION_ONLY_MESSAGE : ownerText)

      if (this.conversationPersistenceReady) {
        ownerMessage = await this.conversationStore.appendMessage({
          role: 'user',
          text: ownerText,
          timestamp: Date.now(),
          attachment: persistedAttachment,
          turnId,
        })
      }

      const result = await this.brain.reply({
        identity: this.identitySnapshot(),
        state: this.snapshot(),
        userText: promptText,
        image: effectiveVisionImage,
        visualContext,
        recentMessages: this.conversation.messages(),
      })

      if (!result?.ok) return result

      // Only the message persisted by this user turn may supply evidence.
      // Assistant output and visual observations never enter this write path.
      if (!effectiveVisionImage && ownerMessage) {
        this.memory.beliefs?.consider(result.beliefCandidates, ownerMessage)
      }

      const gate = effectiveVisionImage
        ? { status: 'skipped', reason: 'vision-context' }
        : ownerText.trim()
          ? this.memoryGate.consider(ownerText, result.rawMemoryCandidate ?? result.memoryCandidate, { messageId: ownerMessage?.id })
          : { status: 'skipped', reason: 'empty-message' }

      const recentUserText = currentVisionImage
        ? `[主人发送了一张图片]${ownerText.trim() ? ` ${ownerText.trim()}` : ''}`
        : ownerText
      const replyMessages = Array.isArray(result.replyMessages)
        ? result.replyMessages.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()).slice(0, 3)
        : []
      const semanticReplies = replyMessages.length ? replyMessages : [result.text]
      this.conversation.append(recentUserText, semanticReplies.join('\n'))
      const reasoning = publicReasoningMetadata(result.reasoning)
      if (this.conversationPersistenceReady) {
        if (semanticReplies.length > 1) {
          for (const [index, text] of semanticReplies.entries()) {
            await this.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, timestamp: Date.now(), reasoning: index === semanticReplies.length - 1 ? reasoning : null })
          }
        } else {
          await this.conversationStore.appendMessage({ role: 'assistant', text: semanticReplies[0], timestamp: Date.now(), reasoning, turnId })
        }
      }

      // Never expose the candidate/evidence or internal gate details to the
      // browser. Reasoning metadata is additive UI telemetry persisted only as
      // optional ConversationStore message metadata.
      if (effectiveVisionImage) await this.syncVisualExperiences()
      return {
        ok: true,
        unavailable: false,
        text: result.text,
        ...(replyMessages.length ? { replyMessages } : {}),
        memoryWrite: gate.status,
        ...(effectiveVisionImage && gate.reason ? { memoryWriteReason: gate.reason } : {}),
        ...(reasoning ? { reasoning } : {}),
      }
    } finally {
      this.chatInFlight -= 1
    }
  }

  async runVisualTurn({ turnId = createTurnId(), emit = () => {}, userText, attachment = null, followUp = null } = {}) {
    this.chatInFlight += 1
    try {
      // Self-healing incremental sync before resolution: any image message
      // appended outside the runtime path must still be visible to Long-Term
      // recall. Idempotent and checkpointed, no models involved.
      await this.syncVisualExperiences()
      const result = await this.turnOrchestrator.runVisual({ turnId, emit, userText, attachment, followUp })
      // Incremental visual-experience sync after the turn's user message has
      // been appended to the archive; idempotent and checkpointed, no models.
      await this.syncVisualExperiences()
      return result
    } finally { this.chatInFlight -= 1 }
  }

  /**
   * Incremental, restart-safe Visual Experience Index sync. Only archive rows
   * after the stored backfill cursor are processed, so a normal greeting never
   * rescans history and no model is ever involved.
   */
  async syncVisualExperiences() {
    if (!this.conversationPersistenceReady || !this.visualExperience) return null
    return this.visualExperience.syncFromArchive({
      readBatch: (afterSequence, limit) => this.conversationStore.rawHistoryAfterSequence({ afterSequence, limit }),
      readMaxSequence: () => this.conversationStore.rawHistoryMaxSequence(),
      tokenizeText: (text, { boost }) => visualTermsFor(text, { boost }),
    })
  }

  startChatTurn({ userText, image = null, attachment = null, attachmentId = null } = {}) {
    return this.turnManager.start(async ({ turnId, emit }) => {
      let normalized = normalizeVisionImage(image)
      if (!normalized && attachmentId) {
        const stored = await this.conversationAsset(attachmentId)
        if (!stored?.dataUrl || !stored.attachment) throw Object.assign(new Error('conversation attachment not found'), { code: 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND' })
        image = { dataUrl: stored.dataUrl }
        attachment = stored.attachment
        normalized = normalizeVisionImage(image)
      }
      if (normalized) {
        const currentAttachment = attachment ?? await this.conversationStore.saveAttachment({ image: normalized })
        return this.runVisualTurn({ turnId, emit, userText, attachment: currentAttachment })
      }
      // D-022: explicit long-term visual references take priority over the recent
      // resolver's generic-boilerplate overlapScore, so they reach the long-term
      // resolver instead of being short-circuited to a wrong recent image.
      if (detectLongTermVisualIntent(userText)) return this.runVisualTurn({ turnId, emit, userText, attachment: null })
      const recalled = await this.recentVisualResolver.resolveFromStore(this.conversationStore, userText)
      if (recalled?.matched || recalled?.reason === 'ambiguous-visual-reference') return this.runVisualTurn({ turnId, emit, userText, attachment: null })
      const followUp = this.turnOrchestrator.planFollowUp(userText)
      if (followUp) {
        const preResolve = await this.longTermVisualResolver.resolve(followUp.query, { limit: 8 })
        if (preResolve.status !== 'none') {
          return this.runVisualTurn({ turnId, emit, userText, attachment: null, followUp: { query: followUp.query, preResolve } })
        }
        this.turnOrchestrator.clearVisualRecallContext()
      }
      emit('turn_started', { mode: 'text' }); emit('thinking', {})
      const result = await this.chat(userText, null, null, { turnId })
      if (!result?.ok) return result
      const replies = Array.isArray(result.replyMessages) && result.replyMessages.length ? result.replyMessages : [result.text]
      for (const text of replies) emit('assistant_message', { text })
      emit('turn_completed', { durationMs: result?.reasoning?.durationMs ?? 0, reasoning: result?.reasoning })
      return result
    })
  }

  pollChatTurn(turnId, after = 0) { return this.turnManager.poll(turnId, after) }

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
    const persisted = typeof this.conversationStore.semanticHistory === 'function'
      ? await this.conversationStore.semanticHistory(48)
      : await this.conversationStore.list(24)
    this.conversation.clear()
    const entries = []
    const keyed = new Map()
    let legacy = null
    const entryFor = (message, index) => {
      if (message.turnId) {
        let entry = keyed.get(message.turnId)
        if (!entry) {
          entry = { user: null, replies: [], index }
          keyed.set(message.turnId, entry)
          entries.push(entry)
        }
        return entry
      }
      if (message.role === 'user') {
        legacy = { user: message, replies: [], index }
        entries.push(legacy)
        return legacy
      }
      return legacy
    }
    for (const [index, message] of persisted.entries()) {
      if (['activity', 'media_ref'].includes(message.kind)) continue
      const entry = entryFor(message, index)
      if (!entry) continue
      if (message.role === 'user') entry.user = message
      else if (message.role === 'assistant') entry.replies.push(message.text)
    }
    for (const entry of entries.sort((left, right) => left.index - right.index)) {
      if (!entry.user || entry.replies.length === 0) continue
      const userText = entry.user.attachment
        ? `[主人发送了一张图片]${entry.user.text ? ` ${entry.user.text}` : ''}`
        : entry.user.text
      this.conversation.append(userText, entry.replies.join('\n'))
    }
  }

  async persist() {
    await this.sandbox.writeJson('world', 'state.json', this.state)
  }

  close() {
    // Local Brain is now a shared external service. Pet owns no model process.
    this.conversation?.clear()
    this.conversationPersistenceReady = false
    this.conversationStore?.close()
    this.visualExperience?.close()
    this.memory?.close()
  }
}
