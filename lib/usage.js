/**
 * Command Code quota readout.
 *
 * The official CLI's `/usage` screen reads the same authenticated Studio
 * routes this module does: `/alpha/billing/credits` carries the two rolling
 * windows (5-hour and weekly, each with `used` / `cap` / `resetAt`) plus the
 * remaining credit buckets, while `/alpha/billing/subscriptions` names the
 * plan whose monthly pool those windows pace. The API exposes no monthly
 * window object, so the monthly ratio is derived the way the CLI derives it:
 * `used = planMonthlyCredits - monthlyCredits`, with the plan total read from
 * the CLI's own plan table (`individual-go` → 10, `individual-pro-v1` → 80, …).
 *
 * Everything here is defensive: the routes are undocumented, so camelCase and
 * snake_case spellings, epoch milliseconds/seconds, and ISO timestamps are all
 * accepted. An unknown plan simply yields no monthly figure rather than a
 * made-up one.
 *
 * @module dsh-commandcode/usage
 */

/** Account identity; only its organization id is used, as the billing query scope. */
export const WHOAMI_PATH = '/alpha/whoami'
/** Remaining credits and the two rolling windows. */
export const CREDITS_PATH = '/alpha/billing/credits'
/** Plan id, subscription status, and billing-period boundaries. */
export const SUBSCRIPTIONS_PATH = '/alpha/billing/subscriptions'

/** Per-request deadline for the read-only billing calls. */
export const USAGE_TIMEOUT_MS = 15_000

/** The identity probe only scopes team billing; it must never hold up the windows. */
const WHOAMI_TIMEOUT_MS = 5_000

/**
 * Monthly credit pool per subscription plan id, mirroring the official CLI's
 * plan table. Keys are the normalized `planId` prefixes the CLI matches.
 */
export const PLAN_MONTHLY_CREDITS = Object.freeze({
  'individual-go': 10,
  'individual-go-v1': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
})

/** Human-readable names for the plan families above. */
export const PLAN_NAMES = Object.freeze({
  'individual-go': 'Go',
  'individual-go-v1': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
})

/** Plan keys longest first, so `individual-go-v1` never resolves as `individual-go`. */
const PLAN_KEYS = Object.keys(PLAN_MONTHLY_CREDITS).sort((left, right) => right.length - left.length)

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** First own, defined field among the accepted spellings. */
function pick(record, ...names) {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name]
  }
  return undefined
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function nonNegative(value) {
  const parsed = toNumber(value)
  return parsed !== undefined && parsed >= 0 ? parsed : undefined
}

/**
 * Normalize an epoch millisecond/second or an ISO timestamp.
 * @param {unknown} value - raw `resetAt` / `currentPeriodEnd` value.
 * @returns {number | undefined} epoch milliseconds, or undefined when unreadable.
 */
export function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Anything below 1e11 is a second-based epoch (millisecond epochs are ~1.7e12).
    return value < 1e11 ? value * 1_000 : value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return toEpochMs(numeric)
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Used share of one limit, clamped to 0–100%.
 * @param {number} used - consumed amount.
 * @param {number} limit - total cap.
 * @returns {number | undefined} percentage, or undefined without a usable cap.
 */
export function usagePercent(used, limit) {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return undefined
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return undefined
  return Math.min(100, used / limit * 100)
}

/**
 * Resolve a subscription `planId` to its monthly credit pool.
 * @param {string | undefined} planId - e.g. `individual-go-v1`.
 * @returns {{ id: string, name: string, monthlyCredits: number } | undefined} plan facts.
 */
export function planInfo(planId) {
  if (typeof planId !== 'string') return undefined
  const normalized = planId.trim().toLowerCase().replace(/_/g, '-')
  if (normalized.length === 0) return undefined
  const key = PLAN_KEYS.find(candidate => normalized === candidate || normalized.startsWith(`${candidate}-`))
  if (key === undefined) return undefined
  return { id: normalized, name: PLAN_NAMES[key] ?? key, monthlyCredits: PLAN_MONTHLY_CREDITS[key] }
}

