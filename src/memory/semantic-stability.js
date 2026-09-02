/**
 * Small, deterministic semantic guard for derived Pet memories.
 *
 * This is deliberately not a general-purpose language model. It only blocks
 * high-risk anchor drift when a derived candidate changes a protected color or
 * date, and it accepts explicit name/location/brand rules supplied by the
 * caller. Unknown semantics remain unchanged and are not guessed.
 */

export const SEMANTIC_PROTECTED_FIELDS = Object.freeze([
  'color',
  'date',
  'name',
  'location',
  'brand',
])

export const SEMANTIC_STABILITY_STATUS = Object.freeze([
  'STABLE',
  'KEEP_ORIGINAL_TERM',
  'DRIFT_DETECTED',
])

const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/gu

// Keep the source term authoritative while allowing a safe descriptive
// paraphrase. These are semantic safeguards, not a translation dictionary.
const COLOR_RULES = Object.freeze([
  {
    field: 'color',
    sourceTerms: ['群青色', 'ultramarine'],
    allowedDerivedTerms: ['群青色', 'ultramarine', '深蓝色调', '深蓝色', '蓝色调', '蓝色'],
    forbiddenDerivedTerms: ['cyan', '绿色', 'green'],
  },
])

function text(value) {
  return String(value ?? '').normalize('NFKC')
}

