import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CREDITS_PATH,
  SUBSCRIPTIONS_PATH,
  fetchUsage,
  normalizeUsage,
  parseCredits,
  parseOrgId,
  parseSubscription,
  planInfo,
  toEpochMs,
  usagePercent,
} from '../lib/usage.js'

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

test('planInfo maps the CLI plan ids and refuses unknown ones', () => {
  assert.deepEqual(planInfo('individual-go-v1'), { id: 'individual-go-v1', name: 'Go', monthlyCredits: 10 })
  assert.deepEqual(planInfo('individual_goat'), { id: 'individual-goat', name: 'GOAT', monthlyCredits: 70 })
  assert.equal(planInfo('individual-pro-v1').monthlyCredits, 80)
  assert.equal(planInfo('teams-pro').name, 'Teams Pro')
  assert.equal(planInfo('enterprise-custom'), undefined)
  assert.equal(planInfo(''), undefined)
  assert.equal(planInfo(undefined), undefined)
  // `individual-goat` must not fall back to the shorter `individual-go` prefix.
  assert.equal(planInfo('individual-goat').monthlyCredits, 70)
})

test('timestamps accept epoch milliseconds, epoch seconds, and ISO strings', () => {
  assert.equal(toEpochMs(1_793_625_222_415), 1_793_625_222_415)
  assert.equal(toEpochMs(1_793_625_222), 1_793_625_222_000)
  assert.equal(toEpochMs('1793625222415'), 1_793_625_222_415)
  assert.equal(toEpochMs('2026-11-30T12:45:32.000Z'), Date.parse('2026-11-30T12:45:32.000Z'))
  assert.equal(toEpochMs('not a date'), undefined)
  assert.equal(toEpochMs(undefined), undefined)
})

test('usagePercent needs a positive cap and clamps at 100', () => {
  assert.equal(usagePercent(1, 4), 25)
  assert.equal(usagePercent(4, 4), 100)
  assert.equal(usagePercent(5, 4), 100)
  assert.equal(usagePercent(0, 0), undefined)
  assert.equal(usagePercent(-1, 4), undefined)
  assert.equal(usagePercent(1, Number.NaN), undefined)
})

test('parseCredits accepts both spellings and keeps the two rolling windows', () => {
  const credits = parseCredits({
    credits: { monthly_credits: 8.5, purchased_credits: 2, free_credits: 1 },
    window_limits: {
      limited: true,
      exceeded: true,
      five_hour: { used: 0.5, cap: 3, reset_at: 1_793_625_222 },
      weekly: { used: 1.5, cap: 6, resetAt: '2026-11-07T12:45:32.000Z', exceeded: false },
    },
  })

  assert.equal(credits.hasCredits, true)
  assert.equal(credits.monthlyRemaining, 8.5)
  assert.equal(credits.purchased, 2)
  assert.equal(credits.free, 1)
  assert.equal(credits.limited, true)
  assert.equal(credits.exceeded, true)
  assert.equal(credits.fiveHour.percent, 16.666666666666664)
  assert.equal(credits.fiveHour.resetsAt, 1_793_625_222_000)
  assert.equal(credits.weekly.percent, 25)
  assert.equal(credits.weekly.exceeded, false)
})

test('parseCredits keeps windows when the credits bucket is missing', () => {
  const credits = parseCredits({
    windowLimits: { fiveHour: { used: 0, cap: 3 }, weekly: { used: 0, cap: 6 } },
  })
  assert.equal(credits.hasCredits, false)
  assert.equal(credits.monthlyRemaining, 0)
  assert.equal(credits.fiveHour.percent, 0)
})

