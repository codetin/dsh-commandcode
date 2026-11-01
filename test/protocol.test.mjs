import assert from 'node:assert/strict'
import test from 'node:test'
import {
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
} from '../lib/protocol.js'

function streamFrom(parts) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}

async function collect(events) {
  const state = chunkState()
  const chunks = []
  for (const event of events) chunks.push(...eventToChunks(event, state))
  return { chunks, state }
}

test('clientSchema makes optional properties nullable at every depth', () => {
  const declared = {
    type: 'object',
    properties: {
      requiredText: { type: 'string', description: 'Needed.' },
      optionalText: { type: 'string', description: 'Optional.' },
      optionalNumber: { type: 'number' },
      nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      nested: {
        type: 'object',
        properties: { inner: { type: 'boolean' } },
        required: ['inner'],
      },
      list: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' } } } },
    },
    required: ['requiredText', 'nested', 'list'],
  }
  const wire = clientSchema(declared)
  assert.equal(wire.required[0], 'requiredText')
  assert.deepEqual(wire.properties.requiredText, declared.properties.requiredText)
  assert.equal(wire.properties.optionalText.anyOf.length, 2)
  assert.match(wire.properties.optionalText.anyOf[0].description, /Leave this out by passing null/)
  assert.equal(wire.properties.optionalText.anyOf[1].type, 'null')
  assert.equal(wire.properties.optionalNumber.anyOf.length, 2)
  assert.deepEqual(wire.properties.nullable, declared.properties.nullable)
  assert.deepEqual(wire.properties.nested, declared.properties.nested)
  // the array itself is required, but its items' optional property is still made nullable
  assert.equal(wire.properties.list.items.properties.item.anyOf.length, 2)
})

test('dropNullArguments drops nulls only where the declaration left the property optional', () => {
  const declared = {
    type: 'object',
    properties: {
      a: { type: 'string' },
      b: { type: 'string' },
      nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
    required: ['a'],
  }
  assert.deepEqual(
    dropNullArguments({ a: 'x', b: null, nullable: null }, declared),
    { a: 'x', nullable: null },
  )
  // a required property is never dropped: a missing required value is as
  // invalid as an explicit null, and silently dropping it would hide the bug.
  assert.deepEqual(dropNullArguments({ a: null, b: 'y' }, declared), { a: null, b: 'y' })
})

test('buildRequest folds system and developer text and carries tool history', () => {
  const request = buildRequest({
    provider: 'commandcode',
    model: 'deepseek/deepseek-v4-flash',
    system: 'base system',
    reasoningEffort: 'high',
    temperature: 0.2,
    maxTokens: 1234,
    tools: [{
      name: 'ping',
      description: 'Ping the service.',
      parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] },
    }],
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'system message' }] },
      { role: 'developer', content: [{ type: 'text', text: 'developer note' }, { type: 'tool-addition', toolName: 'ping' }] },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'calling' },
          { type: 'tool-call', id: 'call_1|fc_1', name: 'ping', arguments: '{"value":7}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1|fc_1', content: [{ type: 'text', text: 'pong' }] },
    ],
  }, undefined)

  assert.equal(request.params.model, 'deepseek/deepseek-v4-flash')
  assert.equal(request.params.system, 'base system\n\nsystem message\n\ndeveloper note')
  assert.equal(request.params.reasoning_effort, 'high')
  assert.equal(request.params.temperature, 0.2)
  assert.equal(request.params.max_tokens, 1234)
  assert.equal(request.params.stream, true)
  assert.equal(request.params.tools[0].name, 'ping')
  const [user, assistant, tool] = request.params.messages
  assert.deepEqual(user, { role: 'user', content: 'hello' })
  assert.deepEqual(assistant.content[0], { type: 'reasoning', text: 'thinking' })
  assert.deepEqual(assistant.content[2], { type: 'tool-call', toolCallId: 'call_1', toolName: 'ping', input: { value: 7 } })
  assert.deepEqual(tool, {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'ping',
      output: { type: 'text', value: 'pong' },
    }],
  })
})

test('buildRequest omits an effort the gateway does not know', () => {
  const request = buildRequest({
    provider: 'commandcode',
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    reasoningEffort: 'minimal',
  })
  assert.equal('reasoning_effort' in request.params, false)
})

