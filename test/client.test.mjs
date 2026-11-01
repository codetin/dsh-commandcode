import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * The loader entry id has to be the published package name: dsh resolves the
 * browser half by the package it installed, so a rename that misses one of the
 * two breaks the card. Reading it here keeps the pair honest.
 * @returns the `name` field of this package's package.json.
 */
function packageName() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
}

/** Query strings keep each import a fresh module instance (ESM caches by URL). */
let imports = 0

/**
 * Load the client half with a supplied React stand-in.
 * @param react - object the factory receives for `require('react')`.
 * @returns the loader entry the module registered.
 */
async function loadClient(react) {
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = {
          id: entry.id,
          module: entry.factory((name) => {
            if (name === 'react') return react
            throw new Error(`unexpected require(${name})`)
          }),
        }
      },
    },
  }
  imports += 1
  try {
    await import(`../client.js?case=${imports}`)
  } finally {
    delete globalThis.window
  }
  return loaded
}

/**
 * A React stand-in that keeps hook state across synchronous re-renders, so a
 * handler's `useState` write is visible in the tree read right after it.
 * @returns the react face plus a mount that renders a component into it.
 */
function createReact() {
  const slots = []
  let cursor = 0
  let draw = () => {}
  const react = {
    createElement(type, config, ...children) {
      return { type, props: { ...config, children: children.flat() } }
    },
    useState(initial) {
      const slot = cursor
      cursor += 1
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial
      return [slots[slot], (next) => {
        slots[slot] = typeof next === 'function' ? next(slots[slot]) : next
        draw()
      }]
    },
  }
  return {
    react,
    mount(component, props) {
      // A new mount is a new component instance: start from empty hook state.
      slots.length = 0
      cursor = 0
      let tree
      draw = () => {
        cursor = 0
        tree = component(props)
      }
      draw()
      return () => tree
    },
  }
}

/** Copy stand-in: the key alone, or the key with its interpolation arguments. */
const t = (key, values) => (values === undefined ? key : `${key}${JSON.stringify(values)}`)

/**
 * A client context that captures the registered card and its inject face.
 * @param react - the React stand-in the loaded factory sees.
 * @param faces - credential operations and the browser rpc face.
 * @returns registration facts, the component, and the card's own props.
 */
async function registerCard(react, faces) {
  const loaded = await loadClient(react)
  const registration = { component: undefined, injected: undefined }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      assert.equal(typeof dispose, 'function')
      return dispose
    },
    locale: {
      register: () => () => {},
      bind: () => t,
    },
    slots: {
      inject: (name, callback) => callback(),
      register(opts, component) {
        registration.component = component
        registration.injected = opts.inject()
        return () => {}
      },
    },
    remote: { credentials: faces.credentials },
    get: key => (key === 'connection' ? { rpc: faces.rpc } : undefined),
  }
  loaded.module.apply(ctx)
  assert.equal(typeof registration.component, 'function')
  return registration
}

/** Every element of a rendered tree, depth first. */
function elements(tree, hits = []) {
  if (tree === null || typeof tree !== 'object') return hits
  hits.push(tree)
  for (const child of tree.props?.children ?? []) elements(child, hits)
  return hits
}

/** The visible text of one element; conditional `null` children contribute nothing. */
function textOf(element) {
  return (element.props?.children ?? [])
    .map((child) => {
      if (typeof child === 'string') return child
      return child === null || child === undefined ? '' : textOf(child)
    })
    .join('')
}

/** The one element of `type` carrying `label`, or undefined. */
function labelled(tree, type, label) {
  return elements(tree).find(element => element.type === type && textOf(element) === label)
}

/** Every button's visible text, in document order. */
function buttons(tree) {
  return elements(tree).filter(element => element.type === 'button').map(textOf)
}

/** The rendered key field, or undefined while the card is collapsed. */
function field(tree) {
  return elements(tree).find(element => element.type === 'input')
}

/** The one outcome line, or undefined while the card reports nothing. */
function message(tree) {
  return elements(tree).find(element => element.props?.role === 'status' || element.props?.role === 'alert')
}

/** Let the card's awaited write settle before reading the tree. */
async function settled() {
  await new Promise(resolve => { setImmediate(resolve) })
}

/** Credential operations recording every write, optionally failing one. */
function credentialOps(writes, failure) {
  return {
    async set(ref, value) {
      writes.push(['set', ref, value])
      return failure === undefined ? { ok: true } : { ok: false, error: { message: failure } }
    },
  }
}