/** One rolling window, or undefined when the payload carries no usable cap. */
function readWindow(raw) {
  if (!isRecord(raw)) return undefined
  const limit = nonNegative(pick(raw, 'cap', 'limit', 'max'))
  if (limit === undefined || limit <= 0) return undefined
  const used = nonNegative(pick(raw, 'used', 'creditsUsed')) ?? 0
  return {
    used,
    limit,
    percent: usagePercent(used, limit),
    resetsAt: toEpochMs(pick(raw, 'resetAt', 'reset_at', 'resetsAt')),
    exceeded: pick(raw, 'exceeded') === true,
  }
}

/**
 * Parse `/alpha/billing/credits`.
 * @param {unknown} payload - response body.
 * @returns {object} credit buckets plus the two parsed windows.
 */
export function parseCredits(payload) {
  if (!isRecord(payload)) throw new Error('Command Code billing endpoint returned an unexpected shape')
  const credits = isRecord(payload.credits) ? payload.credits : {}
  const monthlyRemaining = nonNegative(pick(credits, 'monthlyCredits', 'monthly_credits'))
  const purchased = nonNegative(pick(credits, 'purchasedCredits', 'purchased_credits')) ?? 0
  const free = nonNegative(pick(credits, 'freeCredits', 'free_credits')) ?? 0
  const limits = isRecord(payload.windowLimits)
    ? payload.windowLimits
    : isRecord(payload.window_limits)
      ? payload.window_limits
      : {}
  const fiveHour = readWindow(pick(limits, 'fiveHour', 'five_hour'))
  const weekly = readWindow(limits.weekly)
  return {
    hasCredits: monthlyRemaining !== undefined,
    monthlyRemaining: monthlyRemaining ?? 0,
    purchased,
    free,
    fiveHour,
    weekly,
    limited: limits.limited === true,
    exceeded: limits.exceeded === true || fiveHour?.exceeded === true || weekly?.exceeded === true,
  }
}

/**
 * Parse `/alpha/billing/subscriptions`; a failed subscription call must not
 * hide the two rolling windows, so callers treat undefined as "monthly unknown".
 * @param {unknown} payload - response body.
 * @returns {object | undefined} subscription facts.
 */
export function parseSubscription(payload) {
  if (!isRecord(payload)) return undefined
  const data = isRecord(payload.data) ? payload.data : payload
  const planId = pick(data, 'planId', 'plan_id')
  const status = pick(data, 'status')
  if (typeof planId !== 'string' && typeof status !== 'string') return undefined
  return {
    planId: typeof planId === 'string' ? planId : undefined,
    status: typeof status === 'string' ? status : undefined,
    renewsAt: toEpochMs(pick(data, 'currentPeriodEnd', 'current_period_end')),
    cancelAtPeriodEnd: pick(data, 'cancelAtPeriodEnd', 'cancel_at_period_end') === true,
  }
}

/**
 * Read the organization id that scopes billing for team accounts.
 * @param {unknown} payload - `/alpha/whoami` response body.
 * @returns {string | undefined} organization id.
 */
