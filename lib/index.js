var __knownSymbol = (name2, symbol) => (symbol = Symbol[name2]) ? symbol : /* @__PURE__ */ Symbol.for("Symbol." + name2);
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __using = (stack, value, async) => {
  if (value != null) {
    if (typeof value !== "object" && typeof value !== "function") __typeError("Object expected");
    var dispose, inner;
    if (async) dispose = value[__knownSymbol("asyncDispose")];
    if (dispose === void 0) {
      dispose = value[__knownSymbol("dispose")];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") __typeError("Object not disposable");
    if (inner) dispose = function() {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    stack.push([async, dispose, value]);
  } else if (async) {
    stack.push([async]);
  }
  return value;
};
var __callDispose = (stack, error, hasError) => {
  var E = typeof SuppressedError === "function" ? SuppressedError : function(e, s, m, _) {
    return _ = Error(m), _.name = "SuppressedError", _.error = e, _.suppressed = s, _;
  };
  var fail = (e) => error = hasError ? new E(e, error, "An error was suppressed during disposal") : (hasError = true, e);
  var next = (it) => {
    while (it = stack.pop()) {
      try {
        var result = it[1] && it[1].call(it[2]);
        if (it[0]) return Promise.resolve(result).then(next, (e) => (fail(e), next()));
      } catch (e) {
        fail(e);
      }
    }
    if (hasError) throw error;
  };
  return next();
};

// src/index.ts
import { dshHomePath as dshHomePath4 } from "@deepseek-ai/dsh-home-paths";
import z5 from "@deepseek-ai/schemastery";

// src/fetch/index.ts
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { WebError as WebError3 } from "@deepseek-ai/dsh-web";

// src/store/index.ts
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// src/store/schema.ts
var WEB_STORE_SCHEMA_VERSION = 2;
var WEB_STORE_SCHEMA = `
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
`;
var WEB_STORE_MIGRATIONS = [
  {
    // v1 -> v2: add the LRU column to both tables (existing rows default to 0,
    // which sorts them as "never accessed" and evicts them first).
    from: 1,
    up: `
ALTER TABLE web_searches ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE web_pages ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_web_searches_last_accessed_at ON web_searches (last_accessed_at ASC);
CREATE INDEX IF NOT EXISTS idx_web_pages_last_accessed_at ON web_pages (last_accessed_at ASC);
`
  }
];

// src/store/index.ts
var WebStore = class {
  constructor(options) {
    this.options = options;
  }
  options;
  db;
  opening;
  closed = false;
  /** Open the database (idempotent) and return the handle. */
  async ensureOpen() {
    if (this.closed) throw new Error("web-store: store is closed");
    if (this.db !== void 0) return this.db;
    if (this.opening === void 0) this.opening = this.open();
    const db = await this.opening;
    this.db = db;
    return db;
  }
  async open() {
    const { DatabaseSync } = await import("node:sqlite");
    if (this.options.path !== ":memory:") {
      await mkdir(dirname(resolve(this.options.path)), { recursive: true });
    }
    const db = new DatabaseSync(this.options.path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(WEB_STORE_SCHEMA);
    this.migrate(db);
    return db;
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
  migrate(db) {
    const row = db.prepare("SELECT value FROM web_meta WHERE key = ?").get("schema_version");
    if (row === void 0) {
      db.prepare("INSERT OR REPLACE INTO web_meta (key, value) VALUES (?, ?)").run(
        "schema_version",
        String(WEB_STORE_SCHEMA_VERSION)
      );
      return;
    }
    const current = Number(row.value);
    if (current >= WEB_STORE_SCHEMA_VERSION) return;
    for (const migration of WEB_STORE_MIGRATIONS) {
      if (migration.from < current) continue;
      if (migration.from >= WEB_STORE_SCHEMA_VERSION) break;
      db.exec(migration.up);
    }
    db.prepare("INSERT OR REPLACE INTO web_meta (key, value) VALUES (?, ?)").run(
      "schema_version",
      String(WEB_STORE_SCHEMA_VERSION)
    );
  }
  /** Insert or replace one search record. Returns the row id. */
  async recordSearch(entry) {
    const db = await this.ensureOpen();
    const now = Date.now();
    const result = db.prepare(
      `INSERT INTO web_searches (cache_key, query, engines, created_at, last_accessed_at, sources, truncated, content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           query = excluded.query,
           engines = excluded.engines,
           last_accessed_at = excluded.last_accessed_at,
           sources = excluded.sources,
           truncated = excluded.truncated,
           content = excluded.content`
    ).run(
      entry.cacheKey,
      entry.query,
      JSON.stringify(entry.engines),
      entry.createdAt,
      now,
      JSON.stringify(entry.sources),
      entry.truncated ? 1 : 0,
      entry.content ?? null
    );
    this.maybeEvict(db);
    return Number(result.lastInsertRowid);
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
  async readSearch(cacheKey) {
    const db = await this.ensureOpen();
    const row = db.prepare("SELECT * FROM web_searches WHERE cache_key = ?").get(cacheKey);
    if (row === void 0) return void 0;
    db.prepare("UPDATE web_searches SET last_accessed_at = ? WHERE id = ?").run(Date.now(), row.id);
    return mapSearchRow(row);
  }
  /** Recent search history, newest first. */
  async recentSearches(limit) {
    const db = await this.ensureOpen();
    const rows = db.prepare("SELECT * FROM web_searches ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    return rows.map(mapSearchRow);
  }
  /** Delete all search records. Returns the number of rows deleted. */
  async clearSearches() {
    const db = await this.ensureOpen();
    const result = db.prepare("DELETE FROM web_searches").run();
    return Number(result.changes);
  }
  /** Insert or update one page record by normalized URL. Returns the row id. */
  async recordPage(entry) {
    const db = await this.ensureOpen();
    const now = Date.now();
    const result = db.prepare(
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
           truncated = excluded.truncated`
    ).run(
      entry.url,
      entry.normalizedUrl,
      entry.fetchedAt,
      now,
      entry.etag ?? null,
      entry.lastModified ?? null,
      entry.statusCode,
      entry.bodyKind,
      entry.body,
      entry.truncated ? 1 : 0
    );
    this.maybeEvict(db);
    return Number(result.lastInsertRowid);
  }
  /** Read one page record by normalized URL (and mark it accessed for LRU). */
  async readPage(normalizedUrl) {
    const db = await this.ensureOpen();
    const row = db.prepare("SELECT * FROM web_pages WHERE normalized_url = ?").get(normalizedUrl);
    if (row === void 0) return void 0;
    db.prepare("UPDATE web_pages SET last_accessed_at = ? WHERE id = ?").run(Date.now(), row.id);
    return mapPageRow(row);
  }
  /** Recent page history, newest first. */
  async recentPages(limit) {
    const db = await this.ensureOpen();
    const rows = db.prepare("SELECT * FROM web_pages ORDER BY fetched_at DESC, id DESC LIMIT ?").all(limit);
    return rows.map(mapPageRow);
  }
  /** Refresh a page's freshness metadata after a 304 revalidation. */
  async refreshPage(normalizedUrl, fetchedAt, etag, lastModified) {
    const db = await this.ensureOpen();
    db.prepare(
      "UPDATE web_pages SET fetched_at = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE normalized_url = ?"
    ).run(fetchedAt, etag ?? null, lastModified ?? null, normalizedUrl);
  }
  /** Delete all page records. Returns the number of rows deleted. */
  async clearPages() {
    const db = await this.ensureOpen();
    const result = db.prepare("DELETE FROM web_pages").run();
    return Number(result.changes);
  }
  /** Store statistics. */
  async stats() {
    const db = await this.ensureOpen();
    const searchesRow = db.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM web_searches").get();
    const pagesRow = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS bytes, MAX(fetched_at) AS last FROM web_pages").get();
    return {
      searches: searchesRow.n,
      pages: pagesRow.n,
      pageBytes: pagesRow.bytes,
      ...searchesRow.last !== null ? { lastSearchAt: searchesRow.last } : {},
      ...pagesRow.last !== null ? { lastPageAt: pagesRow.last } : {}
    };
  }
  /**
   * Evict the least-recently-accessed entries beyond the given caps. Keeps at
   * most `maxSearches` search records and `maxPages` page records, deleting
   * the oldest (by `last_accessed_at`, then `id`) beyond each cap. A cap of 0
   * deletes everything; an undefined cap leaves that table untouched. Returns
   * the number of rows evicted per table.
   * @param limits - the per-table entry caps.
   */
  async evict(limits) {
    const db = await this.ensureOpen();
    let searches = 0;
    let pages = 0;
    if (limits.maxSearches !== void 0) {
      const result = db.prepare(
        `DELETE FROM web_searches WHERE id NOT IN (
             SELECT id FROM web_searches ORDER BY last_accessed_at DESC, id DESC LIMIT ?
           )`
      ).run(limits.maxSearches);
      searches = Number(result.changes);
    }
    if (limits.maxPages !== void 0) {
      const result = db.prepare(
        `DELETE FROM web_pages WHERE id NOT IN (
             SELECT id FROM web_pages ORDER BY last_accessed_at DESC, id DESC LIMIT ?
           )`
      ).run(limits.maxPages);
      pages = Number(result.changes);
    }
    return { searches, pages };
  }
  /**
   * Merge eviction caps into the store's current caps. A store shared by the
   * search and fetch modules starts cap-less; each module merges its own
   * resolved cap (search → `maxSearches`, fetch → `maxPages`) after resolving
   * its config, so the shared store accumulates both.
   * @param limits - the caps to merge in (undefined fields are preserved).
   */
  setEvictLimits(limits) {
    const current = this.options.evictLimits ?? {};
    this.options.evictLimits = { ...current, ...limits };
  }
  /**
   * Evict the least-recently-accessed entries beyond the configured caps (a
   * no-op when no caps are set or the store is within the cap). Called after
   * each write to keep the store bounded.
   */
  maybeEvict(db) {
    const limits = this.options.evictLimits;
    if (limits === void 0) return;
    if (limits.maxSearches === void 0 && limits.maxPages === void 0) return;
    void this.evict(limits).catch(() => void 0);
  }
  /** Close the database. Subsequent operations throw. */
  async close() {
    if (this.opening !== void 0) await this.opening.catch(() => void 0);
    this.db?.close();
    this.db = void 0;
    this.opening = void 0;
    this.closed = true;
  }
};
function mapSearchRow(row) {
  return {
    id: row.id,
    cacheKey: row.cache_key,
    query: row.query,
    engines: JSON.parse(row.engines),
    createdAt: row.created_at,
    sources: JSON.parse(row.sources),
    truncated: row.truncated === 1,
    ...row.content !== null ? { content: row.content } : {}
  };
}
function mapPageRow(row) {
  return {
    id: row.id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    fetchedAt: row.fetched_at,
    ...row.etag !== null ? { etag: row.etag } : {},
    ...row.last_modified !== null ? { lastModified: row.last_modified } : {},
    statusCode: row.status_code,
    bodyKind: row.body_kind === "text" ? "text" : "html",
    body: row.body,
    truncated: row.truncated === 1
  };
}

// src/user-agent.ts
var PRODUCT_VERSION = "0.3.0";
var PRODUCT_USER_AGENT = `deepseek-harness/${PRODUCT_VERSION} dsh-web-automation (+https://github.com/stelmakhdigital/dsh-web-automation)`;
var BROWSER_LIKE_USER_AGENT = `Mozilla/5.0 (compatible; deepseek-harness/${PRODUCT_VERSION})`;

// src/fetch/provider.ts
import { WebError as WebError2 } from "@deepseek-ai/dsh-web";
import { deadline, timeoutOf } from "@deepseek-ai/dsh-timeout";

// src/fetch/policy.ts
import { WebError } from "@deepseek-ai/dsh-web";
function validateFetchUrl(input, maxUrlLength) {
  if (input.length > maxUrlLength) {
    throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, "WEB_INVALID_URL");
  }
  let url;
  try {
    url = new URL(input);
  } catch (error) {
    throw new WebError(`invalid URL: ${input}`, "WEB_INVALID_URL", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, "WEB_INVALID_URL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError("credentials in URLs are not allowed", "WEB_BLOCKED_URL");
  }
  return url;
}
function isSameOrigin(a, b) {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port;
}
function classifyContentType(contentType) {
  const mime = (contentType ?? "").replace(/;.*$/s, "").trim().toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime.startsWith("text/")) return "text";
  if (mime === "application/json" || mime === "application/xml" || mime.endsWith("+json") || mime.endsWith("+xml")) return "text";
  return void 0;
}
function parseCharset(contentType) {
  const match = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? "");
  return match?.[1]?.trim().toLowerCase();
}
function decoderForCharset(charset) {
  if (charset === void 0) return new TextDecoder("utf-8");
  try {
    return new TextDecoder(charset);
  } catch (error) {
    throw new WebError(`unsupported charset "${charset}"`, "WEB_UNSUPPORTED_CONTENT_TYPE", { cause: error });
  }
}

// src/fetch/url.ts
var TRACKING_PARAM = /^(utm_|fbclid|gclid|mc_(eid|cid)|ref|source)/i;
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// src/fetch/ssrf.ts
import { lookup } from "node:dns/promises";
var IPV4_BLOCKED = [
  // [network (uint32), prefix length]
  [0, 8],
  // 0.0.0.0/8 "this network"
  [167772160, 8],
  // 10.0.0.0/8 private
  [2130706432, 8],
  // 127.0.0.0/8 loopback
  [2886729728, 12],
  // 172.16.0.0/12 private
  [2851995648, 16],
  // 169.254.0.0/16 link-local (cloud metadata)
  [3232235520, 16],
  // 192.168.0.0/16 private
  [4227858432, 7]
  // fc00::/7 IPv6 ULA (kept here for symmetry; IPv6 handled separately)
];
function ipv4ToUint32(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return void 0;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return void 0;
    const octet = Number(part);
    if (octet > 255) return void 0;
    value = value << 8 | octet;
  }
  return value >>> 0;
}
function inCidr(value, network, prefix) {
  if (prefix === 0) return true;
  const mask = 4294967295 << 32 - prefix >>> 0;
  return (value & mask) === (network & mask);
}
function isPrivateIpv4(text) {
  const value = ipv4ToUint32(text);
  if (value === void 0) return false;
  return IPV4_BLOCKED.some(([network, prefix]) => inCidr(value, network, prefix));
}
function isPrivateIpv6(text) {
  const lower = text.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  return false;
}
function isIpLiteral(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
}
function isPublicAddress(address) {
  if (address.includes(":")) return !isPrivateIpv6(address);
  return !isPrivateIpv4(address);
}
async function checkSsrf(url, options = {}) {
  if (options.allowPrivate) return { allowed: true };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "unparseable URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { allowed: false, reason: `protocol ${parsed.protocol} is not allowed (only http/https)` };
  }
  const host = parsed.hostname;
  if (host === "") return { allowed: false, reason: "empty hostname" };
  if (isIpLiteral(host)) {
    const bare = host.replace(/^\[|\]$/g, "");
    if (!isPublicAddress(bare)) {
      return { allowed: false, reason: `host ${host} is a private/reserved address`, addresses: [bare] };
    }
    return { allowed: true, addresses: [bare] };
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { allowed: false, reason: `DNS resolution failed for ${host}` };
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: `no addresses resolved for ${host}` };
  }
  const ipStrings = addresses.map((a) => a.address);
  const blocked = ipStrings.filter((ip) => !isPublicAddress(ip));
  if (blocked.length > 0) {
    return { allowed: false, reason: `host ${host} resolves to private/reserved address(es): ${blocked.join(", ")}`, addresses: ipStrings };
  }
  return { allowed: true, addresses: ipStrings };
}
var SsrfBlockedError = class extends Error {
  /** The guard's block reason. */
  reason;
  /** The blocked URL. */
  url;
  constructor(url, reason) {
    super(`SSRF guard blocked ${url}: ${reason}`);
    this.url = url;
    this.reason = reason;
  }
};
var SSRF_MAX_REDIRECTS = 5;
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
async function fetchPublic(url, options = {}) {
  const maxRedirects = options.maxRedirects ?? SSRF_MAX_REDIRECTS;
  let currentUrl = url;
  let hops = 0;
  for (; ; ) {
    const check = await checkSsrf(currentUrl, { allowPrivate: options.allowPrivate });
    if (!check.allowed) throw new SsrfBlockedError(currentUrl, check.reason ?? "blocked by the SSRF guard");
    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      ...options.headers !== void 0 ? { headers: options.headers } : {},
      ...options.signal !== void 0 ? { signal: options.signal } : {}
    });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (hops >= maxRedirects) {
      await response.body?.cancel();
      throw new Error(`exceeded the maximum of ${maxRedirects} redirects`);
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (location === null) throw new Error(`redirect (HTTP ${response.status}) without a Location header`);
    let next;
    try {
      next = new URL(location, currentUrl);
    } catch {
      throw new Error(`invalid redirect Location "${location}"`);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`redirect to unsupported protocol ${next.protocol}`);
    }
    currentUrl = next.toString();
    hops += 1;
  }
}

// src/fetch/provider.ts
var CACHED_FETCH_PROVIDER_ID = "cached-http";
var ACCEPT_HEADER = "text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8";
var CachedHttpFetchProvider = class {
  constructor(limits) {
    this.limits = limits;
  }
  limits;
  id = CACHED_FETCH_PROVIDER_ID;
  /** No credentials to check — an anonymous public fetcher is always usable. */
  available() {
    return isPositiveFinite(this.limits.maxUrlLength) && isPositiveFinite(this.limits.maxResponseBytes) && isPositiveFinite(this.limits.maxBodyChars) && isPositiveFinite(this.limits.timeoutMs) && Number.isInteger(this.limits.maxRedirects) && this.limits.maxRedirects >= 0 && isPositiveFinite(this.limits.cacheTtlMs);
  }
  /** Fetch one URL, serving from the cache when fresh. */
  async fetch(request, signal) {
    var _stack = [];
    try {
      if (signal?.aborted) throw new WebError2("web fetch aborted", "WEB_ABORTED");
      const url = validateFetchUrl(request.url, this.limits.maxUrlLength);
      await this.assertPublic(url);
      const key = normalizeUrl(url.toString());
      const cached = await this.limits.store.readPage(key).catch(() => void 0);
      if (cached !== void 0 && Date.now() - cached.fetchedAt < this.limits.cacheTtlMs) {
        if (!this.limits.revalidate) return cloneResult(pageToResult(cached));
        return await this.revalidate(url, key, cached, signal);
      }
      const d = __using(_stack, deadline(signal, this.limits.timeoutMs, "WEB_FETCH_TIMEOUT"));
      return await this.fetchFresh(url, d.signal);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /**
   * Assert a URL is public (not a private/reserved network target). Throws a
   * `WEB_SSRF_BLOCKED` error when the guard blocks the URL. The check runs on
   * the literal host and after DNS resolution (against rebinding).
   * @param url - the URL to check.
   */
  async assertPublic(url) {
    const check = await checkSsrf(url.toString(), { allowPrivate: this.limits.allowPrivateNetworks });
    if (!check.allowed) {
      throw new WebError2(`request to ${url.host} blocked by the SSRF guard: ${check.reason}`, "WEB_SSRF_BLOCKED");
    }
  }
  /** Fetch from the network, cache a 2xx result, and return it. */
  async fetchFresh(url, signal) {
    const { result, etag, lastModified } = await this.followAndRead(url, signal);
    if (result.statusCode >= 200 && result.statusCode < 300) {
      await this.limits.store.recordPage({
        url: result.url,
        normalizedUrl: normalizeUrl(url.toString()),
        fetchedAt: Date.now(),
        ...etag !== void 0 ? { etag } : {},
        ...lastModified !== void 0 ? { lastModified } : {},
        statusCode: result.statusCode,
        bodyKind: result.body.kind,
        body: result.body.content,
        truncated: result.truncated
      }).catch(() => void 0);
    }
    return result;
  }
  /**
   * Conditional revalidation of a TTL-expired cache entry. A 304 refreshes
   * the timestamp and serves the stale body; anything else falls through to a
   * full fetch. A transport failure serves the stale body (stale-on-error)
   * rather than failing the call; caller cancellation and our own timeout
   * still fail loudly.
   */
  async revalidate(url, key, cached, signal) {
    var _stack = [];
    try {
      const d = __using(_stack, deadline(signal, this.limits.timeoutMs, "WEB_FETCH_TIMEOUT"));
      let response;
      try {
        response = await fetch(url, {
          method: "GET",
          redirect: "manual",
          headers: {
            "user-agent": this.limits.userAgent,
            "accept": ACCEPT_HEADER,
            ...cached.etag !== void 0 ? { "if-none-match": cached.etag } : {},
            ...cached.lastModified !== void 0 ? { "if-modified-since": cached.lastModified } : {}
          },
          signal: d.signal
        });
      } catch (error) {
        const translated = translateAbortOrNetwork(error, d.signal);
        if (translated.code === "WEB_ABORTED" || translated.code === "WEB_FETCH_TIMEOUT") throw translated;
        return cloneResult(pageToResult(cached));
      }
      if (response.status === 304) {
        await response.body?.cancel();
        await this.limits.store.refreshPage(key, Date.now(), cached.etag, cached.lastModified).catch(() => void 0);
        return cloneResult(pageToResult(cached));
      }
      await response.body?.cancel();
      return await this.fetchFresh(url, d.signal);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /* jscpd:ignore-start -- transport mirrors @deepseek-ai/dsh-web-fetch-http/provider; MUST evolve together */
  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  async followAndRead(initialUrl, signal) {
    let currentUrl = initialUrl;
    let redirectsFollowed = 0;
    for (; ; ) {
      const response = await this.requestOnce(currentUrl, signal);
      if (isRedirectStatus(response.status)) {
        if (redirectsFollowed >= this.limits.maxRedirects) {
          await response.body?.cancel();
          throw new WebError2(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, "WEB_REDIRECT_BLOCKED");
        }
        const location = response.headers.get("location");
        if (location === null) {
          await response.body?.cancel();
          throw new WebError2(`redirect response (HTTP ${response.status}) without a Location header`, "WEB_PROVIDER_ERROR");
        }
        const target = resolveRedirect(location, currentUrl);
        let validatedTarget;
        try {
          validatedTarget = validateFetchUrl(target.toString(), this.limits.maxUrlLength);
          if (!isSameOrigin(validatedTarget, currentUrl)) {
            throw new WebError2(
              `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
              "WEB_REDIRECT_BLOCKED"
            );
          }
        } catch (error) {
          await response.body?.cancel();
          throw error;
        }
        await response.body?.cancel();
        currentUrl = validatedTarget;
        redirectsFollowed++;
        continue;
      }
      const result = await this.readBody(response, currentUrl, signal);
      const etag = response.headers.get("etag") ?? void 0;
      const lastModified = response.headers.get("last-modified") ?? void 0;
      return { result, ...etag !== void 0 ? { etag } : {}, ...lastModified !== void 0 ? { lastModified } : {} };
    }
  }
  async requestOnce(url, signal) {
    try {
      return await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": this.limits.userAgent, "accept": ACCEPT_HEADER },
        signal
      });
    } catch (error) {
      throw translateAbortOrNetwork(error, signal);
    }
  }
  /** Read, byte-cap, classify, and decode the final response body. */
  async readBody(response, finalUrl, signal) {
    const contentType = response.headers.get("content-type");
    const kind = classifyContentType(contentType);
    if (kind === void 0) {
      await response.body?.cancel();
      throw new WebError2(`unsupported content type "${contentType ?? "unknown"}"`, "WEB_UNSUPPORTED_CONTENT_TYPE");
    }
    let decoder;
    try {
      decoder = decoderForCharset(parseCharset(contentType));
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal);
    const decoded = decoder.decode(bytes);
    const truncatedByChars = decoded.length > this.limits.maxBodyChars;
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded;
    const body = kind === "html" ? { kind: "html", content } : { kind: "text", content };
    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars
    };
  }
  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected.
   */
  async readCapped(response, signal) {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel();
        throw new WebError2(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, "WEB_FETCH_TOO_LARGE");
      }
    }
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false };
    const chunks = [];
    let total = 0;
    let truncatedByBytes = false;
    const reader = response.body.getReader();
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = this.limits.maxResponseBytes - total;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
          truncatedByBytes = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (error) {
      throw translateAbortOrNetwork(error, signal);
    } finally {
      await reader.cancel().catch(() => {
      });
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, truncatedByBytes };
  }
  /* jscpd:ignore-end */
};
function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
function resolveRedirect(location, base) {
  try {
    return new URL(location, base);
  } catch (error) {
    throw new WebError2(`invalid redirect Location "${location}"`, "WEB_PROVIDER_ERROR", { cause: error });
  }
}
function translateAbortOrNetwork(error, signal) {
  const timeout = timeoutOf(signal, "WEB_FETCH_TIMEOUT");
  if (timeout !== void 0) return new WebError2("web fetch timed out", "WEB_FETCH_TIMEOUT", { cause: timeout });
  if (signal.aborted) return new WebError2("web fetch aborted", "WEB_ABORTED", { cause: error });
  return new WebError2(`web fetch failed: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}
function isPositiveFinite(value) {
  return Number.isFinite(value) && value > 0;
}
function pageToResult(page) {
  return {
    url: page.url,
    statusCode: page.statusCode,
    body: page.bodyKind === "html" ? { kind: "html", content: page.body } : { kind: "text", content: page.body },
    truncated: page.truncated
  };
}
function cloneResult(result) {
  return { url: result.url, statusCode: result.statusCode, body: { ...result.body }, truncated: result.truncated };
}

// src/fetch/index.ts
var DEFAULT_USER_AGENT = PRODUCT_USER_AGENT;
var Config = z.object({
  maxUrlLength: z.number().default(2048),
  maxResponseBytes: z.number().default(5e6),
  maxBodyChars: z.number().default(1e5),
  timeoutMs: z.number().default(3e4),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  cacheTtlMs: z.number().default(216e5),
  revalidate: z.boolean().default(true),
  cacheMaxPages: z.number().default(500),
  allowPrivateNetworks: z.boolean().default(false)
});
var MAX_NODE_TIMER_DELAY_MS = 2147483647;
function assertPositiveFinite(name2, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-cached: ${name2} must be a positive finite number`);
  }
}
function assertTimeoutMs(value) {
  assertPositiveFinite("timeoutMs", value);
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-cached: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`);
  }
}
function assertNonNegativeInteger(name2, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-cached: ${name2} must be a non-negative integer`);
  }
}
function apply(ctx, config, options = {}) {
  const resolved = config;
  assertPositiveFinite("maxUrlLength", resolved.maxUrlLength);
  assertPositiveFinite("maxResponseBytes", resolved.maxResponseBytes);
  assertPositiveFinite("maxBodyChars", resolved.maxBodyChars);
  assertTimeoutMs(resolved.timeoutMs);
  assertNonNegativeInteger("maxRedirects", resolved.maxRedirects);
  assertPositiveFinite("cacheTtlMs", resolved.cacheTtlMs);
  assertNonNegativeInteger("cacheMaxPages", resolved.cacheMaxPages);
  let store;
  if (options.store !== void 0) {
    options.store.setEvictLimits({ maxPages: resolved.cacheMaxPages });
    store = options.store;
  } else {
    const owned = new WebStore({
      path: config.storePath ?? dshHomePath("web.db"),
      evictLimits: { maxPages: resolved.cacheMaxPages }
    });
    ctx.effect(function* () {
      yield () => {
        void owned.close();
      };
    }, "web-fetch-cached.store.close()");
    store = owned;
  }
  const limits = {
    maxUrlLength: resolved.maxUrlLength,
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
    cacheTtlMs: resolved.cacheTtlMs,
    store,
    revalidate: resolved.revalidate,
    allowPrivateNetworks: resolved.allowPrivateNetworks
  };
  try {
    ctx.web.registerFetchProvider(new CachedHttpFetchProvider(limits));
  } catch (error) {
    if (error instanceof WebError3 && error.code === "WEB_DUPLICATE_PROVIDER") {
      throw new WebError3(
        'the "cached-http" fetch provider is already registered: the dsh-web-automation plugin and DSH built-in web packages (e.g. the local-web overlay) are mutually exclusive \u2014 keep one',
        "WEB_DUPLICATE_PROVIDER",
        { cause: error }
      );
    }
    throw error;
  }
}

// src/history/index.ts
import { dshHomePath as dshHomePath2 } from "@deepseek-ai/dsh-home-paths";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z2 from "@deepseek-ai/schemastery";
var WEB_HISTORY_MAX_LIMIT = 100;
var Config2 = z2.object({
  history: z2.boolean().default(true),
  cacheClear: z2.boolean().default(true),
  stats: z2.boolean().default(true)
});
function searchLine(entry) {
  const when = new Date(entry.createdAt).toISOString();
  const engines = entry.engines.join("+");
  return `- [${when}] search "${entry.query}" (${engines}) \u2014 ${entry.sources.length} source(s)`;
}
function fetchLine(entry) {
  const when = new Date(entry.fetchedAt).toISOString();
  return `- [${when}] fetch ${entry.url} \u2014 HTTP ${entry.statusCode}, ${entry.body.length} char(s)`;
}
function formatHistoryOutput(args, searches, pages) {
  const sections = [];
  if (args.kind === "search" || args.kind === "all") {
    sections.push(args.kind === "all" ? "Recent searches:" : "");
    sections.push(searches.length > 0 ? searches.map(searchLine).join("\n") : "No search history.");
  }
  if (args.kind === "fetch" || args.kind === "all") {
    sections.push(args.kind === "all" ? "Recent fetches:" : "");
    sections.push(pages.length > 0 ? pages.map(fetchLine).join("\n") : "No fetch history.");
  }
  return sections.filter((section) => section.length > 0).join("\n");
}
function formatStatsOutput(stats) {
  const lines = [
    `Searches stored: ${stats.searches}`,
    `Pages stored: ${stats.pages}`,
    `Page body bytes: ${stats.pageBytes}`
  ];
  if (stats.lastSearchAt !== void 0) lines.push(`Last search: ${new Date(stats.lastSearchAt).toISOString()}`);
  if (stats.lastPageAt !== void 0) lines.push(`Last fetch: ${new Date(stats.lastPageAt).toISOString()}`);
  return lines.join("\n");
}
function apply2(ctx, config, options = {}) {
  const resolved = config;
  let store;
  if (options.store !== void 0) {
    store = options.store;
  } else {
    const owned = new WebStore({ path: config.storePath ?? dshHomePath2("web.db") });
    ctx.effect(function* () {
      yield () => {
        void owned.close();
      };
    }, "tool-web-history.store.close()");
    store = owned;
  }
  ctx.systemPrompt.section({
    name: "tool:web_history",
    order: 115,
    text: "Use web_history to review recent web searches and fetches, web_search_stats for web storage statistics, and web_cache_clear to clear the web search/page cache. These tools read the shared local web store; they make no network requests."
  });
  if (resolved.history) {
    ctx.tools.register(defineTool({
      name: "web_history",
      description: "Show recent web search and fetch history from the local web store. No network requests.",
      parameters: {
        kind: { type: "string", enum: ["search", "fetch", "all"], description: 'History kind. Defaults to "all".' },
        query: { type: "string", description: "Optional substring filter on the query or URL." },
        limit: { type: "number", description: `Maximum entries to return (1\u2013${WEB_HISTORY_MAX_LIMIT}). Defaults to 20.` }
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const kind = args.kind ?? "all";
        const query = typeof args.query === "string" ? args.query.toLowerCase() : void 0;
        const limit = Math.min(Math.max(Math.trunc(Number(args.limit) || 20), 1), WEB_HISTORY_MAX_LIMIT);
        const searches = kind === "fetch" ? [] : await store.recentSearches(limit);
        const pages = kind === "search" ? [] : await store.recentPages(limit);
        const filteredSearches = query === void 0 ? searches : searches.filter((entry) => entry.query.toLowerCase().includes(query));
        const filteredPages = query === void 0 ? pages : pages.filter((entry) => entry.url.toLowerCase().includes(query));
        return { text: formatHistoryOutput({ kind }, filteredSearches, filteredPages) };
      }
    }));
  }
  if (resolved.stats) {
    ctx.tools.register(defineTool({
      name: "web_search_stats",
      description: "Show web store statistics (stored searches, pages, bytes). No network requests.",
      parameters: {},
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: value.text }]
      },
      isConcurrencySafe: () => true,
      async execute() {
        const stats = await store.stats();
        return { text: formatStatsOutput(stats) };
      }
    }));
  }
  if (resolved.cacheClear) {
    ctx.tools.register(defineTool({
      name: "web_cache_clear",
      description: "Clear the local web search and/or page cache. No network requests.",
      parameters: {
        scope: { type: "string", enum: ["search", "pages", "all"], description: 'What to clear. Defaults to "all".' }
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: value.text }]
      },
      async execute(args) {
        const scope = args.scope ?? "all";
        const cleared = [];
        if (scope === "search" || scope === "all") cleared.push(`searches: ${await store.clearSearches()}`);
        if (scope === "pages" || scope === "all") cleared.push(`pages: ${await store.clearPages()}`);
        return { text: `Cleared web cache \u2014 ${cleared.join(", ")}` };
      }
    }));
  }
}

// src/platforms/index.ts
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { defineTool as defineTool2 } from "@deepseek-ai/dsh-tools";
import z3 from "@deepseek-ai/schemastery";

// src/platforms/builtins.ts
var GITHUB = {
  id: "github",
  name: "GitHub",
  format: "json",
  searchUrl: "https://api.github.com/search/repositories?q={query}&per_page={limit}",
  headers: {
    Accept: "application/vnd.github+json",
    "User-Agent": PRODUCT_USER_AGENT
  },
  fields: {
    items: "items",
    url: "html_url",
    title: "full_name",
    snippet: "description",
    publishedAt: "updated_at"
  },
  notes: "Repository search via the GitHub REST API. Unauthenticated requests are rate-limited (10/min)."
};
var REDDIT = {
  id: "reddit",
  name: "Reddit",
  format: "json",
  searchUrl: "https://www.reddit.com/search.json?q={query}&limit={limit}&sort=relevance",
  headers: {
    "User-Agent": PRODUCT_USER_AGENT
  },
  fields: {
    items: "data.children",
    url: "data.url",
    title: "data.title",
    snippet: "data.selftext"
  },
  notes: "Reddit search via the public .json endpoint. Unauthenticated requests are rate-limited."
};
var YOUTUBE = {
  id: "youtube",
  name: "YouTube",
  format: "json-in-html",
  searchUrl: "https://www.youtube.com/results?search_query={query}&hl=en",
  headers: {
    "User-Agent": BROWSER_LIKE_USER_AGENT
  },
  jsonInHtml: {
    marker: "ytInitialData = ",
    fields: {
      items: "contents.twoColumnSearchResults.results",
      url: "videoRenderer.navigationEndpoint.watchEndpoint.videoId",
      urlPrefix: "https://www.youtube.com/watch?v=",
      title: "videoRenderer.title.runs.0.text",
      snippet: "videoRenderer.detailedMetadataSnippets.0.snippet.runs.0.text"
    }
  },
  notes: "Best-effort: parses the embedded ytInitialData blob; may return few results if YouTube changes its page."
};
var BILIBILI = {
  id: "bilibili",
  name: "Bilibili",
  format: "json",
  searchUrl: "https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={query}",
  headers: {
    "User-Agent": BROWSER_LIKE_USER_AGENT,
    Referer: "https://www.bilibili.com"
  },
  fields: {
    items: "data.result",
    url: "bvid",
    urlPrefix: "https://www.bilibili.com/video/",
    title: "title",
    snippet: "description"
  },
  notes: "Best-effort: the search API may require a buvid3 cookie (set headers.Cookie in config)."
};
var V2EX = {
  id: "v2ex",
  name: "V2EX",
  format: "html",
  searchUrl: "https://www.v2ex.com/?q={query}",
  headers: {
    "User-Agent": BROWSER_LIKE_USER_AGENT
  },
  selectors: {
    item: "div.cell.item",
    url: "a",
    title: "a"
  },
  notes: "Best-effort: parses the server-rendered search page; markup may change."
};
var RSS = {
  id: "rss",
  name: "RSS / Atom feed",
  format: "rss",
  notes: "Pass a feed URL as the query; the feed entries are returned (title, link, description, date)."
};
var BUILTIN_PLATFORMS = [GITHUB, REDDIT, YOUTUBE, BILIBILI, V2EX, RSS];

// src/platforms/registry.ts
import { statSync, readFileSync } from "node:fs";

// src/platforms/template.ts
function expandTemplate(template, values) {
  let out = template;
  out = out.replaceAll("{query}", encodeURIComponent(values.query));
  if (values.limit !== void 0) out = out.replaceAll("{limit}", String(values.limit));
  if (values.page !== void 0) out = out.replaceAll("{page}", String(values.page));
  return out;
}
function isPlausibleSearchUrl(template) {
  const probe = expandTemplate(template, { query: "probe" });
  return URL.canParse(probe) && /^https?:/i.test(probe);
}

// src/platforms/types.ts
var RULE_PACK_VERSION = 1;
var PLATFORM_SEARCH_MAX_LIMIT = 100;

// src/platforms/rulepacks.ts
var PLATFORM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
var FORMATS = /* @__PURE__ */ new Set(["html", "json", "rss", "json-in-html"]);
function requireString(value, field, context) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`rulepack: ${context}: ${field} must be a non-empty string`);
  }
  return value;
}
function optionalString(value, field, context) {
  if (value === void 0) return void 0;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`rulepack: ${context}: ${field} must be a string when present`);
  }
  return value;
}
function optionalPositiveInt(value, field, context) {
  if (value === void 0) return void 0;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`rulepack: ${context}: ${field} must be a positive integer when present`);
  }
  return value;
}
function validateHeaders(value, context) {
  if (value === void 0) return void 0;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`rulepack: ${context}: headers must be an object when present`);
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`rulepack: ${context}: headers.${key} must be a string`);
    out[key] = entry;
  }
  return out;
}
function validateSelectors(value, context) {
  if (value === null || typeof value !== "object") {
    throw new Error(`rulepack: ${context}: selectors must be an object for html platforms`);
  }
  const item = requireString(value.item, "selectors.item", context);
  const url = optionalString(value.url, "selectors.url", context);
  const title = optionalString(value.title, "selectors.title", context);
  const snippet = optionalString(value.snippet, "selectors.snippet", context);
  return {
    item,
    ...url !== void 0 ? { url } : {},
    ...title !== void 0 ? { title } : {},
    ...snippet !== void 0 ? { snippet } : {}
  };
}
function validateFields(value, context) {
  if (value === null || typeof value !== "object") {
    throw new Error(`rulepack: ${context}: fields must be an object for json platforms`);
  }
  const items = requireString(value.items, "fields.items", context);
  const url = requireString(value.url, "fields.url", context);
  const urlPrefix = optionalString(value.urlPrefix, "fields.urlPrefix", context);
  const title = optionalString(value.title, "fields.title", context);
  const snippet = optionalString(value.snippet, "fields.snippet", context);
  const publishedAt = optionalString(value.publishedAt, "fields.publishedAt", context);
  return {
    items,
    url,
    ...urlPrefix !== void 0 ? { urlPrefix } : {},
    ...title !== void 0 ? { title } : {},
    ...snippet !== void 0 ? { snippet } : {},
    ...publishedAt !== void 0 ? { publishedAt } : {}
  };
}
function validateJsonInHtml(value, context) {
  if (value === null || typeof value !== "object") {
    throw new Error(`rulepack: ${context}: jsonInHtml must be an object for json-in-html platforms`);
  }
  const marker = requireString(value.marker, "jsonInHtml.marker", context);
  const fields = validateFields(value.fields, context);
  return { marker, fields };
}
function validatePlatform(raw, context) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`rulepack: ${context}: platform must be an object`);
  }
  const obj = raw;
  const id = requireString(obj.id, "id", context);
  if (!PLATFORM_ID_PATTERN.test(id)) throw new Error(`rulepack: ${context}: id "${id}" is not a valid platform id`);
  const name2 = requireString(obj.name, "name", context);
  const formatRaw = requireString(obj.format, "format", context);
  if (!FORMATS.has(formatRaw)) throw new Error(`rulepack: ${context}: format "${formatRaw}" is not one of html|json|rss|json-in-html`);
  const format = formatRaw;
  const platform = { id, name: name2, format };
  const searchUrl = optionalString(obj.searchUrl, "searchUrl", context);
  if (searchUrl !== void 0) platform.searchUrl = searchUrl;
  const headers = validateHeaders(obj.headers, context);
  if (headers !== void 0) platform.headers = headers;
  const maxResults = optionalPositiveInt(obj.maxResults, "maxResults", context);
  if (maxResults !== void 0) platform.maxResults = maxResults;
  const notes = optionalString(obj.notes, "notes", context);
  if (notes !== void 0) platform.notes = notes;
  switch (format) {
    case "html": {
      if (searchUrl === void 0 || !isPlausibleSearchUrl(searchUrl)) {
        throw new Error(`rulepack: ${context}: html platforms need a plausible absolute searchUrl`);
      }
      platform.selectors = validateSelectors(obj.selectors, context);
      break;
    }
    case "json": {
      if (searchUrl === void 0 || !isPlausibleSearchUrl(searchUrl)) {
        throw new Error(`rulepack: ${context}: json platforms need a plausible absolute searchUrl`);
      }
      platform.fields = validateFields(obj.fields, context);
      break;
    }
    case "json-in-html": {
      if (searchUrl === void 0 || !isPlausibleSearchUrl(searchUrl)) {
        throw new Error(`rulepack: ${context}: json-in-html platforms need a plausible absolute searchUrl`);
      }
      platform.jsonInHtml = validateJsonInHtml(obj.jsonInHtml, context);
      break;
    }
    case "rss": {
      break;
    }
  }
  return platform;
}
function validateRulePack(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("rulepack: top level must be an object");
  }
  const obj = raw;
  if (obj.version !== RULE_PACK_VERSION) {
    throw new Error(`rulepack: unsupported version ${String(obj.version)} (expected ${RULE_PACK_VERSION})`);
  }
  const name2 = requireString(obj.name, "name", "pack");
  const description = optionalString(obj.description, "description", "pack");
  if (!Array.isArray(obj.platforms)) throw new Error("rulepack: platforms must be an array");
  const platforms = obj.platforms.map((entry, index) => validatePlatform(entry, `platforms[${index}]`));
  const seen = /* @__PURE__ */ new Set();
  for (const platform of platforms) {
    if (seen.has(platform.id)) throw new Error(`rulepack: duplicate platform id "${platform.id}"`);
    seen.add(platform.id);
  }
  return { version: RULE_PACK_VERSION, name: name2, ...description !== void 0 ? { description } : {}, platforms };
}
function importRulePack(input) {
  const parsed = typeof input === "string" ? JSON.parse(input) : input;
  return validateRulePack(parsed);
}

// src/platforms/registry.ts
function mergePlatforms(groups) {
  const byId = /* @__PURE__ */ new Map();
  const order = [];
  for (const group of groups) {
    for (const platform of group) {
      if (!byId.has(platform.id)) order.push(platform.id);
      byId.set(platform.id, platform);
    }
  }
  return order.map((id) => byId.get(id));
}
var PlatformRegistry = class {
  builtins;
  configured;
  rulePackPaths;
  rulePackCache = /* @__PURE__ */ new Map();
  constructor(options) {
    this.builtins = options.builtins;
    this.configured = options.configured;
    this.rulePackPaths = options.rulePackPaths;
  }
  /**
   * Re-read rule-pack files whose mtime changed (hot reload). Safe to call on
   * every search; unchanged files are not re-read.
   */
  refresh() {
    for (const path of this.rulePackPaths) {
      let mtimeMs;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {
        this.rulePackCache.set(path, { mtimeMs: -1, platforms: [] });
        continue;
      }
      const cached = this.rulePackCache.get(path);
      if (cached !== void 0 && cached.mtimeMs === mtimeMs) continue;
      try {
        const text = readFileSync(path, "utf8");
        const pack = importRulePack(text);
        this.rulePackCache.set(path, { mtimeMs, platforms: pack.platforms });
      } catch (error) {
        const previous = this.rulePackCache.get(path);
        this.rulePackCache.set(path, {
          mtimeMs,
          platforms: previous?.platforms ?? [],
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  /** The merged platform list (built-ins < configured < rule packs). */
  list() {
    this.refresh();
    const rulePackGroups = this.rulePackPaths.map((path) => this.rulePackCache.get(path)?.platforms ?? []);
    return mergePlatforms([this.builtins, this.configured, ...rulePackGroups]);
  }
  /** Look up one platform by id. */
  get(id) {
    return this.list().find((platform) => platform.id === id);
  }
  /** Whether a platform id is registered. */
  has(id) {
    return this.get(id) !== void 0;
  }
  /** All registered platform ids, in merge order. */
  ids() {
    return this.list().map((platform) => platform.id);
  }
  /** The most recent rule-pack load errors (path → message), if any. */
  rulePackErrors() {
    const errors = {};
    for (const [path, entry] of this.rulePackCache) {
      if (entry.error !== void 0) errors[path] = entry.error;
    }
    return errors;
  }
};

// src/platforms/search.ts
import { WebError as WebError4 } from "@deepseek-ai/dsh-web";
import { deadline as deadline2, timeoutOf as timeoutOf2 } from "@deepseek-ai/dsh-timeout";

// src/platforms/parse-html.ts
import * as cheerio from "cheerio";
function cleanText(text) {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : void 0;
}
function resolveHref(href, base) {
  if (href === void 0) return void 0;
  const trimmed = href.trim();
  if (trimmed.length === 0) return void 0;
  try {
    const resolved = new URL(trimmed, base).toString();
    return /^https?:/i.test(resolved) ? resolved : void 0;
  } catch {
    return void 0;
  }
}
function parseHtmlResults(html, selectors, baseUrl) {
  const $ = cheerio.load(html);
  const sources = [];
  const seen = /* @__PURE__ */ new Set();
  $(selectors.item).each((_index, element) => {
    const $item = $(element);
    let href;
    if (selectors.url !== void 0) {
      href = $item.find(selectors.url).first().attr("href");
    } else {
      const selfHref = $item.attr("href");
      href = selfHref !== void 0 && selfHref.length > 0 ? selfHref : $item.find("a").first().attr("href");
    }
    const url = resolveHref(href, baseUrl);
    if (url === void 0 || seen.has(url)) return;
    seen.add(url);
    const source = { url };
    const title = selectors.title !== void 0 ? cleanText($item.find(selectors.title).first().text()) : cleanText($item.text());
    if (title !== void 0) source.title = title;
    const snippet = selectors.snippet !== void 0 ? cleanText($item.find(selectors.snippet).first().text()) : void 0;
    if (snippet !== void 0) source.snippet = snippet;
    sources.push(source);
  });
  return sources;
}

// src/platforms/parse-json.ts
function resolvePath(value, path) {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return void 0;
    current = current[segment];
  }
  return current;
}
function asText(value) {
  if (typeof value !== "string") return void 0;
  const text = value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : void 0;
}
function parseJsonResults(text, fields) {
  const root = JSON.parse(text);
  return itemsToSources(root, fields);
}
function itemsToSources(root, fields) {
  const items = resolvePath(root, fields.items);
  if (!Array.isArray(items)) return [];
  const sources = [];
  for (const item of items) {
    const rawUrl = asText(resolvePath(item, fields.url));
    if (rawUrl === void 0) continue;
    const url = fields.urlPrefix !== void 0 ? `${fields.urlPrefix}${rawUrl}` : rawUrl;
    const source = { url };
    if (fields.title !== void 0) {
      const title = asText(resolvePath(item, fields.title));
      if (title !== void 0) source.title = title;
    }
    if (fields.snippet !== void 0) {
      const snippet = asText(resolvePath(item, fields.snippet));
      if (snippet !== void 0) source.snippet = snippet;
    }
    if (fields.publishedAt !== void 0) {
      const publishedAt = asText(resolvePath(item, fields.publishedAt));
      if (publishedAt !== void 0) source.publishedAt = publishedAt;
    }
    sources.push(source);
  }
  return sources;
}
function extractJsonAfterMarker(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error(`json-in-html marker not found: ${marker}`);
  const start = html.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error(`json-in-html: no object after marker ${marker}`);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error("json-in-html: unbalanced object after marker");
}

// src/platforms/parse-rss.ts
import * as cheerio2 from "cheerio";
function cleanText2(text) {
  if (text === void 0) return void 0;
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : void 0;
}
function resolveLink(link, base) {
  const trimmed = link?.trim();
  if (trimmed === void 0 || trimmed.length === 0) return void 0;
  try {
    const resolved = new URL(trimmed, base).toString();
    return /^https?:/i.test(resolved) ? resolved : void 0;
  } catch {
    return void 0;
  }
}
function parseRssResults(xml, feedUrl) {
  const $ = cheerio2.load(xml, { xml: true });
  const sources = [];
  const seen = /* @__PURE__ */ new Set();
  const emit = (url, title, snippet, publishedAt) => {
    if (url === void 0 || seen.has(url)) return;
    seen.add(url);
    const source = { url };
    if (title !== void 0) source.title = title;
    if (snippet !== void 0) source.snippet = snippet;
    if (publishedAt !== void 0) source.publishedAt = publishedAt;
    sources.push(source);
  };
  if ($("item").length > 0) {
    $("item").each((_index, element) => {
      const $item = $(element);
      const url = resolveLink($item.find("link").first().text(), feedUrl);
      const title = cleanText2($item.find("title").first().text());
      const snippet = cleanText2($item.find("description").first().text()) ?? cleanText2($item.find("summary").first().text());
      const publishedAt = cleanText2($item.find("pubDate").first().text());
      emit(url, title, snippet, publishedAt);
    });
    return sources;
  }
  $("entry").each((_index, element) => {
    const $entry = $(element);
    const href = $entry.find("link").first().attr("href");
    const url = resolveLink(href, feedUrl);
    const title = cleanText2($entry.find("title").first().text());
    const snippet = cleanText2($entry.find("summary").first().text()) ?? cleanText2($entry.find("content").first().text());
    const publishedAt = cleanText2($entry.find("published").first().text()) ?? cleanText2($entry.find("updated").first().text());
    emit(url, title, snippet, publishedAt);
  });
  return sources;
}

// src/platforms/search.ts
function classifyPlatformError(error, signal, context) {
  const timeout = timeoutOf2(signal, "WEB_SEARCH_TIMEOUT");
  if (timeout !== void 0) return new WebError4("platform search timed out", "WEB_SEARCH_TIMEOUT", { cause: timeout });
  if (signal.aborted) return new WebError4("platform search aborted", "WEB_ABORTED", { cause: error });
  return new WebError4(`${context}: ${error instanceof Error ? error.message : String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}
async function readCappedText(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return "";
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) throw new Error(`body exceeds ${maxBytes} bytes`);
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (value.byteLength > remaining) break;
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concatBytes(chunks));
}
function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
async function fetchText(url, headers, signal, maxBytes, allowPrivateNetworks) {
  let response;
  try {
    response = await fetchPublic(url, {
      allowPrivate: allowPrivateNetworks,
      ...headers !== void 0 ? { headers } : {},
      signal
    });
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      throw new WebError4(`request to ${url} blocked by the SSRF guard: ${error.reason}`, "WEB_SSRF_BLOCKED", { cause: error });
    }
    throw classifyPlatformError(error, signal, `fetch ${url}`);
  }
  if (!response.ok) {
    throw new WebError4(`platform search got HTTP ${response.status} from ${url}`, "WEB_PROVIDER_ERROR");
  }
  try {
    return await readCappedText(response, maxBytes);
  } catch (error) {
    throw classifyPlatformError(error, signal, `read ${url}`);
  }
}
function parseByFormat(platform, body, url) {
  switch (platform.format) {
    case "html":
      if (platform.selectors === void 0) throw new WebError4(`platform "${platform.id}" is missing html selectors`, "WEB_PROVIDER_ERROR");
      return parseHtmlResults(body, platform.selectors, url);
    case "json":
      if (platform.fields === void 0) throw new WebError4(`platform "${platform.id}" is missing json fields`, "WEB_PROVIDER_ERROR");
      return parseJsonResults(body, platform.fields);
    case "json-in-html":
      if (platform.jsonInHtml === void 0) throw new WebError4(`platform "${platform.id}" is missing jsonInHtml config`, "WEB_PROVIDER_ERROR");
      const jsonText = extractJsonAfterMarker(body, platform.jsonInHtml.marker);
      return parseJsonResults(jsonText, platform.jsonInHtml.fields);
    case "rss":
      return parseRssResults(body, url);
  }
}
async function searchPlatform(args, deps, signal) {
  var _stack = [];
  try {
    const platform = deps.registry.get(args.platform);
    if (platform === void 0) {
      const available = deps.registry.ids().join(", ");
      throw new WebError4(`unknown platform "${args.platform}"; available: ${available}`, "WEB_PROVIDER_ERROR");
    }
    const limit = Math.min(Math.max(Math.trunc(args.limit ?? deps.maxResults), 1), deps.maxResults);
    let url;
    if (platform.format === "rss") {
      url = args.query.trim();
    } else {
      if (platform.searchUrl === void 0) throw new WebError4(`platform "${platform.id}" has no searchUrl`, "WEB_PROVIDER_ERROR");
      url = expandTemplate(platform.searchUrl, { query: args.query, limit });
    }
    if (!URL.canParse(url) || !/^https?:/i.test(url)) {
      throw new WebError4(`platform "${platform.id}" produced an invalid URL: ${url}`, "WEB_INVALID_URL");
    }
    const d = __using(_stack, deadline2(signal, deps.timeoutMs, "WEB_SEARCH_TIMEOUT"));
    const body = await fetchText(url, platform.headers, d.signal, deps.maxBytes, deps.allowPrivateNetworks);
    const parsed = parseByFormat(platform, body, url);
    const cap = platform.maxResults !== void 0 ? Math.min(limit, platform.maxResults) : limit;
    const truncated = parsed.length > cap;
    return { platform: platform.id, query: args.query, sources: parsed.slice(0, cap), truncated };
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}

// src/platforms/index.ts
var WEB_PLATFORMS_SETTINGS_NAMESPACE = settingsNamespace("web-platforms");
var DEFAULT_PLATFORM_MAX_RESULTS = 20;
var DEFAULT_PLATFORM_TIMEOUT_MS = 3e4;
var DEFAULT_PLATFORM_MAX_BYTES = 5242880;
var Config3 = z3.object({
  tool: z3.boolean().default(true),
  maxResults: z3.number().default(DEFAULT_PLATFORM_MAX_RESULTS),
  timeoutMs: z3.number().default(DEFAULT_PLATFORM_TIMEOUT_MS),
  maxBytes: z3.number().default(DEFAULT_PLATFORM_MAX_BYTES),
  platforms: z3.array(z3.any()).default([]),
  rulePackPaths: z3.array(z3.string()).default([]),
  allowPrivateNetworks: z3.boolean().default(false)
});
function assertPositiveInteger(name2, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`web-platforms: ${name2} must be a positive integer`);
  }
}
function projectSource(source) {
  return {
    url: source.url,
    ...source.title !== void 0 ? { title: source.title } : {},
    ...source.snippet !== void 0 ? { snippet: source.snippet } : {},
    ...source.publishedAt !== void 0 ? { publishedAt: source.publishedAt } : {}
  };
}
function formatPlatformOutput(result) {
  const lines = [`Platform: ${result.platform}`, `Query: ${result.query}`, ""];
  if (result.sources.length === 0) {
    lines.push("No results.");
  } else {
    result.sources.forEach((source, index) => {
      const title = source.title !== void 0 ? ` \u2014 ${source.title}` : "";
      lines.push(`${index + 1}. ${source.url}${title}`);
      if (source.snippet !== void 0) lines.push(`   ${source.snippet}`);
    });
    if (result.truncated) lines.push(`(truncated to ${result.sources.length} results)`);
  }
  return lines.join("\n");
}
function apply3(ctx, config) {
  let current = () => config;
  installSettingsSection(ctx, WEB_PLATFORMS_SETTINGS_NAMESPACE, Config3, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
    }
  });
  const resolved = current();
  assertPositiveInteger("maxResults", resolved.maxResults);
  assertPositiveInteger("timeoutMs", resolved.timeoutMs);
  assertPositiveInteger("maxBytes", resolved.maxBytes);
  const configured = resolved.platforms.map((raw, index) => validatePlatform(raw, `platforms[${index}]`));
  const registry = new PlatformRegistry({
    builtins: BUILTIN_PLATFORMS,
    configured,
    rulePackPaths: resolved.rulePackPaths
  });
  ctx.systemPrompt.section({
    name: "tool:web_platform_search",
    order: 117,
    text: "Use web_platform_search to search a specific platform instead of a general web search. Built-in platforms: github, reddit, youtube, bilibili, v2ex, rss (plus any configured platforms). For the rss platform, pass the feed URL as the query. It returns a list of result URLs with optional titles and snippets."
  });
  if (!resolved.tool) return;
  ctx.tools.register(defineTool2({
    name: "web_platform_search",
    description: "Search a specific web platform (github, reddit, youtube, bilibili, v2ex, rss, or a configured platform) and return its results. For rss, the query is a feed URL.",
    parameters: {
      platform: { type: "string", required: true, description: 'The platform id to search (e.g. "github", "reddit", "rss").' },
      query: { type: "string", required: true, description: "The search query; for the rss platform this is the feed URL." },
      limit: { type: "number", description: `Maximum number of results to return (1\u2013${PLATFORM_SEARCH_MAX_LIMIT}). Defaults to ${DEFAULT_PLATFORM_MAX_RESULTS}.` }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          platform: { type: "string", required: true },
          query: { type: "string", required: true },
          sources: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                url: { type: "string", required: true },
                title: { type: "string" },
                snippet: { type: "string" },
                publishedAt: { type: "string" }
              }
            }
          },
          truncated: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: formatPlatformOutput(value) }]
    },
    timeoutMs: resolved.timeoutMs,
    // Platform reads do not mutate parent-agent state.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const result = await searchPlatform(
        { platform: args.platform, query: args.query, ...typeof args.limit === "number" ? { limit: args.limit } : {} },
        { registry, timeoutMs: resolved.timeoutMs, maxBytes: resolved.maxBytes, maxResults: resolved.maxResults, allowPrivateNetworks: resolved.allowPrivateNetworks },
        exec.signal
      );
      return {
        platform: result.platform,
        query: result.query,
        sources: result.sources.map(projectSource),
        truncated: result.truncated
      };
    }
  }));
}

