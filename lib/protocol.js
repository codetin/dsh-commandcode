/**
 * Command Code `/alpha/generate` wire protocol.
 *
 * A Go-plan subscription has no Provider-API access: the OpenAI-compatible
 * endpoints answer `403 upgrade_required`. Every Go request must go through
 * Command Code's private CLI gateway at `POST /alpha/generate`, which streams
 * line-delimited JSON (bare objects, no SSE `data:` framing).
 *
 * This module serializes the harness request into that envelope and translates
 * the stream back into harness `StreamChunk`s. The envelope mirrors the official
 * `command-code` CLI (`toWireMessages` / `toWireTools`) and the opencode
 * `commandcode-go` plugin.
 *
 * @module dsh-commandcode/protocol
 */

import { contentHasImage, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'

/**
 * Reasoning-effort values the gateway accepts, mapped to selector labels.
 * `off` is sent as-is: the CLI treats it as an explicit "no thinking" choice,
 * distinct from omitting the field (which lets the model decide).
 */
export const GATEWAY_EFFORTS = Object.freeze({
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
})

/** Last-resort output cap when a request carries no maxTokens. */
export const DEFAULT_MAX_TOKENS = 64_000

/** Upstream body budget carried into one error message. */
const MAX_ERROR_BODY_CHARS = 4_000

/**
 * How the gateway wire spells an argument the model does not need to send.
 *
 * The gateway forwards every tool to the OpenAI Responses API as a function
 * tool and never fills in that API's `strict` field, which defaults to `true`:
 * the upstream then reads the schema as if every declared property were
 * required. A `bash` call asked only to list a directory comes back carrying an
 * invented `timeoutMs` and `workdir`, and an optional property the model has
 * nothing to say about arrives holding its own description text.
 *
 * Optionality therefore has to be spelled as nullability on this wire: an
 * optional property accepts `null` and says so in its description. The adapter
 * drops those nulls on the way back ({@link dropNullArguments}), so the harness
 * sees exactly the arguments the model meant to pass.
 */
const NULL_ARGUMENT_HINT = 'Leave this out by passing null unless you need a value other than the default.'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** Whether a schema node already accepts an explicit `null`. */
function allowsNull(schema) {
  if (!isRecord(schema)) return false
  if (schema.type === 'null') return true
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true
  if (schema.const === null) return true
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true
  return Array.isArray(schema.anyOf) && schema.anyOf.some(allowsNull)
}

/** One optional property as the wire's nullable shape, hinting at the null. */
function optionalAsNull(property) {
  const description = typeof property.description === 'string' && property.description.length > 0
    ? `${property.description} ${NULL_ARGUMENT_HINT}`
    : NULL_ARGUMENT_HINT
  return {
    anyOf: [
      { ...property, description },
      { type: 'null', description: 'Use null when you do not need this argument.' },
    ],
  }
}

/**
 * One tool's argument schema in the shape the gateway wire expects: every
 * property the declaration leaves optional becomes nullable, at every depth.
 * A property that already accepts null, and every other schema node, is left
 * as the harness declared it.
 */
export function clientSchema(parameters) {
  if (!isRecord(parameters)) return parameters
  const schema = { ...parameters }
  if (isRecord(parameters.properties)) {
    const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
    const properties = {}
    for (const [name, property] of Object.entries(parameters.properties)) {
      const declared = clientSchema(property)
      properties[name] = !required.has(name) && isRecord(declared) && !allowsNull(declared)
        ? optionalAsNull(declared)
        : declared
    }
    schema.properties = properties
  }
  if (parameters.items !== undefined) schema.items = clientSchema(parameters.items)
  if (Array.isArray(parameters.anyOf)) schema.anyOf = parameters.anyOf.map(clientSchema)
  return schema
}

/**
 * Drop the nulls {@link clientSchema} invites: a null in an optional property's
 * place means "not passed", so the harness reads the argument as absent and the
 * tool's own default applies. A null the declaration sanctions stays put.
 */
export function dropNullArguments(value, schema) {
  if (Array.isArray(value)) {
    const items = isRecord(schema) ? schema.items : undefined
    return value.map(entry => dropNullArguments(entry, items))
  }
  if (!isRecord(value)) return value
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : undefined
  const required = new Set(isRecord(schema) && Array.isArray(schema.required) ? schema.required : [])
  const dropped = {}
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null) {
      const declared = properties?.[name]
      if (declared !== undefined && !required.has(name) && !allowsNull(declared)) continue
    }
    dropped[name] = dropNullArguments(entry, properties?.[name])
  }
  return dropped
}

