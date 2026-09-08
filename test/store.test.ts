import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { WebStore } from '../src/store/index.ts'
import { WEB_STORE_SCHEMA_VERSION } from '../src/store/schema.ts'

/** Create an in-memory store (no file I/O). */
function makeStore(evictLimits?: { maxSearches?: number; maxPages?: number }): WebStore {
  return new WebStore({ path: ':memory:', evictLimits })
}

describe('WebStore — search records', () => {
  it('records and reads a search', async () => {
    const store = makeStore()
    await store.recordSearch({
      cacheKey: 'k1',
      query: 'test query',
      engines: ['ddg'],
      createdAt: Date.now(),
      sources: [{ title: 'Result 1', url: 'https://example.com' }],
      truncated: false,
    })
    const read = await store.readSearch('k1')
    expect(read).toBeDefined()
    expect(read!.query).toBe('test query')
    expect(read!.engines).toEqual(['ddg'])
    expect(read!.sources).toHaveLength(1)
    await store.close()
  })

  it('returns undefined for a missing search', async () => {
    const store = makeStore()
    const read = await store.readSearch('missing')
    expect(read).toBeUndefined()
    await store.close()
  })

  it('lists recent searches (newest first)', async () => {
    const store = makeStore()
    const now = Date.now()
    await store.recordSearch({ cacheKey: 'a', query: 'a', engines: ['ddg'], createdAt: now - 2000, sources: [], truncated: false })
    await store.recordSearch({ cacheKey: 'b', query: 'b', engines: ['ddg'], createdAt: now - 1000, sources: [], truncated: false })
    await store.recordSearch({ cacheKey: 'c', query: 'c', engines: ['ddg'], createdAt: now, sources: [], truncated: false })
    const recent = await store.recentSearches(2)
    expect(recent).toHaveLength(2)
    expect(recent[0]?.query).toBe('c') // newest
    expect(recent[1]?.query).toBe('b')
    await store.close()
  })
})

describe('WebStore — page records', () => {
  it('records and reads a page', async () => {
    const store = makeStore()
    await store.recordPage({
      url: 'https://example.com',
      normalizedUrl: 'example.com',
      fetchedAt: Date.now(),
      statusCode: 200,
      bodyKind: 'text',
      body: 'hello world',
      truncated: false,
    })
    const read = await store.readPage('example.com')
    expect(read).toBeDefined()
    expect(read!.url).toBe('https://example.com')
    expect(read!.body).toBe('hello world')
    expect(read!.statusCode).toBe(200)
    await store.close()
  })

  it('upserts a page (same normalized URL)', async () => {
    const store = makeStore()
    await store.recordPage({
      url: 'https://example.com',
      normalizedUrl: 'example.com',
      fetchedAt: Date.now() - 1000,
      statusCode: 200,
      bodyKind: 'text',
      body: 'old body',
      truncated: false,
    })
    await store.recordPage({
      url: 'https://example.com',
      normalizedUrl: 'example.com',
      fetchedAt: Date.now(),
      statusCode: 200,
      bodyKind: 'text',
      body: 'new body',
      truncated: false,
    })
    const read = await store.readPage('example.com')
    expect(read!.body).toBe('new body')
    const stats = await store.stats()
    expect(stats.pages).toBe(1) // upsert, not insert
    await store.close()
  })
})

