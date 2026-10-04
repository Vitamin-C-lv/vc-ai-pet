// A played board is a runtime event. A model's interpretation of the owner's
// style is derived from those moves; public model chatter is never raw evidence.
export function rememberGomokuReview(memory, game) {
  if (!memory?.remember || !memory?.rememberReflectionCandidate) return { status: 'unavailable' }
  const title = `五子棋棋局 ${game.id}`
  const existing = memory.db.list('fact').find(row => row.title === title)
  const result = game.draw ? '平局' : game.winner === 1 ? '主人获胜' : '花花获胜'
  const coordinates = game.history.map((move, index) => `第${index + 1}手${move.player === 1 ? '主人黑棋' : '花花白棋'}(${move.row + 1},${move.col + 1})`).join('；')
  const anchor = existing ?? memory.remember('fact',
    `主人和花花完成了一局五子棋。棋局${game.id}，共${game.history.length}手，规则确认结果：${result}。真实棋谱：${coordinates}`,
    2, { title, keywords: ['五子棋', '主人', '花花', '棋局', '出招'],
      provenance: { source: 'SYSTEM_EVENT', evidence: 'confirmed', gameId: game.id } })
  const saved = []
  const summary = game.review?.summary
  if (typeof summary === 'string' && summary.trim()) {
    const candidate = { level: 'topic', content: `五子棋复盘总结（仅基于这一局的模型理解）：${summary.trim()}`,
      importance: 2, keywords: ['五子棋', '棋局', '复盘', '总结'], sourceIds: [anchor.id],
      provenance: { source: 'REFLECTION_DERIVED', evidence: 'inferred', gameId: game.id,
        moveNumbers: game.history.map((_, index) => index + 1) } }
    candidate.provenance = { ...candidate.provenance, ...memory.derivedEvidence(candidate) }
    const prior = memory.findSameEvidenceDerivation(candidate)
    const row = prior ?? memory.rememberReflectionCandidate(candidate)
    saved.push(row.id)
  }
  for (const kind of ['style', 'lesson']) {
    const observations = (game.review?.observations ?? []).filter(item => item.kind === kind)
    if (!observations.length) continue
    const level = kind === 'style' ? 'user' : 'lesson'
    const candidate = { level, content: `五子棋复盘（仅基于这一局的理解）：${observations.map(item => item.content).join('；')}`,
      importance: 2, keywords: ['五子棋', '主人', '出招', kind === 'style' ? '风格' : '策略'], sourceIds: [anchor.id],
      provenance: { source: 'REFLECTION_DERIVED', evidence: 'inferred', gameId: game.id,
        moveNumbers: [...new Set(observations.flatMap(item => item.moveNumbers))] } }
    candidate.provenance = { ...candidate.provenance, ...memory.derivedEvidence(candidate) }
    const prior = memory.findSameEvidenceDerivation(candidate)
    const row = prior ?? memory.rememberReflectionCandidate(candidate)
    saved.push(row.id)
  }
  return { status: 'saved', anchorId: anchor.id, memoryIds: saved }
}
