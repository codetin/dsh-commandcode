import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  CommandCodeAdapter,
  DEFAULT_CONTEXT_WINDOW,
  explainGatewayError,
  upstreamErrorCode,
} from '../lib/adapter.js'

function streamFrom(parts) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

function connection(overrides = {}) {
  return {
    displayName: 'Command Code',
    apiKeyEnv: 'COMMANDCODE_API_KEY',
    baseURL: 'https://api.commandcode.ai',
    plan: 'go',
    maxTokens: 64_000,
    defaultContextWindow: DEFAULT_CONTEXT_WINDOW,
    maxRequestImageBytes: 2_097_152,
    http1: false,
    refreshMinutes: 360,
    cliVersion: '9.9.9',
    ...overrides,
  }
}

function adapterWith({ current = connection(), models = [], apiKey = 'user_test' } = {}) {
  return new CommandCodeAdapter({
    connection: () => current,
    models: () => models,
    resolveApiKey: async () => apiKey,
    resolveAttachments: () => undefined,
  })
}

const CATALOG = [
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, efforts: ['off', 'high', 'max'] },
  { id: 'plain/model', name: 'Plain', contextWindow: 200_000 },
]

test('providerInfo, listModels, and resolveModel expose the scanned catalog', async () => {
  const adapter = adapterWith({ models: CATALOG })
  assert.deepEqual(adapter.providerInfo('commandcode'), { id: 'commandcode', name: 'Command Code' })
  assert.deepEqual(await adapter.listModels('commandcode'), [
    { provider: 'commandcode', id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { provider: 'commandcode', id: 'plain/model', name: 'Plain' },
  ])
  const resolved = await adapter.resolveModel('commandcode', 'deepseek/deepseek-v4-flash')
  assert.deepEqual(resolved.context, { contextWindow: 1_000_000 })
  assert.equal(resolved.defaultMaxTokens, 64_000)
  assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.id), ['off', 'high', 'max'])
  assert.deepEqual(resolved.reasoning.efforts.map(effort => effort.name), ['Off', 'High', 'Max'])

  const plain = await adapter.resolveModel('commandcode', 'plain/model')
  assert.equal(plain.reasoning, undefined)
  assert.deepEqual(plain.context, { contextWindow: 200_000 })

  const unknown = await adapter.resolveModel('commandcode', 'not/in/catalog')
  assert.deepEqual(unknown.context, { contextWindow: DEFAULT_CONTEXT_WINDOW })
  assert.equal(unknown.reasoning, undefined)
})

