/**
 * Type stubs for the `@deepseek-ai/*` peer dependencies. These are resolved
 * from the host DSH deployment at runtime; they are not installed in the
 * plugin's own `node_modules` (peer deps). This stub file lets `tsc` typecheck
 * the plugin in isolation (CI, editor) without the host's packages.
 *
 * The stubs mirror the public API surface the plugin imports, with the real
 * signatures (checked against the DSH checkout). They are not a full API
 * mirror — only the members the plugin actually uses are declared. The
 * `typecheck:host` CI job replaces these stubs with the host's real `.d.ts`
 * files for a stricter check.
 */

declare module '@deepseek-ai/cordis' {
  import type { WebSearchProvider, WebFetchProvider } from '@deepseek-ai/dsh-web'
  import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

  export interface Logger {
    info(message: string, ...meta: unknown[]): void
    warn(message: string, ...meta: unknown[]): void
    error(message: string, ...meta: unknown[]): void
    debug(message: string, ...meta: unknown[]): void
  }

  /** The `web` seam: provider registration (seam selection happens in the host). */
  export interface WebSeam {
    registerSearchProvider(provider: WebSearchProvider): () => void
    registerFetchProvider(provider: WebFetchProvider): () => void
  }

  /** The `tools` service: tool registration. */
  export interface ToolsService {
    register(definition: ToolDefinition): () => void
  }

  /** The `systemPrompt` service: ordered prompt sections. */
  export interface SystemPromptService {
    section(section: { name: string; order?: number; text: string }): void
  }

  /** The `invariants` service: startup invariant registration. */
  export interface InvariantsService {
    /** Register an invariant; returns the registration's disposer. */
    register(name: string, installer: (ctx: Context) => Promise<void> | void): () => void
  }

  /**
   * An effect body: a disposer, or a (possibly async) generator — or a
   * function returning one — yielding disposers. Mirrors cordis' `Effect`
   * type (plugins pass `function* () { yield dispose }` thunks).
   */
  export type EffectBody =
    | (() => void)
    | (() => Promise<void>)
    | Generator<() => void | Promise<void>, void, unknown>
    | AsyncGenerator<() => void | Promise<void>, void, unknown>
    | (() => Generator<() => void | Promise<void>, void, unknown>)
    | (() => AsyncGenerator<() => void | Promise<void>, void, unknown>)

  export interface Context {
    web: WebSeam
    tools: ToolsService
    systemPrompt: SystemPromptService
    invariants: InvariantsService
    logger: Logger
    /** Look up a service by name in the current context. */
    get<T = any>(key: string): T | undefined
    /** Inject named dependencies and run the callback with the extended context. */
    inject(keys: string[], fn: (ctx: Context) => void): void
    /** User-settings seam; present after `ctx.inject(['settings'], ...)`. */
    settings: import('@deepseek-ai/dsh-settings').SettingsProvider
    /**
     * Register a lifecycle effect on the current fiber; the disposer(s) run
     * when the fiber is disposed (HMR / context teardown).
     */
    effect(body: EffectBody, label?: string): () => void
    [key: string]: any
  }

