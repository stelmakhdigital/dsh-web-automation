/**
 * The model-facing `browser_*` tools. Each tool operates on the per-agent
 * session owned by `ctx.browser`. Sensitive actions (navigation, script
 * evaluation, and — in `all` mode — clicks/types) are gated by the approval
 * service when the configured {@link BrowserApprovalMode} requires it.
 * @module @deepseek-ai/dsh-web-browser/tools
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { writeScreenshot } from './screenshot.ts'
import type { BrowserElement, BrowserSession, BrowserTarget } from './types.ts'
import { BrowserError, BROWSER_CODES } from './types.ts'

/** Which browser actions require an approval grant before running. */
export type BrowserApprovalMode = 'never' | 'navigate' | 'all'

export interface BrowserToolOptions {
  /** Approval policy for sensitive actions. Default `'never'`. */
  readonly approval: BrowserApprovalMode
  /** Directory screenshots are written to. Default: the OS temp dir. */
  readonly screenshotDir?: string
}

/** A single text content block. */
function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/** Render a snapshot as a readable element list plus page text. */
function renderSnapshot(
  value: { url: string; title: string; elements: readonly BrowserElement[]; text: string; truncated: boolean },
): string {
  const lines: string[] = [`URL: ${value.url}`, `Title: ${value.title}`, '']
  if (value.elements.length === 0) {
    lines.push('No interactive elements.')
  } else {
    lines.push('Interactive elements (click/type by ref or selector):')
    for (const el of value.elements) {
      const href = el.href !== undefined ? ` (${el.href})` : ''
      lines.push(`  ${el.ref} [${el.role}] "${el.name}"${href}`)
    }
  }
  lines.push('', 'Page text:')
  lines.push(value.text === '' ? '(empty)' : value.text)
  if (value.truncated) lines.push('(truncated)')
  return lines.join('\n')
}

/** Validate a navigation URL is http(s) (enforced at the tool boundary, provider-agnostic). */
function assertHttpUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new BrowserError(`invalid URL: ${url}`, BROWSER_CODES.INVALID_URL)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BrowserError(`only http(s) URLs are supported, got "${parsed.protocol}"`, BROWSER_CODES.INVALID_URL)
  }
  return parsed.toString()
}

/** Coerce an evaluated page value to a lossless JSON value (the tool output contract). */
function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue
  } catch {
    // Unserializable (e.g. a circular structure from page.evaluate); report a
    // stable marker rather than a lossy object stringification.
    return typeof value === 'string' ? value : '[unserializable value]'
  }
}

