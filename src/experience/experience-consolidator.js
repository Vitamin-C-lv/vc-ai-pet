import {
  cjkTerms,
  visualTermsFor,
  contentQueryTerms,
  GENERIC_RECALL_TERMS,
} from '../vision/visual-keywords.js'
import { containsSensitiveMemoryText } from '../brain/memory-candidate.js'

export const EXPERIENCE_CONSOLIDATION_MIN_OCCURRENCES = 2
// A durable life pattern should survive a day boundary. Requiring 24 hours
// separates repeated wording in one sitting from behavior that recurs over
// time, reducing accidental promotion of a single conversation into memory.
export const EXPERIENCE_CONSOLIDATION_MIN_DAY_SPAN_MS = 24 * 60 * 60 * 1000
export const EXPERIENCE_CONSOLIDATION_MAX_TERMS = 8

// These are conversation boilerplate terms, not the visual-recall stop list.
// Experience consolidation must retain ordinary words that can be useful in
// life statements even when visual retrieval would suppress them.
export const EXPERIENCE_CONSOLIDATION_STOP_TERMS = Object.freeze([
  '主人', '花花', '今天', '现在', '什么', '怎么', '可以', '一个', '这个', '那个',
  '然后', '但是', '因为', '所以', '记得', '记住', '记下来', '记一下', '记着', '记好',
  '我的', '我们', '你们', '自己', '请', '帮我', '然后', '还是', '又是', '一下',
  '真的', '非常', '比较', '已经', '正在', '就是', '不是', '没有', '可以吗',
  '什么', '怎么', '为什么', '吗', '呢', '啊', '呀', '吧', '哦', '了', '的', '是',
  '在', '有', '和', '也', '都', '还', '很', '再', '这', '那', '我', '你',
])

const STOP_TERMS = new Set(EXPERIENCE_CONSOLIDATION_STOP_TERMS)
const STOP_CHARACTERS = new Set(
  [...STOP_TERMS].flatMap((term) => [...term]),
)
const VISION_PREFIX = /^\s*\[主人发送了一张图片\]\s*/u
const ASCII_TERM = /^[a-z0-9][a-z0-9_-]*$/iu

function cleanOwnerText(value) {
  return String(value ?? '')
    .replace(VISION_PREFIX, '')
    // ExperienceBuffer stores the owner's text and the pet reply in one
    // content field. Only the owner portion may become evidence; otherwise a
    // harmless reply such as "收到" can be promoted as if the owner said it.
    .split(/\n花花回复：/u, 1)[0]
}

function normalizedTerm(value) {
  const term = String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase()
  if (!term || STOP_TERMS.has(term)) return null
  if (!ASCII_TERM.test(term) && [...term].length < 2) return null
  if (!ASCII_TERM.test(term) && [...term].every((character) => STOP_CHARACTERS.has(character))) return null
  // A generated n-gram such as "主人花" is boilerplate too, even though it
  // is not itself a declared stop term. Keep compounds with meaningful text.
  if ([...STOP_TERMS].some((stop) => [...stop].length > 1 && term.includes(stop))) return null
  return term
}

function defaultTokenize(text) {
  const weights = new Map()
  const add = (term, weight) => {
    const normalized = normalizedTerm(term)
    if (!normalized) return
    const numericWeight = Number(weight)
    const existing = weights.get(normalized) ?? 0
    weights.set(normalized, existing + (Number.isFinite(numericWeight) ? numericWeight : 1))
  }

  // cjkTerms supplies deterministic Chinese n-grams. The other two helpers
  // contribute the repository's ASCII handling and query-oriented weighting;
  // GENERIC_RECALL_TERMS is only a ranking hint here, never a hard stop list.
  for (const [term, weight] of cjkTerms(text)) add(term, weight)
  for (const { term, weight } of visualTermsFor(text)) add(term, weight)
  for (const { term, weight } of contentQueryTerms(text)) {
    add(term, weight * (GENERIC_RECALL_TERMS.has(term) ? 1 : 2))
  }

  return [...weights]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length || left[0].localeCompare(right[0]))
    .map(([term]) => term)
}

