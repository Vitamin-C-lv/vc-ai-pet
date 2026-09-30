import { candidateMatchesTopic } from './historical-recall.js'

export function captionReportedNames(caption) {
  return [...String(caption ?? '').matchAll(/(?:名字(?:是|叫|为)|名为|叫)\s*["“「]?([\p{L}\p{N}·_-]+)/gu)]
    .map((match) => match[1])
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
