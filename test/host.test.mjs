import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, Config } from '../index.js'
import { DEFAULT_CLI_VERSION } from '../lib/version.js'

const MARKDOWN = `# Command Code Models

| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
|---|---|---|---|---|---|---|
| \`deepseek/deepseek-v4-flash\` | DeepSeek V4 Flash | 1M | off, high, max | $0.15/$0.6 | Go and above | fast |
| \`moonshotai/Kimi-K2.7-Code\` | Kimi K2.7 Code | 256K | — | $0.95/$4 | Go and above | coding |
| \`MiniMaxAI/MiniMax-M2.5\` | MiniMax M2.5 | 200K | — | $0.3/$1.2 | GOAT and above | agent |
`

const LISTING = {
  object: 'list',
  data: [
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1000000 },
    { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi K2.7 Code', context_length: 262144 },
    { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5', context_length: 200000 },
  ],
}

const REPLY = [
  '{"type":"text-start"}\n',
  '{"type":"text-delta","text":"po"}\n',
  '{"type":"text-delta","text":"ng"}\n',
  '{"type":"text-end"}\n',
  '{"type":"finish","finishReason":"stop"}\n',
].join('')

const REFUSAL = JSON.stringify({
  success: false,
  error: { code: 'upgrade_required', message: 'This endpoint requires an upgraded plan' },
})

function streamFrom(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

function json(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * Stub every endpoint one key test touches: the public listing, the CLI
 * catalog, the registry, and the gateway itself.
 * @param {object} options - gateway answer for this case.
 * @returns the fetch stand-in plus the gateway requests it recorded.
 */
function gatewayFetch({ status = 200, body = REPLY } = {}) {
  const requests = []
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('/provider/v1/models')) return json(LISTING)
    if (target.includes('registry.npmjs.org')) return json({ version: '1.90.0' })
    if (target.includes('command-code')) return new Response(MARKDOWN, { status: 200 })
    if (target.includes('/alpha/generate')) {
      requests.push({ url: target, headers: init.headers, body: JSON.parse(String(init.body)) })
      return status === 200 ? new Response(streamFrom(body), { status }) : new Response(body, { status })
    }
    throw new Error(`unexpected fetch: ${target}`)
  }
  return { fetchImpl, requests }
}

function config(overrides = {}) {
  return {
    baseURL: 'https://api.commandcode.ai',
    plan: 'go',
    maxTokens: 64_000,
    defaultContextWindow: 1_000_000,
    maxRequestImageBytes: 2_097_152,
    http1: false,
    refreshMinutes: 360,
    ...overrides,
  }
}

/**
 * The host context `apply` needs, with the Remote the gateway would route to.
 * @param {object} [options] - stored credential literal to resolve, if any.
 * @returns the context plus the services it captured.
 */
function context({ storedKey } = {}) {
  const remote = new Map()
  const calls = { adapters: [], directories: [] }
  const ctx = {
    fiber: { entry: { options: { id: 'commandcode-provider' } } },
    logger: { info() {}, warn() {}, debug() {} },
    on: () => () => {},
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    get(key) {
      if (key === 'credentials' && storedKey !== undefined) {
        return { resolve: async ref => ({ ref, value: storedKey, source: 'file' }) }
      }
      return undefined
    },
    llm: {
      registerConfigurableProviders(entries) {
        calls.directories.push(...entries)
        return () => {}
      },
      registerAdapter(ids, adapter) {
        calls.adapters.push({ ids, adapter })
        return () => {}
      },
    },
    reflect: {
      provide(key, service) {
        remote.set(key, service)
        return () => remote.delete(key)
      },
    },
  }
  return { ctx, calls, remote }
}

test('the key test sends one real gateway request authenticated by the typed literal', async () => {
  const originalFetch = globalThis.fetch
  const { fetchImpl, requests } = gatewayFetch()
  globalThis.fetch = fetchImpl
  try {
    const { ctx, calls, remote } = context({ storedKey: 'user_stored' })
    apply(ctx, config())
    assert.equal(calls.adapters.length, 1)
    assert.deepEqual(calls.directories[0].settingsNs, 'commandcode-provider')

    const service = remote.get('commandcodeRemote')
    assert.equal(typeof service?.test, 'function')
    assert.equal(service.typertRemote.namespace, 'commandcode')

    assert.deepEqual(await service.test(' user_typed '), {
      model: 'deepseek/deepseek-v4-flash',
      reply: 'pong',
    })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, 'https://api.commandcode.ai/alpha/generate')
    assert.equal(requests[0].headers.authorization, 'Bearer user_typed')
    // The version header comes from the refreshed registry document, not the constant.
    assert.equal(requests[0].headers['x-command-code-version'], '1.90.0')
    assert.equal(requests[0].body.params.model, 'deepseek/deepseek-v4-flash')
    assert.match(JSON.stringify(requests[0].body), /Reply with exactly: pong/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an empty field tests the stored credential instead', async () => {
  const originalFetch = globalThis.fetch
  const { fetchImpl, requests } = gatewayFetch()
  globalThis.fetch = fetchImpl
  try {
    const { ctx, remote } = context({ storedKey: 'user_stored' })
    apply(ctx, config())
    assert.equal((await remote.get('commandcodeRemote').test('')).reply, 'pong')
    assert.equal(requests[0].headers.authorization, 'Bearer user_stored')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a refused key test reports the gateway diagnostic', async () => {
  const originalFetch = globalThis.fetch
  const { fetchImpl } = gatewayFetch({ status: 403, body: REFUSAL })
  globalThis.fetch = fetchImpl
  try {
    const { ctx, remote } = context({ storedKey: 'user_stored' })
    apply(ctx, config())
    await assert.rejects(
      remote.get('commandcodeRemote').test('user_bad'),
      (error) => {
        assert.match(error.message, /upgrade_required/)
        assert.match(error.message, /already uses the Go CLI gateway/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

const CREDITS = {
  credits: { monthlyCredits: 8.5353381081, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0.504704482, cap: 3, exceeded: false, resetAt: 1_793_625_222_415 },
    weekly: { used: 1.4646618919, cap: 6, exceeded: false, resetAt: 1_794_055_729_655 },
  },
}

const SUBSCRIPTION = {
  success: true,
  data: {
    planId: 'individual-go-v1',
    status: 'active',
    currentPeriodEnd: '2026-11-30T12:45:32.000Z',
  },
}

/**
 * Stub the billing routes plus the catalog endpoints `apply` scans in the
 * background.
 * @param {object} [options] - billing fixtures and the subscription status.
 * @returns the fetch stand-in plus every request it recorded.
 */
function usageFetch({ credits = CREDITS, subscription = SUBSCRIPTION, subscriptionStatus = 200 } = {}) {
  const requests = []
  const record = (url, init) => {
    requests.push({ url, headers: init.headers })
  }
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('/alpha/whoami')) {
      record(target, init)
      return json({ user: { userName: 'codetin' }, org: { id: 'org_123' } })
    }
    if (target.includes('/alpha/billing/credits')) {
      record(target, init)
      return json(credits)
    }
    if (target.includes('/alpha/billing/subscriptions')) {
      record(target, init)
      return subscriptionStatus === 200
        ? json(subscription)
        : new Response('subscription unavailable', { status: subscriptionStatus })
    }
    if (target.includes('/provider/v1/models')) return json(LISTING)
    if (target.includes('registry.npmjs.org')) return json({ version: '1.90.0' })
    if (target.includes('command-code')) return new Response(MARKDOWN, { status: 200 })
    throw new Error(`unexpected fetch: ${target}`)
  }
  return { fetchImpl, requests }
}

/** Billing calls only; the background catalog scan is irrelevant to these cases. */
function billingCalls(requests, kind) {
  return requests.filter(request => request.url.includes(`/alpha/billing/${kind}`))
}

test('the usage remote reports the 5-hour, weekly, and derived monthly used shares', async () => {
  const originalFetch = globalThis.fetch
  const { fetchImpl, requests } = usageFetch()
  globalThis.fetch = fetchImpl
  try {
    const { ctx, remote } = context({ storedKey: 'user_stored' })
    apply(ctx, config())
    const snapshot = await remote.get('commandcodeRemote').usage(true)

    assert.equal(snapshot.configured, true)
    assert.equal(snapshot.plan.name, 'Go')
    assert.equal(snapshot.plan.monthlyCredits, 10)
    assert.ok(Math.abs(snapshot.windows.fiveHour.percent - 16.823482733333333) < 1e-9)
    assert.ok(Math.abs(snapshot.windows.weekly.percent - 24.411031531666667) < 1e-9)
    assert.ok(Math.abs(snapshot.monthly.percent - 14.646618919) < 1e-9)
    assert.equal(snapshot.monthly.remaining, 8.5353381081)
    assert.equal(snapshot.windows.fiveHour.resetsAt, 1_793_625_222_415)

    const [creditsCall] = billingCalls(requests, 'credits')
    assert.equal(creditsCall.url, 'https://api.commandcode.ai/alpha/billing/credits?orgId=org_123')
    assert.equal(creditsCall.headers.authorization, 'Bearer user_stored')
    assert.equal(creditsCall.headers['x-command-code-version'], DEFAULT_CLI_VERSION)
    assert.equal(billingCalls(requests, 'subscriptions')[0].url,
      'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_123')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a cached reading is reused until a refresh is forced', async () => {
  const originalFetch = globalThis.fetch
  const { fetchImpl, requests } = usageFetch()
  globalThis.fetch = fetchImpl
  try {
    const { ctx, remote } = context({ storedKey: 'user_stored' })
    apply(ctx, config())
    const service = remote.get('commandcodeRemote')

    await service.usage(false)
    await service.usage(false)
    assert.equal(billingCalls(requests, 'credits').length, 1)

    await service.usage(true)
    assert.equal(billingCalls(requests, 'credits').length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('an unconfigured key hides the quota instead of failing the remote call', async () => {
  const originalFetch = globalThis.fetch
  const previousKey = process.env.COMMANDCODE_API_KEY
  const { fetchImpl, requests } = usageFetch()
  globalThis.fetch = fetchImpl
  delete process.env.COMMANDCODE_API_KEY
  try {
    const { ctx, remote } = context()
    apply(ctx, config())
    assert.deepEqual(await remote.get('commandcodeRemote').usage(true), { configured: false })
    assert.equal(requests.filter(request => request.url.includes('/alpha/billing')).length, 0)
  } finally {
    if (previousKey !== undefined) process.env.COMMANDCODE_API_KEY = previousKey
    globalThis.fetch = originalFetch
  }
})

test('a failed subscription keeps the two rolling windows and hides only the monthly figure', async () => {
  const originalFetch = globalThis.fetch
  const { fetchImpl } = usageFetch({ subscriptionStatus: 500 })
  globalThis.fetch = fetchImpl
  try {
    const { ctx, remote } = context({ storedKey: 'user_stored' })
    apply(ctx, config())
    const snapshot = await remote.get('commandcodeRemote').usage(true)
    assert.equal(snapshot.monthly, undefined)
    assert.ok(snapshot.windows.fiveHour.percent > 0)
    assert.ok(snapshot.windows.weekly.percent > 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})


test('the always-show usage preference is part of the settings schema', () => {
  assert.equal(Config({}).alwaysShowUsage.get(), false)
  assert.equal(Config({ alwaysShowUsage: true }).alwaysShowUsage.get(), true)
})