/** Register the `browser_*` tools on `ctx`. */
export function registerBrowserTools(ctx: Context, options: BrowserToolOptions): void {
  const approval = options.approval
  const screenshotDir = options.screenshotDir ?? join(tmpdir(), 'dsh-browser-screenshots')

  const requiresApproval = (action: 'navigate' | 'evaluate' | 'click' | 'type'): boolean => {
    if (approval === 'never') return false
    if (approval === 'all') return true
    return action === 'navigate' || action === 'evaluate'
  }

  const getSession = (exec: ToolRunContext): BrowserSession => {
    const session = ctx.browser.session(exec.agent)
    if (session === undefined) {
      throw new BrowserError('no browser session is open; call browser_open first', BROWSER_CODES.NOT_OPEN)
    }
    return session
  }

  const targetFrom = (ref: string | undefined, selector: string | undefined): BrowserTarget => {
    if (ref !== undefined && ref !== '') return { kind: 'ref', ref }
    if (selector !== undefined && selector !== '') return { kind: 'selector', selector }
    throw new BrowserError('provide either "ref" (from the latest snapshot) or "selector" (a CSS selector)', BROWSER_CODES.ACTION_FAILED)
  }

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open a browser session (launches a local Chromium). Call once before other browser_* tools. Optionally restore an auth profile (saved login state).',
    parameters: {
      headless: { type: 'boolean', description: 'Run headless (no visible window). Defaults to the configured value (true).' },
      authProfile: { type: 'string', description: 'Name of a configured auth profile (storage state) to restore, e.g. a saved login.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providerId: { type: 'string', required: true },
          url: { type: 'string', required: true },
        },
      },
      render: (_args, value) => textBlock(`Opened browser (${value.providerId}) at ${value.url}`),
    },
    async execute(args, exec) {
      const session = await ctx.browser.open(exec.agent, {
        ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
        ...(args.authProfile !== undefined && args.authProfile !== '' ? { authProfile: args.authProfile } : {}),
      }, exec.signal)
      return { providerId: session.providerId, url: session.url() }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate the open browser to an http(s) URL and wait for load. Returns the final URL and title.',
    parameters: {
      url: { type: 'string', required: true, description: 'The http(s) URL to navigate to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string' },
        },
      },
      render: (_args, value) => textBlock(`Navigated to ${value.url}${value.title !== undefined ? ` — ${value.title}` : ''}`),
    },
    async execute(args, exec) {
      const target = assertHttpUrl(args.url)
      await approve('navigate', `Navigate the browser to ${target}`, exec)
      const session = getSession(exec)
      return session.navigate(target, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Capture a normalized snapshot of the current page: interactive elements (each with a ref you can click/type into) plus the visible text. Call this to "see" a page before acting.',
    parameters: {
      maxTextLength: { type: 'number', description: 'Upper bound on the visible-text length. Defaults to the configured value.' },
      maxElements: { type: 'number', description: 'Upper bound on the number of interactive elements returned. Defaults to the configured value.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          elements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ref: { type: 'string', required: true },
                role: { type: 'string', required: true },
                name: { type: 'string', required: true },
                tag: { type: 'string', required: true },
                href: { type: 'string' },
              },
            },
          },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => textBlock(renderSnapshot(value)),
    },
    async execute(args, exec) {
      const session = getSession(exec)
      const snap = await session.snapshot({
        ...(typeof args.maxTextLength === 'number' ? { maxTextLength: args.maxTextLength } : {}),
        ...(typeof args.maxElements === 'number' ? { maxElements: args.maxElements } : {}),
      }, exec.signal)
      return { url: snap.url, title: snap.title, elements: [...snap.elements], text: snap.text, truncated: snap.truncated }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element on the current page, addressed by a snapshot ref (e.g. "@e3") or a CSS selector.',
    parameters: {
      ref: { type: 'string', description: 'A snapshot element ref (e.g. "@e3").' },
      selector: { type: 'string', description: 'A CSS selector for the element.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => textBlock('Clicked the element.'),
    },
    async execute(args, exec) {
      if (requiresApproval('click')) await approve('click', 'Click an element in the browser', exec)
      const session = getSession(exec)
      await session.click(targetFrom(args.ref, args.selector), exec.signal)
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an element on the current page (replacing its value), addressed by a snapshot ref or a CSS selector.',
    parameters: {
      ref: { type: 'string', description: 'A snapshot element ref (e.g. "@e3").' },
      selector: { type: 'string', description: 'A CSS selector for the element.' },
      text: { type: 'string', required: true, description: 'The text to type.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => textBlock('Typed the text into the element.'),
    },
    async execute(args, exec) {
      if (requiresApproval('type')) await approve('type', 'Type text into an element in the browser', exec)
      const session = getSession(exec)
      await session.type(targetFrom(args.ref, args.selector), args.text, exec.signal)
      return { ok: true }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the current page context and return its JSON-serializable result. Use for reading page state not covered by a snapshot.',
    parameters: {
      expression: { type: 'string', required: true, description: 'A JavaScript expression to evaluate in the page (e.g. "document.title" or "window.location.href").' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { result: { type: 'json' } } },
      render: (_args, value) => textBlock(`Result: ${JSON.stringify(value.result)}`),
    },
    async execute(args, exec) {
      await approve('evaluate', `Evaluate JavaScript in the browser: ${args.expression}`, exec)
      const session = getSession(exec)
      const result = await session.evaluate(args.expression, exec.signal)
      return { result: toJsonValue(result) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current page (or one element). By default saves to a file and returns the path. With `inline: true`, returns the image as base64 (inlined into the model context).',
    parameters: {
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page, not just the viewport.' },
      selector: { type: 'string', description: 'A CSS selector to capture a single element instead of the page.' },
      inline: { type: 'boolean', description: 'Return the image as base64 (inlined into the model context) instead of saving to a file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: 'File path (when inline is false).' },
          mimeType: { type: 'string', required: true },
          base64: { type: 'string', description: 'Base64-encoded PNG (when inline is true).' },
        },
      },
      render: (_args, value) => textBlock(value.base64 !== undefined ? 'Screenshot captured (inlined).' : `Screenshot saved to ${value.path}`),
    },
    async execute(args, exec) {
      const session = getSession(exec)
      const shot = await session.screenshot({
        ...(typeof args.fullPage === 'boolean' ? { fullPage: args.fullPage } : {}),
        ...(args.selector !== undefined && args.selector !== '' ? { selector: args.selector } : {}),
      }, exec.signal)
      if (args.inline === true) {
        // Inline: return the image as base64 (no file write).
        return { mimeType: shot.mimeType, base64: shot.buffer.toString('base64') }
      }
      // The directory is created lazily (mkdir recursive) so the default
      // temp-dir path works out of the box.
      const path = await writeScreenshot(shot.buffer, screenshotDir)
      return { path, mimeType: shot.mimeType }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close the open browser session and release the browser. Call when done.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => textBlock('Closed the browser.'),
    },
    async execute(_args, exec) {
      await ctx.browser.close(exec.agent)
      return { ok: true }
    },
  }))

  async function approve(action: 'navigate' | 'evaluate' | 'click' | 'type', reason: string, exec: ToolRunContext): Promise<void> {
    if (!requiresApproval(action)) return
    // Fail CLOSED when the approval grant cannot be routed: without an agent
    // there is no session to audit to and no UI to route to (same semantics as
    // the core tools' approval seam), so the action is denied, not skipped.
    if (exec.agent === undefined) {
      throw new BrowserError(
        `approval is required for browser ${action}, but the call has no agent to route it through`,
        BROWSER_CODES.APPROVAL_UNAVAILABLE,
      )
    }
    const approver = ctx.get('approval')
    if (approver === undefined) {
      throw new BrowserError(
        `approval is required for browser ${action} but the approval service is unavailable; set approval: "never" to disable`,
        BROWSER_CODES.APPROVAL_UNAVAILABLE,
      )
    }
    const outcome = await approver.request({
      agent: exec.agent,
      toolName: `browser_${action}`,
      callId: exec.callId,
      reason,
      signal: exec.signal,
    })
    if (outcome !== 'allowed-once') {
      throw new BrowserError(`browser ${action} was not approved (outcome: ${outcome})`, BROWSER_CODES.APPROVAL_DENIED)
    }
  }
}
