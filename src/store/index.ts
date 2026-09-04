/**
 * `WebStore`: a persistent SQLite store (node:sqlite) for web search
 * results, fetched pages, cache entries, and history. One file (default
 * `$DSH_HOME/web.db`) is shared by the search provider, the fetch provider,
 * and the history tools; WAL mode keeps concurrent readers from blocking.
 *
 * The store is type-agnostic: `sources` is stored as an opaque JSON array so
 * the package stays a pure utility with no dependency on the web seam.
 *
 * The database opens lazily on the first operation (the node:sqlite import is
 * deferred so Node 22 startup stays quiet, matching `session-query-sqlite`).
 *
 * @module @deepseek-ai/dsh-web-store
 */

import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { WEB_STORE_SCHEMA, WEB_STORE_SCHEMA_VERSION } from './schema.ts'

/** Store configuration. */
export interface WebStoreOptions {
  /** Path to the SQLite file, or `':memory:'` for an in-memory database. */
  path: string
}

/** One stored search record (history + search cache). */
export interface StoredSearch {
  /** Row id. */
  id: number
  /** Stable cache key computed by the caller. */
  cacheKey: string
  /** The search query as issued. */
  query: string
  /** Engine ids that produced the result (JSON array, decoded). */
  engines: string[]
  /** Epoch milliseconds when the search was recorded. */
  createdAt: number
  /** Result sources as an opaque JSON array (decoded). */
  sources: unknown[]
  /** Whether the result was truncated. */
  truncated: boolean
  /** Optional merged answer text. */
  content?: string
}

/** One stored fetched page (history + page cache). */
export interface StoredPage {
  /** Row id. */
  id: number
  /** The requested URL. */
  url: string
  /** Normalized URL (cache key). */
  normalizedUrl: string
  /** Epoch milliseconds when the page was fetched. */
  fetchedAt: number
  /** `ETag` response header, when present. */
  etag?: string
  /** `Last-Modified` response header, when present. */
  lastModified?: string
  /** HTTP status code of the fetch. */
  statusCode: number
  /** Decoded body kind. */
  bodyKind: 'html' | 'text'
  /** Decoded body content (capped by the caller). */
  body: string
  /** Whether the body was truncated. */
  truncated: boolean
}

/** Store statistics. */
export interface WebStoreStats {
  /** Number of stored search records. */
  searches: number
  /** Number of stored page records. */
  pages: number
  /** Total stored page body bytes. */
  pageBytes: number
  /** Epoch milliseconds of the newest search, when any. */
  lastSearchAt?: number
  /** Epoch milliseconds of the newest page, when any. */
  lastPageAt?: number
}

/** Fields for {@link WebStore.recordSearch}. */
export interface SearchRecordInput {
  /** Stable cache key (unique). */
  cacheKey: string
  /** The search query. */
  query: string
  /** Engine ids that produced the result. */
  engines: readonly string[]
  /** Epoch milliseconds. */
  createdAt: number
  /** Result sources (opaque; serialized as JSON). */
  sources: readonly unknown[]
  /** Whether the result was truncated. */
  truncated: boolean
  /** Optional merged answer text. */
  content?: string
}

/** Fields for {@link WebStore.recordPage}. */
export interface PageRecordInput {
  /** The requested URL. */
  url: string
  /** Normalized URL (unique). */
  normalizedUrl: string
  /** Epoch milliseconds. */
  fetchedAt: number
  /** `ETag` response header, when present. */
  etag?: string
  /** `Last-Modified` response header, when present. */
  lastModified?: string
  /** HTTP status code. */
  statusCode: number
  /** Decoded body kind. */
  bodyKind: 'html' | 'text'
  /** Decoded body content. */
  body: string
  /** Whether the body was truncated. */
  truncated: boolean
}

/** Raw `web_searches` row as returned by node:sqlite. */
interface SearchRow {
  id: number
  cache_key: string
  query: string
  engines: string
  created_at: number
  sources: string
  truncated: number
  content: string | null
}

/** Raw `web_pages` row as returned by node:sqlite. */
interface PageRow {
  id: number
  url: string
  normalized_url: string
  fetched_at: number
  etag: string | null
  last_modified: string | null
  status_code: number
  body_kind: string
  body: string
  truncated: number
}

/**
 * The persistent web store. All operations are async (lazy open); the
 * underlying node:sqlite calls are synchronous once open.
 */
export class WebStore {
  private db: DatabaseSync | undefined
  private opening: Promise<DatabaseSync> | undefined
  private closed = false

  constructor(private readonly options: WebStoreOptions) {}

  /** Open the database (idempotent) and return the handle. */
  private async ensureOpen(): Promise<DatabaseSync> {
    if (this.closed) throw new Error('web-store: store is closed')
    if (this.db !== undefined) return this.db
    if (this.opening === undefined) this.opening = this.open()
    const db = await this.opening
    this.db = db
    return db
  }

