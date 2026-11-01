/**
 * Command Code adapter: a harness `LlmAdapter` whose transport is Command
 * Code's private `/alpha/generate` CLI gateway.
 *
 * The adapter is transport-only: connection facts arrive through a thunk that
 * the registering plugin owns, the bearer key through a per-request resolver,
 * and model metadata through `listModels()` / `resolveModel()`.
 *
 * @module dsh-commandcode/adapter
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  errorChain,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  offloadedImageText,
  projectOffloadedImages,
  QUOTA_EXCEEDED_CODE,
  ReasoningEffortId,
  requiredImageOffload,
} from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import {
  buildRequest,
  chunkState,
  collectRequestImages,
  DEFAULT_MAX_TOKENS,
  eventToChunks,
  GATEWAY_EFFORTS,
  gatewayErrorDetail,
  parseEventStream,
  streamErrorDetail,
} from './protocol.js'

/** Default maximum idle interval while a gateway stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
/**
 * Default inline image budget for one request: 2 MiB of base64. The gateway is
 * stateless, so every retained image rides every turn again; beyond this budget
 * the harness records the oldest occurrences as offloaded and retries.
 */
export const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 2_097_152

export { DEFAULT_MAX_TOKENS }

/** Per-image request budget: the full 2048px normalized attachment, re-encoded to fit 1MiB. */
const REQUEST_IMAGE_POLICY = Object.freeze({ maxPixels: 4_194_304, maxBytes: 1_048_576 })

/**
 * One process-wide HTTP/1.1 dispatcher, built on first use and shared by every
 * request so connections keep pooling.
 *
 * Node >= 26 negotiates HTTP/2 for `fetch` by default and multiplexes all
 * gateway traffic onto a single connection; the gateway's Cloudflare edge
 * answers that burst shape by resetting streams with `ENHANCE_YOUR_CALM`,
 * which arrives as a transport failure rather than a readable 429. HTTP/1.1
 * keeps the same limit an ordinary HTTP status. A runtime without the `undici`
 * seam keeps the default instead of failing the request.
 */
let http1Dispatcher

function gatewayDispatcher() {
  http1Dispatcher ??= import('undici')
    .then(({ Agent }) => new Agent({ allowH2: false }))
    .catch(() => undefined)
  return http1Dispatcher
}

/**
 * Deterministic request target for one source image under the route budgets.
 * Both spellings of the same budget ride along: dsh >= 0.1.6 reads
 * `width`/`height`, earlier releases read `maxPixels`, and each validates only
 * the fields it knows, so one target serves either runtime.
 */
function requestImageTarget(ref) {
  return {
    ...requestImageDimensions(ref.width, ref.height, REQUEST_IMAGE_POLICY.maxPixels),
    maxPixels: REQUEST_IMAGE_POLICY.maxPixels,
    maxBytes: REQUEST_IMAGE_POLICY.maxBytes,
  }
}

function effortInfo(effort) {
  return { id: ReasoningEffortId(effort), name: GATEWAY_EFFORTS[effort] ?? effort }
}

/** The exact base64 length of one request image, which is the representation the gateway carries. */
function base64Length(bytes) {
  return 4 * Math.ceil(bytes / 3)
}

/** Exact base64 length of one attachment's resolved request version. */
function requestImageVersions(versions) {
  const lengths = new Map(versions.map(version => [version.attachment.attachmentId, version.bytes]))
  return (block) => {
    const bytes = lengths.get(block.attachment.attachmentId)
    if (bytes === undefined) {
      throw new LlmError(`no request bytes resolved for image attachment ${block.attachment.attachmentId}`, 'MISSING_ATTACHMENT')
    }
    return base64Length(bytes)
  }
}

function modelInfo(provider, model) {
  return { provider, id: model.id, name: model.name ?? model.id }
}

/**
 * Build the reasoning-effort selector for one model.
 * A model exposes exactly the efforts the catalog credits it with, including
 * `Off` when the catalog lists it; a model whose catalog cell is blank decides
 * its own depth and exposes no selector. No default effort is pinned.
 */
function reasoningFor(model) {
  const levels = (model?.efforts ?? []).filter(effort => Object.hasOwn(GATEWAY_EFFORTS, effort))
  if (levels.length === 0) return undefined
  return { efforts: levels.map(effortInfo) }
}

