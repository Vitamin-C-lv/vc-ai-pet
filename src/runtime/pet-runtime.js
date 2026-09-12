import { PetSandbox } from '../core/pet-sandbox.js'
import { createInitialState, advanceState, interact } from '../core/pet-state-engine.js'
import { assertPetPolicy } from '../core/pet-policy.js'
import { ensurePetIdentity } from '../core/pet-identity.js'
import { PetMemory } from '../memory/pet-memory.js'
import { MemoryGate } from '../memory/memory-gate.js'
import { LocalBrain } from '../brain/local-brain.js'
import { RecentConversation, RECENT_CONVERSATION_DEFAULT_MAX_TURNS } from '../conversation/recent-conversation.js'
import { ConversationStore, CONVERSATION_MAX_MESSAGES } from '../conversation/conversation-store.js'
import { normalizeConversationReasoning } from '../conversation/reasoning-metadata.js'
import { RecentVisualResolver } from '../conversation/recent-visual-context.js'
import { selectContextTurns } from '../conversation/context-budget.js'
import { resolveMemoryPipelineConfig } from '../memory/memory-pipeline-config.js'
import { ExplicitMemoryController } from '../memory/explicit-memory-controller.js'
import { ExplicitMemoryQueue } from '../memory/explicit-memory-queue.js'
import { ExperienceBuffer } from '../experience/experience-buffer.js'
import { ExperienceConsolidator } from '../experience/experience-consolidator.js'
import { buildRecentExperienceContext, withExperienceDeclaration } from '../experience/experience-dream-context.js'
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

/**
 * Experience-aware reflection trigger.
 *
 * The raw-memory criteria are unchanged and remain the baseline. On top of them
 * the buffer adds the three signals the owner asked for, so a fresh day of life
 * can be reflected on before anything has been written to PetMemory:
 *
 *   A. enough new experiences accumulated (count trigger);
 *   B. the owner explicitly asked for something to be remembered (HIGH priority);
 *   C. a repeated behaviour or a significant emotion event was observed.
 *
 * Skipping is never wrong here: the next scheduled pass re-evaluates. What would
 * be wrong is reflecting *without* raw sources, which the engine's lease and
 * `isRawEvidenceRow` guards still enforce.
 */
async function experienceAwareReflectionEligibility(runtime, memory, options = {}) {
  const base = reflectionEligibility(memory, options)
  const config = runtime.pipelineConfig
  if (!config?.reflectionOnExperience || !runtime.experienceBuffer || !runtime.experienceBufferReady) {
    return { ...base, experienceSourceCount: 0, experienceReason: 'experience-buffer-unavailable' }
  }

  let pending = []
  try {
    pending = (await runtime.experienceBuffer.pendingExperience({ limit: 200 })) ?? []
  } catch {
    return { ...base, experienceSourceCount: 0, experienceReason: 'experience-buffer-read-failed' }
  }

  const explicitCount = pending.filter((row) => row.sourceType === 'explicit_memory').length
  const repeatedCount = pending.filter((row) => row.sourceType === 'repeated_behavior').length
  const emotionCount = pending.filter((row) => row.sourceType === 'emotion_event').length
  const threshold = config.reflectionNewExperienceTrigger

  // Priority order matches importance: an instruction the owner gave outranks
  // a quantity threshold, which in turn outranks an inferred pattern.
  const experienceReason = explicitCount > 0
    ? 'explicit-memory-pending'
    : pending.length >= threshold
      ? 'new-experience-threshold'
      : repeatedCount > 0
        ? 'repeated-behaviour-observed'
        : emotionCount > 0
          ? 'emotion-event-observed'
          : 'no-new-experience'

  const experienceEligible = explicitCount > 0
    || pending.length >= threshold
    || repeatedCount > 0
    || emotionCount > 0

  return {
    ...base,
    eligible: base.eligible || experienceEligible,
    reason: base.eligible ? base.reason : experienceEligible ? experienceReason : base.reason,
    experienceReason,
    experienceSourceCount: pending.length,
    experienceExplicitCount: explicitCount,
    experienceRepeatedCount: repeatedCount,
    experienceEmotionCount: emotionCount,
  }
}