// src/search/index.ts
import { credentialRef as credentialRef2 } from "@deepseek-ai/dsh-credentials";
import { dshHomePath as dshHomePath3 } from "@deepseek-ai/dsh-home-paths";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { installSettingsSection as installSettingsSection2, settingsNamespace as settingsNamespace2 } from "@deepseek-ai/dsh-settings";
import z4 from "@deepseek-ai/schemastery";
import { WebError as WebError12 } from "@deepseek-ai/dsh-web";

// src/search/engines/bing.ts
import { WebError as WebError6 } from "@deepseek-ai/dsh-web";

// src/search/bingparse.ts
import * as cheerio3 from "cheerio";
function isHttpUrl(value) {
  if (!value.startsWith("http://") && !value.startsWith("https://")) return false;
  try {
    return URL.canParse(value);
  } catch {
    return false;
  }
}
function parseBingSerp(html) {
  const $ = cheerio3.load(html);
  const results = [];
  $("li.b_algo").each((_, el) => {
    const $el = $(el);
    const $title = $el.find("h2 a").first();
    const href = $title.attr("href");
    const title = $title.text().trim();
    if (href === void 0 || !isHttpUrl(href) || title.length === 0) return;
    const snippet = $el.find(".b_caption p, .b_caption").first().text().replace(/\s+/g, " ").trim();
    results.push({ url: href, title, snippet });
  });
  return results;
}
function isBlockedBingSerp(html) {
  if (parseBingSerp(html).length > 0) return false;
  return /consent\.microsoft|challenge-form|captcha|are you a robot/i.test(html);
}