  private async open(): Promise<DatabaseSync> {
    const { DatabaseSync } = await import('node:sqlite')
    if (this.options.path !== ':memory:') {
      await mkdir(dirname(resolve(this.options.path)), { recursive: true })
    }
    const db = new DatabaseSync(this.options.path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(WEB_STORE_SCHEMA)
    db.prepare('INSERT OR IGNORE INTO web_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(WEB_STORE_SCHEMA_VERSION),
    )
    return db
  }

  /** Insert or replace one search record. Returns the row id. */
  async recordSearch(entry: SearchRecordInput): Promise<number> {
    const db = await this.ensureOpen()
    const result = db
      .prepare(
        'INSERT OR REPLACE INTO web_searches (cache_key, query, engines, created_at, sources, truncated, content) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        entry.cacheKey,
        entry.query,
        JSON.stringify(entry.engines),
        entry.createdAt,
        JSON.stringify(entry.sources),
        entry.truncated ? 1 : 0,
        entry.content ?? null,
      )
    return Number(result.lastInsertRowid)
  }

  /** Read one search record by cache key. */
  async readSearch(cacheKey: string): Promise<StoredSearch | undefined> {
    const db = await this.ensureOpen()
    const row = db.prepare('SELECT * FROM web_searches WHERE cache_key = ?').get(cacheKey) as SearchRow | undefined
    return row === undefined ? undefined : mapSearchRow(row)
  }

  /** Recent search history, newest first. */
  async recentSearches(limit: number): Promise<StoredSearch[]> {
    const db = await this.ensureOpen()
    const rows = db
      .prepare('SELECT * FROM web_searches ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as SearchRow[]
    return rows.map(mapSearchRow)
  }

  /** Delete all search records. Returns the number of rows deleted. */
  async clearSearches(): Promise<number> {
    const db = await this.ensureOpen()
    const result = db.prepare('DELETE FROM web_searches').run()
    return Number(result.changes)
  }

  /** Insert or update one page record by normalized URL. Returns the row id. */
  async recordPage(entry: PageRecordInput): Promise<number> {
    const db = await this.ensureOpen()
    const result = db
      .prepare(
        `INSERT INTO web_pages (url, normalized_url, fetched_at, etag, last_modified, status_code, body_kind, body, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(normalized_url) DO UPDATE SET
           url = excluded.url,
           fetched_at = excluded.fetched_at,
           etag = excluded.etag,
           last_modified = excluded.last_modified,
           status_code = excluded.status_code,
           body_kind = excluded.body_kind,
           body = excluded.body,
           truncated = excluded.truncated`,
      )
      .run(
        entry.url,
        entry.normalizedUrl,
        entry.fetchedAt,
        entry.etag ?? null,
        entry.lastModified ?? null,
        entry.statusCode,
        entry.bodyKind,
        entry.body,
        entry.truncated ? 1 : 0,
      )
    return Number(result.lastInsertRowid)
  }

  /** Read one page record by normalized URL. */
  async readPage(normalizedUrl: string): Promise<StoredPage | undefined> {
    const db = await this.ensureOpen()
    const row = db.prepare('SELECT * FROM web_pages WHERE normalized_url = ?').get(normalizedUrl) as PageRow | undefined
    return row === undefined ? undefined : mapPageRow(row)
  }

  /** Recent page history, newest first. */
  async recentPages(limit: number): Promise<StoredPage[]> {
    const db = await this.ensureOpen()
    const rows = db
      .prepare('SELECT * FROM web_pages ORDER BY fetched_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as PageRow[]
    return rows.map(mapPageRow)
  }

  /** Refresh a page's freshness metadata after a 304 revalidation. */
  async refreshPage(normalizedUrl: string, fetchedAt: number, etag?: string, lastModified?: string): Promise<void> {
    const db = await this.ensureOpen()
    db.prepare(
      'UPDATE web_pages SET fetched_at = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE normalized_url = ?',
    ).run(fetchedAt, etag ?? null, lastModified ?? null, normalizedUrl)
  }

  /** Delete all page records. Returns the number of rows deleted. */
  async clearPages(): Promise<number> {
    const db = await this.ensureOpen()
    const result = db.prepare('DELETE FROM web_pages').run()
    return Number(result.changes)
  }

  /** Store statistics. */
  async stats(): Promise<WebStoreStats> {
    const db = await this.ensureOpen()
    const searchesRow = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM web_searches').get() as { n: number; last: number | null }
    const pagesRow = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes, MAX(fetched_at) AS last FROM web_pages')
      .get() as { n: number; bytes: number; last: number | null }
    return {
      searches: searchesRow.n,
      pages: pagesRow.n,
      pageBytes: pagesRow.bytes,
      ...(searchesRow.last !== null ? { lastSearchAt: searchesRow.last } : {}),
      ...(pagesRow.last !== null ? { lastPageAt: pagesRow.last } : {}),
    }
  }

  /** Close the database. Subsequent operations throw. */
  async close(): Promise<void> {
    if (this.opening !== undefined) await this.opening.catch(() => undefined)
    this.db?.close()
    this.db = undefined
    this.opening = undefined
    this.closed = true
  }
}

/** Map a raw `web_searches` row to a {@link StoredSearch}. */
function mapSearchRow(row: SearchRow): StoredSearch {
  return {
    id: row.id,
    cacheKey: row.cache_key,
    query: row.query,
    engines: JSON.parse(row.engines) as string[],
    createdAt: row.created_at,
    sources: JSON.parse(row.sources) as unknown[],
    truncated: row.truncated === 1,
    ...(row.content !== null ? { content: row.content } : {}),
  }
}

/** Map a raw `web_pages` row to a {@link StoredPage}. */
function mapPageRow(row: PageRow): StoredPage {
  return {
    id: row.id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    fetchedAt: row.fetched_at,
    ...(row.etag !== null ? { etag: row.etag } : {}),
    ...(row.last_modified !== null ? { lastModified: row.last_modified } : {}),
    statusCode: row.status_code,
    bodyKind: row.body_kind === 'text' ? 'text' : 'html',
    body: row.body,
    truncated: row.truncated === 1,
  }
}
