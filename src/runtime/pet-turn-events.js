import { randomUUID } from 'node:crypto'

const TYPES = new Set(['turn_started', 'thinking', 'visual_selected', 'visual_image', 'visual_observation', 'visual_compare', 'memory_recall', 'assistant_message', 'turn_completed', 'turn_failed'])
const UNSAFE_TRACE_PATTERN = /(?:chain[-_ ]?of[-_ ]?thought|hidden(?:[-_ ](?:reasoning|rationale|memory[-_ ]scoring))?|reasoning[-_ ]content|raw[-_ ](?:model[-_ ]rationale|memory[-_ ]candidate)|system[-_ ]prompt|prompt[-_ ]?builder|internal[-_ ](?:rules|soul[-_ ]prompt)|my[-_ ](?:reasoning|rationale)|first[-_ ]step|i[-_ ]will[-_ ]inspect|思维链|思维过程|隐藏推理|隐藏记忆评分|原始推理|原始记忆候选|内部规则|内部灵魂提示|系统提示|提示词|我先(?:推理|假设|分析)|我(?:觉得|认为).{0,40}(?:第一步|下一步|应该|打算|计划)|因为.{0,80}所以.{0,80}(?:打算|计划|决定|应该|下一步|要先)|我的思维过程)/iu

function text(value, max = 300) { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function clone(value) { return JSON.parse(JSON.stringify(value)) }

export function sanitizeSafeTraceText(value, max = 180) {
  const valueText = text(value, max)
  return valueText && !UNSAFE_TRACE_PATTERN.test(valueText) ? valueText : ''
}

function safeReasoning(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = {}
  if (['off', 'low', 'medium', 'high'].includes(value.effort)) result.effort = value.effort
  if (Number.isFinite(Number(value.durationMs))) result.durationMs = Math.max(0, Math.round(Number(value.durationMs)))
  return Object.keys(result).length ? result : undefined
}

function publicPayload(type, payload = {}) {
  if (type === 'turn_started') return { mode: payload.mode === 'visual' ? 'visual' : 'text' }
  if (type === 'visual_selected') return { relation: payload.relation === 'current' ? 'current' : 'previous', caption: text(payload.caption, 120) }
  if (type === 'visual_image') return { sourceAttachmentId: text(payload.sourceAttachmentId, 100), caption: text(payload.caption, 120), attachment: payload.attachment && typeof payload.attachment === 'object' ? { id: text(payload.attachment.id, 100), thumbnailUrl: text(payload.attachment.thumbnailUrl, 260), thumbnailWidth: payload.attachment.thumbnailWidth, thumbnailHeight: payload.attachment.thumbnailHeight } : null }
  if (type === 'visual_observation' || type === 'visual_compare') return { summary: sanitizeSafeTraceText(payload.summary, 180) }
  if (type === 'memory_recall') return { summary: sanitizeSafeTraceText(payload.summary, 180), provenance: payload.provenance === 'inferred' ? 'inferred' : 'confirmed' }
  if (type === 'assistant_message') return { text: sanitizeSafeTraceText(payload.text, 300) }
  if (type === 'turn_completed') return { durationMs: Number.isFinite(Number(payload.durationMs)) ? Math.max(0, Math.round(Number(payload.durationMs))) : 0, ...(safeReasoning(payload.reasoning) ? { reasoning: safeReasoning(payload.reasoning) } : {}) }
  if (type === 'turn_failed') {
    const errorStage = ['asset', 'local-brain', 'structured-output', 'protocol'].includes(payload.errorStage) ? payload.errorStage : null
    const inspectionOrdinal = Number.isInteger(payload.inspectionOrdinal) ? Math.max(0, Math.min(5, payload.inspectionOrdinal)) : null
    return {
      code: text(payload.code, 120) || 'TURN_FAILED',
      ...(text(payload.requestId, 120) ? { requestId: text(payload.requestId, 120) } : {}),
      retryable: payload.retryable === true,
      visualInspectionCount: Number.isInteger(payload.visualInspectionCount) ? Math.max(0, Math.min(5, payload.visualInspectionCount)) : 0,
      ...(errorStage ? { errorStage } : {}),
      ...(inspectionOrdinal !== null ? { inspectionOrdinal } : {}),
      ...(text(payload.currentVisualId, 16) ? { currentVisualId: text(payload.currentVisualId, 16) } : {}),
      ...(text(payload.nextVisualId, 16) ? { nextVisualId: text(payload.nextVisualId, 16) } : {}),
      ...(text(payload.attachmentId, 80) ? { attachmentId: text(payload.attachmentId, 80) } : {}),
    }
  }
  return {}
}

export function createTurnId() { return randomUUID() }

export class PetTurnEvents {
  constructor({ turnId = createTurnId(), now = () => Date.now(), onEvent = null } = {}) {
    this.turnId = turnId
    this.now = now
    this.onEvent = onEvent
    this.#events = []
    this.#terminal = false
  }

  #events
  #terminal

  get events() { return this.#events.map(clone) }
  get lastSeq() { return this.#events.length }
  get terminal() { return this.#terminal }

  emit(type, payload = {}) {
    if (!TYPES.has(type)) throw new Error('PET_TURN_EVENT_INVALID')
    if (this.#terminal) {
      if (type === 'turn_completed' || type === 'turn_failed') return clone(this.#events.at(-1))
      throw new Error('PET_TURN_EVENT_AFTER_TERMINAL')
    }
    const event = { seq: this.#events.length + 1, turnId: this.turnId, type, at: this.now(), payload: publicPayload(type, payload) }
    this.#events.push(event)
    if (type === 'turn_completed' || type === 'turn_failed') this.#terminal = true
    const publicEvent = clone(event)
    this.onEvent?.(publicEvent)
    return publicEvent
  }

  after(seq = 0) { return this.#events.filter((event) => event.seq > Number(seq || 0)).map(clone) }
}