function createdTime(row, now) {
  const createdAt = Number(row?.createdAt)
  if (Number.isFinite(createdAt)) return createdAt
  return now()
}

function conversationKey(row) {
  if (row?.conversationKey !== null && row?.conversationKey !== undefined && String(row.conversationKey).trim()) {
    return `conversation-key:${String(row.conversationKey)}`
  }
  if (row?.conversationId !== null && row?.conversationId !== undefined && String(row.conversationId).trim()) {
    return `conversation:${String(row.conversationId)}`
  }
  return `experience:${String(row?.id ?? '')}`
}

function experienceId(row) {
  const id = Number(row?.id)
  if (!Number.isSafeInteger(id)) throw new Error('EXPERIENCE_ID_INVALID')
  return id
}

function shortestEvidence(text, term) {
  const source = String(text ?? '')
  if (!source.includes(term)) return null
  const pieces = source.split(/(?<=[。！？!?；;\n])/u).map((piece) => piece.trim()).filter(Boolean)
  const containing = pieces.filter((piece) => piece.includes(term))
  let evidence = (containing.length ? containing : [source.trim()])
    .sort((left, right) => left.length - right.length || left.localeCompare(right))[0]
  if (!evidence) return null
  if (evidence.length > 120) {
    const position = evidence.indexOf(term)
    const start = Math.max(0, Math.min(position, evidence.length - 120))
    evidence = evidence.slice(start, start + 120)
  }
  return evidence
}

function emptySkipped() {
  return { notEnoughOccurrences: 0, sensitive: 0, nonOwner: 0, duplicate: 0 }
}

function errorCode(error) {
  const candidate = String(error?.code ?? error?.message ?? '').trim()
  return /^[A-Z][A-Z0-9_:-]*$/u.test(candidate)
    ? candidate
    : 'EXPERIENCE_CONSOLIDATION_FAILED'
}

export class ExperienceConsolidator {
  constructor({
    buffer,
    memory,
    now = () => Date.now(),
    minOccurrences = EXPERIENCE_CONSOLIDATION_MIN_OCCURRENCES,
    minDaySpanMs = EXPERIENCE_CONSOLIDATION_MIN_DAY_SPAN_MS,
    maxTerms = EXPERIENCE_CONSOLIDATION_MAX_TERMS,
    tokenize = null,
    logger = null,
    memoryGate = null,
  }) {
    this.buffer = buffer
    this.memory = memory
    this.now = now
    this.minOccurrences = Number.isInteger(minOccurrences) && minOccurrences > 0
      ? minOccurrences
      : EXPERIENCE_CONSOLIDATION_MIN_OCCURRENCES
    this.minDaySpanMs = Number.isFinite(Number(minDaySpanMs)) && Number(minDaySpanMs) >= 0
      ? Number(minDaySpanMs)
      : EXPERIENCE_CONSOLIDATION_MIN_DAY_SPAN_MS
    this.maxTerms = Number.isInteger(maxTerms) && maxTerms >= 0
      ? maxTerms
      : EXPERIENCE_CONSOLIDATION_MAX_TERMS
    this.tokenize = typeof tokenize === 'function' ? tokenize : defaultTokenize
    this.logger = logger
    this.memoryGate = memoryGate
  }

  async #scan({ limit = 50, before = null } = {}) {
    const requestedLimit = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 50
    const rows = await this.buffer.pendingExperience({
      afterId: null,
      limit: requestedLimit,
      before,
    })
    if (!Array.isArray(rows)) throw new Error('EXPERIENCE_PENDING_RESULT_INVALID')