/** The flattened text of one content list, with non-text handles kept as text. */
function flattenText(blocks) {
  let text = ''
  for (const block of blocks) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'file') text += `[file: ${block.attachment.name}]`
  }
  return text
}

/**
 * The attachment refs of the image blocks in one content list that still need
 * request bytes. An occurrence the harness already offloaded is deliberately
 * absent: it reaches the gateway as placeholder text, never as bytes.
 */
function imageRefs(blocks) {
  return blocks.filter(block => block.type === 'image' && block.offloaded !== true).map(block => block.attachment)
}

/** Sanitize a tool call id for the gateway wire protocol. */
function sanitizeToolCallId(id) {
  const head = id.includes('|') ? id.split('|')[0] : id
  return head.length > 64 ? head.slice(0, 64) : head
}

function safeParseJson(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function serializeAssistant(message) {
  const parts = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning') parts.push({ type: 'reasoning', text: block.text })
    else if (block.type === 'image') throw new LlmError('the gateway cannot represent an image in assistant history', 'UNSUPPORTED_CONTENT')
    else if (block.type === 'tool-call') {
      parts.push({
        type: 'tool-call',
        toolCallId: sanitizeToolCallId(block.id),
        toolName: block.name,
        input: safeParseJson(block.arguments),
      })
    }
  }
  return { role: 'assistant', content: parts }
}

/** One inline image part, in the exact wire shape the CLI's `toWireMessages` emits. */
function imagePart(ref, images) {
  const version = images?.get(ref.attachmentId)
  if (version === undefined) {
    throw new LlmError(`no request bytes resolved for image attachment ${ref.attachmentId}`, 'MISSING_ATTACHMENT')
  }
  return {
    type: 'image',
    image: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
    mimeType: version.mediaType,
  }
}

/**
 * One harness user message as gateway turns: its text and image parts, in block
 * order. A text-only message keeps the flat string shape.
 */
function serializeUser(message, images) {
  const parts = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push({ type: 'text', text: block.text })
    else if (block.type === 'image') parts.push(imagePart(block.attachment, images))
    else if (block.type === 'file') parts.push({ type: 'text', text: `[file: ${block.attachment.name}]` })
  }
  if (parts.length === 0) return []
  return [parts.every(part => part.type === 'text')
    ? { role: 'user', content: parts.map(part => part.text).join('') }
    : { role: 'user', content: parts }]
}

/**
 * One harness tool-result message as gateway turns: its own `tool` turn, plus a
 * user turn carrying any images the tool returned.
 *
 * The `tool` turn always comes first: dropping or reordering it leaves its
 * assistant tool-call unmatched and the gateway answers "Tool result is missing
 * for tool call …". Images cannot ride the gateway's text-only tool output, so
 * they follow as a user turn — the only role the gateway carries inline images
 * in — and {@link buildRequest} holds that turn past the end of the tool run.
 */
function serializeTool(message, images, toolNames) {
  const toolCallId = sanitizeToolCallId(message.toolCallId)
  const text = flattenText(message.content)
  const wire = [{
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId,
      toolName: toolNames.get(toolCallId) ?? 'unknown',
      output: message.isError === true
        ? { type: 'error-text', value: text || 'Execution denied' }
        : { type: 'text', value: text || '(no output)' },
    }],
  }]
  const refs = imageRefs(message.content)
  if (refs.length > 0) wire.push({ role: 'user', content: refs.map(ref => imagePart(ref, images)) })
  return wire
}

/**
 * The ordered, de-duplicated image refs a request needs bytes for, rejecting
 * images in roles the gateway cannot carry (assistant and developer history).
 * Offloaded occurrences need no bytes and are never returned.
 */
export function collectRequestImages(messages) {
  const refs = new Map()
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new LlmError(`a ${message.role} message carries an image the gateway cannot replay`, 'UNSUPPORTED_CONTENT')
    }
    for (const ref of imageRefs(message.content)) refs.set(ref.attachmentId, ref)
  }
  return [...refs.values()]
}

