import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PLAN_ORDER,
  displayName,
  fetchCatalog,
  fetchPlanModels,
  parseCatalog,
  parseEfforts,
  planIncludes,
  planTier,
} from '../lib/catalog.js'

const MARKDOWN = `# Command Code Models

| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |
|---|---|---|---|---|---|---|
| \`deepseek/deepseek-v4-flash\` | DeepSeek V4 Flash | 1M | off, high, max | $0.15/$0.6 | Go and above | fast |
| \`moonshotai/Kimi-K2.7-Code\` | Kimi K2.7 Code | 256K | — | $0.95/$4 | Go and above | coding |
| \`MiniMaxAI/MiniMax-M2.5\` | MiniMax M2.5 | 200K | — | $0.3/$1.2 | GOAT and above | agent |
| \`Qwen/Qwen3.8-Max-Prime\` | Qwen 3.8 Max Prime | 1M | low, max | $4/$12 | Pro and above | fast |
| \`claude-sonnet-5\` | Claude Sonnet 5 | 1M | low, medium, high | $2/$10 | Max | frontier |
`

const LISTING = {
  object: 'list',
  data: [
    { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', context_length: 1000000 },
    { id: 'moonshotai/Kimi-K2.7-Code', name: 'Kimi K2.7 Code', context_length: 262144 },
    { id: 'MiniMaxAI/MiniMax-M2.5', name: 'MiniMax M2.5', context_length: 200000 },
    { id: 'Qwen/Qwen3.8-Max-Prime', name: 'Qwen 3.8 Max Prime', context_length: 1000000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1000000 },
    { id: 'unknown/model', name: 'Unknown', context_length: 8000 },
    { id: 'stealth/free-model:free', name: 'Stealth Model', context_length: 4096 },
  ],
}

function fakeFetch(payload) {
  return async () => ({ ok: true, status: 200, json: async () => payload })
}

test('parseCatalog reads plan and efforts from CLI catalog rows', () => {
  const catalog = parseCatalog(MARKDOWN)
  assert.deepEqual([...catalog.keys()], [
    'deepseek/deepseek-v4-flash',
    'moonshotai/Kimi-K2.7-Code',
    'MiniMaxAI/MiniMax-M2.5',
    'Qwen/Qwen3.8-Max-Prime',
    'claude-sonnet-5',
  ])
  assert.deepEqual(catalog.get('deepseek/deepseek-v4-flash'), { minPlan: 'Go and above', efforts: ['off', 'high', 'max'] })
  assert.deepEqual(catalog.get('moonshotai/Kimi-K2.7-Code'), { minPlan: 'Go and above' })
  assert.deepEqual(catalog.get('MiniMaxAI/MiniMax-M2.5'), { minPlan: 'GOAT and above' })
})

test('parseEfforts treats a dash as no declared effort', () => {
  assert.equal(parseEfforts('—'), undefined)
  assert.equal(parseEfforts('-'), undefined)
  assert.equal(parseEfforts(''), undefined)
  assert.deepEqual(parseEfforts('low, medium ,xhigh'), ['low', 'medium', 'xhigh'])
})

test('planTier and planIncludes honor the Go < GOAT < Pro < Max order', () => {
  assert.equal(planTier('Go and above'), 'go')
  assert.equal(planTier('GOAT and above'), 'goat')
  assert.equal(planTier('Pro and above'), 'pro')
  assert.equal(planTier('Max'), 'max')
  assert.equal(planTier('Enterprise'), undefined)
  const go = { minPlan: 'Go and above' }
  const goat = { minPlan: 'GOAT and above' }
  const max = { minPlan: 'Max' }
  assert.equal(planIncludes(go, 'go'), true)
  assert.equal(planIncludes(goat, 'go'), false)
  assert.equal(planIncludes(goat, 'goat'), true)
  assert.equal(planIncludes(max, 'pro'), false)
  assert.equal(planIncludes(max, 'max'), true)
  assert.equal(planIncludes(undefined, 'go'), false)
  assert.deepEqual(Object.keys(PLAN_ORDER), ['go', 'goat', 'pro', 'max'])
})

test('fetchCatalog tries the fallback host when the preferred one fails', async () => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (calls.length === 1) return { ok: false, status: 502 }
    return { ok: true, text: async () => MARKDOWN }
  }
  const catalog = await fetchCatalog({ fetchImpl })
  assert.equal(calls.length, 2)
  assert.match(calls[0], /unpkg\.com/)
  assert.match(calls[1], /jsdelivr\.net/)
  assert.equal(catalog.size, 5)
})

test('fetchCatalog reports the last failure when every host is down', async () => {
  const fetchImpl = async (url) => ({ ok: false, status: url.includes('unpkg') ? 502 : 503 })
  await assert.rejects(fetchCatalog({ fetchImpl }), /HTTP 503/)
})

test('fetchPlanModels keeps only models the plan includes', async () => {
  const catalog = parseCatalog(MARKDOWN)
  const go = await fetchPlanModels(catalog, { plan: 'go', fetchImpl: fakeFetch(LISTING) })
  assert.deepEqual(go.map(model => model.id), [
    'deepseek/deepseek-v4-flash',
    'moonshotai/Kimi-K2.7-Code',
  ])
  assert.equal(go[0].contextWindow, 1000000)
  assert.deepEqual(go[0].efforts, ['off', 'high', 'max'])
  assert.equal(go[1].efforts, undefined)

  const goat = await fetchPlanModels(catalog, { plan: 'goat', fetchImpl: fakeFetch(LISTING) })
  assert.deepEqual(goat.map(model => model.id), [
    'deepseek/deepseek-v4-flash',
    'MiniMaxAI/MiniMax-M2.5',
    'moonshotai/Kimi-K2.7-Code',
  ])
})

test('fetchPlanModels surfaces free tiers and rejects a malformed listing', async () => {
  const catalog = parseCatalog('| `stealth/free-model:free` | Free Model | 4K | — | | Go and above | x |')
  const models = await fetchPlanModels(catalog, { fetchImpl: fakeFetch(LISTING) })
  assert.deepEqual(models.map(model => model.name), ['Stealth Model (free)'])
  await assert.rejects(
    fetchPlanModels(catalog, { fetchImpl: fakeFetch({ nope: true }) }),
    /unexpected shape/,
  )
})

test('displayName marks a free id but not one already named free', () => {
  assert.equal(displayName('minimax/minimax-m3-free', 'MiniMax M3'), 'MiniMax M3 (free)')
  assert.equal(displayName('x/model:free', 'Model'), 'Model (free)')
  assert.equal(displayName('x/model-free', 'Model Free'), 'Model Free')
  assert.equal(displayName('x/model', 'Model'), 'Model')
})
