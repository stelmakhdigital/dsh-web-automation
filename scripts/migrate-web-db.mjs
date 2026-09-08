#!/usr/bin/env node
/**
 * One-off migration: upgrade a v1 `web.db` (no last_accessed_at column) to
 * schema v2, mirroring the plugin's built-in v1->v2 migration. Safe to re-run
 * (idempotent): a file already at v2 is left untouched.
 *
 * Usage: node scripts/migrate-web-db.mjs [path-to-web.db]
 * Default path: $DSH_HOME/web.db (or ~/.dsh/web.db).
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const path = process.argv[2] ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'web.db')
console.log(`migrating: ${path}`)

const db = new DatabaseSync(path)
const row = db.prepare('SELECT value FROM web_meta WHERE key = ?').get('schema_version')
const current = row === undefined ? null : Number(row.value)
console.log(`stored schema_version: ${current}`)

if (current === 2) {
  console.log('already at v2 — nothing to do')
  db.close()
  process.exit(0)
}
if (current !== null && current > 2) {
  console.error(`refusing to downgrade: stored version ${current} > 2`)
  process.exit(1)
}

db.exec('PRAGMA journal_mode = WAL')
db.exec(`
ALTER TABLE web_searches ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE web_pages ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_web_searches_last_accessed_at ON web_searches (last_accessed_at ASC);
CREATE INDEX IF NOT EXISTS idx_web_pages_last_accessed_at ON web_pages (last_accessed_at ASC);
`)
db.prepare('INSERT OR REPLACE INTO web_meta (key, value) VALUES (?, ?)').run('schema_version', '2')

const searchCols = db.prepare('PRAGMA table_info(web_searches)').all().map(c => c.name)
const pageCols = db.prepare('PRAGMA table_info(web_pages)').all().map(c => c.name)
const checks = {
  'web_searches.last_accessed_at': searchCols.includes('last_accessed_at'),
  'web_pages.last_accessed_at': pageCols.includes('last_accessed_at'),
  'searches preserved': db.prepare('SELECT COUNT(*) c FROM web_searches').get().c > 0,
  'pages preserved': db.prepare('SELECT COUNT(*) c FROM web_pages').get().c > 0,
}
console.log(JSON.stringify(checks, null, 2))
if (!Object.values(checks).every(Boolean)) {
  console.error('verification failed')
  process.exit(1)
}
console.log('migration complete: v1 -> v2')
db.close()
