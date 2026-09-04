/**
 * Pure-TypeScript BM25 ranking for local re-ranking of enriched search
 * candidates. No model, no network: token frequencies and corpus statistics
 * only. Deterministic for identical inputs.
 * @module @deepseek-ai/dsh-web-search-multi/bm25
 */

/**
 * Tokenize text into lower-cased runs of letters and digits. Unicode-aware
 * (`\p{L}\p{N}`), so Cyrillic and other scripts tokenize identically to Latin.
 * @param text - the text to tokenize.
 * @returns the tokens in order of appearance (duplicates kept).
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  return matches ?? []
}

/**
 * Score `documents` against `query` with BM25.
 *
 * Uses the non-negative idf variant `ln(1 + (N - df + 0.5) / (df + 0.5))`, so a
 * term present in every document scores zero instead of negative. Documents
 * with no query-term overlap score zero.
 *
 * @param query - the search query.
 * @param documents - the candidate documents, in engine rank order.
 * @param k1 - term-frequency saturation parameter (default 1.2).
 * @param b - length-normalization parameter (default 0.75).
 * @returns one score per document, same order as `documents`.
 */
export function bm25Rank(query: string, documents: readonly string[], k1 = 1.2, b = 0.75): number[] {
  if (documents.length === 0) return []

  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return documents.map(() => 0)

  const docTokens = documents.map(tokenize)
  const docLengths = docTokens.map(tokens => tokens.length)
  const avgLength = docLengths.reduce((sum, length) => sum + length, 0) / documents.length

  // Document frequency per distinct query term.
  const distinctTerms = [...new Set(queryTokens)]
  const df = new Map<string, number>()
  for (const term of distinctTerms) df.set(term, 0)
  for (const tokens of docTokens) {
    const present = new Set(tokens)
    for (const term of distinctTerms) {
      if (present.has(term)) df.set(term, (df.get(term) ?? 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  const n = documents.length
  for (const [term, frequency] of df) {
    idf.set(term, Math.log(1 + (n - frequency + 0.5) / (frequency + 0.5)))
  }

  return docTokens.map((tokens, index) => {
    if (tokens.length === 0) return 0
    const tf = new Map<string, number>()
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
    const length = docLengths[index] ?? 0
    let score = 0
    for (const term of distinctTerms) {
      const termFrequency = tf.get(term) ?? 0
      if (termFrequency === 0) continue
      const inverseDocumentFrequency = idf.get(term) ?? 0
      score += inverseDocumentFrequency * (termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + (b * length) / (avgLength || 1)))
    }
    return score
  })
}