describe('WebStore — LRU eviction', () => {
  it('evicts the least-recently-accessed searches beyond the cap', async () => {
    // No evictLimits: auto-eviction is off, so evict() runs manually.
    const store = makeStore()
    const now = Date.now()
    // Record 4 searches with increasing last_accessed_at.
    for (const [i, key] of ['a', 'b', 'c', 'd'].entries()) {
      await store.recordSearch({ cacheKey: key, query: key, engines: ['ddg'], createdAt: now + i, sources: [], truncated: false })
      // Force a distinct last_accessed_at (recordSearch sets it to Date.now()).
      await new Promise(r => setTimeout(r, 10))
    }
    // Evict to keep 2 (the most recently accessed: c, d).
    const evicted = await store.evict({ maxSearches: 2 })
    expect(evicted.searches).toBe(2)
    const remaining = await store.recentSearches(10)
    expect(remaining.map(r => r.query).sort()).toEqual(['c', 'd'])
    await store.close()
  })

  it('evicts the least-recently-accessed pages beyond the cap', async () => {
    // No evictLimits: auto-eviction is off, so evict() runs manually.
    const store = makeStore()
    const now = Date.now()
    for (const [i, url] of ['a.com', 'b.com', 'c.com', 'd.com'].entries()) {
      await store.recordPage({
        url: `https://${url}`,
        normalizedUrl: url,
        fetchedAt: now + i,
        statusCode: 200,
        bodyKind: 'text',
        body: `body ${url}`,
        truncated: false,
      })
      await new Promise(r => setTimeout(r, 10))
    }
    const evicted = await store.evict({ maxPages: 2 })
    expect(evicted.pages).toBe(2)
    const remaining = await store.recentPages(10)
    expect(remaining.map(r => r.normalizedUrl).sort()).toEqual(['c.com', 'd.com'])
    await store.close()
  })

  it('evict() is a no-op when within the cap', async () => {
    const store = makeStore({ maxSearches: 10 })
    await store.recordSearch({ cacheKey: 'a', query: 'a', engines: ['ddg'], createdAt: Date.now(), sources: [], truncated: false })
    const evicted = await store.evict({ maxSearches: 10 })
    expect(evicted.searches).toBe(0)
    const stats = await store.stats()
    expect(stats.searches).toBe(1)
    await store.close()
  })

  it('evict() with cap 0 deletes everything', async () => {
    const store = makeStore()
    await store.recordSearch({ cacheKey: 'a', query: 'a', engines: ['ddg'], createdAt: Date.now(), sources: [], truncated: false })
    await store.recordPage({ url: 'https://a.com', normalizedUrl: 'a.com', fetchedAt: Date.now(), statusCode: 200, bodyKind: 'text', body: 'x', truncated: false })
    const evicted = await store.evict({ maxSearches: 0, maxPages: 0 })
    expect(evicted.searches).toBe(1)
    expect(evicted.pages).toBe(1)
    const stats = await store.stats()
    expect(stats.searches).toBe(0)
    expect(stats.pages).toBe(0)
    await store.close()
  })

  it('maybeEvict() runs after each write (auto-eviction)', async () => {
    // A store with a cap of 2 should auto-evict after the 3rd write.
    const store = makeStore({ maxSearches: 2 })
    const now = Date.now()
    for (const key of ['a', 'b', 'c']) {
      await store.recordSearch({ cacheKey: key, query: key, engines: ['ddg'], createdAt: now, sources: [], truncated: false })
      await new Promise(r => setTimeout(r, 5))
    }
    // Give the async maybeEvict() a chance to run.
    await new Promise(r => setTimeout(r, 50))
    const stats = await store.stats()
    expect(stats.searches).toBeLessThanOrEqual(2)
    await store.close()
  })
})

describe('WebStore — stats + clear', () => {
  it('reports stats', async () => {
    const store = makeStore()
    await store.recordSearch({ cacheKey: 'a', query: 'a', engines: ['ddg'], createdAt: Date.now(), sources: [], truncated: false })
    await store.recordPage({ url: 'https://a.com', normalizedUrl: 'a.com', fetchedAt: Date.now(), statusCode: 200, bodyKind: 'text', body: 'x'.repeat(100), truncated: false })
    const stats = await store.stats()
    expect(stats.searches).toBe(1)
    expect(stats.pages).toBe(1)
    expect(stats.pageBytes).toBe(100)
    await store.close()
  })

  it('clears searches and pages', async () => {
    const store = makeStore()
    await store.recordSearch({ cacheKey: 'a', query: 'a', engines: ['ddg'], createdAt: Date.now(), sources: [], truncated: false })
    await store.recordPage({ url: 'https://a.com', normalizedUrl: 'a.com', fetchedAt: Date.now(), statusCode: 200, bodyKind: 'text', body: 'x', truncated: false })
    const clearedSearches = await store.clearSearches()
    const clearedPages = await store.clearPages()
    expect(clearedSearches).toBe(1)
    expect(clearedPages).toBe(1)
    const stats = await store.stats()
    expect(stats.searches).toBe(0)
    expect(stats.pages).toBe(0)
    await store.close()
  })
})