/**
 * Command Code adapter. One instance serves the `commandcode` route; the
 * harness model id IS the gateway wire model id.
 */
export class CommandCodeAdapter extends LlmAdapter {
  /**
   * @param {object} options - adapter dependencies.
   * @param {() => object} options.connection - current connection facts for the route.
   * @param {() => readonly object[]} options.models - current scanned catalog.
   * @param {() => Promise<void>} [options.ready] - resolves once the first catalog scan settled.
   * @param {() => Promise<string>} options.resolveApiKey - bearer key for this request.
   * @param {() => object | undefined} [options.resolveAttachments] - durable attachment service.
   * @param {(attachments: object, ref: object) => object | undefined} [options.resolveImageAccess] - image path bridge.
   */
  constructor(options) {
    super()
    this.options = options
  }

  providerInfo(provider) {
    return { id: provider, name: this.options.connection().displayName }
  }

  async listModels(provider) {
    await this.options.ready?.()
    return this.options.models().map(model => modelInfo(provider, model))
  }

  async resolveModel(provider, model) {
    // The first catalog scan starts asynchronously when the plugin mounts; wait
    // for it so reasoning-effort validation runs against the real capabilities
    // instead of an empty catalog that rejects every explicit effort.
    await this.options.ready?.()
    const connection = this.options.connection()
    const configured = this.options.models().find(entry => entry.id === model)
    const info = configured === undefined
      ? modelInfo(provider, { id: model, name: model })
      : modelInfo(provider, configured)
    const reasoning = reasoningFor(configured)
    return {
      ...info,
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      ...reasoning === undefined ? {} : { reasoning },
    }
  }

  /** The one projection every request shares: offloaded images become placeholder text. */
  requestMessages(messages) {
    const attachments = this.options.resolveAttachments?.()
    const resolveImageAccess = this.options.resolveImageAccess
    const projected = projectOffloadedImages(messages, ref => offloadedImageText(
      ref,
      attachments === undefined || resolveImageAccess === undefined
        ? undefined
        : resolveImageAccess(attachments, ref),
    ))
    return projected === messages ? messages : [...projected]
  }

