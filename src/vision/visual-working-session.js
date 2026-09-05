import { normalizeVisionImage } from '../brain/vision-input.js'
import { sanitizeSafeTraceText } from '../runtime/pet-turn-events.js'

export const MAX_VISUAL_INSPECTIONS_PER_TURN = 5

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
  constructor({ turnId, userText, candidatePool, conversationStore, brain, emit, now = () => Date.now() }) {
    this.turnId = turnId
    this.userText = String(userText ?? '')
    this.candidatePool = candidatePool
    this.conversationStore = conversationStore
    this.brain = brain
    this.emit = emit
    this.now = now
    this.startedAt = this.now()
    this.observations = []
    this.inspections = []
  }

  get inspectionCount() { return this.inspections.length }

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
      const imageEvent = this.emit('visual_image', { sourceAttachmentId: candidate.attachmentId, attachment: publicAttachment, caption: candidate.relation === 'current' ? '花花看看这张' : '花花再看看这张' })
      await this.conversationStore.appendMessage({ role: 'assistant', kind: 'media_ref', activityType: 'visual_image', sourceAttachmentId: candidate.attachmentId, activitySeq: imageEvent?.seq, activityAt: imageEvent?.at, turnId: this.turnId, text: caption, attachment: metadata })
      this.inspections.push({ visualId, attachmentId: candidate.attachmentId })
      let step
      try {
        step = await this.brain.visualStep({ userText: this.userText, image, candidatePool: this.candidatePool, observations: this.observations, forceAnswer: ordinal === MAX_VISUAL_INSPECTIONS_PER_TURN - 1 })
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
      if (action === 'answer') {
        if (!forcedFinal && (step.nextVisualId || replyMessages.length === 0)) return visualFailure({ reason: 'invalid-visual-answer', stage: 'structured-output', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
        if (forcedFinal && replyMessages.length === 0) { final = null; break }
        final = { ...step, action: 'answer', nextVisualId: '', replyMessages }
        break
      }
      if (action !== 'inspect' || typeof step.nextVisualId !== 'string' || !this.candidatePool.some((item) => item.visualId === step.nextVisualId)) {
        return visualFailure({ reason: 'invalid-visual-inspection', stage: 'protocol', inspectionOrdinal: ordinal + 1, candidate, nextVisualId: step.nextVisualId, inspections: this.inspections })
      }
      visualId = step.nextVisualId
    }
    const capped = this.inspections.length >= MAX_VISUAL_INSPECTIONS_PER_TURN && !final
    return { ok: true, final: final ?? { replyMessages: ['花花已经来回看了好几遍，但这里还是不能完全确认哦。'] }, capped, inspections: this.inspections, observations: this.observations }
  }
}