test('collectRequestImages ignores offloaded occurrences and rejects images in assistant history', () => {
  const ref = { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1, height: 1 }
  assert.deepEqual(collectRequestImages([
    { role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image', attachment: ref }] },
    { role: 'user', content: [{ type: 'image', attachment: ref }] },
    { role: 'user', content: [{ type: 'image', attachment: { ...ref, attachmentId: 'a2' }, offloaded: true }] },
  ]).map(entry => entry.attachmentId), ['a1'])
  assert.throws(() => collectRequestImages([
    { role: 'assistant', content: [{ type: 'image', attachment: ref }] },
  ]), /cannot replay/)
})

test('eventToChunks translates reasoning, text, tool calls, usage, and finish', async () => {
  const { chunks, state } = await collect([
    { type: 'start' },
    { type: 'reasoning-start' },
    { type: 'reasoning-delta', text: 'think ' },
    { type: 'reasoning-delta', text: 'hard' },
    // reasoning-end may arrive after the text stream opens
    { type: 'text-start' },
    { type: 'text-delta', text: 'hel' },
    { type: 'reasoning-end' },
    { type: 'text-delta', text: 'lo' },
    { type: 'text-end' },
    { type: 'tool-call', toolCallId: 'call_9', toolName: 'ping', input: { value: 7 } },
    {
      type: 'finish-step',
      usage: { inputTokens: 10, inputTokenDetails: { noCacheTokens: 6, cacheReadTokens: 4 }, outputTokens: 3 },
    },
    { type: 'finish', finishReason: 'tool-calls' },
  ])
  assert.equal(state.usageSeen, true)

  const starts = chunks.filter(chunk => chunk.type === 'block-start')
  assert.deepEqual(starts.map(chunk => [chunk.index, chunk.blockType]), [
    [0, 'reasoning'],
    [1, 'text'],
    [2, 'tool-call'],
  ])
  const ends = chunks.filter(chunk => chunk.type === 'block-end')
  assert.deepEqual(ends.map(chunk => chunk.index), [0, 1, 2])
  assert.deepEqual(ends[0].block, { type: 'reasoning', text: 'think hard' })
  assert.deepEqual(ends[1].block, { type: 'text', text: 'hello' })
  assert.deepEqual(ends[2].block, { type: 'tool-call', id: 'call_9', name: 'ping', arguments: '{"value":7}' })
  const usage = chunks.find(chunk => chunk.type === 'usage').usage
  assert.deepEqual(usage, { inputTokens: 6, outputTokens: 3, totalTokens: 13, cacheReadTokens: 4 })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('eventToChunks prefers the turn total over the step usage', async () => {
  const state = chunkState()
  eventToChunks({ type: 'finish-step', usage: { inputTokens: 10, outputTokens: 1 } }, state)
  const chunks = eventToChunks({ type: 'finish', totalUsage: { inputTokens: 20, outputTokens: 2 } }, state)
  const usage = chunks.find(chunk => chunk.type === 'usage').usage
  assert.deepEqual(usage, { inputTokens: 20, outputTokens: 2, totalTokens: 22 })
  assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1)
})

test('eventToChunks closes blocks a truncated stream left open', async () => {
  const { chunks } = await collect([
    { type: 'text-start' },
    { type: 'text-delta', text: 'partial' },
    { type: 'finish', finishReason: 'stop' },
  ])
  const end = chunks.find(chunk => chunk.type === 'block-end')
  assert.deepEqual(end.block, { type: 'text', text: 'partial' })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('eventToChunks applies the declared schema to a tool call', async () => {
  const state = chunkState(new Map([['ping', {
    type: 'object',
    properties: { value: { type: 'number' }, note: { type: 'string' } },
    required: ['value'],
  }]]))
  const chunks = eventToChunks({ type: 'tool-call', toolCallId: 'c', toolName: 'ping', input: { value: 1, note: null } }, state)
  const delta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal(delta.argumentsDelta, '{"value":1}')
})

test('parseEventStream reassembles lines split across byte chunks', async () => {
  const events = []
  const stream = streamFrom(['{"type":"text-start"}\n{"type":"text-', 'delta","text":"hi"}\n\n{"type":"finish"}'])
  for await (const event of parseEventStream(stream)) events.push(event)
  assert.deepEqual(events, [
    { type: 'text-start' },
    { type: 'text-delta', text: 'hi' },
    { type: 'finish' },
  ])
})

test('finishUsage separates cache reads from the non-cached input', () => {
  assert.deepEqual(finishUsage({
    inputTokens: 100,
    inputTokenDetails: { cacheReadTokens: 80 },
    outputTokens: 20,
    outputTokenDetails: { reasoningTokens: 5 },
  }), {
    inputTokens: 20,
    outputTokens: 20,
    totalTokens: 120,
    cacheReadTokens: 80,
    reasoningTokens: 5,
  })
  assert.equal(finishUsage({}), undefined)
  assert.equal(finishUsage(null), undefined)
})

test('gateway details survive JSON, HTML, and in-stream error shapes', () => {
  assert.equal(gatewayErrorDetail('{"success":false,"error":{"code":"bad_key","message":"Invalid key"}}'), 'Invalid key [bad_key]')
  assert.equal(gatewayErrorDetail('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>')
  assert.equal(gatewayErrorDetail('{"error":"plain"}'), 'plain')
  assert.equal(gatewayErrorDetail('   '), undefined)
  assert.deepEqual(streamErrorDetail({
    type: 'error',
    error: { message: 'upstream failed', statusCode: 402, responseBody: '{"error":{"message":"no credits"}}' },
  }), { detail: 'upstream failed: {"error":{"message":"no credits"}}', status: 402 })
})

test('mapFinishReason covers the CLI and harness vocabularies', () => {
  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('end_turn'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('tool_calls'), { kind: 'tool-calls' })
  assert.deepEqual(mapFinishReason('max_tokens'), { kind: 'max-tokens' })
  assert.deepEqual(mapFinishReason('model_context_window_exceeded'), { kind: 'max-tokens' })
  const failure = mapFinishReason('content_filter')
  assert.equal(failure.kind, 'error')
  assert.equal(failure.failure.code, 'CONTENT_FILTER')
})
