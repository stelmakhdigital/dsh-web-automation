/**
 * SQL schema for the web store. `CREATE IF NOT EXISTS` keeps opening an
 * existing file idempotent; the schema version is tracked in `web_meta` so a
 * migration can detect and upgrade older files.
 * @module dsh-web-automation/store/schema
 */

/** Current schema version; bump and add a migration when the shape changes. */
export const WEB_STORE_SCHEMA_VERSION = 2

/**
 * The full schema DDL. Applied on every open (idempotent). WAL journal mode is
 * set separately so concurrent readers (search provider, fetch provider,
 * history tools) do not block each other. `last_accessed_at` drives LRU
 * eviction (updated on every read/write; oldest entries are evicted first).
 */
export const WEB_STORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS web_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  query TEXT NOT NULL,
  engines TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL DEFAULT 0,
  sources TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  content TEXT
);
CREATE TABLE IF NOT EXISTS web_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  fetched_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  last_modified TEXT,
  status_code INTEGER NOT NULL,
  body_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_web_searches_created_at ON web_searches (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_searches_last_accessed_at ON web_searches (last_accessed_at ASC);
CREATE INDEX IF NOT EXISTS idx_web_pages_fetched_at ON web_pages (fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_pages_last_accessed_at ON web_pages (last_accessed_at ASC);
`

/**
 * Migrations from older schema versions to {@link WEB_STORE_SCHEMA_VERSION}.
 * Each entry upgrades from `from` to `from + 1`; they are applied in order on
 * open when the stored version is older than the current one.
 */
export const WEB_STORE_MIGRATIONS: Array<{ from: number; up: string }> = [
  {
    // v1 -> v2: add the LRU column to both tables (existing rows default to 0,
    // which sorts them as "never accessed" and evicts them first).
    from: 1,
    up: `
ALTER TABLE web_searches ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE web_pages ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_web_searches_last_accessed_at ON web_searches (last_accessed_at ASC);
CREATE INDEX IF NOT EXISTS idx_web_pages_last_accessed_at ON web_pages (last_accessed_at ASC);
`,
  },
]