  /** A named service instance registered in a context (cordis `Service`). */
  export abstract class Service {
    constructor(protected ctx: Context, name: string)
    readonly name: string
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-credentials' {
  export type CredentialRef = string & { __brand: 'CredentialRef' }
  export function credentialRef(ref: string): CredentialRef
  export interface ResolvedCredential {
    value: string
    source: string
  }
  export interface CredentialsService {
    resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>
  }
}

declare module '@deepseek-ai/dsh-home-paths' {
  export function dshHomePath(...parts: string[]): string
}

declare module '@deepseek-ai/dsh-invariants' {
  export type InvariantInstaller = (ctx: any) => Promise<void> | void
  export interface InvariantsService {
    register(name: string, installer: InvariantInstaller): void
  }
}

declare module '@deepseek-ai/dsh-launch-environment' {
  export interface LaunchEnvironmentEntry {
    value: string
    source: string
    path?: string
  }
  export interface LaunchEnvironmentSnapshot {
    get(name: string): LaunchEnvironmentEntry | undefined
  }
  export function launchEnvironmentOf(ctx: any): LaunchEnvironmentSnapshot
}

declare module '@deepseek-ai/dsh-settings' {
  export interface SettingsSectionHooks<T = any> {
    setSource(current: () => T): void
    onChange(): void
    validate?: (value: T) => void
  }
  export interface SettingsProvider {
    installSection(owner: any, ns: string, schema: any, entry: any, hooks: SettingsSectionHooks): void
  }
}

declare module '@deepseek-ai/dsh-timeout' {
  export class TimeoutReason extends Error {
    constructor(code: string)
    readonly code: string
  }
  export const MAX_TIMER_DELAY_MS: number
  export function clampTimeout(ms: number, code: string): number
  export interface Deadline {
    readonly signal: AbortSignal
    [Symbol.dispose](): void
  }
  export function deadline(signal: AbortSignal | undefined, ms: number, code: string): Deadline
  export function timeoutOf(x: AbortSignal | { reason?: unknown }, code?: string): TimeoutReason | undefined
}

declare module '@deepseek-ai/dsh-tools' {
  export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
  /**
   * The execution context handed to a tool's `execute`. Mirrors the host's
   * `ToolRunContext` (the members the plugin uses).
   */
  export interface ToolRunContext {
    /** The model-requested call id. */
    readonly callId: string
    /** The tool name. */
    readonly name: string
    /** The agent on whose behalf the call runs (undefined for anonymous). */
    readonly agent?: unknown
    /** Caller-owned cancellation for this invocation. */
    readonly signal: AbortSignal
    [key: string]: any
  }
  export interface ToolDefinition {
    name: string
    description: string
    parameters: any
    output?: { schema: any; render: (args: any, value: any) => any }
    execute: (args: any, exec: ToolRunContext) => Promise<any> | any
    [key: string]: any
  }
  export function defineTool(def: ToolDefinition): ToolDefinition
  export function textBlock(text: string): any
}

declare module '@deepseek-ai/dsh-web' {
  /** The web seam's error type (extends the harness error with a stable code). */
  export class WebError extends Error {
    constructor(message: string, code: string, options?: { cause?: unknown })
    readonly code: string
  }
  export interface WebSearchSource {
    url: string
    title?: string
    snippet?: string
    [key: string]: any
  }
  export interface WebSearchRequest {
    query: string
    maxResults?: number
    [key: string]: any
  }
  export interface WebSearchResult {
    sources: readonly WebSearchSource[]
    content?: string
    truncated: boolean
    [key: string]: any
  }
  export interface WebSearchProvider {
    readonly id: string
    available(): boolean
    search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult>
  }
  export interface WebFetchRequest {
    readonly url: string
  }
  export type WebFetchBody =
    | { readonly kind: 'html'; readonly content: string }
    | { readonly kind: 'text'; readonly content: string }
  export interface WebFetchResult {
    readonly url: string
    readonly statusCode: number
    readonly body: WebFetchBody
    readonly truncated: boolean
  }
  export interface WebFetchProvider {
    readonly id: string
    available(): boolean
    fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult>
  }
}

declare module '@deepseek-ai/dsh-web-search-deepseek' {
  export const DEEPSEEK_DEFAULT_API_VERSION: string
  export const DEEPSEEK_DEFAULT_BASE_URL: string
  export const DEEPSEEK_DEFAULT_MAX_TOKENS: number
  export const DEEPSEEK_DEFAULT_MAX_USES: number
  export const DEEPSEEK_DEFAULT_MODEL: string
  export const DEEPSEEK_PROVIDER_ID: string
  export class DeepSeekSearchProvider {
    constructor(options: any)
    available(): boolean
    search(request: any, signal?: AbortSignal): Promise<any>
  }
  export interface DeepSeekSearchProviderOptions {
    [key: string]: any
  }
  export interface DeepSeekSearchLlmRequest {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-web-search-exa' {
  export const EXA_DEFAULT_BASE_URL: string
  export const EXA_DEFAULT_HIGHLIGHTS_PER_RESULT: number
  export const EXA_DEFAULT_SEARCH_TYPE: string
  export const EXA_PROVIDER_ID: string
  export class ExaSearchProvider {
    constructor(options: any)
    available(): boolean
    search(request: any, signal?: AbortSignal): Promise<any>
  }
  export interface ExaSearchProviderOptions {
    [key: string]: any
  }
}

declare module '@deepseek-ai/schemastery' {
  export type z<T = any> = any
  export const z: any
  export default z
}

declare module '@deepseek-ai/dsh-llm' {
  /** The harness error base (stable machine-routable `code`). */
  export class HarnessError extends Error {
    constructor(message: string, code?: string, options?: { cause?: unknown })
    readonly code?: string
  }
  export type ContentBlock = { type: string; [key: string]: any }
}

declare module '@deepseek-ai/dsh-session' {
  export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
}

declare module 'playwright' {
  export interface Browser {
    newPage(): Promise<Page>
    close(): Promise<void>
    [key: string]: any
  }
  export interface Frame {
    evaluate(fn: any, ...args: any[]): Promise<any>
    url(): string
    [key: string]: any
  }
  export interface Page {
    goto(url: string, options?: any): Promise<any>
    content(): Promise<string>
    screenshot(options?: any): Promise<Buffer>
    click(selector: string, options?: any): Promise<void>
    type(selector: string, text: string, options?: any): Promise<void>
    evaluate(fn: any, ...args: any[]): Promise<any>
    frames(): Frame[]
    mainFrame(): Frame
    close(): Promise<void>
    [key: string]: any
  }
  export interface BrowserContext {
    pages(): Page[]
    newPage(): Promise<Page>
    close(): Promise<void>
    [key: string]: any
  }
  export interface Chromium {
    launch(options?: any): Promise<Browser>
    [key: string]: any
  }
  export const chromium: Chromium
}
