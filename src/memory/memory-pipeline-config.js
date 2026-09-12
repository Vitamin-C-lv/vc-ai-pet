/**
 * Experience-aware Memory Pipeline — configuration resolution.
 *
 * Every knob that changes how much short-term context is kept, how long lived
 * experience is retained, and when consolidation runs is resolved here, in one
 * auditable place. The runtime only consumes resolved values, so a bad value
 * can never half-apply across several modules.
 *
 * Precedence (highest first):
 *   1. explicit environment variables  (ops can intervene without a code change)
 *   2. the DSH plugin config block     (per-deployment tuning)
 *   3. frozen defaults below           (safe behaviour with no configuration)
 *
 * Invalid values never throw: this module is on the runtime init path, and a
 * typo in a config file must degrade to the default with a reported reason
 * instead of preventing the pet from waking up.
 */

export const SHORT_TERM_CONTEXT_TURNS_DEFAULT = 48
export const SHORT_TERM_CONTEXT_TURNS_MIN = 1
export const SHORT_TERM_CONTEXT_TURNS_MAX = 200

export const CONTEXT_BUDGET_CHARS_DEFAULT = 24_000
export const CONTEXT_BUDGET_CHARS_MIN = 2_000
export const CONTEXT_BUDGET_CHARS_MAX = 400_000

export const EXPERIENCE_BUFFER_RETENTION_DAYS_DEFAULT = 14
export const EXPERIENCE_BUFFER_RETENTION_DAYS_MIN = 1
export const EXPERIENCE_BUFFER_RETENTION_DAYS_MAX = 60

export const REFLECTION_NEW_EXPERIENCE_TRIGGER_DEFAULT = 10
export const REFLECTION_TRIGGER_MIN = 1

export const DREAM_RECENT_EXPERIENCE_LIMIT_DEFAULT = 12
export const DREAM_RECENT_EXPERIENCE_LIMIT_MAX = 50

function readNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function readBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

/**
 * Resolve one integer knob with clamping. Returns the value plus how it was
 * obtained so a caller (or an audit) can explain an unexpected number.
 */
function resolveInteger({
  envValue,
  configValue,
  fallback,
  min,
  max,
  integer = true,
}) {
  const envPresent = envValue !== null && envValue !== undefined && envValue !== ''
  const configPresent = configValue !== null && configValue !== undefined && configValue !== ''
  const fromEnv = readNumber(envValue)
  const fromConfig = readNumber(configValue)
  const source = fromEnv !== null ? 'env' : fromConfig !== null ? 'config' : 'default'
  const raw = fromEnv !== null ? fromEnv : fromConfig !== null ? fromConfig : fallback
  // A present-but-unparsable value silently falls back to the default. That is
  // the right runtime behaviour but a terrible debugging experience, so the
  // fact is reported rather than swallowed.
  const invalid = fromEnv === null && envPresent
    ? 'env'
    : fromConfig === null && configPresent && fromEnv === null
      ? 'config'
      : null
  let value = integer ? Math.floor(raw) : raw
  let adjusted = null
  if (value < min) {
    value = min
    adjusted = 'clamped-min'
  } else if (value > max) {
    value = max
    adjusted = 'clamped-max'
  }
  return { value, source, adjusted, invalid, requested: raw }
}

function resolveBoolean({ envValue, configValue, fallback }) {
  const envPresent = envValue !== null && envValue !== undefined && envValue !== ''
  const configPresent = configValue !== null && configValue !== undefined && configValue !== ''
  const fromEnv = readBoolean(envValue)
  const fromConfig = readBoolean(configValue)
  const invalid = fromEnv === null && envPresent
    ? 'env'
    : fromConfig === null && configPresent && fromEnv === null
      ? 'config'
      : null
  if (fromEnv !== null) return { value: fromEnv, source: 'env', invalid: null }
  if (fromConfig !== null) return { value: fromConfig, source: 'config', invalid: null }
  return { value: fallback, source: 'default', invalid }
}

/** Append one diagnostic line per knob that was clamped or ignored. */
function pushDiagnostics(diagnostics, name, resolved) {
  if (resolved.invalid) {
    diagnostics.push(`${name}:invalid-${resolved.invalid}:fell-back-to-default`)
    return
  }
  if (resolved.adjusted) {
    diagnostics.push(`${name}:${resolved.adjusted}:requested=${resolved.requested}`)
  }
}

/**
 * Turn a retention window in days into milliseconds without ever producing a
 * zero/negative window (which would purge everything on the next tick).
 */
export function retentionDaysToMs(days, { min = 1, max = 60 } = {}) {
  const requested = readNumber(days)
  const normalized = requested === null
    ? EXPERIENCE_BUFFER_RETENTION_DAYS_DEFAULT
    : Math.min(max, Math.max(min, requested))
  return Math.round(normalized * 24 * 60 * 60 * 1000)
}

