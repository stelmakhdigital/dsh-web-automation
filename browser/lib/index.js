// src/index.ts
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z2 from "@deepseek-ai/schemastery";

// src/runtime.ts
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

// src/types.ts
import { HarnessError } from "@deepseek-ai/dsh-llm";
var BrowserError = class extends HarnessError {
};
var BROWSER_CODES = {
  UNAVAILABLE: "BROWSER_UNAVAILABLE",
  DUPLICATE_PROVIDER: "BROWSER_DUPLICATE_PROVIDER",
  NOT_OPEN: "BROWSER_NOT_OPEN",
  ALREADY_OPEN: "BROWSER_ALREADY_OPEN",
  INVALID_URL: "BROWSER_INVALID_URL",
  ACTION_FAILED: "BROWSER_ACTION_FAILED",
  TIMEOUT: "BROWSER_TIMEOUT",
  ABORTED: "BROWSER_ABORTED",
  APPROVAL_DENIED: "BROWSER_APPROVAL_DENIED",
  APPROVAL_UNAVAILABLE: "BROWSER_APPROVAL_UNAVAILABLE",
  AUTH_MISSING: "BROWSER_AUTH_MISSING",
  SSRF_BLOCKED: "BROWSER_SSRF_BLOCKED"
};

// src/runtime.ts
var BrowserRuntime = class extends Service {
  static Config = z.object({});
  providers = /* @__PURE__ */ new Map();
  /** Keyed by the agent object, or {@link ANON_KEY} when no agent is present. */
  sessions = /* @__PURE__ */ new Map();
  constructor(ctx, config = {}) {
    super(ctx, "browser");
    void config;
    const closeAll = this.closeAll.bind(this);
    ctx.effect(
      function* () {
        yield () => {
          void closeAll();
        };
      },
      "browser.closeAll()"
    );
  }
  /**
   * Register a browser provider. Throws {@link BrowserError}
   * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider) {
    if (this.providers.has(provider.id)) {
      throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, BROWSER_CODES.DUPLICATE_PROVIDER);
    }
    const store = this.providers;
    const dispose = this.ctx.effect(function* () {
      store.set(provider.id, provider);
      yield () => store.delete(provider.id);
    }, "browser.registerProvider()");
    return () => void dispose();
  }
  /**
   * The open session for `agent`, if any.
   * @param agent - the agent whose session to look up (omitted = the anonymous session).
   * @returns the open session, or undefined when none is open.
   */
  session(agent) {
    return this.sessions.get(agent ?? ANON_KEY);
  }
  /**
   * Open a browser session for `agent`. Throws {@link BrowserError}
   * `BROWSER_ALREADY_OPEN` when the agent already has an open session and
   * `BROWSER_UNAVAILABLE` when no usable provider is registered.
   * @param agent - the agent that owns the session (omitted = the anonymous session).
   * @param options - launch options (headless, auth profile, timeout).
   * @param signal - optional cancellation signal.
   * @returns the newly opened session.
   */
  async open(agent, options = {}, signal) {
    const key = agent ?? ANON_KEY;
    const existing = this.sessions.get(key);
    if (existing !== void 0) {
      throw new BrowserError("a browser session is already open for this agent; call browser_close first", BROWSER_CODES.ALREADY_OPEN);
    }
    const provider = this.resolveProvider();
    const session = await provider.open(options, signal);
    this.sessions.set(key, session);
    return session;
  }
  /**
   * Close and drop the open session for `agent`. A no-op when none is open.
   * @param agent - the agent whose session to close (omitted = the anonymous session).
   */
  async close(agent) {
    const session = this.sessions.get(agent ?? ANON_KEY);
    if (session === void 0) return;
    this.sessions.delete(agent ?? ANON_KEY);
    await session.close();
  }
  /** Close every open session (used on disposal). */
  async closeAll() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }
  resolveProvider() {
    const usable = [...this.providers.values()].filter((provider) => provider.available());
    const [single] = usable;
    if (single === void 0) {
      throw new BrowserError("no usable browser provider is registered", BROWSER_CODES.UNAVAILABLE);
    }
    if (usable.length > 1) {
      const ids = usable.map((provider) => provider.id).join(", ");
      throw new BrowserError(`multiple usable browser providers are registered (${ids}); register exactly one`, BROWSER_CODES.UNAVAILABLE);
    }
    return single;
  }
};
var ANON_KEY = /* @__PURE__ */ Symbol("browser-anon-session");
var runtime_default = BrowserRuntime;