    const groups = new Map()
    const skipped = emptySkipped()
    const scannedRows = []
    // Owner rows that carried a credential. They never reach the gate, so they
    // cannot appear in a candidate group; without this set they would stay pending
    // forever and keep re-triggering Reflection on text that must never be kept.
    const sensitiveIds = new Set()
    for (const row of rows) {
      const id = experienceId(row)
      scannedRows.push({ ...row, id })
      if (row?.actorId !== 'owner') {
        skipped.nonOwner += 1
        continue
      }

      const ownerText = cleanOwnerText(row?.content)
      if (containsSensitiveMemoryText(ownerText)) {
        skipped.sensitive += 1
        sensitiveIds.add(id)
        // A credential-bearing owner turn must not be split into a harmless
        // token candidate (for example the assistant's or an id-like term).
        // It is consumed as rejected evidence below, never offered to the gate
        // with a narrower userText.
        continue
      }
      const terms = new Set(this.tokenize(ownerText).map(normalizedTerm).filter(Boolean))
      for (const term of terms) {
        if (!ownerText.includes(term)) continue
        const evidence = shortestEvidence(ownerText, term)
        if (!evidence) continue
        const group = groups.get(term) ?? {
          term,
          rows: new Map(),
          turns: new Set(),
        }
        if (!group.rows.has(id)) {
          group.rows.set(id, {
            id,
            conversation: conversationKey(row),
            createdAt: createdTime(row, this.now),
            messageId: row?.messageId ?? null,
            evidence,
          })
          group.turns.add(conversationKey(row))
        }
        groups.set(term, group)
      }
    }

    const candidates = []
    for (const group of groups.values()) {
      const evidenceRows = [...group.rows.values()]
      const occurrences = evidenceRows.length
      const firstOccurredAt = Math.min(...evidenceRows.map((row) => row.createdAt))
      const lastOccurredAt = Math.max(...evidenceRows.map((row) => row.createdAt))
      const stable = occurrences >= this.minOccurrences &&
        group.turns.size >= 2 &&
        lastOccurredAt - firstOccurredAt >= this.minDaySpanMs
      if (!stable) {
        skipped.notEnoughOccurrences += 1
        continue
      }

      // Cite the earliest occurrence, not the shortest string.
      //
      // The evidence is the verbatim quote the durable fact is built from, and
      // "when did this first happen" is the claim being made. Ordering by id
      // makes the choice deterministic across runs and across a restart, which a
      // length/locale sort silently was not.
      const evidence = [...evidenceRows]
        .sort((left, right) => left.id - right.id)[0]
        ?.evidence
      if (typeof evidence !== 'string' || !evidence) {
        skipped.notEnoughOccurrences += 1
        continue
      }
      if (containsSensitiveMemoryText(evidence)) {
        skipped.sensitive += 1
        continue
      }

      const earliestRow = [...evidenceRows]
        .sort((left, right) => left.id - right.id)[0]
      candidates.push({
        term: group.term,
        occurrences,
        experienceIds: evidenceRows.map((row) => row.id),
        turns: group.turns.size,
        firstOccurredAt,
        lastOccurredAt,
        evidence,
        messageId: earliestRow?.messageId ?? null,
        content: `主人说：${evidence}`,
        level: 'fact',
        importance: occurrences >= 3 ? 3 : 2,
        keywords: [group.term],
      })
    }

    candidates.sort((left, right) =>
      right.occurrences - left.occurrences ||
      right.term.length - left.term.length ||
      left.firstOccurredAt - right.firstOccurredAt ||
      left.term.localeCompare(right.term),
    )

