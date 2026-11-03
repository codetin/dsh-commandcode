/**
 * dsh-commandcode — Command Code provider for the DeepSeek Harness.
 *
 * A Go-plan (and any other) Command Code subscription has no Provider-API
 * access: the OpenAI-compatible endpoints under `/provider/v1` answer
 * `403 upgrade_required`, so every request must go through Command Code's
 * private CLI gateway at `/alpha/generate`. This plugin:
 *
 * 1. Scans the public model catalog (`/provider/v1/models`, open endpoint) and
 *    keeps the models the configured plan includes, re-scanning on an interval.
 *    Plan membership and per-model reasoning efforts are merged from the
 *    official `command-code` CLI catalog (`reference/models.md`).
 * 2. Registers the `commandcode` provider route whose adapter streams over
 *    `/alpha/generate`, so the model picker, tools, and reasoning-effort
 *    controls all work against the Command Code catalog.
 * 3. Resolves the bearer key per request through the credentials seam
 *    (`COMMANDCODE_API_KEY`), failing loud when it is missing. The client half
 *    adds the same key's input to the Models page's Command Code card.
 * 4. Sends the current published CLI version as `x-command-code-version`,
 *    which is what keeps the gateway from answering `403 upgrade_required`.
 *
 * @module dsh-commandcode
 */

import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import {
  CommandCodeAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
} from './lib/adapter.js'
import { DEFAULT_PLAN, PLAN_ORDER, fetchCatalog, fetchPlanModels } from './lib/catalog.js'
import { registerRemoteService } from './lib/remote.js'
import { fetchUsage } from './lib/usage.js'
import { DEFAULT_CLI_VERSION, fetchCliVersion } from './lib/version.js'

export {
  CommandCodeAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  DEFAULT_MAX_TOKENS,
} from './lib/adapter.js'
export {
  CATALOG_FALLBACK_URL,
  CATALOG_URL,
  CATALOG_URLS,
  DEFAULT_MODELS_URL,
  DEFAULT_PLAN,
  PLAN_ORDER,
  displayName,
  fetchCatalog,
  fetchPlanModels,
  parseCatalog,
  parseEfforts,
  planIncludes,
  planTier,
} from './lib/catalog.js'
export {
  CREDITS_PATH,
  PLAN_MONTHLY_CREDITS,
  SUBSCRIPTIONS_PATH,
  USAGE_TIMEOUT_MS,
  WHOAMI_PATH,
  fetchUsage,
  normalizeUsage,
  parseCredits,
  parseOrgId,
  parseSubscription,
  planInfo,
  toEpochMs,
  usagePercent,
} from './lib/usage.js'
export { DEFAULT_CLI_VERSION, fetchCliVersion } from './lib/version.js'
export {
  GATEWAY_EFFORTS,
  buildRequest,
  chunkState,
  clientSchema,
  collectRequestImages,
  dropNullArguments,
  eventToChunks,
  finishUsage,
  gatewayErrorDetail,
  mapFinishReason,
  parseEventStream,
  streamErrorDetail,
} from './lib/protocol.js'

export const name = 'commandcode'
export const inject = ['llm']

const PACKAGE_NAME = 'dsh-commandcode'
const PROVIDER_ID = 'commandcode'
const DISPLAY_NAME = 'Command Code'
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'
const DEFAULT_BASE_URL = 'https://api.commandcode.ai'
const DEFAULT_SETTINGS_NS = 'commandcode-provider'
const DEFAULT_REFRESH_MINUTES = 360
const RETRY_AFTER_FAILURE_MS = 60_000
/** Remote namespace the browser half calls for its key test. */
const REMOTE_NAMESPACE = 'commandcode'
/** Cordis service key backing that namespace; must not collide with a core service. */
const REMOTE_SERVICE_KEY = 'commandcodeRemote'
/** Throwaway prompt, output cap, and deadline of one key test. */
const TEST_PROMPT = 'Reply with exactly: pong'
const TEST_MAX_TOKENS = 64
const TEST_TIMEOUT_MS = 60_000
/** Model a key test falls back to while the live catalog is still empty. */
const TEST_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'
/**
 * How long one quota reading is reused across browser tabs and composer
 * remounts. A manual refresh passes `force` and skips it.
 */
