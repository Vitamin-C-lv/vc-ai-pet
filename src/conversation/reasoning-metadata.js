const REASONING_EFFORTS = new Set(['off', 'low', 'medium', 'high'])

/**
 * Keep the small, user-facing reasoning telemetry DTO safe to persist.
 * Hidden chain-of-thought or arbitrary model fields are never copied.
 */
export function normalizeConversationReasoning(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const durationMs = Number(value.durationMs)
  if (!Number.isFinite(durationMs) || durationMs < 0) return null

  const metadata = {}
  if (REASONING_EFFORTS.has(value.effort)) metadata.effort = value.effort
  metadata.durationMs = Math.round(durationMs)
  return metadata
}
