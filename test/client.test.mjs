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
async function loadClient(react, primitives) {
  let loaded
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        loaded = {
          id: entry.id,
          module: entry.factory((name) => {
            if (name === 'react') return react
            if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives !== undefined) return primitives
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
 * handler's `useState` write is visible in the tree read right after it. Mount
 * effects run once, after the first draw; `pollMs: 0` keeps the quota pill from
 * starting a real interval inside the test process.
 * @returns the react face plus a mount that renders a component into it.
 */
function createReact() {
  const hooks = []
  const effects = []
  let cursor = 0
  let draw = () => {}
  const react = {
    createElement(type, config, ...children) {
      return { type, props: { ...config, children: children.flat() } }
    },
    useState(initial) {
      const slot = cursor
      cursor += 1
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial
      return [hooks[slot], (next) => {
        hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next
        draw()
      }]
    },
    useRef(initial) {
      const slot = cursor
      cursor += 1
      if (!(slot in hooks)) hooks[slot] = { current: initial }
      return hooks[slot]
    },
    useCallback(callback) {
      cursor += 1
      return callback
    },
    useEffect(effect) {
      cursor += 1
      effects.push(effect)
    },
  }
  return {
    react,
    mount(component, props) {
      // A new mount is a new component instance: start from empty hook state.
      hooks.length = 0
      effects.length = 0
      cursor = 0
      let tree
      draw = () => {
        cursor = 0
        tree = component(props)
      }
      draw()
      for (const effect of effects) effect()
      return () => tree
    },
  }
}

/** Copy stand-in: the key alone, or the key with its interpolation arguments. */
const t = (key, values) => (values === undefined ? key : `${key}${JSON.stringify(values)}`)

/**
 * A ConfigFormController stand-in: one settings snapshot plus the setter the
 * General row writes through, with the listener channel a hook source needs.
 * @param [initial] - starting settings value.
 * @returns the form face.
 */
function configForm(initial = { alwaysShowUsage: false }) {
  let snapshot = { status: 'ready', value: { ...initial }, revision: 1, writable: true }
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async set(field, value) {
      snapshot = { ...snapshot, revision: snapshot.revision + 1, value: { ...snapshot.value, [field]: value } }
      for (const listener of [...listeners]) listener()
      return true
    },
  }
}

/**
 * A client context that captures every registered slot and its inject face.
 * @param react - the React stand-in the loaded factory sees.
 * @param faces - credential operations and the browser rpc face.
 * @returns the key card registration plus every slot by name.
 */
async function registerCard(react, faces) {
  const loaded = await loadClient(react, faces.primitives)
  const registrations = new Map()
  const form = faces.configForm ?? configForm()
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
        registrations.set(opts.name, { component, injected: opts.inject(), opts })
        return () => {}
      },
    },
    remote: { credentials: faces.credentials },
    configForms: { get: () => form },
    get: key => (key === 'connection' ? { rpc: faces.rpc } : undefined),
  }
  loaded.module.apply(ctx)
  const card = registrations.get('settings.models.provider-card')
  assert.equal(typeof card?.component, 'function')
  return { ...card, bySlot: registrations, configForm: form }
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