  /**
   * Resolve the request bytes for every retained image. A request above the
   * route's image budget fails with `IMAGE_OFFLOAD_REQUIRED`; the harness then
   * records the oldest occurrences as offloaded and retries.
   */
  async prepareRequestImages(messages, signal, maxRequestImageBytes) {
    const refs = collectRequestImages(messages)
    if (refs.length === 0) return undefined
    const attachments = this.options.resolveAttachments?.()
    if (attachments === undefined) {
      throw new LlmError('image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const versions = await Promise.all(refs.map(ref => attachments.readImageRequest(ref, requestImageTarget(ref), signal)))
    const offloadImages = requiredImageOffload(messages, {
      representation: 'base64',
      maxBytes: maxRequestImageBytes,
    }, requestImageVersions(versions))
    if (offloadImages > 0) {
      throw new LlmError(
        `commandcode request images exceed the ${maxRequestImageBytes}-byte base64 budget;`
        + ` ${offloadImages} more oldest occurrence(s) must be offloaded.`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages },
      )
    }
    return new Map(versions.map(version => [version.attachment.attachmentId, version]))
  }

  imageRequestTarget(_provider, _model, image) {
    return requestImageTarget(image)
  }

  async *stream(options) {
    yield* this.transport(options, await this.options.resolveApiKey())
  }

  /**
   * One throwaway request authenticated by an explicit literal instead of the
   * stored credential — what the Models page's key test sends, so a typed key
   * can be checked before (or without) saving it. Same transport, same
   * translation, same errors.
   * @param options - harness generate options.
   * @param apiKey - literal to authenticate this one request with.
   */
  async *probe(options, apiKey) {
    yield* this.transport(options, apiKey)
  }

  /**
   * The shared request path: one authenticated stream with the idle guard, the
   * caller's cancellation folded in, and every failure mapped to `LlmError`.
   * @param options - harness generate options.
   * @param apiKey - bearer literal for this request.
   */
  async *transport(options, apiKey) {
    const connection = this.options.connection()
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    let timedOut = false
    let idleTimer
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOut = true
        consumer.abort('Command Code stream idle timeout')
      }, DEFAULT_STREAM_IDLE_TIMEOUT_MS)
      idleTimer.unref?.()
    }
    const iterator = this.request(options, upstream, connection, apiKey)[Symbol.asyncIterator]()
    let exhausted = false
    try {
      armIdle()
      while (true) {
        const result = await iterator.next()
        if (result.done) {
          exhausted = true
          return
        }
        armIdle()
        yield result.value
      }
    } catch (error) {
      if (timedOut) {
        throw new LlmError(
          `stream idle timeout after ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) throw new LlmError('request aborted by caller', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError(errorChain(error), 'TRANSPORT', { cause: error })
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      consumer.abort('Command Code stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  async *request(options, signal, connection, apiKey) {
    const messages = this.requestMessages(options.messages)
    const images = await this.prepareRequestImages(messages, signal, connection.maxRequestImageBytes)
    const body = buildRequest({ ...options, messages }, images)
    const headers = {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-command-code-version': connection.cliVersion,
      'x-cli-environment': 'production',
      // The official CLI identifies itself as `cli`; the gateway reads this
      // with the version header to decide which client features to enable.
      'user-agent': 'cli',
    }

    let response
    try {
      const init = { method: 'POST', headers, body: JSON.stringify(body), signal }
      const dispatcher = connection.http1 ? await gatewayDispatcher() : undefined
      if (dispatcher !== undefined) init.dispatcher = dispatcher
      response = await fetch(`${connection.baseURL}/alpha/generate`, init)
    } catch (error) {
      if (signal.aborted) throw error
      // errorChain unwraps undici's `TypeError: fetch failed` down to the real
      // socket/DNS/TLS failure, which the message alone would otherwise hide.
      throw new LlmError(errorChain(error), 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const detail = gatewayErrorDetail(raw) ?? raw
      throw new LlmError(
        `${explainGatewayError(response.status, detail)} [model=${options.model}]`,
        upstreamErrorCode(response.status, detail),
        { status: response.status },
      )
    }
    if (!response.body) throw new LlmError('returned no response body', 'EMPTY_RESPONSE')

    const state = chunkState(new Map((options.tools ?? []).map(tool => [tool.name, tool.parameters])))
    for await (const event of parseEventStream(response.body)) {
      // A mid-stream failure arrives as an event, not an HTTP status; its
      // message is the only account of what went wrong.
      if (event.type === 'error') {
        const { detail, status } = streamErrorDetail(event)
        throw new LlmError(
          `${detail} [model=${options.model}]`,
          upstreamErrorCode(status ?? 500, detail),
          status === undefined ? undefined : { status },
        )
      }
      yield* eventToChunks(event, state)
      // `finish-step` precedes `finish`; only `finish` terminates.
      if (event.type === 'finish') return
    }
    throw new LlmError('stream ended without a finish event', 'STREAM_CLOSED')
  }
}

/**
 * Map a gateway status and error text to a stable harness `LlmError` code.
 * Upstream sentinels come first because the gateway attaches them to several
 * statuses, and each names a failure the status alone gets wrong.
 * @param {number} status - HTTP status.
 * @param {string} detail - upstream detail.
 * @returns {string} harness error code.
 */
export function upstreamErrorCode(status, detail) {
  if (detail.includes('MODEL_NOT_IN_PLAN')) return 'PERMISSION'
  if (detail.includes('PREMIUM_CREDITS_EXHAUSTED') || isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429 || detail.includes('RATE_LIMITED')) return 'RATE_LIMIT'
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 400) {
    return isContextWindowExceededError(detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * Make the one misdiagnosis this route can produce self-explanatory.
 *
 * A Go subscription that calls the Provider API gets `403 upgrade_required`.
 * This adapter never does — it posts to `/alpha/generate` — so seeing that
 * sentence here means the key is not on a plan that can use the CLI gateway
 * (or the key itself is wrong), not that the transport is wrong.
 * @param {number} status - HTTP status.
 * @param {string} detail - upstream detail.
 * @returns {string} the message to report.
 */
export function explainGatewayError(status, detail) {
  const base = `${detail || `HTTP ${status}`}`
  if (status !== 403) return base
  if (detail.includes('upgrade_required')) {
    return `${base} (this provider already uses the Go CLI gateway /alpha/generate, so the key likely`
      + ' belongs to no active Go/GOAT/Pro/Max plan; check the account this key was issued for)'
  }
  return `${base} (rejected by /alpha/generate; check that the API key belongs to an account with an active plan)`
}