// src/search/http.ts
import { WebError as WebError5 } from "@deepseek-ai/dsh-web";
import { timeoutOf as timeoutOf3 } from "@deepseek-ai/dsh-timeout";
function classifyWebError(error, signal, context) {
  const timeout = timeoutOf3(signal, "WEB_SEARCH_TIMEOUT");
  if (timeout !== void 0) return new WebError5("web search timed out", "WEB_SEARCH_TIMEOUT", { cause: timeout });
  if (signal.aborted) return new WebError5("web search aborted", "WEB_ABORTED", { cause: error });
  return new WebError5(`${context}: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
}
async function readCappedText2(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) throw new Error(`body exceeds ${maxBytes} bytes`);
  }
  if (response.body === null) return "";
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, Math.max(0, remaining)));
        total += Math.max(0, remaining);
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {
    });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

// src/search/rate-limit.ts
var RateLimiter = class {
  constructor(options) {
    this.options = options;
    if (!(options.perSec > 0)) throw new Error("RateLimiter: perSec must be positive");
    this.capacity = Math.max(1, options.burst ?? Math.ceil(options.perSec));
    this.refillPerMs = options.perSec / 1e3;
    this.tokens = this.capacity;
    this.lastRefill = (options.now ?? Date.now)();
  }
  options;
  capacity;
  refillPerMs;
  tokens;
  lastRefill;
  /**
   * Wait until one token is available, then consume it.
   * @param signal - optional caller cancellation; an aborted wait rejects with an `AbortError`.
   */
  async acquire(signal) {
    for (; ; ) {
      this.refill();
      if (signal?.aborted) throw new DOMException("rate limit wait aborted", "AbortError");
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil(deficit / this.refillPerMs) + this.jitter();
      await (this.options.sleep ?? defaultSleep)(waitMs, signal);
    }
  }
  refill() {
    const now = (this.options.now ?? Date.now)();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }
  jitter() {
    const max = this.options.jitterMs ?? 100;
    return Math.floor(Math.random() * (max + 1));
  }
};
function defaultSleep(ms, signal) {
  return new Promise((resolve2, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("rate limit wait aborted", "AbortError"));
      return;
    }
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve2();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("rate limit wait aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/search/url.ts
var TRACKING_PARAM2 = /^(utm_|fbclid|gclid|mc_(eid|cid)|ref|source)/i;
function normalizeUrl2(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAM2.test(key)) parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

// src/search/engines/bing.ts
var BING_DEFAULT_ENDPOINT = "https://www.bing.com/search";
var BingEngine = class {
  constructor(options) {
    this.options = options;
    this.limiter = new RateLimiter({ perSec: options.rateLimitPerSec });
  }
  options;
  id = "bing";
  limiter;
  /** Cheap local check: the endpoint must parse as an absolute URL. No network. */
  available() {
    return URL.canParse(this.options.endpoint);
  }
  /** Fetch and parse one SERP. */
  async search(query, maxResults, signal) {
    const html = await this.fetchSerp(query, maxResults, signal);
    if (isBlockedBingSerp(html)) {
      throw new WebError6(
        "Bing returned a consent or challenge page instead of results; slow down or try again later",
        "WEB_PROVIDER_ERROR"
      );
    }
    return { sources: this.filterAndDedupe(parseBingSerp(html)).slice(0, maxResults) };
  }
  serpUrl(query, maxResults) {
    const url = new URL(this.options.endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(maxResults, 50)));
    if (this.options.market.length > 0) url.searchParams.set("setmkt", this.options.market);
    const qft = this.freshnessQft();
    if (qft.length > 0) url.searchParams.set("qft", qft);
    return url.toString();
  }
  /** Map the freshness setting to Bing's `qft` filter value. */
  freshnessQft() {
    const freshness = this.options.freshness ?? "";
    switch (freshness) {
      case "24h":
        return "+filter:ex1";
      case "week":
        return "+filter:ex2";
      case "month":
        return "+filter:ex3";
      case "year":
        return "+filter:ex4";
      default:
        return "";
    }
  }
  /** Fetch the SERP document; block-like failures surface as `WebError`. */
  async fetchSerp(query, maxResults, signal) {
    await this.limiter.acquire(signal);
    let response;
    try {
      response = await fetch(this.serpUrl(query, maxResults), {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": this.options.userAgent, "accept": "text/html" },
        signal
      });
    } catch (error) {
      throw classifyWebError(error, signal, "Bing search request failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new WebError6(`Bing search request failed (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
    }
    try {
      return await readCappedText2(response, this.options.maxSerpBytes);
    } catch (error) {
      throw classifyWebError(error, signal, "Bing search body read failed");
    }
  }
  /** Drop blocked domains and duplicate URLs (first occurrence wins). */
  filterAndDedupe(results) {
    const seen = /* @__PURE__ */ new Set();
    const sources = [];
    for (const result of results) {
      const key = normalizeUrl2(result.url);
      if (seen.has(key)) continue;
      if (this.isBlockedDomain(result.url)) continue;
      seen.add(key);
      sources.push({
        url: result.url,
        ...result.title.length > 0 ? { title: result.title } : {},
        ...result.snippet.length > 0 ? { snippet: result.snippet } : {}
      });
    }
    return sources;
  }
  isBlockedDomain(url) {
    if (this.options.blockedDomains.length === 0) return false;
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return true;
    }
    return this.options.blockedDomains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^\./, "");
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  }
};

