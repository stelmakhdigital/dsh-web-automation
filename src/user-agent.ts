/**
 * The product User-Agent for all outbound web requests from this plugin.
 *
 * A single source of truth so the version never drifts across modules
 * (search engines, cached fetch, platform endpoints). The `deepseek-harness`
 * prefix identifies the harness product to third-party endpoints; the
 * `dsh-web-automation` token identifies this plugin specifically.
 * @module dsh-web-automation/user-agent
 */

/** The plugin version embedded in the User-Agent. */
export const PRODUCT_VERSION = '0.3.0'

/** The product User-Agent for outbound web requests. */
export const PRODUCT_USER_AGENT = `deepseek-harness/${PRODUCT_VERSION} dsh-web-automation (+https://github.com/stelmakhdigital/dsh-web-automation)`

/**
 * A browser-like User-Agent for platforms that block the product UA (YouTube,
 * Bilibili, V2EX). The version token is shared with {@link PRODUCT_VERSION}.
 */
export const BROWSER_LIKE_USER_AGENT = `Mozilla/5.0 (compatible; deepseek-harness/${PRODUCT_VERSION})`
