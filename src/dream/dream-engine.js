import { isRawEvidenceRow } from '../memory/derived-evidence.js'
import { randomUUID } from 'node:crypto'

import { DreamGate, validateDreamCandidate } from './dream-gate.js'
import { createDreamCandidate, validateDreamCandidateSemantics } from './dream-candidate.js'

export const PET_DREAM_SOURCE_SESSION = 'vc-ai-pet:dream'
export const PET_RAW_SOURCE_SESSION = 'vc-ai-pet'
export const PET_DREAM_WINDOW = 'vc-ai-pet:dream-window'
export const DEEP_DREAM_BATCH_NEW_MAX = 24
export const DEEP_DREAM_RELATED_MAX = 24
// Backward-compatible names used by the first v0.3-B integration.
export const DREAM_BATCH_SIZE = DEEP_DREAM_BATCH_NEW_MAX
export const DREAM_RELATED_LIMIT = DEEP_DREAM_RELATED_MAX
export const DREAM_DERIVED_MAX_PER_BATCH = 3
export const DREAM_LEASE_MS = 30 * 60 * 1000

const DREAM_SOURCE_LEVELS = new Set(['user', 'project', 'fact', 'lesson', 'topic'])

export const DREAM_RESPONSE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'memories'],
  properties: {
    summary: {
      type: 'string',
      maxLength: 600,
    },
    memories: {
      type: 'array',
      maxItems: DREAM_DERIVED_MAX_PER_BATCH,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['level', 'content', 'importance', 'keywords', 'confidence', 'source_ids'],
        properties: {
          level: {
            type: 'string',
            enum: ['soul', 'user', 'fact', 'lesson', 'topic'],
          },
          content: {
            type: 'string',
            minLength: 4,
            maxLength: 180,
          },
          importance: {
            type: 'integer',
            minimum: 2,
            maximum: 3,
          },
          keywords: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'string',
              maxLength: 24,
            },
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
          },
          source_ids: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
            },
          },
        },
        allOf: [
          {
            if: {
              properties: {
                level: { const: 'soul' },
              },
            },
            then: {
              description: 'Soul 只能是慢慢形成的第一人称自我理解；必须以“我”开头、importance=3、弱假设可以只有一个真实来源；置信度由证据根去重计算。',
              properties: {
                content: { pattern: '^我' },
                importance: { const: 3 },
                confidence: { minimum: 0 },
                source_ids: { minItems: 1 },
              },
            },
          },
        ],
      },
    },
  },
})

export const DREAM_RESPONSE_FORMAT = Object.freeze({
  type: 'json_object',
  schema: DREAM_RESPONSE_SCHEMA,
})

export const DREAM_SYSTEM_PROMPT = [
  '你现在不是在和主人聊天。',
  '你是睡着后的李花花，正在整理已经存在于长期 Pet Memory 的历史经历。',
  '',
  '只生成新的理解、认识、经验或长期值得关注的 topic；不要复述聊天，不要写工作总结。',
  '原始 memory 永远是历史经历，绝对不能删除、覆盖、纠正、归档、标记 stale，也不能把多条历史改写成一条。',
  '不要创造来源中没有支持的信息；“相似”不等于“必须合并”。',
  '如果证据互相矛盾或发生时间变化，不要强行选择真相；宁可输出 memories=[]。',
  '最多产生 3 条 derived memory；没有值得形成的新认识时，memories=[] 是正确答案。',
  '每条 source_ids 必须引用本批输入中出现的完整 memory id，并且至少引用一条当前 NEW 的 raw memory；输入 evidence=raw 才是原始证据，session 标签不能覆盖 provenance。',
  'derived memory 可以是 soul、user、fact、lesson、topic；绝对不要输出 rules 或 project。',
  'soul 只用于慢慢形成的第一人称自我理解：content 必须以“我”开头、importance 必须为 3、单一经历只能形成待修正的弱假设；confidence 不代表事实，最终由真实证据根数计算。',
  'related 的 reflection、旧 dream、旧 soul 只能作为背景，不能增加证据数或置信度；soul 必须有真实 raw 来源，其中至少一个是当前 NEW。',
  '不要因为单一事件生成固定的 soul 或人格判断；不要预设或硬编码任何人格形容词。',
  '请严格返回 Dream JSON schema，不要返回 Markdown、解释文字或代码围栏。',
].join('\n')