/** Whether a wire turn is a textless image-only user turn. */
function isImageOnlyUserTurn(turn) {
  return turn.role === 'user'
    && Array.isArray(turn.content)
    && turn.content.length > 0
    && turn.content.every(part => part.type === 'image')
}

/**
 * Build the gateway request envelope for one harness call.
 * @param {object} options - harness `GenerateOptions`.
 * @param {ReadonlyMap<string, object>} [images] - resolved request bytes per attachment id.
 * @returns {object} the `/alpha/generate` request envelope.
 */
export function buildRequest(options, images) {
  let system = options.system ?? ''
  const messages = []
  // Image-only user turns split from tool results must not land between tool
  // turns: the gateway ends tool collection at the first user turn and rejects
  // any later result with "Tool result is missing for tool call …".
  const deferred = []
  const flushDeferred = () => {
    if (deferred.length > 0) messages.push(...deferred.splice(0))
  }
  const pushTurn = (turn) => {
    if (isImageOnlyUserTurn(turn)
      && (messages[messages.length - 1]?.role === 'tool' || deferred.length > 0)) {
      deferred.push(turn)
      return
    }
    if (turn.role === 'user') flushDeferred()
    messages.push(turn)
  }
  const toolNames = new Map()
  for (const message of options.messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') toolNames.set(sanitizeToolCallId(block.id), block.name)
    }
  }
  for (const message of options.messages) {
    switch (message.role) {
      case 'system':
        system += (system ? '\n\n' : '') + flattenText(message.content)
        break
      case 'developer':
        // The gateway has no declaration-change channel, so the current tool
        // list is sent once per request. Fold the message text into the system
        // prompt and drop the add/remove markers; refusing would break every
        // turn after the harness legitimately narrows its tools.
        system += (system ? '\n\n' : '') + flattenText(message.content)
        break
      case 'assistant':
        pushTurn(serializeAssistant(message))
        break
      case 'tool':
        for (const turn of serializeTool(message, images, toolNames)) pushTurn(turn)
        break
      default:
        for (const turn of serializeUser(message, images)) pushTurn(turn)
    }
  }
  flushDeferred()

  const tools = (options.tools ?? []).map(tool => ({
    name: tool.name,
    ...tool.description === undefined ? {} : { description: tool.description },
    input_schema: clientSchema(tool.parameters),
  }))

  const params = {
    model: options.model,
    messages,
    tools,
    system,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  }
  if (options.temperature !== undefined) params.temperature = options.temperature
  // An effort the gateway has no value for is dropped rather than rejected.
  if (options.reasoningEffort !== undefined && Object.hasOwn(GATEWAY_EFFORTS, options.reasoningEffort)) {
    params.reasoning_effort = options.reasoningEffort
  }

  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split('T')[0],
      environment: `${process.platform}-${process.arch}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params,
  }
}

/**
 * Mutable per-stream translation state, threaded through every
 * {@link eventToChunks} call in arrival order.
 * @typedef {object} ChunkState
 * @property {number} nextIndex next free block index
 * @property {Map<number, string>} texts accumulated delta text per open textual block
 * @property {Map<number, {id: string, name?: string, arguments: string}>} toolCalls accumulated tool calls
 * @property {Map<number, 'text' | 'reasoning'>} openTextual open textual block type per index
 * @property {boolean} usageSeen whether a `usage` chunk was already emitted
 * @property {object} [pendingUsage] step usage held until the turn total arrives
 * @property {ReadonlyMap<string, unknown>} [toolSchemas] declared argument schemas per tool
 */

/**
 * Fresh translation state for one gateway stream.
 * @param {ReadonlyMap<string, unknown>} [toolSchemas] - declared argument schemas per tool.
 * @returns {ChunkState} the state.
 */
export function chunkState(toolSchemas) {
  return { nextIndex: 0, texts: new Map(), toolCalls: new Map(), openTextual: new Map(), usageSeen: false, pendingUsage: undefined, toolSchemas }
}

function openBlock(state, type) {
  const index = state.nextIndex++
  state.openTextual.set(index, type)
  return index
}

function latestOpen(state, type) {
  let latest
  for (const [index, open] of state.openTextual) {
    if (open === type && (latest === undefined || index > latest)) latest = index
  }
  return latest
}

function closeTextual(state, index) {
  const type = state.openTextual.get(index)
  if (type === undefined) return []
  state.openTextual.delete(index)
  return [{ type: 'block-end', index, block: { type, text: state.texts.get(index) ?? '' } }]
}

function ensureOpen(state, type) {
  const latest = latestOpen(state, type)
  return latest ?? openBlock(state, type)
}

/**
 * Translate one gateway stream event into zero or more harness StreamChunks.
 * @param {object} event - one parsed gateway event.
 * @param {ChunkState} state - translation state for this stream.
 * @returns {object[]} chunks in stream order.
 */
export function eventToChunks(event, state) {
  const chunks = []
  switch (event.type) {
    case 'text-start': {
      const index = openBlock(state, 'text')
      chunks.push({ type: 'block-start', index, blockType: 'text' })
      break
    }
    case 'text-delta': {
      const index = ensureOpen(state, 'text')
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.length > 0) {
        state.texts.set(index, (state.texts.get(index) ?? '') + text)
        chunks.push({ type: 'text-delta', index, text })
      }
      break
    }
    case 'text-end': {
      const index = latestOpen(state, 'text')
      if (index !== undefined) chunks.push(...closeTextual(state, index))
      break
    }
    case 'reasoning-start': {
      const index = openBlock(state, 'reasoning')
      chunks.push({ type: 'block-start', index, blockType: 'reasoning' })
      break
    }
    case 'reasoning-delta': {
      const index = ensureOpen(state, 'reasoning')
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.length > 0) {
        state.texts.set(index, (state.texts.get(index) ?? '') + text)
        chunks.push({ type: 'reasoning-delta', index, text })
      }
      break
    }
    case 'reasoning-end': {
      const index = latestOpen(state, 'reasoning')
      if (index !== undefined) chunks.push(...closeTextual(state, index))
      break
    }
    case 'tool-call': {
      const callId = typeof event.toolCallId === 'string' ? event.toolCallId
        : typeof event.id === 'string' ? event.id : ''
      const name = typeof event.toolName === 'string' ? event.toolName : undefined
      const raw = event.input ?? event.args ?? event.arguments
      const declared = name === undefined ? undefined : state.toolSchemas?.get(name)
      const input = declared === undefined ? raw : dropNullArguments(raw, declared)
      const argumentsDelta = JSON.stringify(input ?? {})
      const index = state.nextIndex++
      chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
      chunks.push({
        type: 'tool-call-delta',
        index,
        id: ToolCallId(callId),
        ...name === undefined ? {} : { name },
        argumentsDelta,
      })
      // The gateway emits each tool call as one complete event, so the block
      // opens and closes here; the invariant forbids finishing with it open.
      chunks.push({
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: ToolCallId(callId), name: name ?? '', arguments: argumentsDelta },
      })
      break
    }
    // `finish-step` carries step usage and `finish` carries the turn total;
    // only `finish` terminates, and usage is emitted once.
    case 'finish-step': {
      // Hold the step usage: a multi-step turn carries the sum in `finish`'s
      // `totalUsage`, and that total is what the harness should meter.
      state.pendingUsage = finishUsage(event.usage ?? event.totalUsage) ?? state.pendingUsage
      break
    }
    case 'finish': {
      if (!state.usageSeen) {
        const usage = finishUsage(event.totalUsage ?? event.usage) ?? state.pendingUsage
        if (usage !== undefined) {
          state.usageSeen = true
          chunks.push({ type: 'usage', usage })
        }
      }
      // Close any block the gateway left open (a truncated stream may skip
      // `reasoning-end` / `text-end`); the invariant forbids finishing open.
      for (const [index, type] of state.openTextual) {
        chunks.push({ type: 'block-end', index, block: { type, text: state.texts.get(index) ?? '' } })
      }
      state.openTextual.clear()
      chunks.push({ type: 'finish', reason: mapFinishReason(event.finishReason ?? event.rawFinishReason ?? 'stop') })
      break
    }
  }
  return chunks
}

/** The harness usage of a gateway step/finish usage payload, if recognizable. */
export function finishUsage(raw) {
  if (!isRecord(raw)) return undefined
  const inputDetails = isRecord(raw.inputTokenDetails) ? raw.inputTokenDetails : undefined
  const outputDetails = isRecord(raw.outputTokenDetails) ? raw.outputTokenDetails : undefined
  if (typeof raw.inputTokens !== 'number' && typeof raw.outputTokens !== 'number' && inputDetails === undefined) {
    return undefined
  }
  const totalInput = typeof raw.inputTokens === 'number' ? raw.inputTokens : 0
  const cacheRead = typeof inputDetails?.cacheReadTokens === 'number' ? inputDetails.cacheReadTokens : undefined
  const noCache = typeof inputDetails?.noCacheTokens === 'number' ? inputDetails.noCacheTokens : undefined
  const inputTokens = noCache ?? (cacheRead !== undefined ? Math.max(0, totalInput - cacheRead) : totalInput)
  const outputTokens = typeof raw.outputTokens === 'number'
    ? raw.outputTokens
    : typeof outputDetails?.textTokens === 'number' ? outputDetails.textTokens : 0
  const reasoningTokens = typeof outputDetails?.reasoningTokens === 'number' ? outputDetails.reasoningTokens : undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens: totalInput + outputTokens,
    ...cacheRead === undefined ? {} : { cacheReadTokens: cacheRead },
    ...reasoningTokens === undefined ? {} : { reasoningTokens },
  }
}

/** Map the gateway finish-reason vocabulary to the harness FinishReason. */
export function mapFinishReason(raw) {
  switch (raw) {
    case 'stop':
    case 'end_turn':
    case 'end-turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'tool-calls':
    case 'tool_use':
    case 'tool-use':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
    case 'max-output-tokens':
    case 'model_context_window_exceeded':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${String(raw)}`, code: String(raw).toUpperCase() } }
  }
}

