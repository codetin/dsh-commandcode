/**
 * The published `command-code` CLI version, used as the gateway's
 * `x-command-code-version` header.
 *
 * The gateway reads the client's feature set off this header and answers
 * `403 upgrade_required` when it is missing. Pinning the version in this
 * package would go stale and turn into exactly the failure this provider
 * exists to avoid, so the version is refreshed from the npm registry at
 * startup and on every catalog sync; the constant is only a fallback.
 *
 * @module dsh-commandcode/version
 */

/** Last known published CLI version; refreshed at runtime when the registry is reachable. */
export const DEFAULT_CLI_VERSION = '1.88.2'

/** Registry document whose `version` field tracks `command-code@latest`. */
export const CLI_VERSION_URL = 'https://registry.npmjs.org/command-code/latest'

const VERSION_TIMEOUT_MS = 10_000

/**
 * Fetch the latest published CLI version.
 * @param {object} [options] - overrides for tests.
 * @param {string} [options.url] - registry URL.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @returns {Promise<string | undefined>} a `x.y.z` version, or undefined when unavailable.
 */
export async function fetchCliVersion({ url = CLI_VERSION_URL, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const payload = await response.json()
    const version = payload?.version
    return typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version) ? version : undefined
  } catch {
    return undefined
  }
}
