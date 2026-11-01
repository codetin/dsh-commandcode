/**
 * Command Code model discovery.
 *
 * The public listing (`/provider/v1/models`) is an open endpoint: it needs no
 * key and a Go-plan key is refused by the generation endpoints anyway. It
 * discloses only `id` / `name` / `context_length` — neither plan membership nor
 * reasoning support — so both are merged in from the model catalog the official
 * `command-code` CLI ships (`reference/models.md`), fetched live from the
 * published npm package so it tracks `@latest` instead of a checked-in copy.
 *
 * Plan membership is read from the catalog's `Min plan` column rather than
 * guessed from a brand list: `Go and above` models are exactly the ones a Go
 * subscription can call, including the premium exceptions the plan includes.
 *
 * @module dsh-commandcode/catalog
 */

/** Subscription tiers in ascending order; a model's `Min plan` names the lowest tier that can call it. */
export const PLAN_ORDER = Object.freeze({ go: 0, goat: 1, pro: 2, max: 3 })

/** Default plan filter: the Go subscription this provider exists for. */
export const DEFAULT_PLAN = 'go'

/** Context capacity assumed when the listing discloses none. */
const FALLBACK_CONTEXT_WINDOW = 262_144

/** Open model listing; generation never goes through the Provider API. */
export const DEFAULT_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models'

/**
 * Official CLI catalog served from unpkg.
 *
 * unpkg, not jsDelivr: jsDelivr pins its `@latest` resolution for hours, and a
 * stale catalog silently drops models from the filtered list.
 */
export const CATALOG_URL = 'https://unpkg.com/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md'

/**
 * Secondary catalog host, tried only when {@link CATALOG_URL} is unreachable.
 * jsDelivr resolves `@latest` more slowly, so it is never preferred; as a
 * fallback a slightly stale catalog still beats an empty model picker.
 */
export const CATALOG_FALLBACK_URL = 'https://cdn.jsdelivr.net/npm/command-code@latest/dist/bundled/command-code-knowledge/reference/models.md'

/** Catalog hosts in preference order. */
export const CATALOG_URLS = Object.freeze([CATALOG_URL, CATALOG_FALLBACK_URL])

/** Per-request budget for the two upstream catalog endpoints. */
export const FETCH_TIMEOUT_MS = 30_000

/**
 * One row of the official CLI catalog (`reference/models.md`).
 * @typedef {object} CatalogEntry
 * @property {string} minPlan lowest plan that includes the model, verbatim (`Go and above`, `Max`, …)
 * @property {string[]} [efforts] reasoning-effort ids the gateway accepts, in catalog order
 */

/**
 * One model this provider advertises.
 * @typedef {object} CommandCodeModel
 * @property {string} id wire model id accepted by `/alpha/generate`
 * @property {string} name selector label
 * @property {number} contextWindow combined request/response context capacity
 * @property {string[]} [efforts] reasoning-effort ids the model accepts
 */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function positiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * The tier named by a catalog `Min plan` cell.
 * @param {string | undefined} minPlan - catalog cell, e.g. `GOAT and above`.
 * @returns {keyof typeof PLAN_ORDER | undefined} the tier, or undefined when unrecognized.
 */
export function planTier(minPlan) {
  const head = minPlan?.trim().split(/\s+/)[0]?.toLowerCase()
  return head !== undefined && Object.hasOwn(PLAN_ORDER, head) ? head : undefined
}

/**
 * Whether a catalog row is callable on a subscription of `plan`.
 * @param {CatalogEntry | undefined} entry - catalog row.
 * @param {keyof typeof PLAN_ORDER} plan - subscription being served.
 * @returns {boolean} true when the row's minimum tier is at or below `plan`.
 */
export function planIncludes(entry, plan) {
  const tier = planTier(entry?.minPlan)
  if (tier === undefined) return false
  return PLAN_ORDER[tier] <= (PLAN_ORDER[plan] ?? PLAN_ORDER.go)
}

/**
 * Parse the effort column of the official CLI catalog.
 * The column is a comma-separated list such as `low, medium, high`; a dash
 * (`—`) means the model decides its own reasoning depth.
 * @param {string} raw - catalog cell.
 * @returns {string[] | undefined} accepted effort ids, or undefined for none declared.
 */