/**
 * @param {object} [options]
 * @param {object} [options.config] raw `memoryPipeline` block from the plugin config
 * @param {NodeJS.ProcessEnv} [options.env]
 */
export function resolveMemoryPipelineConfig({ config = {}, env = process.env } = {}) {
  const raw = config && typeof config === 'object' ? config : {}
  const diagnostics = []

  const turns = resolveInteger({
    envValue: env.SHORT_TERM_CONTEXT_TURNS,
    configValue: raw.shortTermContextTurns,
    fallback: SHORT_TERM_CONTEXT_TURNS_DEFAULT,
    min: SHORT_TERM_CONTEXT_TURNS_MIN,
    max: SHORT_TERM_CONTEXT_TURNS_MAX,
  })
  if (turns.adjusted || turns.invalid) pushDiagnostics(diagnostics, 'shortTermContextTurns', turns)

  const budget = resolveInteger({
    envValue: env.SHORT_TERM_CONTEXT_CHARS,
    configValue: raw.shortTermContextChars,
    fallback: CONTEXT_BUDGET_CHARS_DEFAULT,
    min: CONTEXT_BUDGET_CHARS_MIN,
    max: CONTEXT_BUDGET_CHARS_MAX,
  })
  if (budget.adjusted || budget.invalid) pushDiagnostics(diagnostics, 'shortTermContextChars', budget)

  const retentionDays = resolveInteger({
    envValue: env.EXPERIENCE_BUFFER_RETENTION_DAYS,
    configValue: raw.experienceBufferRetentionDays,
    fallback: EXPERIENCE_BUFFER_RETENTION_DAYS_DEFAULT,
    min: EXPERIENCE_BUFFER_RETENTION_DAYS_MIN,
    max: EXPERIENCE_BUFFER_RETENTION_DAYS_MAX,
    integer: false,
  })
  if (retentionDays.adjusted || retentionDays.invalid) {
    pushDiagnostics(diagnostics, 'experienceBufferRetentionDays', retentionDays)
  }

  const reflectionTrigger = resolveInteger({
    envValue: env.REFLECTION_NEW_EXPERIENCE_TRIGGER,
    configValue: raw.reflectionNewExperienceTrigger,
    fallback: REFLECTION_NEW_EXPERIENCE_TRIGGER_DEFAULT,
    min: REFLECTION_TRIGGER_MIN,
    max: 200,
  })
  if (reflectionTrigger.adjusted || reflectionTrigger.invalid) {
    pushDiagnostics(diagnostics, 'reflectionNewExperienceTrigger', reflectionTrigger)
  }

  const dreamLimit = resolveInteger({
    envValue: env.DREAM_RECENT_EXPERIENCE_LIMIT,
    configValue: raw.dreamRecentExperienceLimit,
    fallback: DREAM_RECENT_EXPERIENCE_LIMIT_DEFAULT,
    min: 0,
    max: DREAM_RECENT_EXPERIENCE_LIMIT_MAX,
  })
  if (dreamLimit.adjusted || dreamLimit.invalid) pushDiagnostics(diagnostics, 'dreamRecentExperienceLimit', dreamLimit)

  const bufferEnabled = resolveBoolean({
    envValue: env.EXPERIENCE_BUFFER_ENABLED,
    configValue: raw.experienceBufferEnabled,
    fallback: true,
  })
  if (bufferEnabled.invalid) pushDiagnostics(diagnostics, 'experienceBufferEnabled', bufferEnabled)
  const reflectionOnExperience = resolveBoolean({
    envValue: env.REFLECTION_ON_EXPERIENCE,
    configValue: raw.reflectionOnExperience,
    fallback: true,
  })
  if (reflectionOnExperience.invalid) pushDiagnostics(diagnostics, 'reflectionOnExperience', reflectionOnExperience)

  return Object.freeze({
    shortTermContextTurns: turns.value,
    shortTermContextChars: budget.value,
    experienceBufferEnabled: bufferEnabled.value,
    experienceBufferRetentionDays: retentionDays.value,
    experienceBufferRetentionMs: retentionDaysToMs(retentionDays.value, {
      min: EXPERIENCE_BUFFER_RETENTION_DAYS_MIN,
      max: EXPERIENCE_BUFFER_RETENTION_DAYS_MAX,
    }),
    reflectionOnExperience: reflectionOnExperience.value,
    reflectionNewExperienceTrigger: reflectionTrigger.value,
    dreamRecentExperienceLimit: dreamLimit.value,
    sources: Object.freeze({
      shortTermContextTurns: turns.source,
      shortTermContextChars: budget.source,
      experienceBufferRetentionDays: retentionDays.source,
      experienceBufferEnabled: bufferEnabled.source,
      reflectionOnExperience: reflectionOnExperience.source,
      reflectionNewExperienceTrigger: reflectionTrigger.source,
      dreamRecentExperienceLimit: dreamLimit.source,
    }),
    diagnostics: Object.freeze(diagnostics),
  })
}