// src/search/engines/ddg.ts
import { WebError as WebError7 } from "@deepseek-ai/dsh-web";

// src/search/serpparse.ts
import * as cheerio4 from "cheerio";
function parseDuckDuckGoSerp(html) {
  const $ = cheerio4.load(html);
  const results = [];
  $(".result").each((_index, element) => {
    const $result = $(element);
    const $link = $result.find("a.result__a").first();
    const url = decodeDuckDuckGoHref($link.attr("href") ?? "");
    if (!isHttpUrl2(url)) return;
    const title = $link.text().replace(/\s+/g, " ").trim();
    const snippet = $result.find(".result__snippet").first().text().replace(/\s+/g, " ").trim();
    if (title.length === 0 && snippet.length === 0) return;
    results.push({ url, title, snippet });
  });
  return results;
}
function decodeDuckDuckGoHref(href) {
  const trimmed = href.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("//duckduckgo.com/l/") || trimmed.startsWith("https://duckduckgo.com/l/")) {
    try {
      const wrapper = new URL(trimmed.startsWith("http") ? trimmed : `https:${trimmed}`);
      const target = wrapper.searchParams.get("uddg");
      if (target !== null && target.length > 0) return decodeURIComponent(target);
      return "";
    } catch {
      return "";
    }
  }
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  return trimmed;
}
function isHttpUrl2(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
function isBlockedSerp(html) {
  return /anomaly-modal|challenge-form|captcha|not a robot/i.test(html);
}

// src/search/engines/ddg.ts
var DUCKDUCKGO_DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";
var DuckDuckGoEngine = class {
  constructor(options) {
    this.options = options;
    this.limiter = new RateLimiter({ perSec: options.rateLimitPerSec });
  }
  options;
  id = "ddg";
  limiter;
  /** Cheap local check: the endpoint must parse as an absolute URL. No network. */
  available() {
    return URL.canParse(this.endpoint());
  }
  /** Fetch and parse one SERP. */
  async search(query, maxResults, signal) {
    const html = await this.fetchSerp(query, signal);
    if (isBlockedSerp(html)) {
      throw new WebError7(
        "DuckDuckGo returned a bot challenge instead of results; slow down or try again later",
        "WEB_PROVIDER_ERROR"
      );
    }
    return { sources: this.filterAndDedupe(parseDuckDuckGoSerp(html)).slice(0, maxResults) };
  }
  endpoint() {
    return this.options.endpoint.endsWith("/") ? this.options.endpoint : `${this.options.endpoint}/`;
  }
  serpUrl(query) {
    const params = new URLSearchParams({ q: query });
    if (this.options.region.length > 0) params.set("kl", this.options.region);
    const base = this.endpoint();
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}${params.toString()}`;
  }
  /** Fetch the SERP document; block-like failures surface as `WebError`. */
  async fetchSerp(query, signal) {
    await this.limiter.acquire(signal);
    let response;
    try {
      response = await fetch(this.serpUrl(query), {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": this.options.userAgent, "accept": "text/html" },
        signal
      });
    } catch (error) {
      throw classifyWebError(error, signal, "DuckDuckGo search request failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        throw new WebError7(
          `DuckDuckGo blocked the search request (HTTP ${response.status}); slow down or try again later`,
          "WEB_PROVIDER_ERROR"
        );
      }
      throw new WebError7(`DuckDuckGo search request failed (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
    }
    try {
      return await readCappedText2(response, this.options.maxSerpBytes);
    } catch (error) {
      throw classifyWebError(error, signal, "DuckDuckGo search body read failed");
    }
  }
  /** Drop blocked domains and duplicate URLs (first occurrence wins). */
  filterAndDedupe(results) {
    const seen = /* @__PURE__ */ new Set();
    const sources = [];
    for (const result of results) {
      const key = normalizeUrl2(result.url);
      if (seen.has(key)) continue;
      if (this.isBlockedDomain(result.url)) continue;
      seen.add(key);
      sources.push({
        url: result.url,
        ...result.title.length > 0 ? { title: result.title } : {},
        ...result.snippet.length > 0 ? { snippet: result.snippet } : {}
      });
    }
    return sources;
  }
  isBlockedDomain(url) {
    if (this.options.blockedDomains.length === 0) return false;
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return true;
    }
    return this.options.blockedDomains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^\./, "");
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  }
};