function contains(textValue, term) {
  return textValue.toLocaleLowerCase().includes(text(term).toLocaleLowerCase())
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function normalizeAnchor(anchor) {
  if (typeof anchor === 'string' && anchor.trim()) {
    return { field: 'custom', sourceTerms: [anchor.trim()], allowedDerivedTerms: [], forbiddenDerivedTerms: [] }
  }
  if (!anchor || typeof anchor !== 'object') return null

  const sourceTerms = unique([
    anchor.source,
    anchor.sourceTerm,
    ...(Array.isArray(anchor.sourceTerms) ? anchor.sourceTerms : []),
    anchor.term,
  ].map((value) => text(value).trim()))
  if (sourceTerms.length === 0) return null

  return {
    field: SEMANTIC_PROTECTED_FIELDS.includes(anchor.field) ? anchor.field : 'custom',
    sourceTerms,
    allowedDerivedTerms: unique([
      ...(Array.isArray(anchor.allowed) ? anchor.allowed : []),
      ...(Array.isArray(anchor.allowedDerivedTerms) ? anchor.allowedDerivedTerms : []),
    ].map((value) => text(value).trim())),
    forbiddenDerivedTerms: unique([
      ...(Array.isArray(anchor.forbidden) ? anchor.forbidden : []),
      ...(Array.isArray(anchor.forbiddenDerivedTerms) ? anchor.forbiddenDerivedTerms : []),
    ].map((value) => text(value).trim())),
  }
}

function normalizeStabilityInput(sourceOrOptions, derivedValue) {
  if (sourceOrOptions && typeof sourceOrOptions === 'object' && !Array.isArray(sourceOrOptions)) {
    return {
      sourceText: text(sourceOrOptions.sourceText ?? sourceOrOptions.source ?? sourceOrOptions.sourceContent),
      derivedText: text(sourceOrOptions.derivedText ?? sourceOrOptions.derived ?? sourceOrOptions.derivedContent ?? sourceOrOptions.content),
      protectedTerms: sourceOrOptions.protectedTerms ?? sourceOrOptions.anchors ?? [],
    }
  }

  return {
    sourceText: text(sourceOrOptions),
    derivedText: text(derivedValue),
    protectedTerms: [],
  }
}

function conflict(field, sourceTerm, derivedTerm, reason) {
  return { field, sourceTerm, derivedTerm, reason }
}

/**
 * Check one source text against a derived text. A successful descriptive
 * paraphrase is explicitly reported as KEEP_ORIGINAL_TERM so callers can
 * retain the canonical source term in provenance even when the prose uses a
 * safe description such as 深蓝色调.
 */
export function checkSemanticStability(sourceOrOptions, derivedValue = '') {
  const { sourceText, derivedText, protectedTerms } = normalizeStabilityInput(sourceOrOptions, derivedValue)
  const conflicts = []
  const preservedTerms = []

  for (const rule of COLOR_RULES) {
    const sourceTerm = rule.sourceTerms.find((term) => contains(sourceText, term))
    if (!sourceTerm) continue

    const forbidden = rule.forbiddenDerivedTerms.find((term) => contains(derivedText, term))
    if (forbidden) {
      conflicts.push(conflict(rule.field, sourceTerm, forbidden, 'protected-color-drift'))
      continue
    }

    const allowed = rule.allowedDerivedTerms.find((term) => contains(derivedText, term))
    if (allowed && !contains(derivedText, sourceTerm)) preservedTerms.push({ field: rule.field, sourceTerm, derivedTerm: allowed })
  }

  const sourceDates = unique(sourceText.match(DATE_PATTERN) ?? [])
  const derivedDates = unique(derivedText.match(DATE_PATTERN) ?? [])
  const wrongDate = derivedDates.find((date) => sourceDates.length > 0 && !sourceDates.includes(date))
  if (wrongDate) {
    conflicts.push(conflict('date', sourceDates[0], wrongDate, 'protected-date-drift'))
  }

  for (const rawAnchor of Array.isArray(protectedTerms) ? protectedTerms : [protectedTerms]) {
    const anchor = normalizeAnchor(rawAnchor)
    if (!anchor) continue
    const sourceTerm = anchor.sourceTerms.find((term) => contains(sourceText, term))
    if (!sourceTerm) continue

    const forbidden = anchor.forbiddenDerivedTerms.find((term) => contains(derivedText, term))
    if (forbidden) {
      conflicts.push(conflict(anchor.field, sourceTerm, forbidden, 'protected-anchor-drift'))
      continue
    }

    const allowed = anchor.allowedDerivedTerms.find((term) => contains(derivedText, term))
    if (allowed && !contains(derivedText, sourceTerm)) {
      preservedTerms.push({ field: anchor.field, sourceTerm, derivedTerm: allowed })
    }
  }

  const driftDetected = conflicts.length > 0
  const keepOriginalTerm = !driftDetected && preservedTerms.length > 0
  return {
    approved: !driftDetected,
    ok: !driftDetected,
    stable: !driftDetected,
    driftDetected,
    keepOriginalTerm,
    status: driftDetected ? 'DRIFT_DETECTED' : keepOriginalTerm ? 'KEEP_ORIGINAL_TERM' : 'STABLE',
    conflicts,
    preservedTerms,
    sourceText,
    derivedText,
  }
}

export const semanticStabilityCheck = checkSemanticStability
export const validateSemanticStability = checkSemanticStability

export function isSemanticallyStable(sourceOrOptions, derivedValue = '') {
  return checkSemanticStability(sourceOrOptions, derivedValue).approved
}

function candidateSourceIds(candidate) {
  return candidate?.sourceIds ?? candidate?.source_ids ?? candidate?.provenance?.sourceIds ?? []
}

/**
 * Resolve only the source rows cited by a candidate, then run the same pure
 * check. With no source row content available the check is a compatibility
 * no-op; structural/provenance validation remains the caller's responsibility.
 */
export function validateDerivedMemorySemantics(candidate, { sourceRows = [], protectedTerms = [] } = {}) {
  const sourceIds = new Set((Array.isArray(candidateSourceIds(candidate)) ? candidateSourceIds(candidate) : [])
    .map((id) => String(id)))
  const rows = (Array.isArray(sourceRows) ? sourceRows : [])
    .filter((row) => row && sourceIds.has(String(row.id)))
  const sourceText = rows.map((row) => [row.content, ...(Array.isArray(row.keywords) ? row.keywords : [])].filter(Boolean).join(' ')).join('\n')

  return checkSemanticStability({
    sourceText,
    derivedText: candidate?.content ?? '',
    protectedTerms,
  })
}
