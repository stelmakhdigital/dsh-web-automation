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
import { WEB_STORE_MIGRATIONS, WEB_STORE_SCHEMA, WEB_STORE_SCHEMA_VERSION } from './schema.ts'

/** Store configuration. */
export interface WebStoreOptions {
  /** Path to the SQLite file, or `':memory:'` for an in-memory database. */
  path: string
  /**
   * LRU eviction caps. When set, the store evicts the least-recently-accessed
   * entries beyond these caps after each write (a no-op when within the cap).
   * Keeps the store bounded so `web.db` does not grow unbounded over time.
   */
  evictLimits?: { maxSearches?: number; maxPages?: number }
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
    this.migrate(db)
    return db
  }

  /**
   * Apply pending schema migrations. Reads the stored version; if it is older
   * than {@link WEB_STORE_SCHEMA_VERSION}, runs each migration in order and
   * records the new version. A missing version (a brand-new file) means the
   * schema DDL already created the current shape, so the version is stamped to
   * the current one and no migration runs. An existing v1 file (created before
   * the LRU column) is upgraded via the ALTER-based migrations.
   * @param db - the open database handle.
   */
  private migrate(db: DatabaseSync): void {
    const row = db.prepare('SELECT value FROM web_meta WHERE key = ?').get('schema_version') as { value: string } | undefined
    if (row === undefined) {
      // Brand-new database: the schema DDL already created the current shape.
      db.prepare('INSERT OR REPLACE INTO web_meta (key, value) VALUES (?, ?)').run(
        'schema_version',
        String(WEB_STORE_SCHEMA_VERSION),
      )
      return
    }
    const current = Number(row.value)
    if (current >= WEB_STORE_SCHEMA_VERSION) return
    for (const migration of WEB_STORE_MIGRATIONS) {
      if (migration.from < current) continue
      if (migration.from >= WEB_STORE_SCHEMA_VERSION) break
      db.exec(migration.up)
    }
    db.prepare('INSERT OR REPLACE INTO web_meta (key, value) VALUES (?, ?)').run(
      'schema_version',
      String(WEB_STORE_SCHEMA_VERSION),
    )
  }

  /** Insert or replace one search record. Returns the row id. */
  async recordSearch(entry: SearchRecordInput): Promise<number> {
    const db = await this.ensureOpen()
    const now = Date.now()
    const result = db
      .prepare(
        `INSERT INTO web_searches (cache_key, query, engines, created_at, last_accessed_at, sources, truncated, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           query = excluded.query,
           engines = excluded.engines,
           last_accessed_at = excluded.last_accessed_at,
           sources = excluded.sources,
           truncated = excluded.truncated,
           content = excluded.content`,
      )
      .run(
        entry.cacheKey,
        entry.query,
        JSON.stringify(entry.engines),
        entry.createdAt,
        now,
        JSON.stringify(entry.sources),
        entry.truncated ? 1 : 0,
        entry.content ?? null,
      )
    this.maybeEvict(db)
    return Number(result.lastInsertRowid)
  }

  /**
   * Read one search record by cache key (and mark it accessed for LRU).
   *
   * The LRU touch is a synchronous `UPDATE` on the read path — a deliberate
   * cost of LRU semantics (a cache hit must count as an access or hot entries
   * would be evicted). WAL mode keeps this cheap and non-blocking for other
   * connections; at this plugin's scale (a handful of reads per search) it is
   * not a concern.
   */
  async readSearch(cacheKey: string): Promise<StoredSearch | undefined> {
    const db = await this.ensureOpen()
    const row = db.prepare('SELECT * FROM web_searches WHERE cache_key = ?').get(cacheKey) as SearchRow | undefined
    if (row === undefined) return undefined
    db.prepare('UPDATE web_searches SET last_accessed_at = ? WHERE id = ?').run(Date.now(), row.id)
    return mapSearchRow(row)
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
    const now = Date.now()
    const result = db
      .prepare(
        `INSERT INTO web_pages (url, normalized_url, fetched_at, last_accessed_at, etag, last_modified, status_code, body_kind, body, truncated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(normalized_url) DO UPDATE SET
           url = excluded.url,
           fetched_at = excluded.fetched_at,
           last_accessed_at = excluded.last_accessed_at,
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
        now,
        entry.etag ?? null,
        entry.lastModified ?? null,
        entry.statusCode,
        entry.bodyKind,
        entry.body,
        entry.truncated ? 1 : 0,
      )
    this.maybeEvict(db)
    return Number(result.lastInsertRowid)
  }

  /** Read one page record by normalized URL (and mark it accessed for LRU). */
  async readPage(normalizedUrl: string): Promise<StoredPage | undefined> {
    const db = await this.ensureOpen()
    const row = db.prepare('SELECT * FROM web_pages WHERE normalized_url = ?').get(normalizedUrl) as PageRow | undefined
    if (row === undefined) return undefined
    db.prepare('UPDATE web_pages SET last_accessed_at = ? WHERE id = ?').run(Date.now(), row.id)
    return mapPageRow(row)
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

  /**
   * Evict the least-recently-accessed entries beyond the given caps. Keeps at
   * most `maxSearches` search records and `maxPages` page records, deleting
   * the oldest (by `last_accessed_at`, then `id`) beyond each cap. A cap of 0
   * deletes everything; an undefined cap leaves that table untouched. Returns
   * the number of rows evicted per table.
   * @param limits - the per-table entry caps.
   */
  async evict(limits: { maxSearches?: number; maxPages?: number }): Promise<{ searches: number; pages: number }> {
    const db = await this.ensureOpen()
    let searches = 0
    let pages = 0
    if (limits.maxSearches !== undefined) {
      const result = db
        .prepare(
          `DELETE FROM web_searches WHERE id NOT IN (
             SELECT id FROM web_searches ORDER BY last_accessed_at DESC, id DESC LIMIT ?
           )`,
        )
        .run(limits.maxSearches)
      searches = Number(result.changes)
    }
    if (limits.maxPages !== undefined) {
      const result = db
        .prepare(
          `DELETE FROM web_pages WHERE id NOT IN (
             SELECT id FROM web_pages ORDER BY last_accessed_at DESC, id DESC LIMIT ?
           )`,
        )
        .run(limits.maxPages)
      pages = Number(result.changes)
    }
    return { searches, pages }
  }

  /**
   * Merge eviction caps into the store's current caps. A store shared by the
   * search and fetch modules starts cap-less; each module merges its own
   * resolved cap (search → `maxSearches`, fetch → `maxPages`) after resolving
   * its config, so the shared store accumulates both.
   * @param limits - the caps to merge in (undefined fields are preserved).
   */
  setEvictLimits(limits: { maxSearches?: number; maxPages?: number }): void {
    const current = this.options.evictLimits ?? {}
    this.options.evictLimits = { ...current, ...limits }
  }

  /**
   * Evict the least-recently-accessed entries beyond the configured caps (a
   * no-op when no caps are set or the store is within the cap). Called after
   * each write to keep the store bounded.
   */
  private maybeEvict(db: DatabaseSync): void {
    const limits = this.options.evictLimits
    if (limits === undefined) return
    if (limits.maxSearches === undefined && limits.maxPages === undefined) return
    // Fire-and-forget: eviction is best-effort; a failure must not break the
    // write that triggered it.
    void this.evict(limits).catch(() => undefined)
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