// src/search/engines/deepseek.ts
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
  DeepSeekSearchProvider
} from "@deepseek-ai/dsh-web-search-deepseek";
var DeepSeekEngine = class {
  id = "deepseek";
  provider;
  constructor(options) {
    this.provider = new DeepSeekSearchProvider(() => ({
      baseURL: options.baseURL ?? DEEPSEEK_DEFAULT_BASE_URL,
      model: options.model ?? DEEPSEEK_DEFAULT_MODEL,
      apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
      maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
      maxUses: options.maxUses ?? DEEPSEEK_DEFAULT_MAX_USES,
      ...options.apiKey !== void 0 && options.apiKey.length > 0 ? { apiKey: options.apiKey } : {},
      ...options.resolveApiKey !== void 0 ? { resolveApiKey: options.resolveApiKey } : {},
      apiKeyEnv: credentialRef("DEEPSEEK_API_KEY")
    }));
  }
  /** Available when a key is present (static, or a resolver that may yield one). */
  available() {
    return this.provider.available();
  }
  /** Delegate to the wrapped provider. */
  async search(query, maxResults, signal) {
    const result = await this.provider.search({ query, maxResults }, signal);
    return { sources: result.sources, ...result.content !== void 0 ? { content: result.content } : {} };
  }
};

