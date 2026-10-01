import { buildVisualCandidatePool, detectVisualIntent, isDirectRecentVisualReference, isExplicitPreviousVisualReference, isExplicitVisualSearch, isImmediatePreviousVisualReference, isVisualIdentityStatement, RecentVisualResolver } from '../conversation/recent-visual-context.js'
import { detectLongTermVisualIntent } from '../vision/long-term-visual-recall.js'
import { hasVisualContentDescription } from '../vision/visual-keywords.js'
import { MAX_VISUAL_INSPECTIONS_PER_TURN, VisualWorkingSession } from '../vision/visual-working-session.js'
import { sanitizeSafeTraceText } from './pet-turn-events.js'
import { detectContextualVisualRecallFollowUp, VisualRecallContext } from './visual-recall-context.js'
import { readConfirmedVisualNames, captionIdentityLabels, captionMatchesNamedSubject } from '../memory/visual-naming-context.js'

function buildPrimaryComparisonPair(pool, intent) {
  if (intent !== 'comparison' || !Array.isArray(pool)) return []
  const current = pool.find((candidate) => candidate?.relation === 'current')
  const previous = pool.find((candidate) => candidate?.relation === 'previous' && candidate.attachmentId !== current?.attachmentId)
  return current && previous ? [current, previous] : []
}

export class PetTurnOrchestrator {
  constructor({ runtime, resolver = new RecentVisualResolver(), longTermResolver = null, experienceStore = null, semanticIndex = null, recallContext = null, now = () => Date.now() } = {}) {
    this.runtime = runtime
    this.resolver = resolver
    this.longTermResolver = longTermResolver
    this.experienceStore = experienceStore
    this.semanticIndex = semanticIndex
    this.recallContext = recallContext ?? new VisualRecallContext({ now })
    this.now = now
  }

