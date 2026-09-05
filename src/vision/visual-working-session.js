import { normalizeVisionImage } from '../brain/vision-input.js'
import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'
import { visualTermsFor, VISUAL_OBSERVATION_TERM_BOOST } from './visual-keywords.js'

export const MAX_VISUAL_INSPECTIONS_PER_TURN = 5
export const COMPARISON_TASK_MIN_UNIQUE_IMAGES = 2

function visualFailure({ reason = 'visual-step-failed', unavailable = false, requestId = null, stage, inspectionOrdinal, candidate = null, nextVisualId = null, inspections }) {
  const currentVisualId = typeof candidate?.visualId === 'string' ? candidate.visualId.slice(0, 16) : null
  const attachmentId = typeof candidate?.attachmentId === 'string' ? candidate.attachmentId.slice(0, 80) : null
  const next = typeof nextVisualId === 'string' ? nextVisualId.trim().slice(0, 16) : null
  const code = String(reason ?? 'visual-step-failed').slice(0, 120)
  return {
    ok: false,
    unavailable: unavailable === true,
    reason: code,
    requestId: typeof requestId === 'string' ? requestId.slice(0, 160) : null,
    inspections,
    diagnostic: {
      stage,
      errorCode: code,
      requestId: typeof requestId === 'string' ? requestId.slice(0, 160) : null,
      retryable: unavailable === true,
      inspectionOrdinal: Number.isInteger(inspectionOrdinal) ? inspectionOrdinal : inspections.length,
      currentVisualId,
      nextVisualId: next,
      attachmentId,
    },
  }
}

export class VisualWorkingSession {
  constructor({ turnId, userText, candidatePool, comparison = false, comparisonPair = [], conversationStore, brain, emit, now = () => Date.now(), experienceStore = null }) {
    this.turnId = turnId
    this.userText = String(userText ?? '')
    this.candidatePool = Array.isArray(candidatePool) ? candidatePool : []
    this.comparison = comparison === true
    const candidateIds = new Set(this.candidatePool.map((candidate) => candidate?.visualId).filter((visualId) => typeof visualId === 'string'))
    const seenAttachments = new Set()
    this.comparisonPair = (Array.isArray(comparisonPair) ? comparisonPair : [])
      .filter((candidate) => {
        const attachmentId = typeof candidate?.attachmentId === 'string' ? candidate.attachmentId : ''
        const visualId = typeof candidate?.visualId === 'string' ? candidate.visualId : ''
        if (!candidateIds.has(visualId) || !attachmentId || seenAttachments.has(attachmentId)) return false
        seenAttachments.add(attachmentId)
        return true
      })
      .slice(0, COMPARISON_TASK_MIN_UNIQUE_IMAGES)
    this.requiredUniqueImages = this.comparison ? COMPARISON_TASK_MIN_UNIQUE_IMAGES : 1
    this.conversationStore = conversationStore
    this.brain = brain
    this.emit = emit
    this.now = now
    this.experienceStore = experienceStore
    this.startedAt = this.now()
    this.observations = []
    this.inspections = []
    this.prematureAnswersBlocked = 0
    this.prematureReplyMessagesDiscarded = 0
  }

  get inspectionCount() { return this.inspections.length }