// src/search/engines/exa.ts
import { ExaSearchProvider, EXA_DEFAULT_BASE_URL } from "@deepseek-ai/dsh-web-search-exa";
var ExaEngine = class {
  id = "exa";
  options;
  cachedKey;
  provider;
  constructor(options) {
    this.options = options;
    this.cachedKey = options.apiKey ?? "";
    this.provider = this.buildProvider(this.cachedKey);
  }
  buildProvider(apiKey) {
    return new ExaSearchProvider({
      apiKey,
      baseURL: this.options.baseURL ?? EXA_DEFAULT_BASE_URL,
      searchType: this.options.searchType ?? "auto",
      highlightsPerResult: this.options.highlightsPerResult ?? 3
    });
  }
  /** Available when a key is present (static, or a resolver that may yield one). */
  available() {
    return this.cachedKey.length > 0 || this.options.resolveApiKey !== void 0;
  }
  /** Delegate to the wrapped provider, resolving the key per search when a resolver is set. */
  async search(query, maxResults, signal) {
    if (this.options.resolveApiKey !== void 0) {
      const resolved = await this.options.resolveApiKey() ?? "";
      if (resolved !== this.cachedKey) {
        this.cachedKey = resolved;
        this.provider = this.buildProvider(resolved);
      }
    }
    const result = await this.provider.search({ query, maxResults }, signal);
    return { sources: result.sources, ...result.content !== void 0 ? { content: result.content } : {} };
  }
};

// src/search/engines/jina.ts
import { WebError as WebError8 } from "@deepseek-ai/dsh-web";
var JINA_DEFAULT_BASE_URL = "https://s.jina.ai";
var JinaEngine = class {
  constructor(options) {
    this.options = options;
  }
  options;
  id = "jina";
  /** Available when a key is present (static, or a resolver that may yield one). */
  available() {
    const hasKey = (this.options.apiKey?.length ?? 0) > 0 || this.options.resolveApiKey !== void 0;
    return hasKey && URL.canParse(this.options.baseURL ?? JINA_DEFAULT_BASE_URL);
  }
  /** Run one search against the Jina API. */
  async search(query, maxResults, signal) {
    const apiKey = this.options.resolveApiKey !== void 0 ? await this.options.resolveApiKey() ?? this.options.apiKey ?? "" : this.options.apiKey ?? "";
    const url = `${(this.options.baseURL ?? JINA_DEFAULT_BASE_URL).replace(/\/$/, "")}/${encodeURIComponent(query)}`;
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: {
          "user-agent": this.options.userAgent,
          "authorization": `Bearer ${apiKey}`,
          "accept": "application/json",
          "x-retain-images": "false"
        },
        signal
      });
    } catch (error) {
      throw classifyWebError(error, signal, "Jina search request failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new WebError8(`Jina search request failed (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
    }
    let body;
    try {
      body = await readCappedText2(response, this.options.maxResponseBytes);
    } catch (error) {
      throw classifyWebError(error, signal, "Jina search body read failed");
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new WebError8(`Jina search returned a non-JSON response: ${String(error)}`, "WEB_PROVIDER_ERROR", { cause: error });
    }
    const sources = [];
    for (const item of parsed.data ?? []) {
      if (item.url === void 0 || item.url.length === 0) continue;
      sources.push({
        url: item.url,
        ...item.title !== void 0 && item.title.length > 0 ? { title: item.title } : {},
        ...item.description !== void 0 && item.description.length > 0 ? { snippet: item.description } : item.content !== void 0 && item.content.length > 0 ? { snippet: item.content.slice(0, 300) } : {}
      });
      if (sources.length >= maxResults) break;
    }
    return { sources };
  }
};

// src/search/engines/searxng.ts
import { WebError as WebError9 } from "@deepseek-ai/dsh-web";
var SEARXNG_DEFAULT_ENDPOINT = "http://localhost:8080";
var SearXNGEngine = class {
  constructor(options) {
    this.options = options;
    this.limiter = new RateLimiter({ perSec: options.rateLimitPerSec });
  }
  options;
  id = "searxng";
  limiter;
  /** Cheap local check: the endpoint must parse as an absolute URL. No network. */
  available() {
    return URL.canParse(this.endpoint());
  }
  /** Query the SearXNG JSON API and map the results. */
  async search(query, maxResults, signal) {
    const body = await this.fetchJson(query, signal);
    const results = body.results ?? [];
    return { sources: this.filterAndDedupe(results).slice(0, maxResults) };
  }
  endpoint() {
    return this.options.endpoint.replace(/\/$/, "");
  }
  searchUrl(query) {
    const params = new URLSearchParams({ q: query, format: "json" });
    return `${this.endpoint()}/search?${params.toString()}`;
  }
  /** Fetch and parse one SearXNG JSON response. */
  async fetchJson(query, signal) {
    await this.limiter.acquire(signal);
    let response;
    try {
      response = await fetch(this.searchUrl(query), {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": this.options.userAgent, "accept": "application/json" },
        signal
      });
    } catch (error) {
      throw classifyWebError(error, signal, "SearXNG search request failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 429 || response.status === 503) {
        throw new WebError9(
          `SearXNG blocked the search request (HTTP ${response.status}); slow down or try again later`,
          "WEB_PROVIDER_ERROR"
        );
      }
      throw new WebError9(`SearXNG search request failed (HTTP ${response.status})`, "WEB_PROVIDER_ERROR");
    }
    let text;
    try {
      text = await readCappedText2(response, this.options.maxSerpBytes);
    } catch (error) {
      throw classifyWebError(error, signal, "SearXNG search body read failed");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new WebError9("SearXNG returned a non-JSON response (is the JSON API enabled?)", "WEB_PROVIDER_ERROR");
    }
  }
  /** Drop blocked domains and duplicate URLs (first occurrence wins). */
  filterAndDedupe(results) {
    const seen = /* @__PURE__ */ new Set();
    const sources = [];
    for (const result of results) {
      if (result.url === void 0 || result.url.length === 0) continue;
      const key = normalizeUrl2(result.url);
      if (seen.has(key)) continue;
      if (this.isBlockedDomain(result.url)) continue;
      seen.add(key);
      sources.push({
        url: result.url,
        ...result.title?.length ? { title: result.title } : {},
        ...result.content?.length ? { snippet: result.content } : {}
      });
    }
    return sources;
  }
  isBlockedDomain(url) {
    if (this.options.blockedDomains.length === 0) return false;
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return true;
    }
    return this.options.blockedDomains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^\./, "");
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  }
};

// src/search/provider.ts
import { WebError as WebError11 } from "@deepseek-ai/dsh-web";
import { deadline as deadline4 } from "@deepseek-ai/dsh-timeout";

// src/search/enrich.ts
import { WebError as WebError10 } from "@deepseek-ai/dsh-web";
import { deadline as deadline3 } from "@deepseek-ai/dsh-timeout";