// src/ssrf.ts
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
function ipv6ToGroups(text) {
  const bare = (text.split("%")[0] ?? "").toLowerCase();
  if (bare.length === 0) return void 0;
  const separatorIndex = bare.indexOf("::");
  const head = separatorIndex === -1 ? bare : bare.slice(0, separatorIndex);
  const tail = separatorIndex === -1 ? void 0 : bare.slice(separatorIndex + 2);
  const headGroups = head.length > 0 ? head.split(":") : [];
  const tailGroups = tail !== void 0 && tail.length > 0 ? tail.split(":") : [];
  const groups = [...headGroups, ...tailGroups];
  if (tail === void 0 && groups.length !== 8) return void 0;
  if (tail !== void 0 && groups.length > 7) return void 0;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return void 0;
  }
  const values = groups.map((group) => Number.parseInt(group, 16));
  const missing = 8 - values.length;
  const expanded = [
    ...values.slice(0, headGroups.length),
    ...Array.from({ length: missing }, () => 0),
    ...values.slice(headGroups.length)
  ];
  return expanded.length === 8 ? expanded : void 0;
}
function isPrivateIpv6(text) {
  const lower = text.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const groups = ipv6ToGroups(lower);
  if (groups !== void 0) {
    const g0 = groups[0] ?? 0;
    const g1 = groups[1] ?? 0;
    const g2 = groups[2] ?? 0;
    const g3 = groups[3] ?? 0;
    const g4 = groups[4] ?? 0;
    const g5 = groups[5] ?? 0;
    const g6 = groups[6] ?? 0;
    const g7 = groups[7] ?? 0;
    const mapped = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 65535;
    const compatible = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
    const nat64 = g0 === 100 && g1 === 65435 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
    if (mapped || compatible || nat64) {
      const ipv4 = (g6 << 16 | g7) >>> 0;
      const dotted = `${ipv4 >>> 24}.${ipv4 >>> 16 & 255}.${ipv4 >>> 8 & 255}.${ipv4 & 255}`;
      if (isPrivateIpv4(dotted)) return true;
    }
  }
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

// src/playwright.ts
async function assertPublicNavigation(url, allowPrivate) {
  const check = await checkSsrf(url, { allowPrivate });
  if (!check.allowed) {
    throw new BrowserError(
      `navigation to ${url} blocked by the SSRF guard: ${check.reason ?? "private/reserved target"}`,
      BROWSER_CODES.SSRF_BLOCKED
    );
  }
}
var DEFAULT_TIMEOUT_MS = 3e4;
var DEFAULT_MAX_TEXT_LENGTH = 2e4;
var DEFAULT_MAX_ELEMENTS = 200;
var playwrightModule;
var playwrightLoad;
var playwrightLoadFailed = false;
function loadPlaywright() {
  playwrightLoad ??= import("playwright").then(
    (mod) => {
      playwrightModule = mod;
      return mod;
    },
    (error) => {
      playwrightLoadFailed = true;
      throw error;
    }
  );
  return playwrightLoad;
}
var INTERACTIVE_SELECTOR = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="switch"]';
var PlaywrightProvider = class {
  id = "playwright";
  headless;
  timeoutMs;
  authProfiles;
  maxTextLength;
  maxElements;
  allowPrivateNetworks;
  constructor(config = {}) {
    this.headless = config.headless ?? true;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.authProfiles = config.authProfiles ?? {};
    this.maxTextLength = config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
    this.maxElements = config.maxElements ?? DEFAULT_MAX_ELEMENTS;
    this.allowPrivateNetworks = config.allowPrivateNetworks ?? false;
    void loadPlaywright().catch(() => void 0);
  }
  /** Cheap local usability check: the Chromium executable must resolve. */
  available() {
    if (playwrightModule !== void 0) {
      try {
        return playwrightModule.chromium.executablePath() !== "";
      } catch {
        return false;
      }
    }
    return !playwrightLoadFailed;
  }
  async open(options, signal) {
    throwIfAborted(signal);
    let pw;
    try {
      pw = await loadPlaywright();
    } catch (error) {
      throw new BrowserError(
        "playwright is not installed where the dsh-web-browser package is linked; install it into the profile (dsh plugin --profile <name> add playwright) or into the browser package directory (npm install)",
        BROWSER_CODES.UNAVAILABLE,
        { cause: error }
      );
    }
    const storageState = this.resolveStorageState(options.authProfile);
    const browser = await pw.chromium.launch({ headless: options.headless ?? this.headless });
    const contextOptions = {};
    if (storageState !== void 0) contextOptions.storageState = storageState;
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    return new PlaywrightSession(browser, page, this.timeoutMs, this.maxTextLength, this.maxElements, this.allowPrivateNetworks);
  }
  resolveStorageState(profileName) {
    if (profileName === void 0) return void 0;
    const path = this.authProfiles[profileName];
    if (path === void 0) {
      throw new BrowserError(
        `auth profile "${profileName}" is not configured; known profiles: ${Object.keys(this.authProfiles).join(", ") || "(none)"}`,
        BROWSER_CODES.AUTH_MISSING
      );
    }
    return path;
  }
};
var PlaywrightSession = class {
  constructor(browser, page, timeoutMs, maxTextLength, maxElements, allowPrivateNetworks) {
    this.browser = browser;
    this.page = page;
    this.timeoutMs = timeoutMs;
    this.maxTextLength = maxTextLength;
    this.maxElements = maxElements;
    this.allowPrivateNetworks = allowPrivateNetworks;
  }
  browser;
  page;
  timeoutMs;
  maxTextLength;
  maxElements;
  allowPrivateNetworks;
  providerId = "playwright";
  closed = false;
  url() {
    return this.page.url();
  }
  async navigate(url, signal) {
    this.ensureOpen(signal);
    const target = assertHttpUrl(url);
    await assertPublicNavigation(target, this.allowPrivateNetworks);
    try {
      await this.page.goto(target, { waitUntil: "load", timeout: this.timeoutMs });
    } catch (error) {
      throw classifyPlaywrightError(error, "navigate");
    }
    const finalUrl = this.page.url();
    if (finalUrl.length > 0 && finalUrl !== "about:blank") {
      await assertPublicNavigation(finalUrl, this.allowPrivateNetworks);
    }
    const title = await this.page.title().catch(() => void 0);
    return { url: finalUrl, ...title !== void 0 ? { title } : {} };
  }
  async snapshot(options = {}, signal) {
    this.ensureOpen(signal);
    const maxTextLength = options.maxTextLength ?? this.maxTextLength;
    const maxElements = options.maxElements ?? this.maxElements;
    const data = await this.page.evaluate(
      (selector) => {
        function roleFromTag(tag, el) {
          if (tag === "a") return "link";
          if (tag === "button") return "button";
          if (tag === "textarea") return "textbox";
          if (tag === "select") return "combobox";
          if (tag === "input") {
            const type = (el.getAttribute("type") ?? "text").toLowerCase();
            if (type === "checkbox") return "checkbox";
            if (type === "radio") return "radio";
            if (type === "button" || type === "submit" || type === "reset") return "button";
            return "textbox";
          }
          return tag;
        }
        function accessibleName(el, tag) {
          const ariaLabel = el.getAttribute("aria-label");
          if (ariaLabel !== null && ariaLabel !== "") return ariaLabel.trim();
          if (tag === "input") {
            const placeholder = el.getAttribute("placeholder");
            if (placeholder !== null && placeholder !== "") return placeholder.trim();
            const name2 = el.getAttribute("name");
            if (name2 !== null && name2 !== "") return name2.trim();
          }
          const rawText = el.textContent;
          const text2 = (rawText ?? "").trim().replace(/\s+/g, " ");
          if (text2 !== "") return text2.length > 120 ? `${text2.slice(0, 117)}...` : text2;
          const id = el.getAttribute("id");
          return id !== null && id !== "" ? id : "(unnamed)";
        }
        const elements2 = [];
        const nodes = Array.from(document.querySelectorAll(selector));
        let index = 0;
        for (const el of nodes) {
          if (el.getClientRects().length === 0) continue;
          const ref = `@e${index + 1}`;
          index += 1;
          el.setAttribute("data-dsh-ref", ref);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") ?? roleFromTag(tag, el);
          const name2 = accessibleName(el, tag);
          const href = tag === "a" ? el.getAttribute("href") : null;
          elements2.push({ role, name: name2, tag, href });
        }
        const text = document.body.innerText;
        return { elements: elements2, text };
      },
      INTERACTIVE_SELECTOR
    );
    const elements = data.elements.slice(0, maxElements).map((el, i) => ({
      ref: `@e${i + 1}`,
      role: el.role,
      name: el.name,
      tag: el.tag,
      ...el.href !== null && el.href !== "" ? { href: el.href } : {}
    }));
    const truncated = data.elements.length > maxElements || data.text.length > maxTextLength;
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => ""),
      elements,
      text: data.text.slice(0, maxTextLength),
      truncated
    };
  }
  async click(target, signal) {
    this.ensureOpen(signal);
    const locator = this.locatorFor(target);
    try {
      await locator.click({ timeout: this.timeoutMs });
    } catch (error) {
      throw classifyPlaywrightError(error, "click");
    }
  }
  async type(target, text, signal) {
    this.ensureOpen(signal);
    const locator = this.locatorFor(target);
    try {
      await locator.fill(text, { timeout: this.timeoutMs });
    } catch (error) {
      throw classifyPlaywrightError(error, "type");
    }
  }
  async evaluate(expression, signal) {
    this.ensureOpen(signal);
    try {
      return await this.page.evaluate(expression);
    } catch (error) {
      throw classifyPlaywrightError(error, "evaluate");
    }
  }
  async screenshot(options = {}, signal) {
    this.ensureOpen(signal);
    try {
      const buffer = options.selector !== void 0 ? await this.page.locator(options.selector).screenshot({ timeout: this.timeoutMs }) : await this.page.screenshot({ fullPage: options.fullPage ?? false, timeout: this.timeoutMs });
      return { buffer, mimeType: "image/png" };
    } catch (error) {
      throw classifyPlaywrightError(error, "screenshot");
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.browser.close().catch(() => void 0);
  }
  locatorFor(target) {
    return target.kind === "ref" ? this.page.locator(`[data-dsh-ref="${target.ref}"]`) : this.page.locator(target.selector);
  }
  ensureOpen(signal) {
    if (this.closed) throw new BrowserError("the browser session is closed; open a new one", BROWSER_CODES.NOT_OPEN);
    throwIfAborted(signal);
  }
};
function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserError(`invalid URL: ${url}`, BROWSER_CODES.INVALID_URL);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserError(`only http(s) URLs are supported, got "${parsed.protocol}"`, BROWSER_CODES.INVALID_URL);
  }
  return parsed.toString();
}
function throwIfAborted(signal) {
  if (signal !== void 0 && signal.aborted) {
    throw new BrowserError("the browser action was aborted", BROWSER_CODES.ABORTED);
  }
}
function classifyPlaywrightError(error, action) {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout/i.test(message)) {
    return new BrowserError(`browser ${action} timed out: ${message}`, BROWSER_CODES.TIMEOUT, { cause: error });
  }
  if (/target closed|browser has been closed|context closed/i.test(message)) {
    return new BrowserError(`browser ${action} failed (session closed): ${message}`, BROWSER_CODES.NOT_OPEN, { cause: error });
  }
  return new BrowserError(`browser ${action} failed: ${message}`, BROWSER_CODES.ACTION_FAILED, { cause: error });
}