  #nextUninspectedComparisonVisualId() {
    for (const candidate of this.comparisonPair) {
      if (!this.inspections.some((item) => item.attachmentId === candidate.attachmentId)) return candidate.visualId
    }
    return null
  }

  #comparisonFallbackVisualId() {
    return this.comparisonPair[0]?.visualId
      ?? this.candidatePool.find((candidate) => candidate.visualId === this.inspections.at(-1)?.visualId)?.visualId
      ?? this.candidatePool[0]?.visualId
      ?? null
  }

  async #recordVisualEvents(candidate, summary, focus) {
    const store = this.experienceStore
    if (!store || typeof store.findExperienceByAttachmentId !== 'function' || typeof store.recordEvent !== 'function') return

    let experience
    try {
      experience = await store.findExperienceByAttachmentId(candidate.attachmentId)
    } catch (error) {
      return
    }
    if (!experience?.experienceId) return

    const previouslyInspected = this.inspections
      .slice(0, -1)
      .some((item) => item.attachmentId === candidate.attachmentId)
    try {
      await store.recordEvent({
        experienceId: experience.experienceId,
        turnId: this.turnId,
        kind: previouslyInspected ? 'revisit' : 'inspection',
        occurredAt: this.now(),
        summary: null,
        focus: null,
      })
    } catch (error) {
      return
    }

    if (summary) {
      try {
        await store.recordEvent({
          experienceId: experience.experienceId,
          turnId: this.turnId,
          kind: 'observation',
          occurredAt: this.now(),
          summary,
          focus,
          evidence: 'inferred',
          terms: visualTermsFor(summary, { boost: VISUAL_OBSERVATION_TERM_BOOST }),
        })
      } catch (error) {
        // Visual event persistence is best effort and must never fail a turn.
      }
    }

    if (!this.comparison || !summary) return
    const otherInspection = this.inspections
      .slice(0, -1)
      .find((item) => item.attachmentId !== candidate.attachmentId)
    if (!otherInspection || typeof store.findExperienceByAttachmentId !== 'function') return

    let relatedExperience
    try {
      relatedExperience = await store.findExperienceByAttachmentId(otherInspection.attachmentId)
    } catch (error) {
      return
    }
    if (!relatedExperience?.experienceId) return
    try {
      await store.recordEvent({
        experienceId: experience.experienceId,
        turnId: this.turnId,
        kind: 'comparison',
        occurredAt: this.now(),
        summary,
        focus,
        evidence: 'inferred',
        relatedExperienceId: relatedExperience.experienceId,
      })
    } catch (error) {
      // Visual event persistence is best effort and must never fail a turn.
    }
  }

  async run(firstVisualId) {
    let visualId = firstVisualId
    let final = null
    while (visualId && this.inspections.length < MAX_VISUAL_INSPECTIONS_PER_TURN) {
      const candidate = this.candidatePool.find((item) => item.visualId === visualId)
      if (!candidate) break
      const ordinal = this.inspections.length
      let stored
      try {
        stored = await this.conversationStore.readAttachmentDataUrl(candidate.attachmentId)
      } catch (error) {
        return visualFailure({ reason: error?.code ?? 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND', requestId: error?.requestId ?? null, unavailable: error?.retryable === true, stage: 'asset', inspectionOrdinal: ordinal + 1, candidate, inspections: this.inspections })
      }
      const image = stored?.dataUrl ? normalizeVisionImage({ dataUrl: stored.dataUrl }) : null
      if (!image) return visualFailure({ reason: 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND', stage: 'asset', inspectionOrdinal: ordinal + 1, candidate, inspections: this.inspections })
      const metadata = stored.attachment ?? await this.conversationStore.attachment?.(candidate.attachmentId)
      if (!metadata) return visualFailure({ reason: 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND', stage: 'asset', inspectionOrdinal: ordinal + 1, candidate, inspections: this.inspections })
      const alreadyInspected = this.inspections.some((item) => item.visualId === visualId)
      const caption = alreadyInspected
        ? '🔎 花花想再确认一下这张……'
        : candidate.relation === 'current'
          ? '🐾 花花先仔细看看这张……'
          : candidate.relation === 'recalled'
            ? '↩️ 花花翻到以前的一张照片'
            : '↩️ 花花再回头看看前一张……'
      const selectedEvent = this.emit('visual_selected', { relation: candidate.relation, sourceAttachmentId: candidate.attachmentId, caption })
      await this.conversationStore.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_selected', relation: candidate.relation, sourceAttachmentId: candidate.attachmentId, activitySeq: selectedEvent?.seq, activityAt: selectedEvent?.at, turnId: this.turnId, text: caption })
      let publicAttachment
      try {
        publicAttachment = this.conversationStore.publicAttachment(metadata)
      } catch (error) {
        return visualFailure({ reason: error?.code ?? 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND', requestId: error?.requestId ?? null, unavailable: error?.retryable === true, stage: 'asset', inspectionOrdinal: ordinal + 1, candidate, inspections: this.inspections })
      }
      if (!publicAttachment) return visualFailure({ reason: 'PET_CONVERSATION_ATTACHMENT_NOT_FOUND', stage: 'asset', inspectionOrdinal: ordinal + 1, candidate, inspections: this.inspections })
      const imageCaption = candidate.relation === 'recalled'
        ? '花花重新看看这张'
        : candidate.relation === 'current' ? '花花看看这张' : '花花再看看这张'
      const imageEvent = this.emit('visual_image', { sourceAttachmentId: candidate.attachmentId, attachment: publicAttachment, caption: imageCaption })
      await this.conversationStore.appendMessage({ role: 'assistant', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: candidate.attachmentId, activitySeq: imageEvent?.seq, activityAt: imageEvent?.at, turnId: this.turnId, text: caption, attachment: metadata })
      this.inspections.push({ visualId, attachmentId: candidate.attachmentId })
      let step
      try {
        step = await this.brain.visualStep({
          userText: this.userText,
          image,
          candidatePool: this.candidatePool,
          observations: this.observations,
          comparison: this.comparison,
          comparisonPair: this.comparisonPair,
          currentVisualId: visualId,
          inspections: this.inspections,
          requiredUniqueImages: this.requiredUniqueImages,
          forceAnswer: ordinal === MAX_VISUAL_INSPECTIONS_PER_TURN - 1,
        })
      } catch (error) {
        return visualFailure({ reason: error?.code ?? 'visual-step-failed', unavailable: error?.retryable === true, requestId: error?.requestId ?? null, stage: 'local-brain', inspectionOrdinal: ordinal + 1, candidate, inspections: this.inspections })
      }
      if (!step?.ok) return visualFailure({ reason: step?.reason ?? 'local-brain-unavailable', unavailable: step?.unavailable === true, requestId: step?.requestId ?? null, stage: 'local-brain', inspectionOrdinal: ordinal + 1, candidate, inspections: this.inspections })
      if (typeof step.observation !== 'string' || typeof step.action !== 'string' || !['inspect', 'answer'].includes(step.action) || typeof step.nextVisualId !== 'string' || step.nextVisualId.trim().length > 16 || typeof step.focus !== 'string' || step.focus.trim().length > 120 || !Array.isArray(step.replyMessages) || step.replyMessages.length > 3 || step.replyMessages.some((item) => typeof item !== 'string' || item.trim().length < 1 || item.trim().length > 300)) {
        return visualFailure({ reason: 'invalid-visual-step', stage: 'structured-output', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
      }
      const rawObservation = typeof step.observation === 'string' ? step.observation.trim() : ''
      const summary = sanitizeSafeTraceText(rawObservation, 180)
      if (rawObservation.length > 180 || (rawObservation && !summary)) return visualFailure({ reason: 'unsafe-visual-observation', stage: 'structured-output', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
      const focus = typeof step.focus === 'string' ? step.focus.trim() : ''
      const safeFocus = sanitizeSafeTraceText(focus, 120)
      if (focus.length > 120 || (focus && !safeFocus)) return visualFailure({ reason: 'unsafe-visual-focus', stage: 'structured-output', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
      await this.#recordVisualEvents(candidate, summary, safeFocus)
      if (summary) {
        const observation = { visualId, attachmentId: candidate.attachmentId, focus: safeFocus, summary }
        this.observations.push(observation)
        const observationEvent = this.emit('visual_observation', { summary, focus: safeFocus })
        await this.conversationStore.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_observation', activitySeq: observationEvent?.seq, activityAt: observationEvent?.at, turnId: this.turnId, text: `看到：${summary}` })
        if (this.inspections.length >= 1 && this.inspections.some((item) => item.attachmentId !== candidate.attachmentId)) {
          const compareEvent = this.emit('visual_compare', { summary, focus: safeFocus })
          await this.conversationStore.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_compare', activitySeq: compareEvent?.seq, activityAt: compareEvent?.at, turnId: this.turnId, text: `对照：${summary}` })
        }
      }
      const forcedFinal = ordinal === MAX_VISUAL_INSPECTIONS_PER_TURN - 1
      const action = forcedFinal ? 'answer' : step.action
      const replyMessages = Array.isArray(step.replyMessages)
        ? step.replyMessages.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
        : []
      if (replyMessages.some((item) => item.length > 300 || !sanitizeSafeTraceText(item, 300))) return visualFailure({ reason: 'unsafe-visual-reply', stage: 'structured-output', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
      const uniqueImages = new Set(this.inspections.map((item) => item.attachmentId)).size
      if (this.comparison && uniqueImages < this.requiredUniqueImages) {
        const nextComparisonVisualId = this.#nextUninspectedComparisonVisualId()
        if (nextComparisonVisualId) {
          if (action === 'answer') {
            this.prematureAnswersBlocked += 1
            this.prematureReplyMessagesDiscarded += replyMessages.length
          }
          visualId = nextComparisonVisualId
          continue
        }
        if (action === 'answer') {
          this.prematureAnswersBlocked += 1
          this.prematureReplyMessagesDiscarded += replyMessages.length
          final = null
          break
        }
      }
      if (action === 'answer') {
        if (!forcedFinal && (step.nextVisualId || replyMessages.length === 0)) return visualFailure({ reason: 'invalid-visual-answer', stage: 'structured-output', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
        if (forcedFinal && replyMessages.length === 0) { final = null; break }
        final = { ...step, action: 'answer', nextVisualId: '', replyMessages }
        break
      }
      if (action !== 'inspect' || typeof step.nextVisualId !== 'string') {
        return visualFailure({ reason: 'invalid-visual-inspection', stage: 'protocol', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
      }
      if (!this.candidatePool.some((item) => item.visualId === step.nextVisualId)) {
        const comparisonFallback = this.comparison ? (this.#nextUninspectedComparisonVisualId() ?? this.#comparisonFallbackVisualId()) : null
        if (comparisonFallback) {
          visualId = comparisonFallback
          continue
        }
        return visualFailure({ reason: 'invalid-visual-inspection', stage: 'protocol', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
      }
      visualId = step.nextVisualId
    }
    const capped = this.inspections.length >= MAX_VISUAL_INSPECTIONS_PER_TURN && !final
    return {
      ok: true,
      final: final ?? { replyMessages: ['花花已经来回看了好几遍，但这里还是不能完全确认哦。'] },
      capped,
      inspections: this.inspections,
      observations: this.observations,
      prematureAnswersBlocked: this.prematureAnswersBlocked,
      prematureReplyMessagesDiscarded: this.prematureReplyMessagesDiscarded,
    }
  }
}