test('normalizeUsage derives the monthly share from the plan pool', () => {
  const credits = parseCredits({
    credits: { monthlyCredits: 8.5353381081, purchasedCredits: 0, freeCredits: 0 },
    windowLimits: {
      limited: true,
      fiveHour: { used: 0.504704482, cap: 3, resetAt: 1_793_625_222_415 },
      weekly: { used: 1.4646618919, cap: 6, resetAt: 1_794_055_729_655 },
    },
  })
  const subscription = parseSubscription({
    success: true,
    data: {
      planId: 'individual-go-v1',
      status: 'active',
      currentPeriodEnd: '2026-11-30T12:45:32.000Z',
    },
  })

  const snapshot = normalizeUsage({ credits, subscription, now: 1_700_000_000_000 })
  assert.equal(snapshot.fetchedAt, 1_700_000_000_000)
  assert.equal(snapshot.plan.name, 'Go')
  assert.equal(snapshot.plan.status, 'active')
  assert.equal(snapshot.monthly.limit, 10)
  assert.equal(snapshot.monthly.used, 10 - 8.5353381081)
  assert.equal(snapshot.monthly.remaining, 8.5353381081)
  assert.ok(Math.abs(snapshot.monthly.percent - 14.646618919) < 1e-9)
  assert.equal(snapshot.balance.totalRemaining, 8.5353381081)
  assert.equal(snapshot.limited, true)

  // An unknown plan has no honest monthly cap, so the monthly row is omitted.
  const unknown = normalizeUsage({ credits, subscription: parseSubscription({ data: { planId: 'mystery' } }) })
  assert.equal(unknown.monthly, undefined)
  assert.equal(unknown.plan, undefined)
})

test('parseSubscription unwraps the data envelope and tolerates a direct payload', () => {
  assert.deepEqual(parseSubscription({ data: { plan_id: 'individual_pro', status: 'active' } }), {
    planId: 'individual_pro',
    status: 'active',
    renewsAt: undefined,
    cancelAtPeriodEnd: false,
  })
  assert.deepEqual(parseSubscription({ planId: 'individual-max', status: 'active' }), {
    planId: 'individual-max',
    status: 'active',
    renewsAt: undefined,
    cancelAtPeriodEnd: false,
  })
  assert.equal(parseSubscription({}), undefined)
})

test('parseOrgId reads the organization scope, never the user id', () => {
  assert.equal(parseOrgId({ user: { id: 'user_1' }, org: { id: 'org_1' } }), 'org_1')
  assert.equal(parseOrgId({ orgId: 'org_2' }), 'org_2')
  assert.equal(parseOrgId({ user: { id: 'user_1' } }), undefined)
})

test('fetchUsage scopes the billing calls to the organization and attaches the version header', async () => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers })
    if (String(url).includes('/alpha/whoami')) return json({ org: { id: 'org_123' } })
    if (String(url).includes(CREDITS_PATH)) {
      return json({
        credits: { monthlyCredits: 9 },
        windowLimits: { fiveHour: { used: 0, cap: 3 }, weekly: { used: 3, cap: 6 } },
      })
    }
    if (String(url).includes(SUBSCRIPTIONS_PATH)) return json({ data: { planId: 'individual-go' } })
    throw new Error(`unexpected fetch: ${url}`)
  }

  const snapshot = await fetchUsage({
    baseURL: 'https://api.commandcode.ai/',
    apiKey: 'user_test',
    cliVersion: '1.90.0',
    fetchImpl,
    now: 1_700_000_000_000,
  })

  assert.equal(requests.length, 3)
  assert.equal(requests[1].url, `https://api.commandcode.ai${CREDITS_PATH}?orgId=org_123`)
  assert.equal(requests[1].headers.authorization, 'Bearer user_test')
  assert.equal(requests[1].headers['x-command-code-version'], '1.90.0')
  assert.equal(snapshot.windows.weekly.percent, 50)
  assert.equal(snapshot.monthly.percent, 10)
})

test('fetchUsage keeps the windows when the subscription route fails', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/alpha/whoami')) return json({})
    if (String(url).includes(CREDITS_PATH)) {
      return json({ windowLimits: { fiveHour: { used: 1, cap: 4 } } })
    }
    return new Response('nope', { status: 500 })
  }

  const snapshot = await fetchUsage({ apiKey: 'user_test', fetchImpl })
  assert.equal(snapshot.monthly, undefined)
  assert.equal(snapshot.windows.fiveHour.percent, 25)
  assert.equal(snapshot.windows.weekly, undefined)
})

test('fetchUsage reports an invalid key and refuses an empty key before any request', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('/alpha/whoami')) return new Response('unauthorized', { status: 401 })
    return new Response('unauthorized', { status: 401 })
  }

  await assert.rejects(
    fetchUsage({ apiKey: 'user_bad', fetchImpl }),
    /rejected the API key \(HTTP 401\)/,
  )
  await assert.rejects(fetchUsage({ apiKey: '', fetchImpl }), /requires an API key/)
})