export class PetRuntime {
  constructor({ sandboxRoot, logger = null, memoryPipeline = null, env = process.env }) {
    this.sandbox = new PetSandbox(sandboxRoot)
    this.logger = logger
    this.memory = null
    this.memoryGate = null
    this.brain = null
    this.state = null
    this.identity = null
    // The Experience-aware Memory Pipeline resolves every context/retention knob
    // once, here, so no two modules can disagree about the working window.
    this.pipelineConfig = resolveMemoryPipelineConfig({ config: memoryPipeline, env })
    this.conversation = new RecentConversation({ maxTurns: this.pipelineConfig.shortTermContextTurns })
    this.conversationStore = new ConversationStore(this.sandbox.root)
    this.recentVisualResolver = new RecentVisualResolver()
    this.visualExperience = new VisualExperienceStore(this.sandbox.root)
    this.longTermVisualResolver = new LongTermVisualResolver({ experienceStore: this.visualExperience })
    // Experience Buffer: recent life that has not (yet) become a memory row.
    this.experienceBuffer = this.pipelineConfig.experienceBufferEnabled
      ? new ExperienceBuffer({
          root: this.sandbox.root,
          retentionMs: this.pipelineConfig.experienceBufferRetentionMs,
        })
      : null
    this.experienceBufferReady = false
    this.experienceConsolidator = null
    this.consolidationInFlight = false
    // Explicit Memory Queue: the owner's own instruction outranks a model that
    // is merely too shy to volunteer a candidate. The registry keeps the
    // pipeline metadata (priority/source/phrase/content) that the queue itself
    // does not model, so the queue module stays untouched.
    this.explicitMemoryEntries = new Map()
    this.explicitMemoryQueue = new ExplicitMemoryQueue()
    this.explicitMemoryQueue.explicitMemoryEntry = (id) => this.explicitMemoryEntries.get(id) ?? null
    this.explicitMemoryQueue.snapshot = () => [...this.explicitMemoryEntries.values()].map((entry) => ({ ...entry }))
    this.explicitMemoryController = new ExplicitMemoryController()
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
    // The experience store is additive and never blocks waking up: if it cannot
    // be opened the pet still chats, it just does not remember recent life.
    if (this.experienceBuffer) {
      try {
        await this.experienceBuffer.initialize()
        this.experienceBufferReady = true
      } catch (error) {
        this.experienceBufferReady = false
        this.logger?.warn?.(
          `vc-ai-pet: experience buffer unavailable code=${String(error?.code ?? error?.name ?? 'UNKNOWN').slice(0, 60)}`,
        )
      }
    }
    if (this.pipelineConfig.diagnostics.length > 0) {
      this.logger?.warn?.(`vc-ai-pet: memory pipeline config diagnostics=${this.pipelineConfig.diagnostics.join(',')}`)
    }
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
    // Consolidation is the "repeated experience becomes understanding" step. It
    // only exists when the buffer does; without it Dream/Reflection still work
    // exactly as before.
    this.experienceConsolidator = this.experienceBuffer
      ? new ExperienceConsolidator({
          buffer: this.experienceBuffer,
          memory: this.memory,
          logger: this.logger,
        })
      : null
    const visualContextProvider = ({ query }) => buildVisualDreamContext({
      experienceStore: this.visualExperience,
      query,
    })
    // Dream and Reflection keep their prompts and schemas untouched; the only
    // change is that recent lived experience is prepended to the context they
    // already receive. It is rendered with its own declaration so neither engine
    // can mistake a recent experience for a verified long-term memory.
    const experienceAwareContextProvider = async (request) => {
      const visualSection = await visualContextProvider(request)
      const recent = await this.recentExperienceContext({ limit: this.pipelineConfig.dreamRecentExperienceLimit })
      const experienceSection = withExperienceDeclaration(recent.rendered)
      if (!visualSection && !experienceSection) return null
      return [visualSection, experienceSection].filter(Boolean).join('\n\n')
    }
    this.dreamEngine = new DreamEngine({
      memory: this.memory,
      brain: this.brain,
      gate: new DreamGate({ memory: this.memory }),
      visualContextProvider: experienceAwareContextProvider,
    })
    this.reflectionEngine = new ReflectionEngine({
      memory: this.memory,
      brain: this.brain,
      gate: new ReflectionGate({ memory: this.memory }),
      visualContextProvider: experienceAwareContextProvider,
    })
    this.dreamScheduler = new DreamScheduler({
      memory: this.memory,
      engine: this.dreamEngine,
      reflectionEngine: this.reflectionEngine,
      eligibility: (options) => dreamEligibility(this.memory, options),
      deepDreamEligibility: (options) => deepDreamEligibility(this.memory, options),
      reflectionEligibility: (options) => experienceAwareReflectionEligibility(this, this.memory, options),
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

    // Experience consolidation runs before Dream/Reflection and only while the
    // pet is idle. It is the step that turns *repeated* recent life into raw
    // PetMemory rows; Dream and Reflection then work on ordinary raw evidence,
    // so their prompts, schemas and invariants stay exactly as they were.
    await this.consolidateExperiences()

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

  #shouldRouteVisualFollowUp(followUp, preResolve) {
    const status = preResolve?.status
    return status === 'matched'
      || status === 'ambiguous'
      || followUp?.retryOnNone === true
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
    // context). A normal topic shift needs a long-term candidate first;
    // clarification and subject-correction turns are retrieval retries even
    // when the retry currently has no candidate.
    if (!currentVisionImage && this.conversationPersistenceReady) {
      const followUp = this.turnOrchestrator.planFollowUp(ownerText)
      if (followUp) {
        const preResolve = await this.longTermVisualResolver.resolve(followUp.query, { limit: 8 })
        if (this.#shouldRouteVisualFollowUp(followUp, preResolve)) {
          return this.runVisualTurn({ turnId, emit: () => {}, userText: ownerText, attachment: null, followUp: { ...followUp, preResolve } })
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
        recentMessages: this.#shortTermContext(),
      })

      if (!result?.ok) return result

      // Only the message persisted by this user turn may supply evidence.
      // Assistant output and visual observations never enter this write path.
      if (!effectiveVisionImage && ownerMessage) {
        this.memory.beliefs?.consider(result.beliefCandidates, ownerMessage)
      }

      // Explicit Memory Queue: an instruction the owner actually gave outranks
      // a model that is merely too conservative to volunteer a candidate, and it
      // keeps covering the follow-up sentence that carries no keyword at all
      // ("记住我们家的猫叫黑莓" -> "我们家的猫叫黑莓").
      const explicit = ownerText.trim()
        ? this.explicitMemoryController.resolve(ownerText)
        : { decision: 'none', evidence: null, priority: null, source: null, phrase: null }
      let explicitEntry = null
      if (explicit.decision !== 'none') {
        const queued = this.explicitMemoryQueue.enqueue({
          userText: ownerText,
          messageId: ownerMessage?.id ?? null,
          turnId,
          candidate: null,
          phrase: explicit.phrase,
          reason: explicit.decision,
        })
        if (queued) {
          // Normalise the metadata the pipeline contract promises, without
          // editing the queue module's own record shape.
          queued.priority = explicit.priority ?? 'HIGH'
          queued.source = explicit.source ?? 'USER_EXPLICIT'
          queued.decision = explicit.decision
          queued.content = explicit.content ?? null
          queued.evidence = explicit.evidence ?? null
          queued.enqueuedAt = queued.enqueuedAt ?? Date.now()
          explicitEntry = queued
          this.explicitMemoryEntries.set(queued.id, queued)
        }
      }

      const gate = effectiveVisionImage
        ? { status: 'skipped', reason: 'vision-context' }
        : ownerText.trim()
          ? this.memoryGate.consider(ownerText, result.rawMemoryCandidate ?? result.memoryCandidate, {
              messageId: ownerMessage?.id,
              explicitFallback: explicit.decision === 'none'
                ? null
                : {
                    level: explicit.level ?? 'fact',
                    content: explicit.content ?? '',
                    importance: 3,
                    keywords: [],
                    confidence: 1,
                    evidence: explicit.accumulatedEvidence ?? explicit.evidence,
                  },
            })
          : { status: 'skipped', reason: 'empty-message' }

      if (explicitEntry) {
        // Persisted-or-already-known both mean the instruction was honoured.
        // The controller window is intentionally left open: a restatement in a
        // following turn is normal, and deduplication in the gate absorbs it.
        if (gate.status === 'written') {
          this.explicitMemoryQueue.markWritten(explicitEntry.id, { memoryId: gate.id ?? null })
        } else if (gate.status === 'duplicate') {
          this.explicitMemoryQueue.markWritten(explicitEntry.id, { memoryId: gate.id ?? null })
        } else {
          this.explicitMemoryQueue.markRejected(explicitEntry.id, gate.reason ?? gate.status)
        }
      }

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

      // Experience Buffer: record the lived turn so Reflection can later find
      // what repeated and what mattered. Low-value chitchat is rejected by the
      // store's own admission rule, so "not every chat becomes a memory" holds
      // even for the buffer. This is fire-and-forget: a buffer failure must
      // never fail the owner's turn.
      this.#recordExperience({
        turnId,
        ownerText: recentUserText,
        assistantText: semanticReplies.join('\n'),
        hadVision: Boolean(effectiveVisionImage),
        messageId: ownerMessage?.id ?? null,
        explicitMemoryRequest: explicit.decision !== 'none',
        currentVisionImage,
      })

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
        ...(gate.source ? { memoryPriority: gate.priority, memorySource: gate.source } : {}),
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
      readAttachment: (attachmentId) => this.conversationStore.readAttachmentDataUrl(attachmentId),
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
        if (this.#shouldRouteVisualFollowUp(followUp, preResolve)) {
          return this.runVisualTurn({ turnId, emit, userText, attachment: null, followUp: { ...followUp, preResolve } })
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
    }).then(async (result) => {
      await this.#markExperiencesConsumed(result)
      return result
    })
  }

