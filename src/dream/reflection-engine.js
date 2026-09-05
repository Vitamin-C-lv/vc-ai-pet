import { randomUUID } from 'node:crypto'

import { evaluateDerivedEvidence, findSameEvidenceDerivation, isRawEvidenceRow } from '../memory/derived-evidence.js'
import { normalizeProvenance } from '../memory/memory-provenance.js'
import { validateDerivedMemorySemantics } from '../memory/semantic-stability.js'

const REFLECTION_LEVELS = new Set(['user', 'fact', 'lesson', 'topic'])
const RAW_SOURCE_SESSION = 'vc-ai-pet'

export const PET_REFLECTION_SOURCE_SESSION = 'vc-ai-pet:reflection'
export const PET_REFLECTION_WINDOW = 'vc-ai-pet:reflection-window'
export const REFLECTION_BATCH_SIZE = 4
export const REFLECTION_RELATED_LIMIT = 4
export const REFLECTION_DERIVED_MAX_PER_BATCH = 1
export const REFLECTION_LEASE_MS = 30 * 60 * 1000

export const REFLECTION_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'memories'],
  properties: {
    summary: { type: 'string', maxLength: 600 },
    memories: {
      type: 'array',
      maxItems: REFLECTION_DERIVED_MAX_PER_BATCH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'content', 'importance', 'keywords', 'confidence', 'source_ids'],
        properties: {
          level: { type: 'string', enum: ['user', 'fact', 'lesson', 'topic'] },
          content: { type: 'string', minLength: 4, maxLength: 180 },
          importance: { type: 'integer', minimum: 2, maximum: 3 },
          keywords: {
            type: 'array',
            maxItems: 6,
            items: { type: 'string', maxLength: 24 },
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          source_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
  },
})

export const REFLECTION_RESPONSE_FORMAT = Object.freeze({
  type: 'json_object',
  schema: REFLECTION_RESPONSE_SCHEMA,
})

export const REFLECTION_SYSTEM_PROMPT = [
  '你现在不是在和主人聊天。',
  '你是白天短暂回味刚刚经历的李花花，只整理已经存在于长期 Pet Memory 的原始生活记忆。',
  '',
  '只生成一条新的、低风险的 user、fact、lesson 或 topic 理解；没有值得保留的内容时返回 memories=[]。',
  'Micro Reflection 绝对不能生成 soul、rules 或 project，也不能预设人格。',
  '原始 memory 永远是历史经历，不能删除、覆盖、纠正、归档或标记 stale。',
  '每条 source_ids 必须引用本次输入中出现的完整 memory id，并且至少引用一条 NEW 原始 memory。',
  '不要把 Reflection 或 Dream derived memory 当成新的原始经历；不要输出聊天记录或工作总结。',
  '请严格返回 Reflection JSON schema，不要返回 Markdown、解释文字或代码围栏。',
].join('\n')

export const REFLECTION_MEMORY_ADAPTER_METHODS = Object.freeze([
  'reflectionSourceRows',
  'relatedForReflection',
  'reflectionWindow',
  'claimReflection',
  'finishReflection',
  'logReflection',
  'findEquivalentMemory',
  'rememberReflectionCandidate',
])

function asIdSet(value) {
  if (value instanceof Set) return new Set([...value].map((id) => String(id)))
  if (Array.isArray(value)) return new Set(value.map((id) => String(id)))
  return new Set()
}