test('client half registers the key card and the composer quota pill', async () => {
  const calls = { effects: 0, slots: [], registrations: [], locale: undefined }
  const loaded = await loadClient({
    createElement: () => ({}),
    useState: initial => [initial, () => {}],
  })

  assert.equal(loaded.id, packageName())
  assert.deepEqual(loaded.module.inject, ['slots', 'locale', 'remote', 'remote.credentials', 'connection', 'configForms'])

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
        calls.slots.push(name)
        callback()
        return () => {}
      },
      register(opts, component) {
        calls.registrations.push({ opts, component, injected: opts.inject() })
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
    configForms: { get: () => configForm() },
    get: () => undefined,
  }

  loaded.module.apply(ctx)

  assert.equal(calls.effects, 1)
  assert.equal(calls.locale.ns, 'commandcode')
  for (const dict of [calls.locale.dicts.zh, calls.locale.dicts.en]) {
    for (const key of [
      'label', 'edit', 'test', 'testing', 'cancel', 'save', 'testOk', 'testFailed', 'saved', 'empty', 'noHost',
      'quota.fiveHour', 'quota.weekly', 'quota.monthly', 'quota.title', 'quota.refresh', 'quota.failed',
      'quota.setting.title', 'quota.setting.description', 'quota.setting.failed',
    ]) {
      assert.equal(typeof dict[key], 'string', `${key} copy is missing`)
    }
  }
  assert.deepEqual(calls.slots, ['settings.models.provider-card', 'conversation.composer.dock', 'settings.general.item'])

  const card = calls.registrations.find(entry => entry.opts.name === 'settings.models.provider-card')
  assert.equal(card.opts.key, 'commandcode-provider')
  assert.equal(typeof card.component, 'function')
  assert.equal(card.injected.keyRef, 'COMMANDCODE_API_KEY')
  assert.equal(card.injected.t('label'), 'label')
  assert.equal(await card.injected.saveKey('user_test'), undefined)
  await assert.rejects(card.injected.testKey('user_test'), /noHost/)

  const quota = calls.registrations.find(entry => entry.opts.name === 'conversation.composer.dock')
  assert.equal(quota.opts.id, 'commandcode-quota')
  assert.equal(quota.opts.order, 2)
  assert.equal(typeof quota.component, 'function')
  assert.equal(typeof quota.injected.fetchQuota, 'function')
  assert.ok(quota.injected.hooks.quotaConfig !== undefined)

  const row = calls.registrations.find(entry => entry.opts.name === 'settings.general.item')
  assert.equal(row.opts.id, 'commandcode-always-show-usage')
  assert.equal(row.opts.order, 20)
  assert.equal(typeof row.component, 'function')
  assert.ok(row.injected.hooks.quotaConfig !== undefined)
  assert.equal(typeof row.injected.setAlwaysShow, 'function')
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

/** The quota pill button, or undefined while the reading is hidden. */
function quotaTrigger(tree) {
  return elements(tree).find(element => element.type === 'button' && element.props['aria-haspopup'] === 'dialog')
}

/**
 * Mount the quota entry with the standard session projection and settings
 * switch seats the slot kit would supply. The defaults select a Command Code
 * model with the always-show preference off.
 * @param rendered - the React stand-in mount surface.
 * @param quota - the registered dock entry.
 * @param [projection] - `useProjection` stand-in returning a modelSelection value.
 * @param [extra] - additional props, such as an always-show `useQuotaConfig`.
 * @returns the tree getter.
 */
function mountQuota(rendered, quota, projection, extra = {}) {
  return rendered.mount(quota.component, {
    ...quota.injected,
    pollMs: 0,
    useProjection: projection ?? (() => ({ next: { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash' } })),
    useQuotaConfig: () => false,
    ...extra,
  })
}

test('the quota pill shows 5-hour, weekly, and monthly used shares in the composer dock', async () => {
  const now = Date.now()
  const rpc = rpcFace({
    ok: true,
    value: {
      configured: true,
      fetchedAt: now,
      plan: { id: 'individual-go-v1', name: 'Go' },
      windows: {
        fiveHour: { used: 0.504704482, limit: 3, percent: 16.8, resetsAt: now + 3 * 3_600_000 },
        weekly: { used: 1.4646618919, limit: 6, percent: 24.4, resetsAt: now + 2 * 86_400_000 },
      },
      monthly: {
        used: 1.4646618919,
        limit: 10,
        percent: 14.6,
        remaining: 8.5353381081,
        renewsAt: now + 27 * 86_400_000,
      },
      balance: { purchased: 0, free: 0 },
      exceeded: false,
    },
  })
  const rendered = createReact()
  const card = await registerCard(rendered.react, { credentials: credentialOps([]), rpc: rpc.face })
  const quota = card.bySlot.get('conversation.composer.dock')
  const tree = mountQuota(rendered, quota)

  assert.equal(quotaTrigger(tree()), undefined, 'nothing renders before the first reading settles')
  await settled()

  const trigger = quotaTrigger(tree())
  assert.equal(textOf(trigger), 'quota.fiveHour 17% · quota.weekly 24% · quota.monthly 15%')
  assert.equal(trigger.props['aria-label'], t('quota.aria', { summary: textOf(trigger) }))

  trigger.props.onClick()
  const panel = elements(tree()).find(element => element.props?.role === 'dialog')
  assert.ok(panel !== undefined)
  const panelText = textOf(panel)
  assert.match(panelText, /quota\.usedOf\{"used":"\$0\.50","limit":"\$3"\}/)
  assert.match(panelText, /quota\.usedOf\{"used":"\$1\.46","limit":"\$10"\}/)
  assert.match(panelText, /quota\.remaining\{"remaining":"\$8\.54"\}/)
  assert.match(panelText, /quota\.resetsIn/)

  const refresh = elements(tree()).find(element => element.type === 'button' && textOf(element) === t('quota.refresh'))
  assert.ok(refresh !== undefined)
  refresh.props.onClick()
  await settled()
  assert.equal(rpc.calls.length, 2)
  assert.deepEqual(rpc.calls[1].payload, { args: { force: true } })
})

test('the quota pill stays hidden when no Command Code key is configured', async () => {
  const rpc = rpcFace({ ok: true, value: { configured: false } })
  const rendered = createReact()
  const card = await registerCard(rendered.react, { credentials: credentialOps([]), rpc: rpc.face })
  const quota = card.bySlot.get('conversation.composer.dock')
  const tree = mountQuota(rendered, quota)

  await settled()
  assert.equal(tree(), null)
  assert.equal(rpc.calls.length, 1)
})

test('a failed quota reading keeps a quiet pill and explains itself in the panel', async () => {
  const rpc = rpcFace({ ok: false, error: { message: 'HTTP 401' } })
  const rendered = createReact()
  const card = await registerCard(rendered.react, { credentials: credentialOps([]), rpc: rpc.face })
  const quota = card.bySlot.get('conversation.composer.dock')
  const tree = mountQuota(rendered, quota)

  await settled()
  const trigger = quotaTrigger(tree())
  assert.equal(textOf(trigger), t('quota.unavailable'))

  trigger.props.onClick()
  const panel = elements(tree()).find(element => element.props?.role === 'dialog')
  assert.match(textOf(panel), /quota\.failed\{"message":"HTTP 401"\}/)
})

test('the quota pill is hidden and never polled while another provider is selected', async () => {
  const rpc = rpcFace({ ok: true, value: { configured: true } })
  const rendered = createReact()
  const card = await registerCard(rendered.react, { credentials: credentialOps([]), rpc: rpc.face })
  const quota = card.bySlot.get('conversation.composer.dock')
  const tree = mountQuota(rendered, quota, () => ({ next: { provider: 'deepseek', model: 'deepseek-v4' } }))

  await settled()
  assert.equal(tree(), null)
  assert.equal(rpc.calls.length, 0, 'another provider never touches the Command Code quota API')
})

test('the always-show preference keeps the quota pill under another provider', async () => {
  const now = Date.now()
  const rpc = rpcFace({
    ok: true,
    value: {
      configured: true,
      fetchedAt: now,
      windows: { fiveHour: { used: 0.5, limit: 3, percent: 16.7, resetsAt: now + 3_600_000 } },
      balance: { purchased: 0, free: 0 },
    },
  })
  const rendered = createReact()
  const card = await registerCard(rendered.react, { credentials: credentialOps([]), rpc: rpc.face })
  const quota = card.bySlot.get('conversation.composer.dock')
  const tree = mountQuota(rendered, quota, () => ({ next: { provider: 'deepseek', model: 'deepseek-v4' } }), {
    useQuotaConfig: () => true,
  })

  await settled()
  const trigger = quotaTrigger(tree())
  assert.ok(trigger !== undefined)
  assert.equal(textOf(trigger), 'quota.fiveHour 17%')
  assert.equal(rpc.calls.length, 1)
})

test('the General settings switch persists 始终展示CommandCode用量统计', async () => {
  const form = configForm({ alwaysShowUsage: false })
  const rendered = createReact()
  const card = await registerCard(rendered.react, {
    credentials: credentialOps([]),
    rpc: rpcFace({ ok: true, value: {} }).face,
    configForm: form,
  })
  const row = card.bySlot.get('settings.general.item')
  const tree = rendered.mount(row.component, {
    ...row.injected,
    useQuotaConfig: selector => selector(form.getSnapshot()),
  })

  const toggle = elements(tree()).find(element => element.type === 'button' && element.props.role === 'switch')
  assert.equal(toggle.props['aria-checked'], false)
  assert.equal(toggle.props['aria-label'], t('quota.setting.title'))

  toggle.props.onClick()
  await settled()

  assert.equal(form.getSnapshot().value.alwaysShowUsage, true)
  const after = elements(tree()).find(element => element.type === 'button' && element.props.role === 'switch')
  assert.equal(after.props['aria-checked'], true)
})

test('the always-show row uses the standard Switch primitive when the shell exposes it', async () => {
  const StandardSwitch = function StandardSwitch() { return null }
  const form = configForm({ alwaysShowUsage: false })
  const rendered = createReact()
  const card = await registerCard(rendered.react, {
    credentials: credentialOps([]),
    rpc: rpcFace({ ok: true, value: {} }).face,
    configForm: form,
    primitives: { Switch: StandardSwitch },
  })
  const row = card.bySlot.get('settings.general.item')
  const tree = rendered.mount(row.component, {
    ...row.injected,
    useQuotaConfig: selector => selector(form.getSnapshot()),
  })

  const control = elements(tree()).find(element => element.type === StandardSwitch)
  assert.ok(control !== undefined, 'the row renders the host primitive, not its fallback')
  assert.equal(control.props.checked, false)
  assert.equal(control.props.disabled, false)
  assert.equal(control.props.label, t('quota.setting.title'))

  control.props.onChange(true)
  await settled()
  assert.equal(form.getSnapshot().value.alwaysShowUsage, true)
})