/**
 * The root-owned PetMemory adapter required by DreamEngine.
 *
 * Methods deliberately expose only Pet upper-layer memory operations. The
 * engine never reaches through the adapter to SQLite or to another memory
 * orchestration layer.
 */
export const DREAM_MEMORY_ADAPTER_METHODS = Object.freeze([
  'dreamSourceRows',
  'relatedForDream',
  'dreamWindow',
  'claimDream',
  'finishDream',
  'logDream',
  'findEquivalentMemory',
  'rememberDreamCandidate',
])

export function assertDreamMemoryAdapter(memory) {
  if (!memory || typeof memory !== 'object') {
    throw new TypeError('PET_DREAM_MEMORY_ADAPTER_REQUIRED')
  }

  for (const method of DREAM_MEMORY_ADAPTER_METHODS) {
    if (typeof memory[method] !== 'function') {
      throw new TypeError(`PET_DREAM_MEMORY_ADAPTER_MISSING:${method}`)
    }
  }

  return memory
}

function cleanString(value, max) {
  return String(value ?? '').trim().slice(0, max)
}

function rowId(row) {
  const id = cleanString(row?.id, 64)
  return id || null
}

function rowCreatedAt(row) {
  const value = Number(row?.created_at ?? row?.updated_at)
  return Number.isFinite(value) ? value : 0
}

function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const timeDiff = rowCreatedAt(left) - rowCreatedAt(right)
    if (timeDiff !== 0) return timeDiff
    return String(rowId(left) ?? '').localeCompare(String(rowId(right) ?? ''))
  })
}

function isEligibleSource(row, after, before) {
  const createdAt = Number(row?.created_at)
  const importance = Number(row?.importance)

  return Boolean(
    row &&
    typeof row === 'object' &&
    rowId(row) &&
    DREAM_SOURCE_LEVELS.has(row.level) &&
    row.status === 'active' &&
    Number.isFinite(importance) &&
    importance >= 2 &&
    isRawEvidenceRow(row) &&
    Number.isFinite(createdAt) &&
    createdAt > after &&
    createdAt <= before,
  )
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
  const id = rowId(row) ?? ''
  const level = cleanString(row?.level, 16)
  const sourceSession = row?.source_session ?? 'unknown'
  const createdAt = row?.created_at ?? row?.updated_at ?? ''
  const importance = row?.importance ?? ''
  const content = String(row?.content ?? '').trim()

  return [
    `[${id}]`,
    `[${level}]`,
    `[source_session=${sourceSession}]`,
    `[evidence=${isRawEvidenceRow(row) ? 'raw' : 'background-only'}]`,
    `[${createdAt}]`,
    `[${importance}]`,
    content,
  ].join('\n')
}

function formatMemorySection(label, rows) {
  const entries = rows.map(formatMemoryRow)
  return [label, entries.length > 0 ? entries.join('\n\n') : '(none)'].join('\n')
}

