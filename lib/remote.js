/**
 * Minimal host-side Remote service for the browser half.
 *
 * The Harness Web client reaches a plugin's host code through the Typert
 * gateway (`ctx.connection.rpc.call('/api', '<namespace>/<method>', { args })`).
 * The gateway only routes to a registered Cordis service that carries a
 * `typertRemote` binding and the source-mode method descriptor on its
 * prototype. Building that by hand keeps this plugin free of a hard dependency
 * on the Typert service classes: it uses only `ctx.reflect.provide` (a Cordis
 * core service) and the documented descriptor key.
 *
 * A method is addressed as `<namespace>/<method>`, and the gateway spreads the
 * request's `args` object across the implementation's parameters, matching
 * names exactly. Keep one parameter per wire field.
 */

/** Descriptor key the gateway reads off the service prototype. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Register one Remote service.
 *
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx owning context
 * @param {string} deps.serviceKey Cordis service key
 * @param {string} deps.namespace wire namespace used in the endpoint
 * @param {Array<{ method: string, implementation: Function }>} deps.methods
 * @returns {() => void} disposer that unregisters the service
 */
export function registerRemoteService({ ctx, serviceKey, namespace, methods }) {
  const service = {}
  Object.defineProperty(service, 'ctx', { value: ctx, enumerable: false, writable: true })
  Object.defineProperty(service, 'name', { value: serviceKey, enumerable: false, writable: true })
  Object.defineProperty(service, 'typertRemote', {
    value: Object.freeze({ service, serviceKey, namespace }),
    enumerable: false,
  })

  const prototype = {}
  for (const { method, implementation } of methods) {
    Object.defineProperty(prototype, method, {
      value: implementation,
      enumerable: false,
      writable: false,
    })
  }
  Object.defineProperty(prototype, REMOTE_METHODS, {
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(
        methods.map(({ method }) => Object.freeze({
          method,
          invocation: Object.freeze({ kind: 'direct' }),
        })),
      ),
    }),
    enumerable: false,
  })
  Object.setPrototypeOf(service, prototype)

  return ctx.reflect.provide(serviceKey, service)
}