test('stream posts the CLI envelope to /alpha/generate and translates the response', async () => {
  const captured = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured.url = url
    captured.init = init
    return new Response(streamFrom([
      '{"type":"start"}\n',
      '{"type":"text-start"}\n',
      '{"type":"text-delta","text":"po"}\n',
      '{"type":"text-delta","text":"ng"}\n',
      '{"type":"text-end"}\n',
      '{"type":"finish-step","usage":{"inputTokens":12,"inputTokenDetails":{"cacheReadTokens":2},"outputTokens":3}}\n',
      '{"type":"finish","finishReason":"stop"}\n',
    ]), { status: 200 })
  }
  try {
    const chunks = []
    for await (const chunk of adapterWith({ models: CATALOG }).stream({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4-flash',
      reasoningEffort: 'high',
      system: 'be terse',
      tools: [{ name: 'ping', description: 'Ping.', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)

    assert.equal(captured.url, 'https://api.commandcode.ai/alpha/generate')
    assert.equal(captured.init.headers.authorization, 'Bearer user_test')
    assert.equal(captured.init.headers['x-command-code-version'], '9.9.9')
    assert.equal(captured.init.headers['x-cli-environment'], 'production')
    assert.equal(captured.init.headers['user-agent'], 'cli')
    const body = JSON.parse(captured.init.body)
    assert.equal(body.params.model, 'deepseek/deepseek-v4-flash')
    assert.equal(body.params.reasoning_effort, 'high')
    assert.equal(body.params.system, 'be terse')
    assert.equal(body.params.messages[0].content, 'hi')
    assert.deepEqual(body.params.tools[0].input_schema.properties.value, { type: 'number' })

    assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['po', 'ng'])
    assert.deepEqual(chunks.find(chunk => chunk.type === 'usage').usage, {
      inputTokens: 10,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadTokens: 2,
    })
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('probe authenticates with the supplied literal instead of the stored key', async () => {
  const captured = {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    captured.url = url
    captured.init = init
    return new Response(streamFrom([
      '{"type":"text-start"}\n',
      '{"type":"text-delta","text":"pong"}\n',
      '{"type":"text-end"}\n',
      '{"type":"finish","finishReason":"stop"}\n',
    ]), { status: 200 })
  }
  try {
    // The resolver holds a different key, so the header proves which one rode.
    const adapter = adapterWith({ models: CATALOG, apiKey: 'user_stored' })
    const chunks = []
    for await (const chunk of adapter.probe({
      provider: 'commandcode',
      model: 'deepseek/deepseek-v4-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: pong' }] }],
    }, 'user_typed')) chunks.push(chunk)

    assert.equal(captured.url, 'https://api.commandcode.ai/alpha/generate')
    assert.equal(captured.init.headers.authorization, 'Bearer user_typed')
    assert.deepEqual(
      chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text),
      ['pong'],
    )
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream explains a 403 instead of reporting a bare HTTP status', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    error: { code: 'upgrade_required', message: 'This endpoint requires an upgraded plan' },
  }), { status: 403 })
  try {
    await assert.rejects(
      (async () => {
        for await (const _chunk of adapterWith().stream({
          provider: 'commandcode',
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) { /* drain */ }
      })(),
      (error) => {
        assert.equal(error instanceof LlmError, true)
        assert.equal(error.code, 'AUTH')
        assert.equal(error.failure.status, 403)
        assert.match(error.message, /upgrade_required/)
        assert.match(error.message, /already uses the Go CLI gateway/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a stream without a finish event is reported as truncated', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(streamFrom(['{"type":"text-start"}\n{"type":"text-delta","text":"x"}\n']), { status: 200 })
  try {
    await assert.rejects(
      (async () => {
        for await (const _chunk of adapterWith().stream({
          provider: 'commandcode',
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        })) { /* drain */ }
      })(),
      (error) => error instanceof LlmError && error.code === 'STREAM_CLOSED',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('upstreamErrorCode names each recoverable failure', () => {
  assert.equal(upstreamErrorCode(403, 'MODEL_NOT_IN_PLAN'), 'PERMISSION')
  assert.equal(upstreamErrorCode(402, 'PREMIUM_CREDITS_EXHAUSTED'), 'QUOTA')
  assert.equal(upstreamErrorCode(429, ''), 'RATE_LIMIT')
  assert.equal(upstreamErrorCode(200, 'RATE_LIMITED'), 'RATE_LIMIT')
  assert.equal(upstreamErrorCode(401, ''), 'AUTH')
  assert.equal(upstreamErrorCode(403, ''), 'AUTH')
  assert.equal(upstreamErrorCode(400, 'context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(upstreamErrorCode(400, 'bad tool'), 'INVALID_REQUEST')
  assert.equal(upstreamErrorCode(503, ''), 'SERVER')
  assert.equal(upstreamErrorCode(418, ''), 'HTTP_418')
})

test('explainGatewayError only adds the Go-plan hint where it applies', () => {
  assert.match(explainGatewayError(403, 'upgrade_required'), /Go\/GOAT\/Pro\/Max/)
  assert.match(explainGatewayError(403, 'forbidden'), /rejected by \/alpha\/generate/)
  assert.equal(explainGatewayError(500, 'boom'), 'boom')
  assert.equal(explainGatewayError(500, ''), 'HTTP 500')
})