export function buildDreamMessages({ newMemories = [], relatedMemories = [] } = {}) {
  return [
    {
      role: 'system',
      content: DREAM_SYSTEM_PROMPT,
    },
    {
      role: 'user',
      content: [
        formatMemorySection('NEW MEMORIES', newMemories),
        formatMemorySection('RELATED OLD MEMORIES', relatedMemories),
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

export function parseDreamResponse(rawText) {
  const parsed = parseJsonObject(rawText)
  if (!parsed || !Array.isArray(parsed.memories)) return null
  if (typeof parsed.summary !== 'string') return null

  return {
    summary: cleanString(parsed.summary, 600),
    // The response schema caps this at three. The cap also protects the Pet
    // layer if a compatible Local Brain implementation ignores the schema.
    memories: parsed.memories.slice(0, DREAM_DERIVED_MAX_PER_BATCH),
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

function chunkRows(rows, size) {
  const batches = []
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size))
  }
  return batches
}

function modelFailure(code, message = code) {
  const error = new Error(message)
  error.code = code
  return error
}

export class DreamEngine {
  constructor({
    memory,
    brain,
    gate = null,
    owner = `vc-ai-pet:dream:${process.pid}:${randomUUID()}`,
    now = () => Date.now(),
    batchSize = DREAM_BATCH_SIZE,
    relatedLimit = DREAM_RELATED_LIMIT,
    maxDerivedPerBatch = DREAM_DERIVED_MAX_PER_BATCH,
  } = {}) {
    this.memory = assertDreamMemoryAdapter(memory)

    if (!brain || typeof brain.dreamCompletion !== 'function') {
      throw new TypeError('PET_DREAM_BRAIN_ADAPTER_MISSING:dreamCompletion')
    }

    if (typeof now !== 'function') throw new TypeError('PET_DREAM_CLOCK_INVALID')
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError('PET_DREAM_BATCH_SIZE_INVALID')
    if (!Number.isInteger(relatedLimit) || relatedLimit < 0) throw new TypeError('PET_DREAM_RELATED_LIMIT_INVALID')
    if (!Number.isInteger(maxDerivedPerBatch) || maxDerivedPerBatch < 1) throw new TypeError('PET_DREAM_DERIVED_LIMIT_INVALID')

    this.brain = brain
    this.gate = gate ?? new DreamGate({ memory: this.memory })
    this.owner = String(owner)
    this.now = now
    // Production Deep Dream is fixed at 24 new memories per batch. Smaller values
    // remain useful for deterministic unit tests; callers cannot enlarge it.
    this.batchSize = Math.min(batchSize, DREAM_BATCH_SIZE)
    this.relatedLimit = Math.min(relatedLimit, DREAM_RELATED_LIMIT)
    this.maxDerivedPerBatch = Math.min(maxDerivedPerBatch, DREAM_DERIVED_MAX_PER_BATCH)
    this.inFlight = false
  }

  isInFlight() {
    return this.inFlight
  }

  async run({ force = false, now = undefined } = {}) {
    // `force` belongs to the scheduler boundary. It may bypass sleep/age/count
    // policy there, but it never bypasses this engine's lease or source gates.
    void force

    if (this.inFlight) {
      return {
        status: 'skipped',
        reason: 'dream-in-flight',
        sourceCount: 0,
        batchCount: 0,
        derivedCount: 0,
        duplicateCount: 0,
        checkpoint: null,
      }
    }

    this.inFlight = true

    let previousCheckpoint = 0
    let sourceRows = []
    let attemptedBatches = 0
    let written = []
    let duplicates = []
    let leaseClaimed = false

    try {
      const window = await this.memory.dreamWindow()
      previousCheckpoint = Number.isFinite(Number(window?.last_dream_time))
        ? Number(window.last_dream_time)
        : 0

      const boundary = Number.isFinite(Number(now)) ? Number(now) : Number(this.now())
      const rawSourceRows = await this.memory.dreamSourceRows({
        after: previousCheckpoint,
        before: boundary,
      })

      if (!Array.isArray(rawSourceRows)) {
        throw modelFailure('PET_DREAM_SOURCE_ROWS_INVALID')
      }

      sourceRows = sortRows(
        rawSourceRows.filter((row) => isEligibleSource(row, previousCheckpoint, boundary)),
      )

      if (sourceRows.length === 0) {
        return {
          status: 'skipped',
          reason: 'no-new-sources',
          sourceCount: 0,
          batchCount: 0,
          derivedCount: 0,
          duplicateCount: 0,
          checkpoint: previousCheckpoint,
          checkpointBefore: previousCheckpoint,
          checkpointAfter: previousCheckpoint,
        }
      }

      const claimed = await this.memory.claimDream(this.owner, boundary)
      if (!claimed) {
        return {
          status: 'skipped',
          reason: 'dream-lease-unavailable',
          sourceCount: sourceRows.length,
          batchCount: 0,
          derivedCount: 0,
          duplicateCount: 0,
          checkpoint: previousCheckpoint,
          checkpointBefore: previousCheckpoint,
          checkpointAfter: previousCheckpoint,
        }
      }
      leaseClaimed = true

      const batches = chunkRows(sourceRows, this.batchSize)
      const allNewIds = new Set(sourceRows.map((row) => rowId(row)).filter(Boolean))
      const proposals = []
      const summaries = []
      let invalidCandidateCount = 0

      for (const batch of batches) {
        attemptedBatches++
        const batchIds = new Set(batch.map((row) => rowId(row)).filter(Boolean))
        const query = buildRelatedQuery(batch)
        const relatedRows = query.length > 0
          ? await this.memory.relatedForDream(query, {
              k: this.relatedLimit,
              // Related history must not turn another NEW row from this run
              // into an old-only citation.
              excludeIds: [...allNewIds],
            })
          : []

        if (!Array.isArray(relatedRows)) throw modelFailure('PET_DREAM_RELATED_ROWS_INVALID')

        // Keep the adapter's historical related rows as-is: active Reflection
        // rows and old Dream rows are valid context. Only this run's NEW rows
        // are excluded, so candidates still cite only supplied IDs.
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
        const rawNewSourceIds = new Set(
          batch
            .filter((row) => isRawEvidenceRow(row))
            .map((row) => rowId(row))
            .filter(Boolean),
        )
        const context = {
          newSourceIds: batchIds,
          availableSourceIds,
          rawSourceIds,
          rawNewSourceIds,
          sourceRows: [...batch, ...related],
        }
        const messages = buildDreamMessages({
          newMemories: batch,
          relatedMemories: related,
        })

        const completion = await this.brain.dreamCompletion({
          messages,
          responseFormat: DREAM_RESPONSE_FORMAT,
        })

        if (!completion || completion.ok === false || completion.unavailable === true) {
          throw modelFailure(
            completion?.reason || completion?.code || 'local-brain-unavailable',
            'Local Brain Dream completion unavailable',
          )
        }

        const parsed = parseDreamResponse(completion.rawText)
        if (!parsed) throw modelFailure('PET_DREAM_STRUCTURED_OUTPUT_INVALID')

        if (parsed.summary) summaries.push(parsed.summary)

        for (const rawCandidate of parsed.memories.slice(0, this.maxDerivedPerBatch)) {
          const candidate = createDreamCandidate(rawCandidate)
          if (!candidate || !validateDreamCandidate(candidate, context)) {
            invalidCandidateCount++
            continue
          }

          const semanticallyChecked = validateDreamCandidateSemantics(candidate, {
            sourceRows: context.sourceRows,
            protectedTerms: context.protectedTerms,
          })
          if (!semanticallyChecked.candidate) {
            invalidCandidateCount++
            continue
          }

          // Keep the candidate wrapper until the commit phase. This ensures
          // DreamGate remains the only component that writes derived memory.
          proposals.push({ rawCandidate: semanticallyChecked.candidate, context })
        }
      }

      // No derived memory is inserted until every batch above has completed.
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
          invalidCandidateCount++
        }
      }

      const summary = summaries.join(' ').trim().slice(0, 600)
      const changes = {
        kind: 'dream',
        checkpointFrom: previousCheckpoint,
        checkpointTo: boundary,
        sourceIds: sourceRows.map((row) => rowId(row)),
        derived: written,
        duplicates,
        skipped: invalidCandidateCount,
      }

      await this.memory.logDream(summary, changes, 'vc-ai-pet v0.3-B deep-dream')
      await this.memory.finishDream(boundary)
      leaseClaimed = false

      return {
        status: 'completed',
        ok: true,
        sourceCount: sourceRows.length,
        batchCount: batches.length,
        derivedCount: written.length,
        duplicateCount: duplicates.length,
        checkpoint: boundary,
        checkpointBefore: previousCheckpoint,
        checkpointAfter: boundary,
        derived: written,
        duplicates,
        skipped: invalidCandidateCount,
      }
    } catch (error) {
      if (leaseClaimed) {
        try {
          // Failure releases the lease without consuming any source boundary.
          await this.memory.finishDream(previousCheckpoint)
        } catch {
          // Preserve the original failure as the run result. The adapter's
          // failure is still observable through its own diagnostics.
        }
      }

      return {
        status: 'failed',
        ok: false,
        reason: typeof error?.code === 'string' ? error.code : 'dream-failed',
        sourceCount: sourceRows.length,
        batchCount: attemptedBatches,
        derivedCount: written.length,
        duplicateCount: duplicates.length,
        checkpoint: previousCheckpoint,
        checkpointBefore: previousCheckpoint,
        checkpointAfter: previousCheckpoint,
      }
    } finally {
      this.inFlight = false
    }
  }

  runDream(options = {}) {
    return this.run(options)
  }
}