    return {
      scannedRows,
      result: {
        scanned: scannedRows.length,
        candidates,
        skipped,
        sensitiveIds,
      },
    }
  }

  async analyze({ limit = 50, before = null } = {}) {
    return (await this.#scan({ limit, before })).result
  }

  async consolidate({ limit = 50, before = null } = {}) {
    try {
      const { scannedRows, result } = await this.#scan({ limit, before })
      if (scannedRows.length === 0) {
        return {
          status: 'skipped',
          ok: true,
          reason: 'no-pending-experience',
          scanned: 0,
          candidates: 0,
          written: 0,
          duplicates: 0,
          rejected: {},
          writtenIds: [],
          processedIds: [],
          checkpoint: null,
        }
      }

      if (!this.memoryGate || typeof this.memoryGate.consider !== 'function') {
        return {
          status: 'failed',
          ok: false,
          reason: 'memory-gate-missing',
          scanned: result.scanned,
          candidates: result.candidates.length,
          written: 0,
          duplicates: 0,
          rejected: {},
          writtenIds: [],
          processedIds: [],
          checkpoint: null,
        }
      }

      const selected = result.candidates.slice(0, this.maxTerms)
      const deferredIds = new Set(result.candidates
        .slice(this.maxTerms)
        .flatMap((candidate) => candidate.experienceIds))
      // Consolidation may only consume the rows it actually decided something
      // about.
      //
      // The Experience Buffer exists so Reflection can look at recent life. If
      // consolidation marked every row it merely *scanned*, a tick would swallow
      // the whole pending set before Reflection ever ran — a day of ordinary
      // conversation would be consumed by a pass that found no pattern in it, and
      // Reflection would starve while the buffer looked empty. So a row is
      // consumed only when it belongs to a group stable enough to reach the
      // MemoryGate (written, duplicate or rejected), or when its text carried a
      // credential and was deliberately purged. Rows that formed no stable group
      // stay pending for Reflection to read.
      const consumedIds = new Set()
      for (const candidate of result.candidates) {
        for (const id of candidate.experienceIds) consumedIds.add(id)
      }
      // A credential-bearing owner row is deliberately purged: it must never be
      // kept, and leaving it pending would keep Reflection re-reading it.
      const purgedIds = result.sensitiveIds ?? new Set()
      const processedIds = scannedRows
        .map((row) => row.id)
        .filter((id) => !deferredIds.has(id))
        .filter((id) => consumedIds.has(id) || purgedIds.has(id))

      let written = 0
      let duplicates = 0
      const rejected = result.skipped.sensitive > 0
        ? { 'memory-sensitive-reject': result.skipped.sensitive }
        : {}
      const writtenIds = []
      // Commit the candidates as one unit.
      //
      // A gate that throws on the second candidate must not leave the first
      // candidate's row behind while the pass reports failure and keeps its
      // experiences pending: the next pass would then find a row the failure
      // report said was never created. `PetMemory.forget()` reverts the rows this
      // pass wrote before the error is rethrown, so "this pass failed" and "this
      // pass wrote nothing" always agree.
      try {
        for (const candidate of selected) {
          const evidence = candidate.evidence
          const rawCandidate = {
            remember: true,
            level: 'fact',
            content: evidence,
            importance: candidate.occurrences >= 3 ? 3 : 2,
            keywords: candidate.keywords,
            confidence: 1,
            evidence,
          }
          const decision = this.memoryGate.consider(evidence, rawCandidate, {
            messageId: candidate.messageId,
          })
          if (!decision || !['written', 'duplicate', 'skipped'].includes(decision.status)) {
            throw new Error('MEMORY_GATE_DECISION_INVALID')
          }
          if (decision.status === 'duplicate') {
            duplicates += 1
            continue
          }
          if (decision.status === 'written') {
            if (decision.id === null || decision.id === undefined) throw new Error('MEMORY_GATE_WRITE_RESULT_INVALID')
            written += 1
            writtenIds.push(String(decision.id))
            continue
          }
          rejected[decision.reason ?? 'memory-candidate-rejected'] =
            (rejected[decision.reason ?? 'memory-candidate-rejected'] ?? 0) + 1
        }
      } catch (error) {
        const reverted = typeof this.memory.forget === 'function'
          ? writtenIds.filter((id) => {
              try { return this.memory.forget(id) === true } catch { return false }
            })
          : []
        const rollbackUnavailable = writtenIds.length > 0 && reverted.length !== writtenIds.length
        this.logger?.warn?.(
          `vc-ai-pet: experience consolidation rolled back written=${reverted.length}/${writtenIds.length}`
          + ` rollbackUnavailable=${rollbackUnavailable ? 'YES' : 'NO'}`,
        )
        throw error
      }

      if (processedIds.length > 0) {
        await this.buffer.markProcessed(processedIds, { processedAt: this.now() })
      }
      return {
        status: 'completed',
        ok: true,
        scanned: result.scanned,
        candidates: result.candidates.length,
        written,
        duplicates,
        rejected,
        writtenIds,
        processedIds,
        checkpoint: processedIds.length ? Math.max(...processedIds) : null,
      }
    } catch (error) {
      try { this.logger?.error?.('Experience consolidation failed', error) } catch {}
      return { status: 'failed', ok: false, reason: errorCode(error) }
    }
  }
}
