import { assertLoopbackUrl } from '../core/pet-policy.js'

export class VisualEmbeddingClient {
  constructor({ baseUrl = 'http://127.0.0.1:17863', fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
    this.baseUrl = assertLoopbackUrl(baseUrl).toString().replace(/\/$/u, '')
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async describe() {
    const response = await this.fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3_000) })
    const result = await response.json()
    if (!response.ok || result.status !== 'ok' || !result.model) throw new Error('PET_VISUAL_ENCODER_UNAVAILABLE')
    return result
  }

  async embed(input) {
    const response = await this.fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }), signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) throw new Error('PET_VISUAL_ENCODER_UNAVAILABLE')
    const result = await response.json()
    if (!result.model || !Array.isArray(result.data) || result.data.length !== input.length) throw new Error('PET_VISUAL_EMBEDDING_INVALID')
    const vectors = result.data.map(({ embedding }, index) => {
      if (result.data[index].index !== index || !Array.isArray(embedding) || embedding.length !== result.dimension
        || embedding.some((value) => !Number.isFinite(value))) throw new Error('PET_VISUAL_EMBEDDING_INVALID')
      const norm = Math.hypot(...embedding)
      if (!norm) throw new Error('PET_VISUAL_EMBEDDING_INVALID')
      return embedding.map((value) => value / norm)
    })
    return { model: result.model, vectors }
  }
}