const USAGE_CACHE_MS = 20_000

/**
 * Plugin configuration, validated by the same-named schemastery schema and
 * doubling as the `commandcode-provider` settings-section shape.
 *
 * Every field is `volatile()`: a settings write reaches the running plugin as
 * a committed reference instead of remounting it, and the Models page renders
 * a form field for it. The credential field's `credential-ref` role is what
 * turns it into a secret input backed by the credentials service.
 */
export const Config = z.object({
  /** Gateway base URL; `/alpha/generate` is appended. */
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  /** Subscription tier whose models to advertise: `go` (default), `goat`, `pro`, or `max`. */
  plan: z.union([z.const('go'), z.const('goat'), z.const('pro'), z.const('max')]).default(DEFAULT_PLAN).volatile(),
  /** Default per-request output cap; explicit request values win. */
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS).volatile(),
  /** Context capacity used when the selected model has no exact value. */
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW).volatile(),
  /** Inline base64 image bytes one request accepts before the oldest occurrences are offloaded. */
  maxRequestImageBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_REQUEST_IMAGE_BYTES).volatile(),
  /** Send gateway traffic over HTTP/1.1: the gateway edge resets HTTP/2 streams under concurrency. */
  http1: z.boolean().default(false).volatile(),
  /** Catalog rescan interval in minutes. */
  refreshMinutes: z.number().step(1).min(1).max(1440).default(DEFAULT_REFRESH_MINUTES).volatile(),
  /**
   * Keep the composer quota pill visible even while another provider is
   * selected. This is a browser preference: Settings → General writes it
   * through the settings document, and the client half reads it back live.
   */
  alwaysShowUsage: z.boolean().default(false).volatile(),
})

/** Read a volatile config reference (or a plain value, outside the Loader). */
function valueOf(field) {
  return typeof field?.get === 'function' ? field.get() : field
}

function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Resolve the live configuration into the connection facts the adapter reads.
 * @param {object} config - plugin config, possibly holding volatile references.
 * @param {string} cliVersion - gateway client version to advertise.
 * @returns {object} connection facts.
 */
function readConnection(config, cliVersion) {
  const plan = valueOf(config.plan)
  const baseURL = valueOf(config.baseURL)
  return {
    displayName: DISPLAY_NAME,
    baseURL: (typeof baseURL === 'string' && baseURL.length > 0 ? baseURL : DEFAULT_BASE_URL).replace(/\/+$/, ''),
    plan: typeof plan === 'string' && Object.hasOwn(PLAN_ORDER, plan) ? plan : DEFAULT_PLAN,
    maxTokens: positive(valueOf(config.maxTokens), DEFAULT_MAX_TOKENS),
    defaultContextWindow: positive(valueOf(config.defaultContextWindow), DEFAULT_CONTEXT_WINDOW),
    maxRequestImageBytes: positive(valueOf(config.maxRequestImageBytes), DEFAULT_MAX_REQUEST_IMAGE_BYTES),
    http1: valueOf(config.http1) === true,
    refreshMinutes: positive(valueOf(config.refreshMinutes), DEFAULT_REFRESH_MINUTES),
    cliVersion,
  }
}

/**
 * Mount the provider route and keep its model catalog fresh.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} config - validated plugin config holding volatile references.
 */