/** The legacy v1 schema (before the LRU column and version stamping). */
const V1_SCHEMA = `
CREATE TABLE web_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE web_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key TEXT NOT NULL UNIQUE,
  query TEXT NOT NULL,
  engines TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sources TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  content TEXT
);
CREATE TABLE web_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  fetched_at INTEGER NOT NULL,
  etag TEXT,
  last_modified TEXT,
  status_code INTEGER NOT NULL,
  body_kind TEXT NOT NULL,
  body TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0
);
`

/** Create a temp directory for a file-backed store. */
function makeTempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'web-store-migration-'))
  return {
    path: join(dir, 'web.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('WebStore — schema migration', () => {
  it('migrates a stamped v1 file to the current schema, keeping data', async () => {
    const { path, cleanup } = makeTempDb()
    try {
      const legacy = new DatabaseSync(path)
      legacy.exec(V1_SCHEMA)
      legacy.prepare('INSERT INTO web_meta (key, value) VALUES (?, ?)').run('schema_version', '1')
      legacy.prepare('INSERT INTO web_searches (cache_key, query, engines, created_at, sources, truncated) VALUES (?, ?, ?, ?, ?, ?)')
        .run('k1', 'legacy query', '["ddg"]', 1234, '[]', 0)
      legacy.prepare('INSERT INTO web_pages (url, normalized_url, fetched_at, status_code, body_kind, body, truncated) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('https://legacy.com', 'legacy.com', 1234, 200, 'text', 'legacy body', 0)
      legacy.close()

      const store = new WebStore({ path })
      const search = await store.readSearch('k1')
      expect(search?.query).toBe('legacy query')
      const page = await store.readPage('legacy.com')
      expect(page?.body).toBe('legacy body')
      const stats = await store.stats()
      expect(stats.searches).toBe(1)
      expect(stats.pages).toBe(1)
      await store.close()

      const verify = new DatabaseSync(path, { readOnly: true })
      const version = verify.prepare('SELECT value FROM web_meta WHERE key = ?').get('schema_version') as { value: string }
      expect(version.value).toBe(String(WEB_STORE_SCHEMA_VERSION))
      const columns = verify.prepare('PRAGMA table_info(web_searches)').all() as Array<{ name: string }>
      expect(columns.map(column => column.name)).toContain('last_accessed_at')
      verify.close()
    } finally {
      cleanup()
    }
  })

  it('migrates a pre-versioning file (no schema_version row)', async () => {
    const { path, cleanup } = makeTempDb()
    try {
      const legacy = new DatabaseSync(path)
      legacy.exec(V1_SCHEMA)
      // No schema_version row at all (a file created before version tracking).
      legacy.close()

      const store = new WebStore({ path })
      await store.recordSearch({ cacheKey: 'k1', query: 'q', engines: ['ddg'], createdAt: Date.now(), sources: [], truncated: false })
      const stats = await store.stats()
      expect(stats.searches).toBe(1)
      await store.close()

      const verify = new DatabaseSync(path, { readOnly: true })
      const version = verify.prepare('SELECT value FROM web_meta WHERE key = ?').get('schema_version') as { value: string }
      expect(version.value).toBe(String(WEB_STORE_SCHEMA_VERSION))
      verify.close()
    } finally {
      cleanup()
    }
  })

  it('stamps a brand-new file with the current version', async () => {
    const { path, cleanup } = makeTempDb()
    try {
      const store = new WebStore({ path })
      await store.recordSearch({ cacheKey: 'k1', query: 'q', engines: ['ddg'], createdAt: Date.now(), sources: [], truncated: false })
      await store.close()

      const verify = new DatabaseSync(path, { readOnly: true })
      const version = verify.prepare('SELECT value FROM web_meta WHERE key = ?').get('schema_version') as { value: string }
      expect(version.value).toBe(String(WEB_STORE_SCHEMA_VERSION))
      verify.close()
    } finally {
      cleanup()
    }
  })
})
