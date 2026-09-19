const PUNCTUATION = /[\s\p{P}\p{S}]+/gu

export function normalizeWakeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(PUNCTUATION, '')
    .trim()
}

export function confirmWakeCandidate(candidate, transcript) {
  const normalized = normalizeWakeText(transcript)
  if (candidate === 'huahua_zaima') return normalized.includes('花花在吗')
  if (candidate === 'huahua') return normalized.includes('花花')
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
  const confirmed = confirmWakeCandidate(candidate, transcript)
  if (!confirmed) return { confirmed: false, normalized, query: '' }
  return {
    confirmed: true,
    normalized,
    query: stripWakePhrase(transcript, candidate),
    wakeOnly: stripWakePhrase(transcript, candidate).length === 0,
  }
}