export function parseOrgId(payload) {
  if (!isRecord(payload)) return undefined
  const org = isRecord(payload.org) ? payload.org : undefined
  const id = pick(org ?? {}, 'id') ?? pick(payload, 'orgId', 'org_id')
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Fold the two responses into the snapshot the status bar consumes.
 * @param {object} input - parsed responses and the reading time.
 * @returns {object} display-ready usage snapshot.
 */
export function normalizeUsage({ credits, subscription, now = Date.now() }) {
  const plan = planInfo(subscription?.planId)
  const totalRemaining = credits.monthlyRemaining + credits.purchased + credits.free
  let monthly
  if (plan !== undefined && credits.hasCredits) {
    const limit = plan.monthlyCredits
    const used = Math.max(0, limit - credits.monthlyRemaining)
    monthly = {
      used,
      limit,
      remaining: credits.monthlyRemaining,
      percent: usagePercent(used, limit),
      renewsAt: subscription?.renewsAt,
      plan: plan.name,
      planId: plan.id,
    }
  }
  return {
    fetchedAt: now,
    plan: plan === undefined
      ? undefined
      : {
          id: plan.id,
          name: plan.name,
          monthlyCredits: plan.monthlyCredits,
          status: subscription?.status,
          renewsAt: subscription?.renewsAt,
          cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd === true,
        },
    windows: { fiveHour: credits.fiveHour, weekly: credits.weekly },
    monthly,
    balance: {
      monthlyRemaining: credits.monthlyRemaining,
      purchased: credits.purchased,
      free: credits.free,
      totalRemaining,
    },
    limited: credits.limited,
    exceeded: credits.exceeded,
  }
}

function billingError(url, status, detail) {
  if (status === 401 || status === 403) {
    return new Error(`Command Code rejected the API key (HTTP ${status})`)
  }
  const suffix = detail.length > 0 ? `: ${detail.slice(0, 160)}` : ''
  return new Error(`Command Code billing endpoint ${url} answered HTTP ${status}${suffix}`)
}

async function requestJson(url, { headers, fetchImpl, timeoutMs }) {
  let response
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Command Code billing request failed: ${detail}`)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw billingError(url, response.status, detail)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(`Command Code billing endpoint ${url} returned malformed JSON`)
  }
}

/**
 * Read one account's remaining quota.
 *
 * `/alpha/whoami` is tried first because team plans scope billing by
 * organization; when it is unavailable the individual routes are still read.
 * Credits are required, the subscription is optional (its failure only hides
 * the derived monthly figure).
 *
 * @param {object} options - connection facts and test seams.
 * @param {string} options.baseURL - gateway base URL.
 * @param {string} options.apiKey - bearer key.
 * @param {string} [options.cliVersion] - client version header.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation.
 * @param {number} [options.timeoutMs] - per-request deadline.
 * @param {number} [options.now] - reading time for the snapshot.
 * @returns {Promise<object>} the normalized usage snapshot.
 */
export async function fetchUsage({
  baseURL,
  apiKey,
  cliVersion,
  fetchImpl = fetch,
  timeoutMs = USAGE_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new Error('Command Code usage requires an API key')
  }
  const base = (typeof baseURL === 'string' && baseURL.length > 0 ? baseURL : 'https://api.commandcode.ai')
    .replace(/\/+$/, '')
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
    'user-agent': 'cli',
  }
  if (typeof cliVersion === 'string' && cliVersion.length > 0) {
    headers['x-command-code-version'] = cliVersion
  }
  const read = (path, requestTimeout = timeoutMs) => requestJson(`${base}${path}`, {
    headers,
    fetchImpl,
    timeoutMs: requestTimeout,
  })

  let orgId
  try {
    orgId = parseOrgId(await read(WHOAMI_PATH, Math.min(timeoutMs, WHOAMI_TIMEOUT_MS)))
  } catch {
    // Individual accounts need no scope; credits below reports a bad key.
    orgId = undefined
  }
  const query = orgId === undefined ? '' : `?orgId=${encodeURIComponent(orgId)}`
  const [creditsResult, subscriptionResult] = await Promise.allSettled([
    read(`${CREDITS_PATH}${query}`),
    read(`${SUBSCRIPTIONS_PATH}${query}`),
  ])
  if (creditsResult.status === 'rejected') throw creditsResult.reason
  const credits = parseCredits(creditsResult.value)
  const subscription = subscriptionResult.status === 'fulfilled'
    ? parseSubscription(subscriptionResult.value)
    : undefined
  return normalizeUsage({ credits, subscription, now })
}
