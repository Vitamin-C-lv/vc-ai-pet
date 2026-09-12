import {
  cjkTerms,
  visualTermsFor,
  contentQueryTerms,
  GENERIC_RECALL_TERMS,
} from '../vision/visual-keywords.js'
import { containsSensitiveMemoryText } from '../brain/memory-candidate.js'

export const EXPERIENCE_CONSOLIDATION_MIN_OCCURRENCES = 2
export const EXPERIENCE_CONSOLIDATION_MIN_DAY_SPAN_MS = 0
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
  return String(value ?? '').replace(VISION_PREFIX, '')
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
    maxTerms = EXPERIENCE_CONSOLIDATION_MAX_TERMS,
    tokenize = null,
    logger = null,
  }) {
    this.buffer = buffer
    this.memory = memory
    this.now = now
    this.minOccurrences = Number.isInteger(minOccurrences) && minOccurrences > 0
      ? minOccurrences
      : EXPERIENCE_CONSOLIDATION_MIN_OCCURRENCES
    this.maxTerms = Number.isInteger(maxTerms) && maxTerms >= 0
      ? maxTerms
      : EXPERIENCE_CONSOLIDATION_MAX_TERMS
    this.tokenize = typeof tokenize === 'function' ? tokenize : defaultTokenize
    this.logger = logger
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
    for (const row of rows) {
      const id = experienceId(row)
      scannedRows.push({ ...row, id })
      if (row?.actorId !== 'owner') {
        skipped.nonOwner += 1
        continue
      }

      const ownerText = cleanOwnerText(row?.content)
      if (containsSensitiveMemoryText(ownerText)) skipped.sensitive += 1
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
        lastOccurredAt - firstOccurredAt >= EXPERIENCE_CONSOLIDATION_MIN_DAY_SPAN_MS
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

      candidates.push({
        term: group.term,
        occurrences,
        experienceIds: evidenceRows.map((row) => row.id),
        turns: group.turns.size,
        firstOccurredAt,
        lastOccurredAt,
        evidence,
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
          writtenIds: [],
          processedIds: [],
          checkpoint: null,
        }
      }

      const selected = result.candidates.slice(0, this.maxTerms)
      const deferredIds = new Set(result.candidates
        .slice(this.maxTerms)
        .flatMap((candidate) => candidate.experienceIds))
      const processedIds = scannedRows
        .map((row) => row.id)
        .filter((id) => !deferredIds.has(id))

      let written = 0
      let duplicates = 0
      const writtenIds = []
      for (const candidate of selected) {
        const duplicate = this.memory.findEquivalentMemory(candidate.content)
        if (duplicate) {
          duplicates += 1
          continue
        }

        const provenance = {
          source: 'USER_STATEMENT',
          evidence: 'confirmed',
          evidenceQuote: candidate.evidence,
        }
        const row = typeof this.memory.remember === 'function'
          ? this.memory.remember(candidate.level, candidate.content, candidate.importance, {
            keywords: candidate.keywords,
            provenance,
          })
          : typeof this.memory.rememberCandidate === 'function'
            ? this.memory.rememberCandidate({ ...candidate, provenance })
            : (() => { throw new Error('PET_MEMORY_WRITE_METHOD_MISSING') })()
        if (!row || row.id === null || row.id === undefined) throw new Error('PET_MEMORY_WRITE_RESULT_INVALID')
        written += 1
        writtenIds.push(String(row.id))
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
