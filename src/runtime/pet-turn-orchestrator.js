import { MAX_VISUAL_INSPECTIONS_PER_TURN, VisualWorkingSession } from '../vision/visual-working-session.js'
import { visualTermsFor } from '../vision/visual-keywords.js'
import { VisualRecallContext } from './visual-recall-context.js'

export class PetTurnOrchestrator {
  constructor({ runtime, resolver = null, longTermResolver = null, experienceStore = null, semanticIndex = null, recallContext = null, now = () => Date.now() } = {}) {
    this.runtime = runtime
    this.resolver = resolver
    this.longTermResolver = longTermResolver
    this.experienceStore = experienceStore
    this.semanticIndex = semanticIndex
    this.recallContext = recallContext ?? new VisualRecallContext({ now })
    this.now = now
  }

  async runVisual({ turnId, emit, userText, source = null, toolRecall = null }) {
    if (!toolRecall) throw Object.assign(new Error('visual tool requires a model decision'), { code: 'PET_VISUAL_DECISION_REQUIRED' })
    return this.#runModelSelectedVisual({ turnId, emit, userText, source, toolRecall,
      startedAt: toolRecall.startedAt ?? this.now(), store: this.runtime.conversationStore })
  }

  async #runModelSelectedVisual({ turnId, emit, userText, source, toolRecall, startedAt, store }) {
    const { query, taskUserText = userText, goal: recallGoal, photoCount, excludeAttachmentIds = [] } = toolRecall
    if (!toolRecall.ownerMessageStored) await store.appendMessage({ role: 'user', text: userText, turnId, source })
    const preamble = toolRecall.preamble || '花花再仔细看看。'
    const preambleMessage = await store.appendMessage({ role: 'assistant', kind: 'final', text: preamble, turnId })
    emit('assistant_message', { text: preamble, messageId: preambleMessage?.id })
    if (toolRecall.tool === 'search_visual_memory') {
      return this.#runIndexedVisual({ turnId, emit, userText, taskUserText, query, recallGoal, photoCount,
        excludedAttachmentIds: excludeAttachmentIds, startedAt, store })
    }
    if (toolRecall.ownerCaption && toolRecall.attachmentIds.length === 1 && toolRecall.ownerMessageId) {
      const experience = await this.experienceStore?.findExperienceByAttachmentId(toolRecall.attachmentIds[0])
      if (experience) {
        await this.experienceStore.recordEvent({ experienceId: experience.experienceId, turnId,
          kind: 'owner_caption', summary: userText, evidence: 'raw', eventId: toolRecall.ownerMessageId,
          occurredAt: startedAt })
        await this.experienceStore.indexTerms(experience.experienceId, visualTermsFor(userText, { boost: 3 }),
          { sourceKind: 'user_text', sourceRef: toolRecall.ownerMessageId })
      }
    }
    const messages = await store.listForRecentVisualRecall()
    const pool = toolRecall.attachmentIds.map((attachmentId, index) => {
      const owner = messages.findLast((row) => row.role === 'user' && row.attachment?.id === attachmentId)
      return { visualId: `V${index}`, attachmentId, relation: 'recalled',
        userText: [owner?.text, toolRecall.ownerCaption ? userText : ''].filter(Boolean).join('\n'),
        timestamp: owner?.timestamp }
    })
    const session = new VisualWorkingSession({ turnId, userText, taskUserText, recallQuery: query,
      candidatePool: pool, conversationStore: store, brain: this.runtime.brain, emit, now: this.now,
      experienceStore: this.experienceStore, recallGoal, photoCount })
    const result = await session.run(pool[0]?.visualId)
    if (!result.ok) return result
    this.recallContext.record({ mode: 'long_term_visual_recall', query: taskUserText,
      result, excludedAttachmentIds: excludeAttachmentIds })
    return this.#finishVisualResult({ turnId, emit, userText, attachment: null, startedAt, result })
  }

  recallContextActive() {
    return this.recallContext.active()
  }

  clearVisualRecallContext() {
    this.recallContext.clear()
  }

  async #runIndexedVisual({ turnId, emit, userText, taskUserText = userText, query, recallGoal, photoCount, startedAt, store, excludedAttachmentIds = [] }) {
    let resolved
    try { resolved = await this.semanticIndex.search(query, { limit: MAX_VISUAL_INSPECTIONS_PER_TURN, recallGoal, excludedAttachmentIds }) } catch {
      return this.#finishLongTermNone({ turnId, emit, userText, startedAt, ownerMessageStored: true, recallQuery: taskUserText, excludedAttachmentIds, unavailable: true })
    }
    const pool = (resolved?.candidates ?? []).slice(0, MAX_VISUAL_INSPECTIONS_PER_TURN)
      .filter((candidate) => !excludedAttachmentIds.includes(candidate.attachmentId))
      .map((candidate, index) => ({ ...candidate, visualId: `V${index}`, relation: 'recalled' }))
    // The embedding model already screens thumbnails. A second VLM preview
    // gate rejected clear matches in live tests; inspect the leading originals.
    const ranked = pool.slice(0, recallGoal === 'summarize_photos' || excludedAttachmentIds.length > 0 ? MAX_VISUAL_INSPECTIONS_PER_TURN : 2)
    if (ranked.length === 0) return this.#finishLongTermNone({ turnId, emit, userText, startedAt, ownerMessageStored: true, recallQuery: taskUserText, excludedAttachmentIds, unavailable: resolved?.status === 'index-pending' })
    return this.#runLongTermVisual({
      turnId, emit, userText, taskUserText, startedAt, store, resolveQuery: query, recallGoal, photoCount, ownerMessageStored: true, excludedAttachmentIds,
      preResolved: { status: 'matched', winner: ranked[0], candidates: ranked },
    })
  }

  async #runLongTermVisual({ turnId, emit, userText, taskUserText = userText, resolveQuery = userText, preResolved, startedAt, store, recallGoal = 'find_photo', photoCount, ownerMessageStored = false, excludedAttachmentIds = [] }) {
    const contextUses = this.recallContext.snapshot()?.uses ?? 0
    const result = preResolved
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
      return this.#finishLongTermNone({ turnId, emit, userText, startedAt, ownerMessageStored,
        recallQuery: taskUserText, excludedAttachmentIds, failureReason: '找到了旧记录，但对应原图已不可读取，未完成核验' })
    }

    if (!ownerMessageStored) await store.appendMessage({ role: 'user', text: userText, turnId })
    const session = new VisualWorkingSession({
      turnId,
      userText,
      taskUserText,
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
      const message = await store.appendMessage({ role: 'assistant', kind: 'final', turnId, text })
      this.runtime.conversation.append(userText, text)
      emit('assistant_message', { text, messageId: message?.id })
      this.runtime.logger?.warn?.(`vc-ai-pet: photo recall failed code=${visualResult.reason} stage=${visualResult.diagnostic?.stage ?? 'unknown'}`)
      return visualResult
    }
    this.recallContext.record({ mode: visualResult.verifiedAttachmentId ? 'long_term_visual_recall' : 'visual_recall_ambiguous',
      query: taskUserText, result, clarificationRequested: !visualResult.verifiedAttachmentId,
      uses: contextUses, excludedAttachmentIds })
    return this.#finishVisualResult({ turnId, emit, userText, attachment: null, startedAt, result: visualResult })
  }

  async #finishVisualResult({ turnId, emit, userText, attachment, startedAt, result }) {
    const store = this.runtime.conversationStore
    const replyMessages = result.final.replyMessages?.length ? result.final.replyMessages : ['花花看到了，不过还不太确定。']
    const durationMs = Math.max(0, this.now() - startedAt)
    const reasoning = { effort: result.reasoning?.effort ?? 'medium', durationMs, visualInspections: result.inspections.length, visualUniqueImages: new Set(result.inspections.map((item) => item.attachmentId)).size }
    for (const [index, text] of replyMessages.entries()) {
      const message = await store.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning: index === replyMessages.length - 1 ? reasoning : null })
      emit('assistant_message', { text, messageId: message?.id })
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

  async #finishLongTermNone({ turnId, emit, userText, startedAt, ownerMessageStored = false, recallQuery = null, unavailable = false, excludedAttachmentIds = [], failureReason = null }) {
    const reply = await this.runtime.brain.reply({ identity: this.runtime.identitySnapshot(),
      state: this.runtime.snapshot(), userText: recallQuery ?? userText,
      recentMessages: this.runtime.conversation.messages(), allowVisualRecall: false,
      toolResultContext: failureReason ?? (unavailable ? '图库检索服务暂时不可用，未返回已核验照片'
        : '候选为空或不存在可读取的图片，未找到可核验照片'), now: this.now() })
    if (!reply?.ok) return reply
    const text = reply.text
    if (recallQuery) this.recallContext.record({ mode: 'visual_recall_ambiguous', query: recallQuery,
      result: { status: 'none' }, clarificationRequested: true, excludedAttachmentIds })
    const reasoning = { effort: 'low', durationMs: Math.max(0, this.now() - startedAt) }
    if (!ownerMessageStored) await this.runtime.conversationStore.appendMessage({ role: 'user', text: userText, turnId })
    const message = await this.runtime.conversationStore.appendMessage({ role: 'assistant', kind: 'final', turnId, text, reasoning })
    this.runtime.conversation.append(userText, text)
    emit('assistant_message', { text, reasoning, messageId: message?.id }); emit('turn_completed', { durationMs: reasoning.durationMs, reasoning })
    return { ok: true, text, replyMessages: [text], memoryWrite: 'skipped', memoryWriteReason: 'vision-context', reasoning }
  }

}