// src/tools.ts
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/screenshot.ts
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
async function writeScreenshot(buffer, dir) {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `browser-${randomUUID()}.png`);
  await writeFile(path, buffer);
  return path;
}

// src/tools.ts
function textBlock(text) {
  return [{ type: "text", text }];
}
function renderSnapshot(value) {
  const lines = [`URL: ${value.url}`, `Title: ${value.title}`, ""];
  if (value.elements.length === 0) {
    lines.push("No interactive elements.");
  } else {
    lines.push("Interactive elements (click/type by ref or selector):");
    for (const el of value.elements) {
      const href = el.href !== void 0 ? ` (${el.href})` : "";
      lines.push(`  ${el.ref} [${el.role}] "${el.name}"${href}`);
    }
  }
  lines.push("", "Page text:");
  lines.push(value.text === "" ? "(empty)" : value.text);
  if (value.truncated) lines.push("(truncated)");
  return lines.join("\n");
}
function assertHttpUrl2(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BrowserError(`invalid URL: ${url}`, BROWSER_CODES.INVALID_URL);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BrowserError(`only http(s) URLs are supported, got "${parsed.protocol}"`, BROWSER_CODES.INVALID_URL);
  }
  return parsed.toString();
}
function toJsonValue(value) {
  if (value === void 0) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return typeof value === "string" ? value : "[unserializable value]";
  }
}
function registerBrowserTools(ctx, options) {
  const approval = options.approval;
  const screenshotDir = options.screenshotDir ?? join2(tmpdir(), "dsh-browser-screenshots");
  const requiresApproval = (action) => {
    if (approval === "never") return false;
    if (approval === "all") return true;
    return action === "navigate" || action === "evaluate";
  };
  const getSession = (exec) => {
    const session = ctx.browser.session(exec.agent);
    if (session === void 0) {
      throw new BrowserError("no browser session is open; call browser_open first", BROWSER_CODES.NOT_OPEN);
    }
    return session;
  };
  const targetFrom = (ref, selector) => {
    if (ref !== void 0 && ref !== "") return { kind: "ref", ref };
    if (selector !== void 0 && selector !== "") return { kind: "selector", selector };
    throw new BrowserError('provide either "ref" (from the latest snapshot) or "selector" (a CSS selector)', BROWSER_CODES.ACTION_FAILED);
  };
  ctx.tools.register(defineTool({
    name: "browser_open",
    description: "Open a browser session (launches a local Chromium). Call once before other browser_* tools. Optionally restore an auth profile (saved login state).",
    parameters: {
      headless: { type: "boolean", description: "Run headless (no visible window). Defaults to the configured value (true)." },
      authProfile: { type: "string", description: "Name of a configured auth profile (storage state) to restore, e.g. a saved login." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          providerId: { type: "string", required: true },
          url: { type: "string", required: true }
        }
      },
      render: (_args, value) => textBlock(`Opened browser (${value.providerId}) at ${value.url}`)
    },
    async execute(args, exec) {
      const session = await ctx.browser.open(exec.agent, {
        ...typeof args.headless === "boolean" ? { headless: args.headless } : {},
        ...args.authProfile !== void 0 && args.authProfile !== "" ? { authProfile: args.authProfile } : {}
      }, exec.signal);
      return { providerId: session.providerId, url: session.url() };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_navigate",
    description: "Navigate the open browser to an http(s) URL and wait for load. Returns the final URL and title.",
    parameters: {
      url: { type: "string", required: true, description: "The http(s) URL to navigate to." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" }
        }
      },
      render: (_args, value) => textBlock(`Navigated to ${value.url}${value.title !== void 0 ? ` \u2014 ${value.title}` : ""}`)
    },
    async execute(args, exec) {
      const target = assertHttpUrl2(args.url);
      await approve("navigate", `Navigate the browser to ${target}`, exec);
      const session = getSession(exec);
      return session.navigate(target, exec.signal);
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_snapshot",
    description: 'Capture a normalized snapshot of the current page: interactive elements (each with a ref you can click/type into) plus the visible text. Call this to "see" a page before acting.',
    parameters: {
      maxTextLength: { type: "number", description: "Upper bound on the visible-text length. Defaults to the configured value." },
      maxElements: { type: "number", description: "Upper bound on the number of interactive elements returned. Defaults to the configured value." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          elements: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                ref: { type: "string", required: true },
                role: { type: "string", required: true },
                name: { type: "string", required: true },
                tag: { type: "string", required: true },
                href: { type: "string" }
              }
            }
          },
          text: { type: "string", required: true },
          truncated: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => textBlock(renderSnapshot(value))
    },
    async execute(args, exec) {
      const session = getSession(exec);
      const snap = await session.snapshot({
        ...typeof args.maxTextLength === "number" ? { maxTextLength: args.maxTextLength } : {},
        ...typeof args.maxElements === "number" ? { maxElements: args.maxElements } : {}
      }, exec.signal);
      return { url: snap.url, title: snap.title, elements: [...snap.elements], text: snap.text, truncated: snap.truncated };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_click",
    description: 'Click an element on the current page, addressed by a snapshot ref (e.g. "@e3") or a CSS selector.',
    parameters: {
      ref: { type: "string", description: 'A snapshot element ref (e.g. "@e3").' },
      selector: { type: "string", description: "A CSS selector for the element." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render: () => textBlock("Clicked the element.")
    },
    async execute(args, exec) {
      if (requiresApproval("click")) await approve("click", "Click an element in the browser", exec);
      const session = getSession(exec);
      await session.click(targetFrom(args.ref, args.selector), exec.signal);
      return { ok: true };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_type",
    description: "Type text into an element on the current page (replacing its value), addressed by a snapshot ref or a CSS selector.",
    parameters: {
      ref: { type: "string", description: 'A snapshot element ref (e.g. "@e3").' },
      selector: { type: "string", description: "A CSS selector for the element." },
      text: { type: "string", required: true, description: "The text to type." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render: () => textBlock("Typed the text into the element.")
    },
    async execute(args, exec) {
      if (requiresApproval("type")) await approve("type", "Type text into an element in the browser", exec);
      const session = getSession(exec);
      await session.type(targetFrom(args.ref, args.selector), args.text, exec.signal);
      return { ok: true };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_evaluate",
    description: "Evaluate a JavaScript expression in the current page context and return its JSON-serializable result. Use for reading page state not covered by a snapshot.",
    parameters: {
      expression: { type: "string", required: true, description: 'A JavaScript expression to evaluate in the page (e.g. "document.title" or "window.location.href").' }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { result: { type: "json" } } },
      render: (_args, value) => textBlock(`Result: ${JSON.stringify(value.result)}`)
    },
    async execute(args, exec) {
      await approve("evaluate", `Evaluate JavaScript in the browser: ${args.expression}`, exec);
      const session = getSession(exec);
      const result = await session.evaluate(args.expression, exec.signal);
      return { result: toJsonValue(result) };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the current page (or one element). By default saves to a file and returns the path. With `inline: true`, returns the image as base64 (inlined into the model context).",
    parameters: {
      fullPage: { type: "boolean", description: "Capture the full scrollable page, not just the viewport." },
      selector: { type: "string", description: "A CSS selector to capture a single element instead of the page." },
      inline: { type: "boolean", description: "Return the image as base64 (inlined into the model context) instead of saving to a file." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", description: "File path (when inline is false)." },
          mimeType: { type: "string", required: true },
          base64: { type: "string", description: "Base64-encoded PNG (when inline is true)." }
        }
      },
      render: (_args, value) => textBlock(value.base64 !== void 0 ? "Screenshot captured (inlined)." : `Screenshot saved to ${value.path}`)
    },
    async execute(args, exec) {
      const session = getSession(exec);
      const shot = await session.screenshot({
        ...typeof args.fullPage === "boolean" ? { fullPage: args.fullPage } : {},
        ...args.selector !== void 0 && args.selector !== "" ? { selector: args.selector } : {}
      }, exec.signal);
      if (args.inline === true) {
        return { mimeType: shot.mimeType, base64: shot.buffer.toString("base64") };
      }
      const path = await writeScreenshot(shot.buffer, screenshotDir);
      return { path, mimeType: shot.mimeType };
    }
  }));
  ctx.tools.register(defineTool({
    name: "browser_close",
    description: "Close the open browser session and release the browser. Call when done.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean", required: true } } },
      render: () => textBlock("Closed the browser.")
    },
    async execute(_args, exec) {
      await ctx.browser.close(exec.agent);
      return { ok: true };
    }
  }));
  async function approve(action, reason, exec) {
    if (!requiresApproval(action)) return;
    if (exec.agent === void 0) {
      throw new BrowserError(
        `approval is required for browser ${action}, but the call has no agent to route it through`,
        BROWSER_CODES.APPROVAL_UNAVAILABLE
      );
    }
    const approver = ctx.get("approval");
    if (approver === void 0) {
      throw new BrowserError(
        `approval is required for browser ${action} but the approval service is unavailable; set approval: "never" to disable`,
        BROWSER_CODES.APPROVAL_UNAVAILABLE
      );
    }
    const outcome = await approver.request({
      agent: exec.agent,
      toolName: `browser_${action}`,
      callId: exec.callId,
      reason,
      signal: exec.signal
    });
    if (outcome !== "allowed-once") {
      throw new BrowserError(`browser ${action} was not approved (outcome: ${outcome})`, BROWSER_CODES.APPROVAL_DENIED);
    }
  }
}

