const PUNCTUATION = /[\s\p{P}\p{S}]+/gu

export function normalizeWakeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(PUNCTUATION, '')
    .trim()
}

export function confirmWakeCandidate(candidate, transcript) {
  const normalized = normalizeWakeText(transcript)
  if (candidate === 'huahua_zaima') return normalized.startsWith('花花在吗')
  if (candidate === 'huahua') return normalized.startsWith('花花')
  return false
}

function readableTranscript(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim()
}

export function stripWakePhrase(transcript, candidate = 'huahua') {
  const normalized = readableTranscript(transcript)
  if (!normalized) return ''

  // The device emits the first-layer candidate. The PC stage is still
  // responsible for deciding whether the suffix was “在吗”; this keeps
  // “花花，在吗” equivalent to the real transcript while never forwarding
  // either wake phrase to PetRuntime.
  if (candidate === 'huahua_zaima' || normalized.startsWith('花花在吗')) {
    if (normalized.startsWith('花花在吗')) return normalized.slice('花花在吗'.length)
  }
  if (normalized.startsWith('花花')) return normalized.slice('花花'.length)
  return normalized
}

export function isClearFollowUp(transcript, confidence) {
  return stripWakePhrase(transcript).length >= 2 &&
    Number.isFinite(confidence) && confidence >= 0.6
}

export function classifyWakeTranscript(transcript, candidate = 'huahua') {
  const normalized = normalizeWakeText(transcript)
  if (!confirmWakeCandidate(candidate, transcript)) {
    return { confirmed: false, normalized, query: '', wakeKind: null }
  }
  const wakeKind = normalized.startsWith('花花在吗') ? 'huahua_zaima' : 'huahua'
  const query = stripWakePhrase(transcript, candidate)
  return {
    confirmed: true,
    normalized,
    wakeKind,
    query,
    wakeOnly: query.length === 0,
  }
}


export function evaluateWakeRecognition({
  wakeText,
  wakeConfidence,
  fullText,
  candidate = 'huahua',
  stage1Score = 1,
  stage1MinScore = 0,
  stage2MinConfidence = 0,
}) {
  const verifier = classifyWakeTranscript(wakeText, candidate)
  if (!verifier.confirmed) {
    return {
      accepted: false,
      reason: 'wake-verifier-rejected',
      wakeKind: null,
      query: '',
      wakeOnly: false,
    }
  }
  const normalizedFull = normalizeWakeText(fullText)
  const verifiedZaima = normalizeWakeText(wakeText).startsWith('花花在吗')
  const zaimaMisheard = verifiedZaima &&
    (normalizedFull === '花在吗' || normalizedFull === '花在了' || normalizedFull === '花花在忙')
  const wakeKind = normalizedFull.startsWith('花花在吗') || zaimaMisheard ? 'huahua_zaima' : 'huahua'
  if (!Number.isFinite(stage1Score) || stage1Score < stage1MinScore) {
    return {
      accepted: false,
      reason: 'stage1-score-rejected',
      wakeKind,
      query: '',
      wakeOnly: false,
    }
  }
  if (!Number.isFinite(wakeConfidence) || wakeConfidence < stage2MinConfidence) {
    return {
      accepted: false,
      reason: 'wake-confidence-rejected',
      wakeKind,
      query: '',
      wakeOnly: false,
    }
  }
  // The constrained recognizer can confirm the wake phrase while the open
  // recognizer hears a homophone. Never forward that mismatch as a query.
  if (zaimaMisheard) {
    return { accepted: true, reason: 'wake-confirmed-zaima', wakeKind, query: '', wakeOnly: true }
  }
  if (normalizedFull && !normalizedFull.startsWith('花花')) {
    if (normalizedFull === '画画') {
      return { accepted: true, reason: 'wake-confirmed-homophone', wakeKind, query: '', wakeOnly: true }
    }
    return { accepted: false, reason: 'full-transcript-mismatch', wakeKind, query: '', wakeOnly: false }
  }
  const query = stripWakePhrase(fullText, wakeKind)
  return {
    accepted: true,
    reason: 'wake-confirmed',
    wakeKind,
    query,
    wakeOnly: query.length === 0,
  }
}

export function evaluateVadWakeRecognition({ wakeText, wakeConfidence, fullText, fullConfidence }) {
  const verifier = classifyWakeTranscript(wakeText)
  const full = normalizeWakeText(fullText)
  const verifiedZaima = normalizeWakeText(wakeText).startsWith('花花在吗')
  const homophoneVariant = (full === '哈哈在吗' || full === '画画在吗') && verifiedZaima &&
    wakeConfidence >= 0.95 && fullConfidence >= 0.7
  const zaimaVariant = verifiedZaima &&
    (full === '花在吗' || full === '花在了' || full === '花花在忙' || homophoneVariant)
  if (!verifier.confirmed || !Number.isFinite(wakeConfidence) || wakeConfidence < 0.8 ||
      !Number.isFinite(fullConfidence) || fullConfidence < (zaimaVariant ? 0.5 : 0.6)) {
    return { accepted: false, reason: 'vad-verifier-rejected', wakeKind: null, query: '', wakeOnly: false }
  }
  // A grammar recognizer alone can confidently hallucinate "花花" on other
  // speech. The open recognizer must independently hear the phrase, except
  // for calibrated, exact short-phrase mishearings of "花花在吗".
  if (zaimaVariant) {
    return { accepted: true, reason: 'wake-confirmed', wakeKind: 'huahua_zaima', query: '', wakeOnly: true }
  }
  if (!full.startsWith('花花')) {
    return { accepted: false, reason: 'vad-full-transcript-mismatch', wakeKind: null, query: '', wakeOnly: false }
  }
  const wakeKind = full.startsWith('花花在吗') ? 'huahua_zaima' : 'huahua'
  const query = stripWakePhrase(fullText, wakeKind)
  return { accepted: true, reason: 'wake-confirmed', wakeKind, query, wakeOnly: !query }
}