// src/search/bm25.ts
function tokenize(text) {
  const matches = text.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  return matches ?? [];
}
function bm25Rank(query, documents, k1 = 1.2, b = 0.75) {
  if (documents.length === 0) return [];
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return documents.map(() => 0);
  const docTokens = documents.map(tokenize);
  const docLengths = docTokens.map((tokens) => tokens.length);
  const avgLength = docLengths.reduce((sum, length) => sum + length, 0) / documents.length;
  const distinctTerms = [...new Set(queryTokens)];
  const df = /* @__PURE__ */ new Map();
  for (const term of distinctTerms) df.set(term, 0);
  for (const tokens of docTokens) {
    const present = new Set(tokens);
    for (const term of distinctTerms) {
      if (present.has(term)) df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const idf = /* @__PURE__ */ new Map();
  const n = documents.length;
  for (const [term, frequency] of df) {
    idf.set(term, Math.log(1 + (n - frequency + 0.5) / (frequency + 0.5)));
  }
  return docTokens.map((tokens, index) => {
    if (tokens.length === 0) return 0;
    const tf = /* @__PURE__ */ new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    const length = docLengths[index] ?? 0;
    let score = 0;
    for (const term of distinctTerms) {
      const termFrequency = tf.get(term) ?? 0;
      if (termFrequency === 0) continue;
      const inverseDocumentFrequency = idf.get(term) ?? 0;
      score += inverseDocumentFrequency * (termFrequency * (k1 + 1)) / (termFrequency + k1 * (1 - b + b * length / (avgLength || 1)));
    }
    return score;
  });
}

// src/search/embedding.ts
function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === void 0 || y === void 0) return 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}
async function embeddingRerank(query, snippets, options, signal) {
  if (snippets.length === 0) return [];
  if (options.endpoint.length === 0) return snippets.map((_, i) => i);
  const texts = [query, ...snippets];
  const embeddings = await computeEmbeddings(texts, options, signal);
  if (embeddings.length !== texts.length) return snippets.map((_, i) => i);
  const queryEmbedding = embeddings[0];
  if (queryEmbedding === void 0) return snippets.map((_, i) => i);
  const scores = snippets.map((_, i) => {
    const snippetEmbedding = embeddings[i + 1];
    if (snippetEmbedding === void 0) return 0;
    return cosineSimilarity(queryEmbedding, snippetEmbedding);
  });
  return scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score).map(({ i }) => i);
}
async function computeEmbeddings(texts, options, signal) {
  const url = `${options.endpoint.replace(/\/$/, "")}/embeddings`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": options.userAgent },
      body: JSON.stringify({ model: options.model, input: texts }),
      signal: controller.signal
    });
    if (!response.ok) return [];
    const text = await response.text();
    if (text.length > options.maxResponseBytes) return [];
    const parsed = JSON.parse(text);
    const embeddings = (parsed.data ?? []).map((d) => d.embedding ?? []);
    return embeddings.length === texts.length ? embeddings : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}

// src/search/extract.ts
import * as cheerio5 from "cheerio";
var NON_CONTENT_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "canvas",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  "button",
  "select",
  "input"
].join(", ");
function extractReadableText(html) {
  const $ = cheerio5.load(html);
  $(NON_CONTENT_SELECTORS).remove();
  const article = $("article").first();
  const main = article.length > 0 ? article : $("main").first();
  const roleMain = main.length > 0 ? main : $('[role="main"]').first();
  const container = roleMain.length > 0 ? roleMain : $("body").length > 0 ? $("body") : $("html");
  return container.text().replace(/\s+/g, " ").trim();
}
function snippetWindow(query, text, maxChars) {
  const lower = text.toLowerCase();
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((term) => term.length > 1);
  let start = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (start === -1 || index < start)) start = index;
  }
  if (start === -1) return text.slice(0, maxChars);
  const from = Math.max(0, start - Math.floor(maxChars / 3));
  const window = text.slice(from, from + maxChars);
  return `${from > 0 ? "\u2026" : ""}${window}${from + maxChars < text.length ? "\u2026" : ""}`;
}

