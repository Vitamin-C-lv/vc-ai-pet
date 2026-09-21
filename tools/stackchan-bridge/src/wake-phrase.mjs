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
  const classified = classifyWakeTranscript(wakeText, candidate)
  if (!classified.confirmed) {
    return {
      accepted: false,
      reason: 'wake-verifier-rejected',
      wakeKind: null,
      query: '',
      wakeOnly: false,
    }
  }
  if (!Number.isFinite(stage1Score) || stage1Score < stage1MinScore) {
    return {
      accepted: false,
      reason: 'stage1-score-rejected',
      wakeKind: classified.wakeKind,
      query: '',
      wakeOnly: false,
    }
  }
  if (!Number.isFinite(wakeConfidence) || wakeConfidence < stage2MinConfidence) {
    return {
      accepted: false,
      reason: 'wake-confidence-rejected',
      wakeKind: classified.wakeKind,
      query: '',
      wakeOnly: false,
    }
  }
  const query = stripWakePhrase(fullText, classified.wakeKind)
  return {
    accepted: true,
    reason: 'wake-confirmed',
    wakeKind: classified.wakeKind,
    query,
    wakeOnly: query.length === 0,
  }
}