function parseEventLine(line) {
  if (line.length === 0 || line.startsWith(':')) return undefined
  let parsed
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return isRecord(parsed) && typeof parsed.type === 'string' ? parsed : undefined
}

/**
 * Parse the line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 * @param {ReadableStream<Uint8Array>} stream - response body.
 * @returns {AsyncGenerator<object>} parsed events in arrival order.
 */
export async function* parseEventStream(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? '' : decoder.decode(value, { stream: true })
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const event = parseEventLine(line)
        if (event !== undefined) yield event
      }
      if (done) {
        const event = parseEventLine(buffer.trim())
        if (event !== undefined) yield event
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * The upstream detail of an in-stream `error` event. A generation that fails
 * after the headers are sent carries its only failure text in this line.
 * @param {object} event - the `error` event.
 * @returns {{detail: string, status?: number}} the detail and any HTTP status.
 */
export function streamErrorDetail(event) {
  const error = isRecord(event.error) ? event.error : event
  const body = nonEmptyString(error.responseBody)
  const message = nonEmptyString(error.message)
    ?? (body === undefined ? undefined : gatewayErrorDetail(body))
    ?? JSON.stringify(event)
  const status = typeof error.statusCode === 'number' && Number.isInteger(error.statusCode) ? error.statusCode : undefined
  const detail = body === undefined || message.includes(body) ? message : `${message}: ${body}`
  return {
    detail: detail.slice(0, MAX_ERROR_BODY_CHARS),
    ...status === undefined ? {} : { status },
  }
}

/**
 * The upstream detail of a gateway error body.
 * The gateway answers `{"success":false,"error":{"code","status","message"}}`,
 * but an edge or proxy can answer HTML or plain text instead; an unparsed body
 * is passed through verbatim because it still names the failure.
 * @param {string} body - response body.
 * @returns {string | undefined} the detail.
 */
export function gatewayErrorDetail(body) {
  const trimmed = body.trim()
  if (trimmed.length === 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return trimmed.slice(0, MAX_ERROR_BODY_CHARS)
  }
  const envelope = isRecord(parsed) && 'error' in parsed ? parsed.error : parsed
  if (typeof envelope === 'string') {
    const text = nonEmptyString(envelope)
    return text ?? trimmed.slice(0, MAX_ERROR_BODY_CHARS)
  }
  const message = isRecord(envelope)
    ? nonEmptyString(envelope.message) ?? nonEmptyString(envelope.detail)
    : undefined
  if (message === undefined) return trimmed.slice(0, MAX_ERROR_BODY_CHARS)
  const code = isRecord(envelope) ? nonEmptyString(envelope.code) : undefined
  return code === undefined || message.includes(code) ? message : `${message} [${code}]`
}
