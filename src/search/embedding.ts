/**
 * Embedding-based re-ranking for search results. Computes embeddings for the
 * query and each result snippet via a local embedding endpoint (e.g., a local
 * LLM server with an `/embeddings` route), then re-ranks by cosine similarity.
 *
 * The endpoint is configurable (default: off). When off, the plugin falls back
 * to BM25 (keyword-based) re-ranking. When on, the plugin calls the endpoint
 * to get embeddings and re-ranks by semantic similarity.
 * @module dsh-web-automation/search/embedding
 */

/** Embedding endpoint options. */
export interface EmbeddingOptions {
  /** The embedding endpoint base URL (e.g., `http://localhost:11434`). Empty = off. */
  endpoint: string
  /** The embedding model name (e.g., `nomic-embed-text`). */
  model: string
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /** Hard cap on one response body (bytes). */
  maxResponseBytes: number
  /** Request timeout (ms). */
  timeoutMs: number
}

/** A single embedding vector (float32). */
export type Embedding = number[]

/**
 * Compute the cosine similarity between two vectors.
 * @param a - the first vector.
 * @param b - the second vector.
 * @returns the cosine similarity in [-1, 1] (1 = identical direction).
 */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined || y === undefined) return 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  if (denom === 0) return 0
  return dot / denom
}

/**
 * Re-rank search results by embedding similarity to the query.
 * @param query - the search query.
 * @param snippets - the result snippets (one per source).
 * @param options - the embedding endpoint options.
 * @param signal - the abort signal.
 * @returns the re-ranked indices (highest similarity first).
 */
export async function embeddingRerank(
  query: string,
  snippets: readonly string[],
  options: EmbeddingOptions,
  signal: AbortSignal,
): Promise<number[]> {
  if (snippets.length === 0) return []
  if (options.endpoint.length === 0) return snippets.map((_, i) => i) // off: preserve order

  // Compute embeddings for the query + all snippets in one batch request.
  const texts = [query, ...snippets]
  const embeddings = await computeEmbeddings(texts, options, signal)
  if (embeddings.length !== texts.length) return snippets.map((_, i) => i) // fallback

  const queryEmbedding = embeddings[0]
  if (queryEmbedding === undefined) return snippets.map((_, i) => i) // fallback
  const scores = snippets.map((_, i) => {
    const snippetEmbedding = embeddings[i + 1]
    if (snippetEmbedding === undefined) return 0
    return cosineSimilarity(queryEmbedding, snippetEmbedding)
  })
  // Sort indices by score (descending).
  return scores
    .map((score, i) => ({ score, i }))
    .sort((a, b) => b.score - a.score)
    .map(({ i }) => i)
}

/**
 * Compute embeddings for a batch of texts via the endpoint.
 * @param texts - the texts to embed.
 * @param options - the embedding endpoint options.
 * @param signal - the abort signal.
 * @returns the embeddings (one per text), or an empty array on failure.
 */
async function computeEmbeddings(
  texts: readonly string[],
  options: EmbeddingOptions,
  signal: AbortSignal,
): Promise<Embedding[]> {
  const url = `${options.endpoint.replace(/\/$/, '')}/embeddings`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': options.userAgent },
      body: JSON.stringify({ model: options.model, input: texts }),
      signal: controller.signal,
    })
    if (!response.ok) return []
    const text = await response.text()
    if (text.length > options.maxResponseBytes) return []
    const parsed = JSON.parse(text) as { data?: Array<{ embedding?: number[] }> }
    const embeddings = (parsed.data ?? []).map(d => d.embedding ?? [])
    return embeddings.length === texts.length ? embeddings : []
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', onAbort)
  }
}