function cleanString(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

export function validateReflectionCandidate(
  raw,
  {
    newSourceIds = [],
    rawSourceIds = undefined,
    rawNewSourceIds = undefined,
    availableSourceIds = [],
    sourceRows = [],
    findById,
  } = {},
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const level = cleanString(raw.level, 16)
  const content = cleanString(raw.content, 180)
  const importance = Number(raw.importance)
  const confidence = Number(raw.confidence)

  if (!REFLECTION_LEVELS.has(level)) return null
  if (content.length < 4) return null
  if (!Number.isInteger(importance) || importance < 2 || importance > 3) return null
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.map((item) => cleanString(item, 24)).filter(Boolean).slice(0, 6)
    : []

  if (!Array.isArray(raw.source_ids) || raw.source_ids.length > 8) return null
  const sourceIds = [...new Set(raw.source_ids.map((item) => cleanString(item, 64)).filter(Boolean))]
  if (sourceIds.length === 0) return null

  const availableIds = asIdSet(availableSourceIds)
  if (!sourceIds.every((id) => availableIds.has(id))) return null
  const evidence = evaluateDerivedEvidence({ level, sourceIds }, { sourceRows, newSourceIds, findById })
  if (!evidence) return null
  return { level, content, importance, ...evidence, keywords, sourceIds }
}

export class ReflectionGate {
  constructor({ memory }) {
    this.memory = memory
  }

  consider(raw, context) {
    const candidate = validateReflectionCandidate(raw, context)
    if (!candidate) return { status: 'skipped', reason: 'invalid-candidate' }

    const semantic = validateDerivedMemorySemantics(raw, {
      sourceRows: context?.sourceRows,
      protectedTerms: context?.protectedTerms,
    })
    if (!semantic.approved) {
      return {
        status: 'skipped',
        reason: 'semantic-drift',
        semantic,
      }
    }

    const requested = raw?.provenance ?? { source: 'REFLECTION_DERIVED' }
    if (normalizeProvenance(requested).source !== 'REFLECTION_DERIVED') return { status: 'skipped', reason: 'invalid-provenance' }
    const provenance = { ...normalizeProvenance({
      source: 'REFLECTION_DERIVED',
      evidence: 'inferred',
      sourceIds: candidate.sourceIds,
    }), sourceRoots: candidate.sourceRoots, confidence: candidate.confidence, evidenceCount: candidate.evidenceCount }
    if (provenance.source !== 'REFLECTION_DERIVED' || provenance.evidence !== 'inferred') {
      return { status: 'skipped', reason: 'invalid-provenance' }
    }

    const existing = this.memory.findEquivalentMemory(candidate.content) ??
      this.memory.findSameEvidenceDerivation?.({ ...candidate, provenance }) ??
      findSameEvidenceDerivation({ ...candidate, provenance }, context?.sourceRows)
    if (existing) return { status: 'duplicate', existingId: existing.id }

    const row = this.memory.rememberReflectionCandidate({ ...candidate, provenance })
    return { status: 'written', row, sourceIds: candidate.sourceIds, provenance, semantic }
  }
}

function rowId(row) {
  const value = cleanString(row?.id, 64)
  return value || null
}

function rowCreatedAt(row) {
  const value = Number(row?.created_at ?? row?.updated_at)
  return Number.isFinite(value) ? value : 0
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const timeDiff = rowCreatedAt(left) - rowCreatedAt(right)
    return timeDiff || String(rowId(left) ?? '').localeCompare(String(rowId(right) ?? ''))
  })
}

function dedupeRows(rows, excludedIds = new Set()) {
  const seen = new Set(excludedIds)
  const result = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = rowId(row)
    if (!id || seen.has(id)) continue
    seen.add(id)
    result.push(row)
  }
  return result
}

function formatMemoryRow(row) {
  const sourceSession = row?.source_session ?? 'unknown'

  return [
    `[${rowId(row) ?? ''}]`,
    `[${cleanString(row?.level, 16)}]`,
    `[source_session=${sourceSession}]`,
    `[evidence=${isRawEvidenceRow(row) ? 'raw' : 'background-only'}]`,
    `[${row?.created_at ?? row?.updated_at ?? ''}]`,
    `[${row?.importance ?? ''}]`,
    String(row?.content ?? '').trim(),
  ].join('\n')
}

function formatMemorySection(label, rows) {
  const entries = rows.map(formatMemoryRow)
  return [label, entries.length > 0 ? entries.join('\n\n') : '(none)'].join('\n')
}

export function buildReflectionMessages({ newMemories = [], relatedMemories = [] } = {}) {
  return [
    { role: 'system', content: REFLECTION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        formatMemorySection('NEW RAW MEMORIES', newMemories),
        formatMemorySection('RELATED HISTORY', relatedMemories),
        '',
        '请只根据以上长期 memory 生成 JSON。',
      ].join('\n\n'),
    },
  ]
}

