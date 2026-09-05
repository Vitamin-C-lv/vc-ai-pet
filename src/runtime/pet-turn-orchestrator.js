import { buildVisualCandidatePool, detectVisualIntent, isImmediatePreviousVisualReference, RecentVisualResolver } from '../conversation/recent-visual-context.js'
import { VisualWorkingSession } from '../vision/visual-working-session.js'
import { sanitizeSafeTraceText } from './pet-turn-events.js'

function buildPrimaryComparisonPair(pool, intent) {
  if (intent !== 'comparison' || !Array.isArray(pool)) return []
  const current = pool.find((candidate) => candidate?.relation === 'current')
  const previous = pool.find((candidate) => candidate?.relation === 'previous' && candidate.attachmentId !== current?.attachmentId)
  return current && previous ? [current, previous] : []
}

export class PetTurnOrchestrator {
  constructor({ runtime, resolver = new RecentVisualResolver(), now = () => Date.now() } = {}) { this.runtime = runtime; this.resolver = resolver; this.now = now }

  async runVisual({ turnId, emit, userText, attachment }) {
    const startedAt = this.now()
    const store = this.runtime.conversationStore
    const messages = typeof store.listForRecentVisualRecall === 'function'
      ? await store.listForRecentVisualRecall()
      : typeof store.list === 'function'
        ? await store.list(500)
        : []
    const pool = buildVisualCandidatePool({ currentAttachment: attachment, userText, messages })
    const resolved = this.resolver.resolve(userText, messages)
    const intent = detectVisualIntent(userText, { hasCurrent: Boolean(attachment), candidateCount: pool.length - (attachment ? 1 : 0) })
    const comparisonPair = buildPrimaryComparisonPair(pool, intent)
    emit('turn_started', { mode: 'visual' }); emit('thinking', {})
    const historicalCandidateCount = pool.length - (attachment ? 1 : 0)
    const explicitPreviousReference = intent === 'temporal_followup' && isImmediatePreviousVisualReference(userText)
    const unresolvedHistoricalReference = ['temporal_followup', 'historical_visual'].includes(intent)
      && historicalCandidateCount > 0
      && !resolved?.matched
      && (!attachment || intent === 'historical_visual' || explicitPreviousReference)
    if (intent === 'ambiguous' || pool.length === 0 || unresolvedHistoricalReference || (intent === 'comparison' && comparisonPair.length < 2)) {
      return this.#finishAmbiguous({ turnId, emit, userText, attachment, startedAt })
    }
    const resolvedVisual = pool.find((candidate) => candidate.attachmentId === resolved?.attachmentId)?.visualId
    const preferResolvedHistorical = resolvedVisual && (!attachment || intent === 'historical_visual' || explicitPreviousReference)
    const first = preferResolvedHistorical
      ? resolvedVisual
      : attachment || intent === 'comparison'
        ? pool[0]?.visualId
        : resolvedVisual ?? pool[0]?.visualId
    await store.appendMessage({ role: 'user', text: userText, attachment, turnId })
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
      await store.appendMessage({ role: 'assistant', kind: 'activity', activityType: 'memory_recall', provenance, activitySeq: recallEvent?.seq, activityAt: recallEvent?.at, turnId, text: `${provenance === 'inferred' ? '联想到：' : '想起：'}${summary}` })
    }
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
    })
    const result = await session.run(first)
    if (!result.ok) return result
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
