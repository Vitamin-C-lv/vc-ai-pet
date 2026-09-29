import { buildVisualCandidatePool, detectVisualIntent, isDirectRecentVisualReference, isExplicitPreviousVisualReference, isExplicitVisualSearch, isImmediatePreviousVisualReference, RecentVisualResolver } from '../conversation/recent-visual-context.js'
import { detectLongTermVisualIntent } from '../vision/long-term-visual-recall.js'
import { hasVisualContentDescription } from '../vision/visual-keywords.js'
import { MAX_VISUAL_INSPECTIONS_PER_TURN, VisualWorkingSession } from '../vision/visual-working-session.js'
import { sanitizeSafeTraceText } from './pet-turn-events.js'
import { detectContextualVisualRecallFollowUp, VisualRecallContext } from './visual-recall-context.js'

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

  async runVisual({ turnId, emit, userText, attachment, followUp = null, source = null }) {
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
    // A new upload is the subject unless the owner explicitly refers to an
    // earlier image or asks for a comparison.
    if (attachment && intent !== 'comparison' && !isExplicitPreviousVisualReference(userText)) pool = pool.filter((candidate) => candidate.relation === 'current')
    emit('turn_started', { mode: 'visual' }); emit('thinking', {})
    const historicalCandidateCount = pool.length - (attachment ? 1 : 0)
    const explicitPreviousReference = intent === 'temporal_followup' && isImmediatePreviousVisualReference(userText)
    const unresolvedHistoricalReference = intent === 'temporal_followup'
      && historicalCandidateCount > 0
      && !resolved?.matched
      && (!attachment || intent === 'historical_visual' || explicitPreviousReference)
    if (intent === 'ambiguous' || unresolvedHistoricalReference || (intent === 'comparison' && comparisonPair.length < 2)) {
      return this.#finishAmbiguous({
        turnId,
        emit,
        userText,
        attachment,
        startedAt,
        recordRecallContext: !attachment && (intent === 'ambiguous' || unresolvedHistoricalReference),
      })
    }
    const longTermQuery = followUp?.query ?? userText
    // D-022: an explicit long-term visual reference always reaches the long-term
    // resolver, even when the recent resolver produced a generic-boilerplate
    // match; only the recent-only historical path still defers to resolved.matched.
    const longTermIntent = !attachment
      ? (followUp ? { mode: 'long-term-visual' } : detectLongTermVisualIntent(userText))
      : null
    const semanticRequest = !attachment && (longTermIntent || isExplicitVisualSearch(userText)
      || (intent === 'historical_visual' && !isDirectRecentVisualReference(userText, messages)
        && !/(这张图|这张图片|这张照片|这个图|那张图|那张照片)/u.test(userText)))
    if (semanticRequest && !hasVisualContentDescription(userText)) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt, recordRecallContext: true })
    }
    if (semanticRequest && this.experienceStore?.listExperiences && this.runtime.brain?.visualSearch) {
      const experiences = await this.experienceStore.listExperiences({ limit: 100 })
      const galleryPool = []
      const seen = new Set()
      for (const experience of experiences) {
        const occurrences = experience.occurrenceCount > 1 && this.experienceStore.occurrenceFor
          ? await this.experienceStore.occurrenceFor(experience.experienceId, { limit: 100 })
          : [experience]
        // Reuploads of one visual experience are the same candidate. Prefer
        // the owner's latest occurrence so it remains the image shown on recall.
        const item = occurrences.at(-1) ?? experience
        if (!item?.attachmentId || seen.has(item.attachmentId)) continue
        seen.add(item.attachmentId)
        galleryPool.push({ visualId: `V${galleryPool.length}`, attachmentId: item.attachmentId,
          relation: 'recalled', userText: item.userText, timestamp: item.occurredAt ?? item.lastOccurredAt })
      }
      return this.#runSemanticVisual({ turnId, emit, userText, pool: galleryPool, startedAt, store })
    }
    if (semanticRequest && this.runtime.brain?.visualSearch) {
      return this.#runSemanticVisual({ turnId, emit, userText, pool, startedAt, store })
    }
    if (semanticRequest && !longTermIntent) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt })
    }
    if (!attachment && !longTermIntent && intent === 'historical_visual' && !resolved?.matched) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt, recordRecallContext: true })
    }
    if (!attachment && longTermIntent) {
      return this.#runLongTermVisual({ turnId, emit, userText, resolveQuery: longTermQuery, followUp, startedAt, store })
    }
    if (pool.length === 0) {
      return this.#finishAmbiguous({
        turnId,
        emit,
        userText,
        attachment,
        startedAt,
        recordRecallContext: !attachment && intent === 'ambiguous',
      })
    }
    const resolvedVisual = pool.find((candidate) => candidate.attachmentId === resolved?.attachmentId)?.visualId
    const preferResolvedHistorical = resolvedVisual && (!attachment || intent === 'historical_visual' || explicitPreviousReference)
    const first = preferResolvedHistorical
      ? resolvedVisual
      : attachment || intent === 'comparison'
        ? pool[0]?.visualId
        : resolvedVisual ?? pool[0]?.visualId
    await store.appendMessage({ role: 'user', text: userText, attachment, turnId, source })
    // The current upload must become an occurrence before VisualWorkingSession
    // records its inspection/observation event. This is still archive-only and
    // zero-model; the outer runVisualTurn performs the idempotent follow-up sync.
    if (typeof this.runtime.syncVisualExperiences === 'function') await this.runtime.syncVisualExperiences()
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
    const detected = detectContextualVisualRecallFollowUp(userText)
    if (!detected) return null
    const query = this.recallContext.buildFollowUpQuery({ ...detected, text: userText })
    if (!query) return null
    return {
      kind: detected.kind,
      query,
      subject: detected.subject,
      subjectCorrection: detected.subjectCorrection === true,
      clarification: detected.clarification === true,
      retryOnNone: detected.subjectCorrection === true || detected.clarification === true,
    }
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

  async #runSemanticVisual({ turnId, emit, userText, pool, startedAt, store }) {
    const previews = []
    for (const candidate of pool) {
      try {
        const stored = await store.readAttachmentDataUrl(candidate.attachmentId, { thumbnail: true })
        if (stored?.dataUrl) previews.push({ visualId: candidate.visualId, image: { dataUrl: stored.dataUrl } })
      } catch {
        // Missing images cannot be searched or published.
      }
    }
    if (previews.length === 0) return this.#finishLongTermNone({ turnId, emit, userText, startedAt })
    let shortlist = previews
    do {
      const next = []
      for (let index = 0; index < shortlist.length; index += 10) {
        let search
        try {
          search = await this.runtime.brain.visualSearch({ userText, candidates: shortlist.slice(index, index + 10) })
        } catch {
          return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt })
        }
        if (!search?.ok) return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt })
        const chosen = search.visualIds.slice(0, 2)
        next.push(...chosen.map((visualId) => shortlist.find((item) => item.visualId === visualId)).filter(Boolean))
      }
      shortlist = next
    } while (shortlist.length > MAX_VISUAL_INSPECTIONS_PER_TURN)
    const ranked = shortlist.map(({ visualId }) => pool.find((candidate) => candidate.visualId === visualId)).filter(Boolean)
    if (ranked.length === 0) return this.#finishLongTermNone({ turnId, emit, userText, startedAt })
    return this.#runLongTermVisual({
      turnId, emit, userText, startedAt, store,
      preResolved: { status: 'matched', winner: ranked[0], candidates: ranked },
    })
  }

  async #runLongTermVisual({ turnId, emit, userText, resolveQuery = userText, followUp = null, preResolved = null, startedAt, store }) {
    if (!preResolved && !followUp && (!this.longTermResolver || typeof this.longTermResolver.resolve !== 'function')) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt })
    }
    if (followUp) this.recallContext.consume({ ...followUp, text: userText })
    const contextUses = this.recallContext.snapshot()?.uses ?? 0
    const result = preResolved ?? followUp?.preResolve ?? await this.longTermResolver.resolve(resolveQuery, { limit: 8 })
    if (result?.status === 'ambiguous') {
      this.recallContext.record({
        mode: 'visual_recall_ambiguous',
        query: resolveQuery,
        result,
        subjectCorrection: followUp?.subjectCorrection ? followUp.subject : null,
        clarificationRequested: true,
        uses: contextUses,
      })
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt })
    }
    if (result?.status !== 'matched' || !result.winner) {
      if (followUp?.retryOnNone === true) {
        this.recallContext.record({
          mode: 'visual_recall_ambiguous',
          query: resolveQuery,
          result,
          subjectCorrection: followUp?.subjectCorrection ? followUp.subject : null,
          clarificationRequested: followUp?.clarification === true || followUp?.subjectCorrection === true,
          uses: contextUses,
        })
      } else {
        this.recallContext.clear()
      }
      return this.#finishLongTermNone({ turnId, emit, userText, startedAt })
    }

    const ranked = [result.winner, ...(Array.isArray(result.candidates) ? result.candidates : [])]
    const candidateAttachments = [
      ...ranked.map((candidate) => ({ candidate, attachmentId: candidate?.attachmentId })),
      ...ranked.flatMap((candidate) => (Array.isArray(candidate?.attachmentIds) ? candidate.attachmentIds : [])
        .map((attachmentId) => ({ candidate, attachmentId }))),
    ]
    const seenAttachments = new Set()
    const recalledPool = []
    for (const { candidate, attachmentId } of candidateAttachments) {
      if (!attachmentId || seenAttachments.has(attachmentId)) continue
      seenAttachments.add(attachmentId)
      try {
        const stored = await store.readAttachmentDataUrl(attachmentId)
        if (!stored?.dataUrl || !stored.attachment) continue
        recalledPool.push({ visualId: `V${recalledPool.length}`, attachmentId, relation: 'recalled', userText: candidate.userText, timestamp: candidate.occurredAt })
      } catch {
        // An unavailable occurrence cannot be checked or sent.
      }
      if (recalledPool.length >= MAX_VISUAL_INSPECTIONS_PER_TURN) break
    }
    if (recalledPool.length === 0) {
      const attachmentId = result.winner.attachmentId ?? null
      const recallCaption = '🐾 花花找到一条旧记录，但原图已经找不到了……'
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
    const session = new VisualWorkingSession({
      turnId,
      userText: resolveQuery,
      candidatePool: recalledPool,
      comparison: false,
      conversationStore: store,
      brain: this.runtime.brain,
      emit,
      now: this.now,
      experienceStore: this.experienceStore,
    })
    const visualResult = await session.run('V0')
    if (!visualResult.ok) return visualResult
    if (visualResult.verifiedAttachmentId) {
      if (followUp?.clarification === true) this.recallContext.record({ mode: 'long_term_visual_recall', query: resolveQuery, result, clarificationRequested: false, uses: contextUses })
      else this.recallContext.clear()
    } else {
      this.recallContext.record({ mode: 'visual_recall_ambiguous', query: resolveQuery, result, clarificationRequested: true, uses: contextUses })
    }
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
      // Which attachment this turn actually showed the pet. The runtime must not
      // infer that from an observation: the visual session may inspect recalled
      // pictures too, so its `attachmentId` can belong to an older image and would
      // make a brand-new upload look like a duplicate of it.
      attachmentId: attachment?.id ?? null,
      // What the pet actually perceived this turn. The vision session already
      // sanitized both lists (safe summary ≤180 chars, focus ≤120), and the
      // runtime needs them to remember the picture it was shown — the raw
      // `result` is not exposed, only these two vetted projections.
      inspections: Array.isArray(result.inspections)
        ? result.inspections.map((item) => ({
            visualId: item?.visualId ?? null,
            attachmentId: item?.attachmentId ?? null,
          }))
        : [],
      observations: Array.isArray(result.observations)
        ? result.observations.map((item) => ({
            visualId: item?.visualId ?? null,
            attachmentId: item?.attachmentId ?? null,
            focus: item?.focus ?? '',
            summary: item?.summary ?? '',
          }))
        : [],
    }
  }

  async #finishLongTermNone({ turnId, emit, userText, startedAt }) {
    const text = '花花暂时没有找到能确认的那张照片，主人能再说说特征吗？'
    const reasoning = { effort: 'low', durationMs: Math.max(0, this.now() - startedAt) }
    await this.runtime.conversationStore.appendMessage({ role: 'user', text: userText, turnId })
    await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
    this.runtime.conversation.append(userText, text)
    emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
    return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
  }

  async #finishAmbiguous({ turnId, emit, userText, attachment = null, startedAt, recordRecallContext = false }) {
    const text = '主人说的是哪一张呀？花花怕认错，能再说得具体一点吗？'
    const reasoning = { effort: 'low', durationMs: Math.max(0, this.now() - startedAt) }
    if (recordRecallContext) {
      this.recallContext.record({
        mode: 'visual_recall_ambiguous',
        query: userText,
        result: { status: 'ambiguous' },
        clarificationRequested: true,
      })
    }
    await this.runtime.conversationStore.appendMessage({ role: 'user', text: userText, attachment, turnId })
    await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
    this.runtime.conversation.append(attachment ? `[主人发送了一张图片] ${userText}` : userText, text)
    emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
    return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
  }
}
