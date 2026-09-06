import { buildVisualCandidatePool, detectVisualIntent, isImmediatePreviousVisualReference, RecentVisualResolver } from '../conversation/recent-visual-context.js'
import { detectLongTermVisualIntent } from '../vision/long-term-visual-recall.js'
import { VisualWorkingSession } from '../vision/visual-working-session.js'
import { sanitizeSafeTraceText } from './pet-turn-events.js'
import { detectEllipticalFollowUp, VisualRecallContext } from './visual-recall-context.js'

function buildPrimaryComparisonPair(pool, intent) {
  if (intent !== 'comparison' || !Array.isArray(pool)) return []
  const current = pool.find((candidate) => candidate?.relation === 'current')
  const previous = pool.find((candidate) => candidate?.relation === 'previous' && candidate.attachmentId !== current?.attachmentId)
  return current && previous ? [current, previous] : []
}

export class PetTurnOrchestrator {
  constructor({ runtime, resolver = new RecentVisualResolver(), longTermResolver = null, experienceStore = null, recallContext = null, now = () => Date.now() } = {}) {
    this.runtime = runtime
    this.resolver = resolver
    this.longTermResolver = longTermResolver
    this.experienceStore = experienceStore
    this.recallContext = recallContext ?? new VisualRecallContext({ now })
    this.now = now
  }

