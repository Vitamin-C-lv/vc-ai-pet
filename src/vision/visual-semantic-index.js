import { VisualEmbeddingClient } from './visual-embedding-client.js'
import { readConfirmedVisualNames, captionMatchesNamedSubject } from '../memory/visual-naming-context.js'

function similarity(query, vector) {
  if (!vector || query.length !== vector.length) return -1
  return query.reduce((sum, value, index) => sum + value * vector[index], 0)
}

export class VisualSemanticIndex {
  constructor({ experienceStore, conversationStore, client = new VisualEmbeddingClient(), memory = null, logger = null } = {}) {
    this.store = experienceStore
    this.conversationStore = conversationStore
    this.client = client
    this.memory = memory
    this.logger = logger
    this.inFlight = null
    this.active = false
    this.timer = null
    this.closed = false
    this.skippedSources = new Set()
  }

  start() {
    if (this.active || this.closed) return
    this.active = true
    const run = async () => {
      try { await this.sync() } catch {
        this.logger?.warn?.('vc-ai-pet: visual semantic indexing postponed; encoder unavailable')
      }
      if (!this.closed) {
        this.timer = setTimeout(run, 10_000)
        this.timer.unref?.()
      }
    }
    void run()
  }

  stop() {
    this.closed = true
    this.active = false
    clearTimeout(this.timer)
  }

  async sync({ limit = 8 } = {}) {
    if (this.closed) return { indexed: 0 }
    if (this.inFlight) return this.inFlight
    this.inFlight = this.#sync(limit)
    try { return await this.inFlight } finally { this.inFlight = null }
  }

  async #sync(limit) {
    const { model } = await this.client.describe()
    if (this.closed) return { indexed: 0, scanned: 0, model }
    const sources = await this.store.semanticIndexSources(model, { limit, excludeExperienceIds: [...this.skippedSources] })
    if (!sources.length) {
      this.skippedSources.clear()
      return { indexed: 0, scanned: 0, model }
    }
    const inputs = []
    const prepared = []
    for (const source of sources) {
      try {
        const stored = await this.conversationStore.readAttachmentDataUrl(source.attachmentId, { thumbnail: true })
        if (!stored?.dataUrl) { this.skippedSources.add(source.experienceId); continue }
        const imageIndex = inputs.length
        inputs.push({ image: stored.dataUrl })
        const textIndex = source.userText?.trim() ? inputs.length : null
        if (textIndex !== null) inputs.push({ text: source.userText })
        prepared.push({ source, imageIndex, textIndex })
      } catch {
        this.skippedSources.add(source.experienceId)
        // A missing source image is never replaced by an observation or caption.
      }
    }
    if (!inputs.length) return { indexed: 0, scanned: sources.length, skipped: sources.length, model }
    const embedded = await this.client.embed(inputs)
    if (embedded.model !== model) throw new Error('PET_VISUAL_ENCODER_MODEL_CHANGED')
    if (this.closed) return { indexed: 0, model }
    for (const { source, imageIndex, textIndex } of prepared) {
      await this.store.upsertSemanticEmbedding({
        ...source, model, imageVector: embedded.vectors[imageIndex],
        textVector: textIndex === null ? null : embedded.vectors[textIndex],
      })
    }
    return { indexed: prepared.length, scanned: sources.length, skipped: sources.length - prepared.length, model }
  }

  async search(query, { limit = 5, recallGoal = 'find_photo' } = {}) {
    const { facts, names } = readConfirmedVisualNames(this.memory, query)
    const text = `${query}${facts.length ? `。称呼说明：${facts.join('；')}` : ''}`
    const { model, vectors: [vector] } = await this.client.embed([{ text }])
    const indexedRows = await this.store.semanticEmbeddings(model)
    if (!indexedRows.length) return { status: 'index-pending', candidates: [], model }
    // A name is an owner-provided identity constraint. Apply it before top K:
    // otherwise unlabelled lookalikes crowd every known subject photo out.
    const subjectRecall = ['describe_subject', 'summarize_photos'].includes(recallGoal)
    const rows = subjectRecall && names.length
      ? indexedRows.filter((row) => captionMatchesNamedSubject(row.userText, names))
      : indexedRows
    const rank = (key) => rows.filter((row) => row[key])
      .map((row) => ({ row, similarity: similarity(vector, row[key]) }))
      .sort((a, b) => b.similarity - a.similarity)
    // Image and owner-caption cosine scores have different distributions.
    // Fuse their ranks rather than pretending the scores are interchangeable.
    const scores = new Map()
    const imageRank = rank('imageVector')
    const captionRank = rank('textVector')
    for (const ranked of [imageRank, captionRank]) {
      ranked.forEach(({ row }, index) => scores.set(row.experienceId,
        (scores.get(row.experienceId) ?? 0) + 1 / (60 + index + 1)))
    }
    const fused = rows.toSorted((a, b) => (scores.get(b.experienceId) ?? 0) - (scores.get(a.experienceId) ?? 0))
    // Generic owner captions ("看看这个") must not crowd the strongest visual
    // matches out of the pool. Preserve both routes within the same five slots.
    const selected = new Map()
    for (const { row } of imageRank.slice(0, Math.ceil(limit * 0.6))) selected.set(row.experienceId, row)
    for (const { row } of captionRank.slice(0, Math.floor(limit * 0.4))) selected.set(row.experienceId, row)
    for (const row of fused) {
      if (selected.size >= limit) break
      selected.set(row.experienceId, row)
    }
    const leading = subjectRecall
      ? [captionRank[0]?.row, imageRank[0]?.row] : [imageRank[0]?.row, captionRank[0]?.row]
    const ordered = new Map()
    for (const row of [...leading, ...fused]) {
      if (row && selected.has(row.experienceId)) ordered.set(row.experienceId, row)
    }
    const candidates = [...ordered.values()].map((row) => ({
      experienceId: row.experienceId, attachmentId: row.attachmentId,
      userText: row.userText, occurredAt: row.occurredAt,
      score: scores.get(row.experienceId) ?? 0,
    })).slice(0, limit)
    return { status: 'matched', candidates, winner: candidates[0], model, searchQuery: text }
  }
}