export function apply(ctx, config) {
  let cliVersion = DEFAULT_CLI_VERSION
  let current = readConnection(config, cliVersion)
  /** Live-scanned catalog; deliberately outside the settings-backed config. */
  let models = []
  let stopped = false
  // The first scan runs asynchronously; model resolution awaits it so the very
  // first request validates reasoning efforts against the real catalog.
  let markReady
  const ready = new Promise((resolve) => { markReady = resolve })

  // One fixed reference keeps the Models page's derived credential name, its
  // configured/missing dot, and the key input on the same entry.
  const CREDENTIAL_REF = DEFAULT_API_KEY_ENV

  /**
   * Read the stored credential — or the ambient variable when the credentials
   * service is absent — without asserting it. The quota status bar treats an
   * absent key as "hide the indicator", not as a failed request.
   * @returns {Promise<string | undefined>} the raw key, when one is configured.
   */
  async function storedApiKey() {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(CREDENTIAL_REF)
      const stored = typeof hit?.value === 'string' ? hit.value.trim() : ''
      return stored.length > 0 ? stored : undefined
    }
    const ambient = process.env[CREDENTIAL_REF]?.trim()
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  const adapter = new CommandCodeAdapter({
    connection: () => current,
    models: () => models,
    ready: () => ready,
    resolveApiKey: async () => {
      const value = await storedApiKey()
      if (value === undefined) {
        throw new LlmError(
          `${PACKAGE_NAME}: no API key for provider "${PROVIDER_ID}"; store ${CREDENTIAL_REF} through the credentials`
          + ` service (the Models page writes it, under refs: in ~/.dsh/.credentials.yaml), or export`
          + ` ${CREDENTIAL_REF} in the launching environment`,
          'MISSING_CREDENTIAL',
        )
      }
      return assertUsableApiKey(value, PACKAGE_NAME, CREDENTIAL_REF)
    },
    // Resolved lazily: a deployment without the attachment service keeps serving
    // text-only traffic and fails loud only when an image actually arrives.
    resolveAttachments: () => ctx.get('attachments'),
    // Bridges the stored image object into the current tool execution world, so
    // an offloaded occurrence still names a path the model can read.
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
      ref,
    ),
  })

  /**
   * Directory entry for the Models page: one configurable provider route whose
   * settings form is the plugin's own section.
   */
  const directory = ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    settingsNs: ctx.fiber.entry?.options.id ?? DEFAULT_SETTINGS_NS,
    settingsPath: [],
  }])

  const registration = ctx.llm.registerAdapter([PROVIDER_ID], adapter)

  /**
   * One throwaway gateway request behind the Models page's 测试 button: a typed
   * literal is checked as-is, an empty field checks the stored credential the
   * adapter would use anyway. The answer — or the gateway's own refusal — is
   * the whole result, so the test can never pass on a key that does not work.
   * @param {string} [apiKey] - literal typed into the card, when it carries one.
   * @returns {Promise<{ model: string, reply: string }>} the model asked and its answer.
   */
  async function testApiKey(apiKey) {
    await ready
    const model = models[0]?.id ?? TEST_FALLBACK_MODEL
    const deadline = AbortSignal.timeout(TEST_TIMEOUT_MS)
    const options = {
      provider: PROVIDER_ID,
      model,
      maxTokens: TEST_MAX_TOKENS,
      messages: [{ role: 'user', content: [{ type: 'text', text: TEST_PROMPT }] }],
      signal: deadline,
    }
    const typed = typeof apiKey === 'string' ? apiKey.trim() : ''
    const stream = typed.length > 0
      ? adapter.probe(options, assertUsableApiKey(typed, PACKAGE_NAME, DEFAULT_API_KEY_ENV))
      : adapter.stream(options)
    let reply = ''
    let reasoning = ''
    try {
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') reply += chunk.text
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
      }
    } catch (error) {
      if (deadline.aborted) throw new Error(`the key test timed out after ${TEST_TIMEOUT_MS / 1_000}s`)
      throw error
    }
    // A model that answers with reasoning alone still proves the key works.
    const answer = (reply.trim() || reasoning.trim()).replace(/\s+/g, ' ')
    return { model, reply: answer.slice(0, 200) }
  }

  /** Last successful quota reading, reused while its fingerprint and TTL match. */
  let usageCache

  /**
   * Read the account's remaining quota for the status bar. An unconfigured key
   * is reported as `configured: false` so the browser half can stay silent
   * instead of showing a permanent error.
   * @param {boolean} [force] - skip the short-lived cache.
   * @returns {Promise<object>} the snapshot, or the unconfigured marker.
   */
  async function readUsage(force) {
    const apiKey = await storedApiKey()
    if (apiKey === undefined) return { configured: false }
    const fingerprint = `${current.baseURL}\n${current.cliVersion}\n${apiKey}`
    if (force !== true
      && usageCache !== undefined
      && usageCache.fingerprint === fingerprint
      && Date.now() - usageCache.at < USAGE_CACHE_MS) {
      return { configured: true, ...usageCache.snapshot }
    }
    const snapshot = await fetchUsage({
      baseURL: current.baseURL,
      apiKey,
      cliVersion: current.cliVersion,
    })
    usageCache = { fingerprint, at: Date.now(), snapshot }
    return { configured: true, ...snapshot }
  }

  const unregisterRemote = registerRemoteService({
    ctx,
    serviceKey: REMOTE_SERVICE_KEY,
    namespace: REMOTE_NAMESPACE,
    methods: [
      {
        method: 'test',
        implementation: async function test(apiKey) {
          return testApiKey(apiKey)
        },
      },
      {
        method: 'usage',
        implementation: async function usage(force) {
          return readUsage(force)
        },
      },
    ],
  })

  ctx.effect(() => () => {
    registration()
    directory()
    unregisterRemote()
  })

  /** Scan the catalog for the configured plan and swap it into the adapter's view. */
  async function syncCatalog() {
    // The official CLI catalog owns the two facts the Provider API withholds:
    // plan membership and reasoning efforts. Without it there is no honest
    // filter, so a failed scan keeps the previous catalog instead of guessing.
    const plan = current.plan
    const [catalog, version] = await Promise.all([fetchCatalog(), fetchCliVersion()])
    // The version header only feeds the gateway handshake, so it is independent
    // of which catalog a plan change ends up owning. The adapter reads the
    // connection facts per request, so the refreshed version has to land in
    // them — otherwise every request would keep advertising the fallback.
    if (version !== undefined && version !== cliVersion) {
      cliVersion = version
      current = readConnection(config, cliVersion)
    }
    const next = await fetchPlanModels(catalog, { plan })
    // A settings write during the scan owns the newer catalog; never let this
    // older result overwrite it.
    if (plan !== current.plan) return
    if (next.length === 0) {
      throw new Error(`no ${plan} models found; keeping the previous catalog`)
    }
    models = next
    ctx.logger.info('[commandcode] synced %d %s model(s)', next.length, plan)
    ctx.logger.debug('[commandcode] models: %s', next.map(model => model.id).join(', '))
  }

  let timer
  const schedule = (delay) => {
    if (stopped) return
    timer = setTimeout(run, delay)
    timer.unref?.()
  }
  const run = async () => {
    try {
      await syncCatalog()
      schedule(current.refreshMinutes * 60_000)
    } catch (error) {
      ctx.logger.warn('[commandcode] catalog scan failed: %s', error instanceof Error ? error.message : String(error))
      schedule(RETRY_AFTER_FAILURE_MS)
    } finally {
      markReady()
    }
  }

  ctx.effect(() => {
    stopped = false
    schedule(0)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  })

  // Every field is volatile, so a settings write is announced here instead of
  // remounting the plugin. The adapter reads `current` per operation; only a
  // plan change needs a fresh scan.
  ctx.on('loader/volatile-update', () => {
    const previousPlan = current.plan
    current = readConnection(config, cliVersion)
    // A new base URL (or a re-read credential environment) invalidates the
    // cached quota reading even when the plan itself did not change.
    usageCache = undefined
    if (current.plan !== previousPlan) {
      ctx.logger.info('[commandcode] plan changed to %s; rescanning the catalog', current.plan)
      void syncCatalog().catch((error) => {
        ctx.logger.warn('[commandcode] catalog rescan failed: %s', error instanceof Error ? error.message : String(error))
      })
    }
  })
}