/**
 * A browser rpc face recording every call.
 * @param answer - `{ok:true, value}` or `{ok:false, error}` for the host's reply.
 * @returns the face plus its call log.
 */
function rpcFace(answer) {
  const calls = []
  return {
    calls,
    face: {
      async call(endpoint, method, payload) {
        calls.push({ endpoint, method, payload })
        return typeof answer === 'function' ? answer(payload) : answer
      },
    },
  }
}

test('client half registers the Command Code key card on the Models page slot', async () => {
  const calls = { effects: 0, register: undefined, slot: undefined, locale: undefined }
  const loaded = await loadClient({
    createElement: () => ({}),
    useState: initial => [initial, () => {}],
  })

  assert.equal(loaded.id, packageName())
  assert.deepEqual(loaded.module.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'connection'])

  const ctx = {
    effect(fn) {
      calls.effects += 1
      const dispose = fn()
      assert.equal(typeof dispose, 'function')
    },
    locale: {
      register(ns, dicts) {
        calls.locale = { ns, dicts }
        return () => {}
      },
      bind(ns) {
        assert.equal(ns, 'commandcode')
        return key => key
      },
    },
    slots: {
      inject(name, callback) {
        calls.slot = name
        callback()
        return () => {}
      },
      register(opts, component) {
        calls.register = { opts, component }
        return () => {}
      },
    },
    remote: {
      credentials: {
        async set() {
          return { ok: true }
        },
      },
    },
    get: () => undefined,
  }

  loaded.module.apply(ctx)

  assert.equal(calls.effects, 1)
  assert.equal(calls.locale.ns, 'commandcode')
  for (const dict of [calls.locale.dicts.zh, calls.locale.dicts.en]) {
    for (const key of ['label', 'edit', 'test', 'testing', 'cancel', 'save', 'testOk', 'testFailed', 'saved', 'empty', 'noHost']) {
      assert.equal(typeof dict[key], 'string', `${key} copy is missing`)
    }
  }
  assert.equal(calls.slot, 'settings.models.provider-card')
  assert.equal(calls.register.opts.name, 'settings.models.provider-card')
  assert.equal(calls.register.opts.key, 'commandcode-provider')
  assert.equal(typeof calls.register.component, 'function')

  const injected = calls.register.opts.inject()
  assert.equal(injected.keyRef, 'COMMANDCODE_API_KEY')
  assert.equal(injected.t('label'), 'label')
  assert.equal(await injected.saveKey('user_test'), undefined)
  await assert.rejects(injected.testKey('user_test'), /noHost/)
})

test('the card stays collapsed until 编辑, then tests the typed key through the host', async () => {
  const writes = []
  const rpc = rpcFace({ ok: true, value: { model: 'deepseek/deepseek-v4-flash', reply: 'pong' } })
  const rendered = createReact()
  const card = await registerCard(rendered.react, {
    credentials: credentialOps(writes),
    rpc: rpc.face,
  })
  const tree = rendered.mount(card.component, { ...card.injected, keyConfigured: false })

  // Collapsed: the state and one action, never a field.
  assert.equal(field(tree()), undefined)
  assert.deepEqual(buttons(tree()), [t('edit')])
  assert.ok(elements(tree()).some(element => element.type === 'span' && textOf(element) === t('missing')))

  labelled(tree(), 'button', t('edit')).props.onClick()
  assert.equal(field(tree()).props.type, 'password')
  assert.equal(field(tree()).props.autoFocus, true)
  assert.deepEqual(buttons(tree()), [t('test'), t('cancel'), t('save')])

  field(tree()).props.onChange({ target: { value: ' user_typed ' } })
  labelled(tree(), 'button', t('test')).props.onClick()
  await settled()

  assert.deepEqual(rpc.calls, [{
    endpoint: '/api',
    method: 'commandcode/test',
    payload: { args: { apiKey: 'user_typed' } },
  }])
  assert.equal(textOf(message(tree())), t('testOk', { reply: 'pong' }))
  assert.equal(message(tree()).props.style.color, 'var(--dsw-alias-state-success-primary)')
  assert.equal(message(tree()).props.role, 'status')
  assert.equal(field(tree()).props.value, ' user_typed ', 'a passing test keeps the draft')
  assert.deepEqual(writes, [], 'testing never stores anything')

  // Saving then closes the disclosure with its own green line.
  labelled(tree(), 'button', t('save')).props.onClick()
  await settled()
  assert.deepEqual(writes, [['set', 'COMMANDCODE_API_KEY', 'user_typed']])
  assert.equal(field(tree()), undefined)
  assert.equal(textOf(message(tree())), t('saved'))
})