export function parseEfforts(raw) {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed === '—' || trimmed === '-') return undefined
  const efforts = trimmed.split(',').map(part => part.trim()).filter(part => part.length > 0)
  return efforts.length === 0 ? undefined : efforts
}

/**
 * Parse `reference/models.md` rows into model id → catalog entry.
 *
 * Row shape: `| \`id\` | Name | Context | Efforts | $/1M … | Min plan | Best for |`.
 * Only data rows quote their id, which skips header and separator rows.
 * @param {string} markdown - catalog document.
 * @returns {Map<string, CatalogEntry>} entries by exact model id.
 */
export function parseCatalog(markdown) {
  const byId = new Map()
  for (const line of markdown.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map(cell => cell.trim())
    const id = cells[1]?.startsWith('`') === true ? cells[1].replace(/`/g, '') : undefined
    const minPlan = nonEmptyString(cells[6])
    if (id === undefined || minPlan === undefined) continue
    const efforts = parseEfforts(cells[4] ?? '')
    byId.set(id, { minPlan, ...efforts === undefined ? {} : { efforts } })
  }
  return byId
}

/**
 * The listing reuses one display name across the paid and free tier of the
 * same model (`MiniMaxAI/MiniMax-M3` and `minimax/minimax-m3-free` are both
 * "MiniMax M3"). Free tiers are marked by a `-free` or `:free` id suffix, so
 * surface that in the name to keep the two apart.
 * @param {string} id - listing model id.
 * @param {string} name - listing display name.
 * @returns {string} a label that distinguishes the free tier.
 */
export function displayName(id, name) {
  return /(?:-|:)(?:free)$/i.test(id) && !/free/i.test(name) ? `${name} (free)` : name
}

/**
 * Fetch the official CLI catalog: per-model plan membership and reasoning efforts.
 * Each candidate host is tried in order; the first usable catalog wins.
 * @param {object} [options] - overrides for tests.
 * @param {string} [options.url] - single catalog URL, overriding the host list.
 * @param {readonly string[]} [options.urls] - catalog hosts in preference order.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @returns {Promise<Map<string, CatalogEntry>>} entries by exact model id.
 */
export async function fetchCatalog({ url, urls = CATALOG_URLS, fetchImpl = fetch } = {}) {
  const candidates = url === undefined ? urls : [url]
  let lastError
  for (const candidate of candidates) {
    try {
      const response = await fetchImpl(candidate, {
        headers: { accept: 'text/markdown' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`Command Code CLI catalog answered HTTP ${response.status}`)
      return parseCatalog(await response.text())
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('Command Code CLI catalog is unreachable')
}

/**
 * Fetch the live listing and keep the models the selected plan can call.
 * @param {ReadonlyMap<string, CatalogEntry>} catalog - parsed CLI catalog.
 * @param {object} [options] - overrides for tests.
 * @param {keyof typeof PLAN_ORDER} [options.plan] - subscription being served.
 * @param {string} [options.url] - listing URL.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @returns {Promise<CommandCodeModel[]>} the callable catalog, sorted by id.
 */
export async function fetchPlanModels(catalog, { plan = DEFAULT_PLAN, url = DEFAULT_MODELS_URL, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Command Code models endpoint answered HTTP ${response.status}`)
  const payload = await response.json()
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('Command Code models endpoint returned an unexpected shape')
  }
  const models = []
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue
    const id = nonEmptyString(raw.id)
    if (id === undefined) continue
    const entry = catalog.get(id)
    if (!planIncludes(entry, plan)) continue
    const contextWindow = positiveNumber(raw.context_length)
      ?? positiveNumber(raw.context_window)
      ?? FALLBACK_CONTEXT_WINDOW
    models.push({
      id,
      name: displayName(id, nonEmptyString(raw.name) ?? id.split('/').pop() ?? id),
      contextWindow,
      ...entry?.efforts === undefined ? {} : { efforts: entry.efforts },
    })
  }
  // Stable order keeps a synced catalog deterministic across scans.
  models.sort((left, right) => left.id.localeCompare(right.id))
  return models
}