// src/search/enrich.ts
async function enrichSources(query, sources, keep, options, signal) {
  const candidates = sources;
  const texts = new Array(candidates.length).fill(void 0);
  let next = 0;
  const workerCount = Math.min(options.concurrency, candidates.length);
  const workers = [];
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push((async () => {
      while (next < candidates.length) {
        const index = next;
        next += 1;
        const candidate = candidates[index];
        if (candidate === void 0 || signal.aborted) return;
        const page = await fetchPageText(candidate.url, options, signal);
        if (page !== void 0) texts[index] = page;
      }
    })());
  }
  await Promise.all(workers);
  if (signal.aborted) throw new WebError10("web search aborted", "WEB_ABORTED");
  const documents = candidates.map(
    (source, index) => [source.title ?? "", source.snippet ?? "", texts[index] ?? ""].filter((part) => part.length > 0).join("\n")
  );
  let ranked;
  const embedding = options.embedding;
  if (embedding !== void 0 && embedding.endpoint.length > 0) {
    try {
      const order = await embeddingRerank(query, documents, embedding, signal);
      ranked = order.map((index, rank) => ({ source: candidates[index], index, score: 1 / (rank + 1) }));
    } catch {
      const scores = bm25Rank(query, documents);
      ranked = candidates.map((source, index) => ({ source, index, score: scores[index] ?? 0 })).sort((a, b) => b.score - a.score || a.index - b.index);
    }
  } else {
    const scores = bm25Rank(query, documents);
    ranked = candidates.map((source, index) => ({ source, index, score: scores[index] ?? 0 })).sort((a, b) => b.score - a.score || a.index - b.index);
  }
  const kept = ranked.slice(0, Math.min(keep, candidates.length));
  return kept.map(({ source, index }) => {
    const text = texts[index];
    if (text === void 0 || text.length === 0) return { ...source };
    const snippet = snippetWindow(query, text, options.snippetChars);
    return snippet.length > 0 ? { ...source, snippet } : { ...source };
  });
}
async function fetchPageText(url, options, signal) {
  var _stack = [];
  try {
    const key = normalizeUrl2(url);
    const cached = await options.store.readPage(key).catch(() => void 0);
    if (cached !== void 0 && Date.now() - cached.fetchedAt < options.pageCacheTtlMs) {
      return cached.bodyKind === "html" ? extractReadableText(cached.body) : cached.body;
    }
    const d = __using(_stack, deadline3(signal, options.pageTimeoutMs, "WEB_PAGE_TIMEOUT"));
    let response;
    try {
      response = await fetchPublic(url, {
        allowPrivate: options.allowPrivateNetworks,
        headers: {
          "user-agent": options.userAgent,
          "accept": "text/html,application/xhtml+xml,text/*;q=0.9"
        },
        signal: d.signal
      });
    } catch (error) {
      if (error instanceof SsrfBlockedError) return void 0;
      if (signal.aborted) throw new WebError10("web search aborted", "WEB_ABORTED", { cause: error });
      return void 0;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return void 0;
    }
    const mime = (response.headers.get("content-type") ?? "").replace(/;.*$/s, "").trim().toLowerCase();
    if (mime !== "" && !mime.startsWith("text/") && mime !== "application/xhtml+xml" && !mime.endsWith("+xml") && !mime.endsWith("+json")) {
      await response.body?.cancel();
      return void 0;
    }
    let body;
    try {
      body = await readCappedText2(response, options.maxPageBytes);
    } catch (error) {
      if (signal.aborted) throw new WebError10("web search aborted", "WEB_ABORTED", { cause: error });
      return void 0;
    }
    const truncated = body.length > options.maxBodyChars;
    const capped = truncated ? body.slice(0, options.maxBodyChars) : body;
    const bodyKind = mime.startsWith("text/html") || mime === "application/xhtml+xml" ? "html" : "text";
    const text = bodyKind === "html" ? extractReadableText(capped) : capped;
    if (text.length === 0) return void 0;
    await options.store.recordPage({
      url,
      normalizedUrl: key,
      fetchedAt: Date.now(),
      statusCode: response.status,
      bodyKind,
      body: capped,
      truncated
    }).catch(() => void 0);
    return text;
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}

// src/search/cooldown.ts
var EngineCooldown = class {
  constructor(options) {
    this.options = options;
  }
  options;
  states = /* @__PURE__ */ new Map();
  /** True while the engine is cooling down. */
  isCoolingDown(engineId) {
    const state = this.states.get(engineId);
    if (state === void 0) return false;
    return (this.options.now ?? Date.now)() < state.until;
  }
  /** Record a failure and extend the cooldown (exponential backoff). */
  recordFailure(engineId) {
    const now = (this.options.now ?? Date.now)();
    const previous = this.states.get(engineId);
    const consecutive = (previous?.consecutive ?? 0) + 1;
    const delay = Math.min(this.options.baseMs * 2 ** (consecutive - 1), this.options.maxMs);
    this.states.set(engineId, { until: now + delay, consecutive });
  }
  /** Record a success and clear the cooldown. */
  recordSuccess(engineId) {
    this.states.delete(engineId);
  }
  /** Cooldown state for diagnostics (engine id → remaining ms, 0 when idle). */
  remainingMs(engineId) {
    const state = this.states.get(engineId);
    if (state === void 0) return 0;
    const remaining = state.until - (this.options.now ?? Date.now)();
    return remaining > 0 ? remaining : 0;
  }
};

// src/search/rrf.ts
function reciprocalRankFuse(lists, k = 60) {
  const fused = /* @__PURE__ */ new Map();
  for (const list of lists) {
    list.forEach((source, index) => {
      const key = normalizeUrl2(source.url);
      const contribution = 1 / (k + index + 1);
      const existing = fused.get(key);
      if (existing === void 0) {
        fused.set(key, { score: contribution, source: { ...source } });
        return;
      }
      existing.score += contribution;
      mergeSourceFields(existing.source, source);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).map((entry) => entry.source);
}
function mergeSourceFields(target, other) {
  if (target.title === void 0 && other.title !== void 0) target.title = other.title;
  if (target.snippet === void 0 && other.snippet !== void 0) target.snippet = other.snippet;
  if (target.publishedAt === void 0 && other.publishedAt !== void 0) target.publishedAt = other.publishedAt;
}

// src/search/provider.ts
var MULTI_SEARCH_PROVIDER_ID = "multi";
var MultiSearchProvider = class {
  constructor(options) {
    this.options = options;
    this.cooldown = new EngineCooldown({ baseMs: options.cooldownBaseMs, maxMs: options.cooldownMaxMs });
  }
  options;
  id = MULTI_SEARCH_PROVIDER_ID;
  cooldown;
  /** At least one built engine must be available. */
  available() {
    return [...this.options.engineById.values()].some((engine) => engine.available());
  }
  /** Run one search: cache check, routing, enrichment, history. */
  async search(request, signal) {
    var _stack = [];
    try {
      const query = request.query.trim();
      if (query.length === 0) return { sources: [], truncated: false };
      const maxResults = request.maxResults ?? this.options.defaultMaxResults;
      const startedAt = Date.now();
      const cacheKey = searchCacheKey(query, this.options.engines, this.options.mode);
      const cached = await this.options.store.readSearch(cacheKey).catch(() => void 0);
      if (cached !== void 0 && Date.now() - cached.createdAt < this.options.searchCacheTtlMs) {
        this.options.logger?.info("web-search: cache hit", { query, sources: cached.sources.length, latencyMs: Date.now() - startedAt });
        return cloneSearchResult({
          sources: cached.sources,
          ...cached.content !== void 0 ? { content: cached.content } : {},
          truncated: cached.truncated
        });
      }
      const d = __using(_stack, deadline4(signal, this.options.timeoutMs, "WEB_SEARCH_TIMEOUT"));
      const engineIds = this.selectEngines();
      if (engineIds.length === 0) {
        throw new WebError11(
          "no search engine is available (missing credentials or all engines cooling down)",
          "WEB_PROVIDER_ERROR"
        );
      }
      const candidateLimit = Math.max(maxResults, this.options.enrichFetchLimit);
      const routed = this.options.mode === "fuse" && engineIds.length > 1 ? await this.fuse(engineIds, query, candidateLimit, d.signal) : await this.fallback(engineIds, query, candidateLimit, d.signal);
      let sources = filterAndDedupe(routed.sources);
      const content = routed.content;
      if (this.options.enrich && sources.length > 1) {
        const keep = Math.min(this.options.enrichKeep, maxResults, sources.length);
        sources = await enrichSources(query, sources.slice(0, this.options.enrichFetchLimit), keep, {
          store: this.options.store,
          ...this.options.enrichOptions
        }, d.signal);
      }
      const truncated = sources.length >= maxResults;
      const result = {
        sources,
        ...content !== void 0 ? { content } : {},
        truncated
      };
      await this.options.store.recordSearch({
        cacheKey,
        query,
        engines: engineIds,
        createdAt: Date.now(),
        sources,
        truncated,
        ...content !== void 0 ? { content } : {}
      }).catch(() => void 0);
      this.options.logger?.info("web-search: completed", { query, engines: engineIds, sources: sources.length, latencyMs: Date.now() - startedAt });
      return cloneSearchResult(result);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  /** Resolve the engine list: forced engine, or ordered list minus unavailable/cooldown. */
  selectEngines() {
    if (this.options.forcedEngine !== void 0) {
      const engine = this.options.engineById.get(this.options.forcedEngine);
      if (engine === void 0 || !engine.available()) {
        throw new WebError11(
          `forced search engine "${this.options.forcedEngine}" is not available`,
          "WEB_PROVIDER_ERROR"
        );
      }
      return [this.options.forcedEngine];
    }
    return this.options.engines.filter((id) => {
      const engine = this.options.engineById.get(id);
      return engine !== void 0 && engine.available() && !this.cooldown.isCoolingDown(id);
    });
  }
  /** Sequential fallback: the first engine returning results wins. */
  async fallback(ids, query, maxResults, signal) {
    const errors = [];
    for (const id of ids) {
      const engine = this.options.engineById.get(id);
      if (engine === void 0) continue;
      try {
        const result = await engine.search(query, maxResults, signal);
        this.cooldown.recordSuccess(id);
        if (result.sources.length > 0) return result;
        errors.push(`${id}: no results`);
      } catch (error) {
        if (signal.aborted) throw toWebError(error, "web search aborted");
        this.cooldown.recordFailure(id);
        errors.push(`${id}: ${errorMessage(error)}`);
      }
    }
    throw new WebError11(`all search engines failed: ${errors.join("; ")}`, "WEB_PROVIDER_ERROR");
  }
  /** Parallel fuse: all engines run; successes merge via RRF. */
  async fuse(ids, query, maxResults, signal) {
    const settled = await Promise.allSettled(
      ids.map((id) => {
        const engine = this.options.engineById.get(id);
        if (engine === void 0) return Promise.resolve({ sources: [] });
        return engine.search(query, maxResults, signal);
      })
    );
    const errors = [];
    const lists = [];
    settled.forEach((outcome, index) => {
      const id = ids[index];
      if (id === void 0) return;
      if (outcome.status === "fulfilled") {
        this.cooldown.recordSuccess(id);
        if (outcome.value.sources.length > 0) lists.push([...outcome.value.sources]);
        else errors.push(`${id}: no results`);
      } else {
        if (signal.aborted) throw toWebError(outcome.reason, "web search aborted");
        this.cooldown.recordFailure(id);
        errors.push(`${id}: ${errorMessage(outcome.reason)}`);
      }
    });
    if (lists.length === 0) {
      throw new WebError11(`all search engines failed: ${errors.join("; ")}`, "WEB_PROVIDER_ERROR");
    }
    return { sources: reciprocalRankFuse(lists) };
  }
};
function searchCacheKey(query, engines, mode) {
  const normalized = query.toLowerCase().replace(/\s+/g, " ");
  return `multi:${mode}:${[...engines].join(",")}:${normalized}`;
}
function filterAndDedupe(sources) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const source of sources) {
    const key = normalizeUrl2(source.url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...source });
  }
  return result;
}
function toWebError(error, message) {
  if (error instanceof WebError11) return error;
  return new WebError11(message, "WEB_ABORTED", { cause: error });
}
function errorMessage(error) {
  if (error instanceof WebError11) return error.message;
  return String(error);
}
function cloneSearchResult(result) {
  return {
    sources: result.sources.map((source) => ({ ...source })),
    ...result.content !== void 0 ? { content: result.content } : {},
    truncated: result.truncated
  };
}

// src/search/index.ts
var DEFAULT_USER_AGENT2 = PRODUCT_USER_AGENT;
var WEB_SEARCH_MULTI_SETTINGS_NAMESPACE = settingsNamespace2("web-search-multi");
var Config4 = z4.object({
  engines: z4.array(z4.string()).default(["ddg", "bing", "exa", "deepseek", "jina", "searxng"]),
  mode: z4.union(["fallback", "fuse"]).default("fallback"),
  region: z4.string().default(""),
  enrich: z4.boolean().default(true),
  enrichFetchLimit: z4.number().default(10),
  enrichKeep: z4.number().default(5),
  enrichConcurrency: z4.number().default(4),
  pageTimeoutMs: z4.number().default(1e4),
  snippetChars: z4.number().default(300),
  searchCacheTtlMs: z4.number().default(9e5),
  pageCacheTtlMs: z4.number().default(216e5),
  cacheMaxSearches: z4.number().default(1e3),
  rateLimitPerSec: z4.number().default(1),
  userAgent: z4.string().default(DEFAULT_USER_AGENT2),
  blockedDomains: z4.array(z4.string()).default([]),
  timeoutMs: z4.number().default(3e4),
  cooldownBaseMs: z4.number().default(3e4),
  cooldownMaxMs: z4.number().default(36e5),
  freshness: z4.string().default(""),
  embedding: z4.object({ endpoint: z4.string().default(""), model: z4.string().default("") }).default({ endpoint: "", model: "" }),
  allowPrivateNetworks: z4.boolean().default(false)
});
var MAX_NODE_TIMER_DELAY_MS2 = 2147483647;
function assertPositiveFinite2(name2, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-search-multi: ${name2} must be a positive finite number`);
  }
}
function assertTimeoutMs2(value) {
  assertPositiveFinite2("timeoutMs", value);
  if (value > MAX_NODE_TIMER_DELAY_MS2) {
    throw new Error(`web-search-multi: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS2}`);
  }
}
function assertNonNegativeInteger2(name2, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-search-multi: ${name2} must be a non-negative integer`);
  }
}
function resolveKey(config, defaultEnv, env) {
  if (config?.apiKey !== void 0 && config.apiKey.length > 0) return config.apiKey;
  const ref = config?.apiKeyEnv ?? defaultEnv;
  return env.get(ref)?.value ?? "";
}
function makeResolver(ctx, ref) {
  const credential = credentialRef2(ref);
  return async () => {
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const resolved = await credentials.resolve(credential);
      if (resolved !== void 0 && resolved.value.length > 0) return resolved.value;
    }
    const ambient = launchEnvironmentOf(ctx).get(ref);
    return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
  };
}
function apply4(ctx, config, options = {}) {
  let current = () => config;
  installSettingsSection2(ctx, WEB_SEARCH_MULTI_SETTINGS_NAMESPACE, Config4, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
    }
  });
  const resolved = current();
  assertPositiveFinite2("enrichFetchLimit", resolved.enrichFetchLimit);
  assertPositiveFinite2("enrichKeep", resolved.enrichKeep);
  assertPositiveFinite2("enrichConcurrency", resolved.enrichConcurrency);
  assertPositiveFinite2("pageTimeoutMs", resolved.pageTimeoutMs);
  assertPositiveFinite2("snippetChars", resolved.snippetChars);
  assertPositiveFinite2("searchCacheTtlMs", resolved.searchCacheTtlMs);
  assertPositiveFinite2("pageCacheTtlMs", resolved.pageCacheTtlMs);
  assertPositiveFinite2("rateLimitPerSec", resolved.rateLimitPerSec);
  assertTimeoutMs2(resolved.timeoutMs);
  assertPositiveFinite2("cooldownBaseMs", resolved.cooldownBaseMs);
  assertPositiveFinite2("cooldownMaxMs", resolved.cooldownMaxMs);
  assertNonNegativeInteger2("cacheMaxSearches", resolved.cacheMaxSearches);
  const mode = resolved.mode;
  if (mode !== "fallback" && mode !== "fuse") {
    throw new Error(`web-search-multi: mode must be "fallback" or "fuse", got "${mode}"`);
  }
  const env = launchEnvironmentOf(ctx);
  let store;
  if (options.store !== void 0) {
    options.store.setEvictLimits({ maxSearches: resolved.cacheMaxSearches });
    store = options.store;
  } else {
    const owned = new WebStore({
      path: config.storePath ?? dshHomePath3("web.db"),
      evictLimits: { maxSearches: resolved.cacheMaxSearches }
    });
    ctx.effect(function* () {
      yield () => {
        void owned.close();
      };
    }, "web-search-multi.store.close()");
    store = owned;
  }
  const engines = [
    new DuckDuckGoEngine({
      endpoint: DUCKDUCKGO_DEFAULT_ENDPOINT,
      region: resolved.region,
      userAgent: resolved.userAgent,
      rateLimitPerSec: resolved.rateLimitPerSec,
      maxSerpBytes: 5e6,
      blockedDomains: resolved.blockedDomains
    }),
    new BingEngine({
      endpoint: BING_DEFAULT_ENDPOINT,
      market: resolved.region,
      userAgent: resolved.userAgent,
      rateLimitPerSec: resolved.rateLimitPerSec,
      maxSerpBytes: 5e6,
      blockedDomains: resolved.blockedDomains,
      freshness: resolved.freshness
    }),
    new ExaEngine({
      apiKey: resolveKey(config.exa, "EXA_API_KEY", env),
      resolveApiKey: makeResolver(ctx, config.exa?.apiKeyEnv ?? "EXA_API_KEY"),
      ...config.exa?.baseURL !== void 0 ? { baseURL: config.exa.baseURL } : {}
    }),
    new DeepSeekEngine({
      apiKey: resolveKey(config.deepseek, "DEEPSEEK_API_KEY", env),
      resolveApiKey: makeResolver(ctx, config.deepseek?.apiKeyEnv ?? "DEEPSEEK_API_KEY"),
      ...config.deepseek?.baseURL !== void 0 ? { baseURL: config.deepseek.baseURL } : {},
      ...config.deepseek?.model !== void 0 ? { model: config.deepseek.model } : {},
      ...config.deepseek?.maxUses !== void 0 ? { maxUses: config.deepseek.maxUses } : {}
    }),
    new JinaEngine({
      apiKey: resolveKey(config.jina, "JINA_API_KEY", env),
      resolveApiKey: makeResolver(ctx, config.jina?.apiKeyEnv ?? "JINA_API_KEY"),
      baseURL: config.jina?.baseURL ?? JINA_DEFAULT_BASE_URL,
      userAgent: resolved.userAgent,
      maxResponseBytes: 5e6
    }),
    new SearXNGEngine({
      endpoint: config.searxng?.endpoint ?? SEARXNG_DEFAULT_ENDPOINT,
      userAgent: resolved.userAgent,
      rateLimitPerSec: resolved.rateLimitPerSec,
      maxSerpBytes: 5e6,
      blockedDomains: resolved.blockedDomains
    })
  ];
  const engineById = new Map(engines.map((engine) => [engine.id, engine]));
  const provider = new MultiSearchProvider({
    engines: resolved.engines,
    ...config.engine !== void 0 ? { forcedEngine: config.engine } : {},
    mode: resolved.mode,
    defaultMaxResults: 10,
    store,
    engineById,
    enrich: resolved.enrich,
    enrichFetchLimit: resolved.enrichFetchLimit,
    enrichKeep: resolved.enrichKeep,
    searchCacheTtlMs: resolved.searchCacheTtlMs,
    pageCacheTtlMs: resolved.pageCacheTtlMs,
    timeoutMs: resolved.timeoutMs,
    cooldownBaseMs: resolved.cooldownBaseMs,
    cooldownMaxMs: resolved.cooldownMaxMs,
    enrichOptions: {
      pageTimeoutMs: resolved.pageTimeoutMs,
      pageCacheTtlMs: resolved.pageCacheTtlMs,
      maxPageBytes: 5e6,
      maxBodyChars: 1e5,
      snippetChars: resolved.snippetChars,
      userAgent: resolved.userAgent,
      concurrency: resolved.enrichConcurrency,
      allowPrivateNetworks: resolved.allowPrivateNetworks,
      ...resolved.embedding.endpoint.length > 0 ? {
        embedding: {
          endpoint: resolved.embedding.endpoint,
          model: resolved.embedding.model,
          userAgent: resolved.userAgent,
          maxResponseBytes: 5e6,
          timeoutMs: 1e4
        }
      } : {}
    },
    logger: {
      info: (message, ...meta) => ctx.logger?.info(message, ...meta)
    }
  });
  try {
    ctx.web.registerSearchProvider(provider);
  } catch (error) {
    if (error instanceof WebError12 && error.code === "WEB_DUPLICATE_PROVIDER") {
      throw new WebError12(
        'the "multi" search provider is already registered: the dsh-web-automation plugin and DSH built-in web packages (e.g. the local-web overlay) are mutually exclusive \u2014 keep one',
        "WEB_DUPLICATE_PROVIDER",
        { cause: error }
      );
    }
    throw error;
  }
}

// src/index.ts
var name = "dsh-web-automation";
var inject = ["web", "tools", "systemPrompt"];
var Config5 = z5.object({
  search: Config4.default({}),
  fetch: Config.default({}),
  platforms: Config3.default({}),
  history: Config2.default({})
});
function apply5(ctx, config) {
  const shared = config.search?.storePath === void 0 && config.fetch?.storePath === void 0 && config.history?.storePath === void 0;
  let sharedStore;
  if (shared) {
    sharedStore = new WebStore({ path: dshHomePath4("web.db") });
    const owned = sharedStore;
    ctx.effect(function* () {
      yield () => {
        void owned.close();
      };
    }, "web-automation.store.close()");
  }
  apply4(ctx, config.search ?? {}, shared ? { store: sharedStore } : {});
  apply(ctx, config.fetch ?? {}, shared ? { store: sharedStore } : {});
  apply3(ctx, config.platforms ?? {});
  apply2(ctx, config.history ?? {}, shared ? { store: sharedStore } : {});
}
export {
  Config5 as Config,
  apply5 as apply,
  inject,
  name
};
