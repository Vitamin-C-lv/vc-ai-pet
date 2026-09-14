import { isConfirmedProvenance, resolveMemoryProvenance, provenanceFromLegacyRow } from './memory-provenance.js'

const DERIVED = new Set(['DREAM_DERIVED', 'REFLECTION_DERIVED'])
const ids = (values) => [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))].sort()

// A runtime session label cannot override explicit assistant/derived metadata.
export function isRawEvidenceRow(row) {
  if (!row || row.source_session === 'vc-ai-pet:dream' || row.source_session === 'vc-ai-pet:reflection') return false
  if (provenanceFromLegacyRow(row).source === 'ASSISTANT_RESPONSE') return false
  const provenance = resolveMemoryProvenance(row)
  return Boolean(row.id && isConfirmedProvenance(provenance) &&
    !['assistant', 'model'].includes(String(row.role ?? '').toLowerCase()))
}

// Visual observations are model-produced interpretations. They may support a
// derived understanding, but their inferred provenance keeps them out of the
// raw-fact channel even when the underlying row was written by an assistant.
export function isObservationEvidenceRow(row) {
  if (!row || row.id === null || row.id === undefined) return false
  const provenance = resolveMemoryProvenance(row)
  return provenance.source === 'VISUAL_OBSERVATION' && provenance.evidence === 'inferred'
}

export function rawEvidenceRoots(row, { sourceRows = [], findById } = {}, seen = new Set()) {
  if (!isRawEvidenceRow(row) || seen.has(String(row.id))) return []
  const nextSeen = new Set(seen).add(String(row.id))
  const references = ids(resolveMemoryProvenance(row).sourceIds).filter((id) => id !== String(row.id))
  if (references.length === 0) return [String(row.id)]
  const roots = []
  for (const id of references) {
    const found = sourceRows.find((entry) => String(entry.id) === id) ?? findById?.(id)
    const resolved = found?.row ?? found
    const branch = rawEvidenceRoots(resolved, { sourceRows, findById }, nextSeen)
    if (!branch.length) return []
    roots.push(...branch)
  }
  return ids(roots)
}

// Confidence is an evidence budget, never the model's own certainty. Repeating
// a source or adding derived context cannot change this budget.
export function confidenceForRoots(sourceRoots) {
  return Math.min(0.8, 0.45 + 0.1 * Math.min(3, Math.max(0, ids(sourceRoots).length - 1)) +
    (ids(sourceRoots).length >= 5 ? 0.05 : 0))
}

export function evaluateDerivedEvidence(candidate, { sourceRows = [], newSourceIds = [], findById } = {}) {
  if (!Array.isArray(sourceRows)) return null
  const sourceIds = ids(candidate?.sourceIds ?? candidate?.source_ids)
  const newIds = new Set((Array.isArray(newSourceIds) || newSourceIds instanceof Set
    ? [...newSourceIds]
    : []).map(String))
  const citedRows = sourceIds.map((id) => sourceRows.find((row) => String(row.id) === id))
  if (!sourceIds.length || citedRows.some((row) => !row)) return null
  // Assistant output is not even a valid cited background source.
  if (citedRows.some((row) => resolveMemoryProvenance(row).source === 'ASSISTANT_RESPONSE')) return null
  const rawRows = citedRows.filter(isRawEvidenceRow)
  const rawRoots = ids(rawRows.flatMap((row) => rawEvidenceRoots(row, { sourceRows, findById })))
  // A visual observation is background perception, never evidence of its own.
  //
  // The observation row is already `inferred`, so `rawEvidenceRoots()` refuses to
  // treat it as a root — but that alone is not enough: if its id were appended to
  // `sourceRoots`, then `confidenceForRoots()` and `evidenceCount` would both count
  // it, and the pet's certainty about an image would rise simply because it looked
  // at the picture twice. The declaration Dream and Reflection receive states the
  // opposite ("不能作为 source_ids，不能增加 evidenceCount，不能提高 confidence"), so
  // the budget is computed from raw roots only. What an observation *does* give the
  // derivation is traceability: re-inspection rows cite their image anchor, and that
  // anchor is a genuine confirmed root, so the derivation still traces back to "the
  // owner really did show me this".
  const sourceRoots = rawRoots
  if (!rawRoots.length) return null
  const newRawOrObservation = citedRows.some((row) => {
    if (!newIds.has(String(row.id))) return false
    if (isObservationEvidenceRow(row)) return true
    return isRawEvidenceRow(row) && rawEvidenceRoots(row, { sourceRows, findById }).length > 0
  })
  if (!newRawOrObservation) return null
  const confidence = confidenceForRoots(sourceRoots)
  return {
    sourceRoots,
    confidence,
    evidenceCount: sourceRoots.length,
    ...(candidate.level === 'soul' ? { selfStatus: sourceRoots.length < 3 ? 'hypothesis' : 'evolving' } : {}),
  }
}

// Conservatively allow one interpretation per level and evidence set. This
// intentionally does not claim to solve arbitrary semantic paraphrase matching.
export function findSameEvidenceDerivation(candidate, rows = []) {
  const roots = ids(candidate?.provenance?.sourceRoots ?? candidate?.sourceRoots)
  if (!roots.length) return null
  return rows.find((row) => {
    if (row.level !== candidate.level || !DERIVED.has(resolveMemoryProvenance(row).source)) return false
    const prior = ids(row.provenance?.sourceRoots ?? row.provenance?.sourceIds)
    return prior.length === roots.length && prior.every((id, index) => id === roots[index])
  }) ?? null
}