  async runVisual({ turnId, emit, userText, attachment, followUp = null }) {
    const startedAt = this.now()
    const store = this.runtime.conversationStore
    if (attachment) this.recallContext.clear()
    const messages = typeof store.listForRecentVisualRecall === 'function'
      ? await store.listForRecentVisualRecall()
      : typeof store.list === 'function'
        ? await store.list(500)
        : []
    let pool = buildVisualCandidatePool({ currentAttachment: attachment, userText, messages })
    const resolved = await this.resolver.resolve(userText, messages)
    const intent = detectVisualIntent(userText, { hasCurrent: Boolean(attachment), candidateCount: pool.length - (attachment ? 1 : 0) })
    const comparisonPair = buildPrimaryComparisonPair(pool, intent)
    emit('turn_started', { mode: 'visual' }); emit('thinking', {})
    const historicalCandidateCount = pool.length - (attachment ? 1 : 0)
    const explicitPreviousReference = intent === 'temporal_followup' && isImmediatePreviousVisualReference(userText)
    const unresolvedHistoricalReference = intent === 'temporal_followup'
      && historicalCandidateCount > 0
      && !resolved?.matched
      && (!attachment || intent === 'historical_visual' || explicitPreviousReference)
    if (intent === 'ambiguous' || unresolvedHistoricalReference || (intent === 'comparison' && comparisonPair.length < 2)) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment, startedAt })
    }
    const longTermQuery = followUp?.query ?? userText
    const longTermIntent = !attachment && !resolved?.matched
      ? (followUp ? { mode: 'long-term-visual' } : detectLongTermVisualIntent(userText))
      : null
    if (!attachment && !resolved?.matched && (intent === 'historical_visual' || longTermIntent)) {
      return this.#runLongTermVisual({ turnId, emit, userText, resolveQuery: longTermQuery, followUp, startedAt, store, messages, pool })
    }
    if (pool.length === 0) return this.#finishAmbiguous({ turnId, emit, userText, attachment, startedAt })
    const resolvedVisual = pool.find((candidate) => candidate.attachmentId === resolved?.attachmentId)?.visualId
    const preferResolvedHistorical = resolvedVisual && (!attachment || intent === 'historical_visual' || explicitPreviousReference)
    const first = preferResolvedHistorical
      ? resolvedVisual
      : attachment || intent === 'comparison'
        ? pool[0]?.visualId
        : resolvedVisual ?? pool[0]?.visualId
    await store.appendMessage({ role: 'user', text: userText, attachment, turnId })
    await this.#appendMemoryRecall({ turnId, emit, userText, store })
    const session = new VisualWorkingSession({
      turnId,
      userText,
      candidatePool: pool,
      comparison: intent === 'comparison',
      comparisonPair,
      conversationStore: store,
      brain: this.runtime.brain,
      emit,
      now: this.now,
      experienceStore: this.experienceStore,
    })
    const result = await session.run(first)
    if (!result.ok) return result
    return this.#finishVisualResult({ turnId, emit, userText, attachment, startedAt, result })
  }

  recallContextActive() {
    return this.recallContext.active()
  }

  planFollowUp(userText) {
    if (!this.recallContext.active()) return null
    const detected = detectEllipticalFollowUp(userText)
    if (!detected) return null
    const query = this.recallContext.buildFollowUpQuery({ ...detected, text: userText })
    return query ? { kind: detected.kind, query } : null
  }

  clearVisualRecallContext() {
    this.recallContext.clear()
  }

  async #appendMemoryRecall({ turnId, emit, userText, store }) {
    const recalledCandidates = String(userText ?? '').trim()
      ? (this.runtime.memory?.recall?.(userText, 2, { bumpHits: false }) ?? [])
      : []
    const recalledMemory = (Array.isArray(recalledCandidates) ? recalledCandidates : [])
      .filter((item) => ['user', 'project', 'fact', 'lesson', 'topic'].includes(item?.level))
    for (const memory of recalledMemory) {
      const memorySource = String(memory?.source ?? memory?.sourceKind ?? memory?.provenance?.source ?? '').toLowerCase()
      const provenance = memory?.provenance?.evidence === 'inferred'
        || ['dream', 'reflection', 'inferred', 'dream_derived', 'reflection_derived'].includes(memorySource)
        ? 'inferred'
        : 'confirmed'
      const summary = sanitizeSafeTraceText(memory.content, 180)
      if (!summary) continue
      const recallEvent = emit('memory_recall', { summary, provenance })
      const text = sanitizeSafeTraceText(`${provenance === 'inferred' ? '联想到：' : '想起：'}${summary}`, 300)
      await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'memory_recall', provenance, activitySeq: recallEvent?.seq, activityAt: recallEvent?.at, turnId, text })
    }
  }

  async #runLongTermVisual({ turnId, emit, userText, resolveQuery = userText, followUp = null, startedAt, store, pool }) {
    if (!followUp && (!this.longTermResolver || typeof this.longTermResolver.resolve !== 'function')) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt })
    }
    if (followUp) this.recallContext.consume(userText)
    const result = followUp?.preResolve ?? await this.longTermResolver.resolve(resolveQuery, { limit: 8 })
    if (result?.status === 'ambiguous') {
      this.recallContext.record({ mode: 'visual_recall_ambiguous', query: resolveQuery, result })
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt })
    }
    if (result?.status !== 'matched' || !result.winner) {
      this.recallContext.clear()
      return this.#finishLongTermNone({ turnId, emit, userText, startedAt })
    }

    this.recallContext.clear()
    const winner = result.winner
    const attachmentId = winner.attachmentId
    const metadata = typeof store.attachment === 'function' ? await store.attachment(attachmentId) : null
    const recallCaption = sanitizeSafeTraceText(
      metadata ? '🐾 花花想起以前好像见过……' : '🐾 花花想起以前好像见过，可是原图已经找不到了……',
      120,
    )
    if (!metadata) {
      const recallEvent = emit('visual_recall', { sourceAttachmentId: attachmentId, caption: recallCaption })
      await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_recall', sourceAttachmentId: attachmentId, activitySeq: recallEvent?.seq, activityAt: recallEvent?.at, turnId, text: recallCaption })
      const text = '主人，花花记得以前好像见过，可是原图找不到了，没办法重新确认哦。'
      const reasoning = { effort: 'low', durationMs: Math.max(0, this.now() - startedAt) }
      await store.appendMessage({ role: 'user', text: userText, turnId })
      await store.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
      this.runtime.conversation.append(userText, text)
      emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
      return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
    }

    await store.appendMessage({ role: 'user', text: userText, turnId })
    await this.#appendMemoryRecall({ turnId, emit, userText, store })
    const recallEvent = emit('visual_recall', { sourceAttachmentId: attachmentId, caption: recallCaption })
    await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'visual_recall', sourceAttachmentId: attachmentId, activitySeq: recallEvent?.seq, activityAt: recallEvent?.at, turnId, text: recallCaption })
    pool = [
      { visualId: 'V0', attachmentId, relation: 'recalled', userText: winner.userText, timestamp: winner.occurredAt },
      ...pool.map((candidate, index) => ({ ...candidate, visualId: `V${index + 1}`, relation: 'previous' })),
    ]
    const session = new VisualWorkingSession({
      turnId,
      userText,
      candidatePool: pool,
      comparison: false,
      conversationStore: store,
      brain: this.runtime.brain,
      emit,
      now: this.now,
      experienceStore: this.experienceStore,
    })
    const visualResult = await session.run('V0')
    if (!visualResult.ok) return visualResult
    return this.#finishVisualResult({ turnId, emit, userText, attachment: null, startedAt, result: visualResult })
  }

  async #finishVisualResult({ turnId, emit, userText, attachment, startedAt, result }) {
    const store = this.runtime.conversationStore
    const replyMessages = result.final.replyMessages?.length ? result.final.replyMessages : ['花花看到了，不过还不太确定。']
    const durationMs = Math.max(0, this.now() - startedAt)
    const reasoning = { effort: 'medium', durationMs, visualInspections: result.inspections.length, visualUniqueImages: new Set(result.inspections.map((item) => item.attachmentId)).size }
    for (const [index, text] of replyMessages.entries()) {
      emit('assistant_message', { text })
      await store.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning: index === replyMessages.length - 1 ? reasoning : null })
    }
    this.runtime.conversation.append(attachment ? `[主人发送了一张图片] ${userText}` : userText, replyMessages.join('\n'))
    emit('turn_completed', { durationMs, reasoning })
    return {
      ok: true,
      text: replyMessages[0],
      replyMessages,
      memoryWrite: 'skipped',
      memoryWriteReason: 'vision-context',
      reasoning,
      capped: result.capped,
      prematureAnswersBlocked: result.prematureAnswersBlocked ?? 0,
      prematureReplyMessagesDiscarded: result.prematureReplyMessagesDiscarded ?? 0,
    }
  }

  async #finishLongTermNone({ turnId, emit, userText, startedAt }) {
    const text = '花花认真翻了翻以前的照片，好像没有找到和这个有关的呢。'
    const reasoning = { effort: 'low', durationMs: Math.max(0, this.now() - startedAt) }
    await this.runtime.conversationStore.appendMessage({ role: 'user', text: userText, turnId })
    await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
    this.runtime.conversation.append(userText, text)
    emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
    return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
  }

  async #finishAmbiguous({ turnId, emit, userText, attachment = null, startedAt }) {
    const text = '主人说的是哪一张呀？花花怕认错，能再说得具体一点吗？'
    const reasoning = { effort: 'low', durationMs: Math.max(0, this.now() - startedAt) }
    await this.runtime.conversationStore.appendMessage({ role: 'user', text: userText, attachment, turnId })
    await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
    this.runtime.conversation.append(attachment ? `[主人发送了一张图片] ${userText}` : userText, text)
    emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
    return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
  }
}
