/**
 * Shared HTTP helpers for the search engines and enrichment: error
 * classification against a deadline signal and capped body reads.
 * @module @deepseek-ai/dsh-web-search-multi/http
 */

import { WebError } from '@deepseek-ai/dsh-web'
import { timeoutOf } from '@deepseek-ai/dsh-timeout'

/**
 * Translate a thrown fetch error into a `WebError`, classified by the
 * deadline signal: our backstop timeout wins (`WEB_SEARCH_TIMEOUT`), any
 * other abort is `WEB_ABORTED`, and a throw with the signal not aborted is a
 * network failure (`WEB_PROVIDER_ERROR`).
 * @param error - the thrown value.
 * @param signal - the deadline signal the request ran under.
 * @param context - a human-readable failure context (engine name, phase).
 * @returns the classified `WebError`.
 */
export function classifyWebError(error: unknown, signal: AbortSignal, context: string): WebError {
  const timeout = timeoutOf(signal, 'WEB_SEARCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web search timed out', 'WEB_SEARCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web search aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`${context}: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * Read a response body as UTF-8 text up to a byte cap. A declared
 * `Content-Length` over the cap rejects immediately; a stream that grows past
 * the cap is cut short.
 * @param response - the response to read.
 * @param maxBytes - the byte cap.
 * @returns the decoded text.
 */
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (Number.isFinite(length) && length > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`)
  }
  /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
  if (response.body === null) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - total
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, Math.max(0, remaining)))
        total += Math.max(0, remaining)
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
  } finally {
    /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
    await reader.cancel().catch(() => {
      /* best-effort cleanup after a completed or broken read */
    })
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/** True for a positive whole number (config sanity). */
export function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** True for a positive finite number (config sanity). */
export function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}