function parseJsonObject(rawText) {
  if (rawText && typeof rawText === 'object' && !Array.isArray(rawText)) return rawText
  if (typeof rawText !== 'string' || rawText.trim().length === 0) return null
  try {
    const parsed = JSON.parse(rawText)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseReflectionResponse(rawText) {
  const parsed = parseJsonObject(rawText)
  if (!parsed || !Array.isArray(parsed.memories) || typeof parsed.summary !== 'string') return null
  return {
    summary: cleanString(parsed.summary, 600),
    memories: parsed.memories.slice(0, REFLECTION_DERIVED_MAX_PER_BATCH),
  }
}

function buildRelatedQuery(rows) {
  const parts = []
  for (const row of rows) {
    if (Array.isArray(row?.keywords)) parts.push(...row.keywords)
    if (row?.content) parts.push(row.content)
  }
  return String(parts.join(' ')).trim().slice(0, 800)
}

function reflectionFailure(code) {
  const error = new Error(code)
  error.code = code
  return error
}

export function assertReflectionMemoryAdapter(memory) {
  if (!memory || typeof memory !== 'object') throw new TypeError('PET_REFLECTION_MEMORY_ADAPTER_REQUIRED')
  for (const method of REFLECTION_MEMORY_ADAPTER_METHODS) {
    if (typeof memory[method] !== 'function') throw new TypeError(`PET_REFLECTION_MEMORY_ADAPTER_MISSING:${method}`)
  }
  return memory
}

export class ReflectionEngine {
  constructor({
    memory,
    brain,
    gate = null,
    owner = `vc-ai-pet:reflection:${process.pid}:${randomUUID()}`,
    now = () => Date.now(),
    batchSize = REFLECTION_BATCH_SIZE,
    relatedLimit = REFLECTION_RELATED_LIMIT,
    maxDerivedPerBatch = REFLECTION_DERIVED_MAX_PER_BATCH,
  } = {}) {
    this.memory = assertReflectionMemoryAdapter(memory)
    if (!brain || typeof brain.reflectionCompletion !== 'function') {
      throw new TypeError('PET_REFLECTION_BRAIN_ADAPTER_MISSING:reflectionCompletion')
    }
    if (typeof now !== 'function') throw new TypeError('PET_REFLECTION_CLOCK_INVALID')
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError('PET_REFLECTION_BATCH_SIZE_INVALID')
    if (!Number.isInteger(relatedLimit) || relatedLimit < 0) throw new TypeError('PET_REFLECTION_RELATED_LIMIT_INVALID')
    if (!Number.isInteger(maxDerivedPerBatch) || maxDerivedPerBatch < 1) throw new TypeError('PET_REFLECTION_DERIVED_LIMIT_INVALID')

    this.brain = brain
    this.gate = gate ?? new ReflectionGate({ memory: this.memory })
    this.owner = String(owner)
    this.now = now
    this.batchSize = Math.min(batchSize, REFLECTION_BATCH_SIZE)
    this.relatedLimit = Math.min(relatedLimit, REFLECTION_RELATED_LIMIT)
    this.maxDerivedPerBatch = Math.min(maxDerivedPerBatch, REFLECTION_DERIVED_MAX_PER_BATCH)
    this.inFlight = false
  }

  isInFlight() {
    return this.inFlight
  }

  async run({ force = false, now = undefined } = {}) {
    void force
    if (this.inFlight) return {
      status: 'skipped', reason: 'reflection-in-flight', sourceCount: 0, batchCount: 0,
      derivedCount: 0, duplicateCount: 0, checkpoint: null,
    }

    this.inFlight = true
    let previousCheckpoint = 0
    let sourceRows = []
    let attemptedBatches = 0
    let written = []
    let duplicates = []
    let leaseClaimed = false

    try {
      const window = await this.memory.reflectionWindow()
      previousCheckpoint = Number.isFinite(Number(window?.last_dream_time))
        ? Number(window.last_dream_time)
        : 0
      const boundary = Number.isFinite(Number(now)) ? Number(now) : Number(this.now())
      const rawRows = await this.memory.reflectionSourceRows({ after: previousCheckpoint, before: boundary })
      if (!Array.isArray(rawRows)) throw reflectionFailure('PET_REFLECTION_SOURCE_ROWS_INVALID')
      sourceRows = sortRows(rawRows.filter((row) =>
        row?.status === 'active' &&
        isRawEvidenceRow(row) &&
        Number(row?.importance) >= 2 &&
        Number.isFinite(Number(row?.created_at)) &&
        Number(row.created_at) > previousCheckpoint &&
        Number(row.created_at) <= boundary,
      ))

      if (sourceRows.length === 0) return {
        status: 'skipped', reason: 'no-new-sources', sourceCount: 0, batchCount: 0,
        derivedCount: 0, duplicateCount: 0, checkpoint: previousCheckpoint,
        checkpointBefore: previousCheckpoint, checkpointAfter: previousCheckpoint,
      }

      // Micro Reflection is deliberately one small pass. Leave any later
      // raw rows behind the processed boundary for a future 30-minute turn;
      // only Deep Dream is allowed to fan out across multiple batches.
      const processedRows = sourceRows.slice(0, this.batchSize)
      const processedBoundary = processedRows.length < sourceRows.length
        ? rowCreatedAt(processedRows[processedRows.length - 1])
        : boundary

      const claimed = await this.memory.claimReflection(this.owner, boundary)
      if (!claimed) return {
        status: 'skipped', reason: 'reflection-lease-unavailable', sourceCount: sourceRows.length,
        batchCount: 0, derivedCount: 0, duplicateCount: 0, checkpoint: previousCheckpoint,
        checkpointBefore: previousCheckpoint, checkpointAfter: previousCheckpoint,
      }
      leaseClaimed = true

      const batches = [processedRows]
      const allNewIds = new Set(processedRows.map((row) => rowId(row)).filter(Boolean))
      const proposals = []
      const summaries = []
      let invalidCandidateCount = 0

      for (const batch of batches) {
        attemptedBatches += 1
        const batchIds = new Set(batch.map((row) => rowId(row)).filter(Boolean))
        const query = buildRelatedQuery(batch)
        const relatedRows = query.length > 0
          ? await this.memory.relatedForReflection(query, { k: this.relatedLimit, excludeIds: [...allNewIds] })
          : []
        if (!Array.isArray(relatedRows)) throw reflectionFailure('PET_REFLECTION_RELATED_ROWS_INVALID')

        const related = dedupeRows(relatedRows, allNewIds).slice(0, this.relatedLimit)
        const availableSourceIds = new Set([
          ...batchIds,
          ...related.map((row) => rowId(row)).filter(Boolean),
        ])
        const rawSourceIds = new Set(
          [...batch, ...related]
            .filter((row) => isRawEvidenceRow(row))
            .map((row) => rowId(row))
            .filter(Boolean),
        )
        const context = {
          newSourceIds: batchIds,
          rawNewSourceIds: batchIds,
          rawSourceIds,
          availableSourceIds,
          sourceRows: [...batch, ...related],
        }
        const completion = await this.brain.reflectionCompletion({
          messages: buildReflectionMessages({ newMemories: batch, relatedMemories: related }),
          responseFormat: REFLECTION_RESPONSE_FORMAT,
        })
        if (!completion || completion.ok === false || completion.unavailable === true) {
          throw reflectionFailure(completion?.reason || 'local-brain-unavailable')
        }

        const parsed = parseReflectionResponse(completion.rawText)
        if (!parsed) throw reflectionFailure('PET_REFLECTION_STRUCTURED_OUTPUT_INVALID')
        if (parsed.summary) summaries.push(parsed.summary)
        for (const rawCandidate of parsed.memories.slice(0, this.maxDerivedPerBatch)) {
          if (validateReflectionCandidate(rawCandidate, context)) proposals.push({ rawCandidate, context })
          else invalidCandidateCount += 1
        }
      }

      for (const { rawCandidate, context } of proposals) {
        const result = this.gate.consider(rawCandidate, context)
        if (result.status === 'written') {
          written.push({
            id: result.row?.id ?? null,
            level: result.row?.level ?? rawCandidate.level,
            sourceIds: result.sourceIds ?? [],
            provenance: result.provenance ?? rawCandidate.provenance,
          })
        } else if (result.status === 'duplicate') {
          duplicates.push(result.existingId ?? null)
        } else {
          invalidCandidateCount += 1
        }
      }

      await this.memory.logReflection(
        summaries.join(' ').trim().slice(0, 600),
        {
          kind: 'reflection',
          checkpointFrom: previousCheckpoint,
          checkpointTo: processedBoundary,
          sourceIds: processedRows.map((row) => rowId(row)),
          derived: written,
          duplicates,
          skipped: invalidCandidateCount,
        },
        'vc-ai-pet v0.3-B micro-reflection',
      )
      await this.memory.finishReflection(processedBoundary)
      leaseClaimed = false

      return {
        status: 'completed', ok: true, sourceCount: processedRows.length,
        pendingSourceCount: sourceRows.length - processedRows.length, batchCount: batches.length,
        derivedCount: written.length, duplicateCount: duplicates.length, checkpoint: processedBoundary,
        checkpointBefore: previousCheckpoint, checkpointAfter: processedBoundary, derived: written,
        duplicates, skipped: invalidCandidateCount,
      }
    } catch (error) {
      if (leaseClaimed) {
        try { await this.memory.finishReflection(previousCheckpoint) } catch {}
      }
      return {
        status: 'failed', ok: false, reason: typeof error?.code === 'string' ? error.code : 'reflection-failed',
        sourceCount: sourceRows.length, batchCount: attemptedBatches, derivedCount: 0,
        duplicateCount: duplicates.length, checkpoint: previousCheckpoint,
        checkpointBefore: previousCheckpoint, checkpointAfter: previousCheckpoint,
      }
    } finally {
      this.inFlight = false
    }
  }

  runReflection(options = {}) {
    return this.run(options)
  }
}
