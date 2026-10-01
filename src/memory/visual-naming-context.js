import { candidateMatchesTopic } from './historical-recall.js'

export function captionReportedNames(caption) {
  return [...String(caption ?? '').matchAll(/(?:名字(?:是|叫|为)|名为|叫)\s*["“「]?([\p{L}\p{N}·_-]+)/gu)]
    .map((match) => match[1])
}

// Later owner corrections supersede an earlier label for this same picture.
// Keep the original captions intact; select the latest explicit statement only
// when deciding which name the owner assigned to its subject.
export function captionIdentityLabels(caption) {
  for (const line of String(caption ?? '').split('\n').reverse()) {
    if (/(?:是不是|是否|可能|也许|好像|如果|假如|吗|么|[？?])/u.test(line)) continue
    if (/(?:不是|不叫)/u.test(line) && !/(?:而是|就是|[，,]\s*是)/u.test(line)) continue
    const labels = [...line.matchAll(/(?:名字(?:是|叫|为)|名为|(?<!不)叫|就是|而是|[，,]\s*是)\s*(?:(?:我们|我|你们|你)家的)?\s*["“「]?([\p{L}\p{N}·_-]+)/gu)]
      .map((match) => match[1])
    if (labels.length) return labels
  }
  return []
}

export function captionMatchesNamedSubject(caption, names) {
  const labels = captionIdentityLabels(caption)
  return labels.length
    ? labels.some((label) => names.some((name) => label.startsWith(name)))
    : names.some((name) => String(caption ?? '').includes(name))
}

export function readConfirmedVisualNames(memory, query) {
  const namedFact = (item) => item?.provenance?.evidence === 'confirmed'
    && /(叫|名字)/u.test(item.content ?? '') && candidateMatchesTopic(item, query)
  const facts = (memory?.recall?.(query, 2, { bumpHits: false, filter: namedFact }) ?? [])
    .filter(namedFact).slice(0, 2).map((item) => item.content)
  const names = new Set()
  for (const fact of facts) {
    for (const label of captionReportedNames(fact)) {
      // Raw owner statements may continue with “哦你要记住”. Keep only the
      // literal name prefix also present in the current owner request.
      for (let length = label.length; length >= 2; length--) {
        const name = label.slice(0, length)
        if (query.includes(name)) { names.add(name); break }
      }
    }
  }
  return { facts, names: [...names] }
}