  async runVisual({ turnId, emit, userText, attachment, followUp = null, source = null, toolRecall = null }) {
    const startedAt = toolRecall?.startedAt ?? this.now()
    const store = this.runtime.conversationStore
    if (attachment) this.recallContext.clear()
    const messages = typeof store.listForRecentVisualRecall === 'function'
      ? await store.listForRecentVisualRecall()
      : typeof store.list === 'function'
        ? await store.list(500)
        : []
    let pool = buildVisualCandidatePool({ currentAttachment: attachment, userText, messages })
    const resolved = await this.resolver.resolve(userText, messages)
    const ownerCorrection = !attachment && isVisualIdentityStatement(userText)
      && resolved?.matched && resolved.reason === 'active-visual-reference'
    if (ownerCorrection) pool = pool.filter((candidate) => candidate.attachmentId === resolved.attachmentId)
    const intent = detectVisualIntent(userText, { hasCurrent: Boolean(attachment), candidateCount: pool.length - (attachment ? 1 : 0) })
    const comparisonPair = buildPrimaryComparisonPair(pool, intent)
    // A new upload is the subject unless the owner explicitly refers to an
    // earlier image or asks for a comparison.
    if (attachment && intent !== 'comparison' && !isExplicitPreviousVisualReference(userText)) pool = pool.filter((candidate) => candidate.relation === 'current')
    if (!toolRecall) { emit('turn_started', { mode: 'visual' }); emit('thinking', {}) }
    const historicalCandidateCount = pool.length - (attachment ? 1 : 0)
    const explicitPreviousReference = intent === 'temporal_followup' && isImmediatePreviousVisualReference(userText)
    const unresolvedHistoricalReference = intent === 'temporal_followup'
      && historicalCandidateCount > 0
      && !resolved?.matched
      && (!attachment || intent === 'historical_visual' || explicitPreviousReference)
    if (!toolRecall && (intent === 'ambiguous' || unresolvedHistoricalReference || (intent === 'comparison' && comparisonPair.length < 2))) {
      return this.#finishAmbiguous({
        turnId,
        emit,
        userText,
        attachment,
        startedAt,
        recordRecallContext: !attachment && (intent === 'ambiguous' || unresolvedHistoricalReference),
      })
    }
    const longTermQuery = toolRecall?.query ?? followUp?.query ?? userText
    const ownerMessageStored = toolRecall?.ownerMessageStored === true
    // D-022: an explicit long-term visual reference always reaches the long-term
    // resolver, even when the recent resolver produced a generic-boilerplate
    // match; only the recent-only historical path still defers to resolved.matched.
    const longTermIntent = !attachment
      ? (followUp ? { mode: 'long-term-visual' } : detectLongTermVisualIntent(userText))
      : null
    const semanticRequest = !attachment && (toolRecall || longTermIntent || isExplicitVisualSearch(userText)
      || (intent === 'historical_visual' && !isDirectRecentVisualReference(userText, messages)
        && !/(这张图|这张图片|这张照片|这个图|那张图|那张照片)/u.test(userText)))
    if (semanticRequest && !toolRecall && !hasVisualContentDescription(longTermQuery)) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment: null, startedAt, ownerMessageStored, recordRecallContext: true })
    }
    if (semanticRequest && this.semanticIndex && this.runtime.brain?.visualSearch) {
      const preamble = toolRecall?.preamble || '花花去图库里找找，再仔细看看有没有认错～'
      if (!ownerMessageStored) {
        await store.appendMessage({ role: 'user', text: userText, turnId })
      }
      await store.appendMessage({ role: 'assistant', kind: 'final', text: preamble, turnId })
      emit('assistant_message', { text: preamble })
      return this.#runIndexedVisual({ turnId, emit, userText, query: longTermQuery,
        recallGoal: toolRecall?.goal ?? 'find_photo', photoCount: toolRecall?.photoCount, startedAt, store })
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
    await store.appendMessage({ role: 'user', text: userText, attachment, turnId, source,
      ...(ownerCorrection ? { sourceAttachmentId: resolved.attachmentId, activityType: 'visual_owner_caption' } : {}) })
    if (ownerCorrection) {
      pool[0].userText += `\n${userText}`
      this.recallContext.clear()
    }
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

  async #runIndexedVisual({ turnId, emit, userText, query, recallGoal, photoCount, startedAt, store }) {
    let resolved
    try { resolved = await this.semanticIndex.search(query, { limit: MAX_VISUAL_INSPECTIONS_PER_TURN, recallGoal }) } catch {
      return this.#finishLongTermNone({ turnId, emit, userText, startedAt, ownerMessageStored: true, recallQuery: query, unavailable: true })
    }
    const { names } = readConfirmedVisualNames(this.runtime.memory, query)
    const pool = (resolved?.candidates ?? []).slice(0, MAX_VISUAL_INSPECTIONS_PER_TURN)
      .filter((candidate) => {
        if (!names.length) return true
        const caption = candidate.userText ?? ''
        if (['describe_subject', 'summarize_photos'].includes(recallGoal)) return captionMatchesNamedSubject(caption, names)
        const labels = captionIdentityLabels(caption)
        return !labels.length || labels.some((label) => names.some((name) => label.startsWith(name)))
      })
      .map((candidate, index) => ({ ...candidate, visualId: `V${index}`, relation: 'recalled' }))
    // The embedding model already screens thumbnails. A second VLM preview
    // gate rejected clear matches in live tests; inspect the leading originals.
    const ranked = pool.slice(0, recallGoal === 'summarize_photos' ? MAX_VISUAL_INSPECTIONS_PER_TURN : 2)
    if (ranked.length === 0) return this.#finishLongTermNone({ turnId, emit, userText, startedAt, ownerMessageStored: true, recallQuery: query, unavailable: resolved?.status === 'index-pending' })
    return this.#runLongTermVisual({
      turnId, emit, userText, startedAt, store, resolveQuery: query, recallGoal, photoCount, ownerMessageStored: true,
      preResolved: { status: 'matched', winner: ranked[0], candidates: ranked },
    })
  }

  async #runLongTermVisual({ turnId, emit, userText, resolveQuery = userText, followUp = null, preResolved = null, startedAt, store, recallGoal = 'find_photo', photoCount, ownerMessageStored = false }) {
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
      if (!ownerMessageStored) await store.appendMessage({ role: 'user', text: userText, turnId })
      await store.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
      this.runtime.conversation.append(userText, text)
      emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
      return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
    }

    if (!ownerMessageStored) await store.appendMessage({ role: 'user', text: userText, turnId })
    if (!preResolved) await this.#appendMemoryRecall({ turnId, emit, userText, store })
    const session = new VisualWorkingSession({
      turnId,
      userText,
      recallQuery: resolveQuery,
      candidatePool: recalledPool,
      comparison: false,
      conversationStore: store,
      brain: this.runtime.brain,
      emit,
      now: this.now,
      experienceStore: this.experienceStore,
      recallGoal,
      photoCount,
    })
    const visualResult = await session.run('V0')
    if (!visualResult.ok) {
      const text = '花花这次没能完成照片核对，先不发图。主人可以再试一次，花花会重新找。'
      await store.appendMessage({ role: 'assistant', kind: 'final', turnId, text })
      this.runtime.conversation.append(userText, text)
      emit('assistant_message', { text })
      this.runtime.logger?.warn?.(`vc-ai-pet: photo recall failed code=${visualResult.reason} stage=${visualResult.diagnostic?.stage ?? 'unknown'}`)
      return visualResult
    }
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
    const reasoning = { effort: result.reasoning?.effort ?? 'medium', durationMs, visualInspections: result.inspections.length, visualUniqueImages: new Set(result.inspections.map((item) => item.attachmentId)).size }
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

  async #finishLongTermNone({ turnId, emit, userText, startedAt, ownerMessageStored = false, recallQuery = null, unavailable = false }) {
    const text = unavailable ? '花花的图库检索刚刚没准备好，这次先不发图，等恢复后再帮主人找～'
      : '花花暂时没有找到能确认的那张照片，主人能再说说特征吗？'
    if (recallQuery) this.recallContext.record({ mode: 'visual_recall_ambiguous', query: recallQuery,
      result: { status: 'none' }, clarificationRequested: true })
    const reasoning = { effort: 'low', durationMs: Math.max(0, this.now() - startedAt) }
    if (!ownerMessageStored) await this.runtime.conversationStore.appendMessage({ role: 'user', text: userText, turnId })
    await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
    this.runtime.conversation.append(userText, text)
    emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
    return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
  }

  async #finishAmbiguous({ turnId, emit, userText, attachment = null, startedAt, recordRecallContext = false, ownerMessageStored = false }) {
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
    if (!ownerMessageStored) await this.runtime.conversationStore.appendMessage({ role: 'user', text: userText, attachment, turnId })
    await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
    this.runtime.conversation.append(attachment ? `[主人发送了一张图片] ${userText}` : userText, text)
    emit('assistant_message', { text, reasoning }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
    return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
  }
}
