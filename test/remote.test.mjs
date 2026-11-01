import assert from 'node:assert/strict'
import test from 'node:test'
import { registerRemoteService } from '../lib/remote.js'

/** The descriptor key the Typert gateway reads off the service prototype. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'

test('registerRemoteService exposes the namespace, the method descriptors, and a disposer', async () => {
  const provided = []
  const ctx = {
    reflect: {
      provide(key, service) {
        provided.push({ key, service })
        return () => { provided.length = 0 }
      },
    },
  }

  const dispose = registerRemoteService({
    ctx,
    serviceKey: 'commandcodeRemote',
    namespace: 'commandcode',
    methods: [{
      method: 'test',
      implementation: async function test(apiKey) {
        return { reply: apiKey }
      },
    }],
  })

  assert.equal(provided.length, 1)
  const [{ key, service }] = provided
  assert.equal(key, 'commandcodeRemote')
  assert.equal(service.typertRemote.serviceKey, 'commandcodeRemote')
  assert.equal(service.typertRemote.namespace, 'commandcode')
  assert.equal(service.typertRemote.service, service)
  assert.deepEqual(service[REMOTE_METHODS], {
    version: 1,
    methods: [{ method: 'test', invocation: { kind: 'direct' } }],
  })
  // The gateway spreads `args` across parameters by name: one field, one parameter.
  assert.equal(service.test.length, 1)
  assert.deepEqual(await service.test('user_typed'), { reply: 'user_typed' })
  // Nothing the gateway reads is enumerable on the wire object.
  assert.deepEqual(Object.keys(service), [])
  assert.equal(typeof dispose, 'function')
})