test('a failing test keeps the card open and reports the host diagnostic in red', async () => {
  const rendered = createReact()
  const rpc = rpcFace({ ok: false, error: { code: 'commandcode/failed', message: 'Invalid API key' } })
  const card = await registerCard(rendered.react, {
    credentials: credentialOps([]),
    rpc: rpc.face,
  })
  const tree = rendered.mount(card.component, { ...card.injected, keyConfigured: false })

  labelled(tree(), 'button', t('edit')).props.onClick()
  field(tree()).props.onChange({ target: { value: 'user_bad' } })
  labelled(tree(), 'button', t('test')).props.onClick()
  await settled()

  assert.equal(textOf(message(tree())), t('testFailed', { message: 'Invalid API key' }))
  assert.equal(message(tree()).props.style.color, 'var(--dsw-alias-state-error-primary)')
  assert.equal(message(tree()).props.role, 'alert')
  assert.equal(field(tree()).props.value, 'user_bad')
})

test('a refused save keeps the field open with the failure named', async () => {
  const writes = []
  const rendered = createReact()
  const card = await registerCard(rendered.react, {
    credentials: credentialOps(writes, 'credentials/denied'),
    rpc: rpcFace({ ok: true, value: { reply: 'pong' } }).face,
  })
  const tree = rendered.mount(card.component, { ...card.injected, keyConfigured: false })

  labelled(tree(), 'button', t('edit')).props.onClick()
  field(tree()).props.onChange({ target: { value: 'user_typed' } })
  labelled(tree(), 'button', t('save')).props.onClick()
  await settled()

  assert.deepEqual(writes, [['set', 'COMMANDCODE_API_KEY', 'user_typed']])
  assert.equal(field(tree()).props.value, 'user_typed', 'the field stays open so the key can be retried')
  assert.equal(textOf(message(tree())), t('failed', { message: 'credentials/denied' }))
  assert.equal(message(tree()).props.style.color, 'var(--dsw-alias-state-error-primary)')
})

test('an empty field tests the stored key, and nothing is tested while none is stored', async () => {
  const rpc = rpcFace({ ok: true, value: { reply: 'pong' } })
  const rendered = createReact()
  const card = await registerCard(rendered.react, { credentials: credentialOps([]), rpc: rpc.face })
  const tree = rendered.mount(card.component, { ...card.injected, keyConfigured: true })

  assert.ok(labelled(tree(), 'button', t('edit')) !== undefined)
  labelled(tree(), 'button', t('edit')).props.onClick()
  assert.equal(field(tree()).props.placeholder, t('placeholderSaved'))
  labelled(tree(), 'button', t('test')).props.onClick()
  await settled()
  assert.deepEqual(rpc.calls[0].payload, { args: { apiKey: '' } })
  assert.equal(textOf(message(tree())), t('testOk', { reply: 'pong' }))

  // Nothing stored and nothing typed: the card refuses before reaching the host.
  const bare = rendered.mount(card.component, { ...card.injected, keyConfigured: false })
  labelled(bare(), 'button', t('edit')).props.onClick()
  assert.equal(field(bare()).props.placeholder, t('placeholder'))
  labelled(bare(), 'button', t('test')).props.onClick()
  await settled()
  assert.equal(rpc.calls.length, 1, 'no request is sent without a key')
  assert.equal(textOf(message(bare())), t('empty'))
})

test('取消 discards the draft and the outcome it produced', async () => {
  const rpc = rpcFace({ ok: true, value: { reply: 'pong' } })
  const rendered = createReact()
  const card = await registerCard(rendered.react, { credentials: credentialOps([]), rpc: rpc.face })
  const tree = rendered.mount(card.component, { ...card.injected, keyConfigured: false })

  labelled(tree(), 'button', t('edit')).props.onClick()
  field(tree()).props.onChange({ target: { value: 'user_typed' } })
  labelled(tree(), 'button', t('test')).props.onClick()
  await settled()
  assert.ok(message(tree()) !== undefined)

  labelled(tree(), 'button', t('cancel')).props.onClick()
  assert.equal(field(tree()), undefined)
  assert.equal(message(tree()), undefined)
  assert.deepEqual(buttons(tree()), [t('edit')])

  labelled(tree(), 'button', t('edit')).props.onClick()
  assert.equal(field(tree()).props.value, '', 'the discarded draft does not come back')
})