  /**
   * A completed reflection pass has *consumed* the experiences it was shown, so
   * they are marked processed and stop being re-fed on every later pass. Only a
   * completed pass marks anything: a skipped or failed reflection must leave the
   * buffer intact or the life it was supposed to reflect on is lost.
   */
  async #markExperiencesConsumed(result) {
    if (!this.experienceBuffer || !this.experienceBufferReady) return 0
    if (result?.status !== 'completed' || result?.ok !== true) return 0
    try {
      const pending = await this.experienceBuffer.pendingExperience({ limit: 200 })
      const ids = (pending ?? []).map((row) => row.id).filter((id) => Number.isInteger(id))
      if (ids.length === 0) return 0
      await this.experienceBuffer.markProcessed(ids)
      return ids.length
    } catch (error) {
      this.logger?.warn?.(
        `vc-ai-pet: experience mark-processed failed code=${String(error?.code ?? 'UNKNOWN').slice(0, 60)}`,
      )
      return 0
    }
  }

  /**
   * Turn repeated recent experience into raw PetMemory rows.
   *
   * Deliberately conservative and idempotent: the consolidator only promotes
   * something that appeared more than once across different conversations, it
   * deduplicates against existing memory, and it never runs while a chat, dream
   * or reflection is in flight. A failure is logged, never thrown — this is a
   * background tidy-up, not part of answering the owner.
   */
  async consolidateExperiences({ limit = 50 } = {}) {
    if (!this.experienceBuffer || !this.experienceBufferReady || !this.experienceConsolidator) {
      return { status: 'skipped', ok: false, reason: 'consolidator-unavailable' }
    }
    if (this.chatInFlight > 0 || this.dreamEngine?.isInFlight?.() || this.reflectionEngine?.isInFlight?.()) {
      return { status: 'skipped', ok: false, reason: 'pet-busy' }
    }
    if (this.consolidationInFlight) return { status: 'skipped', ok: false, reason: 'consolidation-in-flight' }
    this.consolidationInFlight = true
    try {
      const result = await this.experienceConsolidator.consolidate({ limit })
      if (result?.written > 0) {
        this.logger?.info?.(
          `vc-ai-pet: experience consolidation written=${result.written} candidates=${result.candidates} scanned=${result.scanned}`,
        )
      }
      return result
    } catch (error) {
      this.logger?.warn?.(
        `vc-ai-pet: experience consolidation failed code=${String(error?.code ?? 'UNKNOWN').slice(0, 60)}`,
      )
      return { status: 'failed', ok: false, reason: String(error?.code ?? 'consolidation-failed') }
    } finally {
      this.consolidationInFlight = false
    }
  }

  /**
   * The working window sent to the model.
   *
   * `RecentConversation` still owns and bounds the short-term memory; this only
   * decides what fits in the token budget. When the budget is exceeded, casual
   * chitchat is dropped before anything the owner stated as a fact, and the most
   * recent turns are never dropped at all — a pet that forgets what was just
   * said is worse than one that forgets an old greeting.
   *
   * Any failure falls back to the unbounded window: trimming is an optimisation,
   * never a reason to answer with less context than before.
   */
  #shortTermContext() {
    const turns = this.conversation?.snapshot?.() ?? []
    try {
      const selected = selectContextTurns(turns, {
        maxTurns: this.pipelineConfig.shortTermContextTurns,
        maxChars: this.pipelineConfig.shortTermContextChars,
      })
      if (Array.isArray(selected?.turns) && selected.turns.length > 0) {
        return selected.turns.flatMap(({ user, assistant }) => [
          { role: 'user', content: user },
          { role: 'assistant', content: assistant },
        ])
      }
    } catch (error) {
      this.logger?.warn?.(`vc-ai-pet: context budget selection failed code=${String(error?.code ?? 'UNKNOWN').slice(0, 60)}`)
    }
    return this.conversation.messages()
  }

  recall(query, k = 5) {
    return this.memory.recall(query, k)
  }

  /**
   * Recent lived experience for Dream / Reflection input. Read-only and safe to
   * call when the buffer is unavailable: the caller gets an empty context rather
   * than an exception in the middle of a background pass.
   */
  async recentExperienceContext({ limit = this.pipelineConfig.dreamRecentExperienceLimit } = {}) {
    if (!this.experienceBuffer || !this.experienceBufferReady) {
      return buildRecentExperienceContext({ entries: [], limit })
    }
    try {
      const entries = typeof this.experienceBuffer.recent === 'function'
        ? await this.experienceBuffer.recent({ limit })
        : await this.experienceBuffer.pendingExperience({ limit })
      return buildRecentExperienceContext({ entries: entries ?? [], limit })
    } catch (error) {
      this.logger?.warn?.(`vc-ai-pet: recent experience read failed code=${String(error?.code ?? 'UNKNOWN').slice(0, 60)}`)
      return buildRecentExperienceContext({ entries: [], limit })
    }
  }

  /**
   * Write one lived turn into the Experience Buffer. Deliberately synchronous
   * and swallowed: the buffer is a memory aid, never a precondition for talking.
   */
  #recordExperience({
    turnId = null,
    ownerText = '',
    assistantText = '',
    hadVision = false,
    messageId = null,
    explicitMemoryRequest = false,
    currentVisionImage = null,
  } = {}) {
    if (!this.experienceBuffer || !this.experienceBufferReady) return null
    try {
      const emotion = this.emotion && typeof this.emotion === 'object'
        ? { mood: this.emotion.mood ?? null, intensity: this.emotion.intensity ?? null }
        : null
      // The store owns the canonical `experience_events` column names. The
      // runtime only supplies the values, and supplies both the canonical name
      // and the pre-rename alias so a schema migration behind this store cannot
      // silently drop the content.
      const payload = {
        conversationId: turnId,
        turnId,
        messageId,
        actorId: 'owner',
        actor: 'owner',
        content: ownerText,
        ownerText,
        assistantText,
        hadVision: Boolean(hadVision),
        visionSummary: hadVision && currentVisionImage ? '主人这一轮发送了图片' : null,
        emotion,
        explicitMemoryRequest,
        sourceType: explicitMemoryRequest ? 'explicit_memory' : null,
      }
      return this.experienceBuffer.record(payload)
    } catch (error) {
      this.logger?.warn?.(`vc-ai-pet: experience record failed code=${String(error?.code ?? 'UNKNOWN').slice(0, 60)}`)
      return null
    }
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
    // Each turn contributes roughly two archived messages (owner + final
    // assistant reply), so restoring the configured working window means asking
    // for twice as many messages. 48 messages could only ever rebuild 24 turns.
    const restoreMessages = Math.min(
      CONVERSATION_MAX_MESSAGES,
      Math.max(48, this.pipelineConfig.shortTermContextTurns * 2 + 4),
    )
    const persisted = typeof this.conversationStore.semanticHistory === 'function'
      ? await this.conversationStore.semanticHistory(restoreMessages)
      : await this.conversationStore.list(restoreMessages)
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