// src/index.ts
var name = "web-browser";
var inject = ["tools", "systemPrompt"];
var WEB_BROWSER_SETTINGS_NAMESPACE = settingsNamespace("web-browser");
var DEFAULT_BROWSER_TIMEOUT_MS = 3e4;
var DEFAULT_BROWSER_MAX_TEXT_LENGTH = 2e4;
var DEFAULT_BROWSER_MAX_ELEMENTS = 200;
var Config = z2.object({
  tool: z2.boolean().default(true),
  headless: z2.boolean().default(true),
  approval: z2.union(["never", "navigate", "all"]).default("never"),
  timeoutMs: z2.number().default(DEFAULT_BROWSER_TIMEOUT_MS),
  maxTextLength: z2.number().default(DEFAULT_BROWSER_MAX_TEXT_LENGTH),
  maxElements: z2.number().default(DEFAULT_BROWSER_MAX_ELEMENTS),
  authProfiles: z2.dict(z2.string()).default({}),
  allowPrivateNetworks: z2.boolean().default(false)
});
function assertPositiveInteger(name2, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`web-browser: ${name2} must be a positive integer`);
  }
}
function apply(ctx, config) {
  let current = () => config;
  installSettingsSection(ctx, WEB_BROWSER_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source;
    },
    onChange: () => {
    }
  });
  const resolved = current();
  assertPositiveInteger("timeoutMs", resolved.timeoutMs);
  assertPositiveInteger("maxTextLength", resolved.maxTextLength);
  assertPositiveInteger("maxElements", resolved.maxElements);
  new runtime_default(ctx, {});
  ctx.browser.registerProvider(new PlaywrightProvider({
    headless: resolved.headless,
    timeoutMs: resolved.timeoutMs,
    maxTextLength: resolved.maxTextLength,
    maxElements: resolved.maxElements,
    authProfiles: resolved.authProfiles,
    allowPrivateNetworks: resolved.allowPrivateNetworks
  }));
  ctx.systemPrompt.section({
    name: "tool:browser",
    order: 118,
    text: 'Drive a local browser with the browser_* tools: browser_open (once), then browser_navigate + browser_snapshot to see a page, then browser_click / browser_type (by snapshot ref like "@e3" or a CSS selector), browser_evaluate for page state, browser_screenshot for a PNG, and browser_close when done. Take a snapshot after any action that changes the page.'
  });
  if (!resolved.tool) return;
  registerBrowserTools(ctx, { approval: resolved.approval });
}
export {
  BROWSER_CODES,
  BrowserError,
  BrowserRuntime,
  Config,
  DEFAULT_BROWSER_MAX_ELEMENTS,
  DEFAULT_BROWSER_MAX_TEXT_LENGTH,
  DEFAULT_BROWSER_TIMEOUT_MS,
  PlaywrightProvider,
  WEB_BROWSER_SETTINGS_NAMESPACE,
  apply,
  inject,
  name,
  registerBrowserTools
};
