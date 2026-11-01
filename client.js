/**
 * Browser half of `dsh-commandcode`.
 *
 * The Models page renders a key input only for its two built-in provider
 * layouts (`llm-deepseek` and `llm-pi-ai`); every other namespace gets the
 * "advanced settings" hint. This client half fills that gap through the
 * `settings.models.provider-card` extension slot the page dispatches with the
 * provider's settings namespace, so the Command Code card gets a real API-key
 * input without touching the shipped page.
 *
 * The card opens collapsed — the credential state and one 编辑 button — and the
 * disclosure holds the write-only field, 测试 / 取消 / 保存, and the outcome of
 * the last action. The key is written through the credentials Remote under the
 * same fixed reference the host adapter resolves (`COMMANDCODE_API_KEY`), and
 * 测试 asks the host half for one real `/alpha/generate` request, so a green
 * line means a key that actually answered.
 */

window.__ModuleLoader__.load({
  id: 'dsh-commandcode',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Fixed credential reference shared with the Host adapter. */
    const KEY_REF = 'COMMANDCODE_API_KEY'
    /** Loader entry id of the provider row; the page dispatches this as entryKey. */
    const CARD_KEY = 'commandcode-provider'
    /** Client locale namespace owned by this plugin. */
    const NS = 'commandcode'
    /** Host Remote namespace carrying the key test. */
    const RPC_NAMESPACE = 'commandcode'

    /** Copy for every visible string; the client locale service owns the active dictionary. */
    const zh = {
      label: 'API 密钥',
      edit: '编辑',
      test: '测试',
      testing: '测试中…',
      cancel: '取消',
      save: '保存',
      saving: '保存中…',
      placeholder: '粘贴 Command Code API key（user_…）',
      placeholderSaved: '已保存；留空测试已保存的 key',
      configured: '已配置',
      missing: '未配置',
      testOk: '测试成功：{reply}',
      testEmpty: '测试成功，但模型没有返回文本。',
      testFailed: '测试失败：{message}',
      saved: '已保存',
      empty: '请输入密钥。',
      failed: '保存失败：{message}',
      noHost: '浏览器连接服务不可用，无法测试。',
    }

    const en = {
      label: 'API key',
      edit: 'Edit',
      test: 'Test',
      testing: 'Testing…',
      cancel: 'Cancel',
      save: 'Save',
      saving: 'Saving…',
      placeholder: 'Paste a Command Code API key (user_…)',
      placeholderSaved: 'Saved; leave blank to test the saved key',
      configured: 'Configured',
      missing: 'Not configured',
      testOk: 'Test passed: {reply}',
      testEmpty: 'Test passed, but the model returned no text.',
      testFailed: 'Test failed: {message}',
      saved: 'Saved',
      empty: 'Enter a key first.',
      failed: 'Could not save: {message}',
      noHost: 'The browser connection service is unavailable, so the key cannot be tested.',
    }

    /** Failure text of anything thrown across the card's awaits. */
    function detail(cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }

    /**
     * One key card, rendered inside the Command Code provider row.
     * @param props - injected copy, credential operations, and the host key
     *   test, plus the slot's owner props (`keyConfigured` is the page's
     *   confirmed credential state).
     * @returns the card.
     */
    function KeyCard(props) {
      const { t, keyConfigured, saveKey, testKey, keyRef } = props
      const [draft, setDraft] = React.useState('')
      const [editing, setEditing] = React.useState(false)
      const [pending, setPending] = React.useState(undefined)
      const [message, setMessage] = React.useState(undefined)
      const trimmed = draft.trim()

      /** Open the disclosure; the previous outcome goes with it. */
      const open = () => {
        setEditing(true)
        setMessage(undefined)
      }

      /** Close without writing, discarding the draft and its outcome. */
      const cancel = () => {
        setEditing(false)
        setDraft('')
        setMessage(undefined)
      }

      const save = async () => {
        if (trimmed.length === 0) {
          setMessage({ ok: false, text: t('empty') })
          return
        }
        setPending('save')
        setMessage(undefined)
        try {
          const failure = await saveKey(trimmed)
          if (failure !== undefined) {
            setMessage({ ok: false, text: t('failed', { message: failure }) })
            return
          }
          setDraft('')
          setEditing(false)
          setMessage({ ok: true, text: t('saved') })
        } catch (cause) {
          setMessage({ ok: false, text: t('failed', { message: detail(cause) }) })
        } finally {
          setPending(undefined)
        }
      }

      /**
       * Prove the key with one real request. An empty field tests the stored
       * credential instead, which is the only way to check a key already saved
       * without typing it again.
       */
      const test = async () => {
        if (trimmed.length === 0 && !keyConfigured) {
          setMessage({ ok: false, text: t('empty') })
          return
        }
        setPending('test')
        setMessage(undefined)
        try {
          const answer = await testKey(trimmed)
          const reply = typeof answer?.reply === 'string' ? answer.reply.trim() : ''
          setMessage({ ok: true, text: reply.length === 0 ? t('testEmpty') : t('testOk', { reply }) })
        } catch (cause) {
          setMessage({ ok: false, text: t('testFailed', { message: detail(cause) }) })
        } finally {
          setPending(undefined)
        }
      }

      const busy = pending !== undefined
      const secondary = {
        boxSizing: 'border-box',
        height: 32,
        borderRadius: 'var(--dsw-radius-md)',
        font: 'inherit',
        fontSize: 13,
        lineHeight: '20px',
        padding: '0 12px',
        flex: 'none',
        border: '0.5px solid var(--dsw-alias-border-l3)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        opacity: busy ? 0.4 : 1,
        cursor: busy ? 'default' : 'pointer',
      }
      const primary = {
        ...secondary,
        border: 'none',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        opacity: busy || trimmed.length === 0 ? 0.4 : 1,
        cursor: busy || trimmed.length === 0 ? 'default' : 'pointer',
      }
      const inputStyle = {
        boxSizing: 'border-box',
        width: '100%',
        height: 32,
        border: '0.5px solid var(--dsw-alias-border-l4)',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 14,
        lineHeight: '22px',
        padding: '0 10px',
        opacity: busy ? 0.6 : 1,
      }

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          paddingTop: 10,
          borderTop: '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
        }, [
          h('span', {
            key: 'label',
            style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, fontWeight: 500, lineHeight: '18px' },
          }, t('label')),
          h('span', {
            key: 'state',
            style: {
              color: keyConfigured
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-tertiary)',
              fontSize: 12,
              lineHeight: '18px',
            },
          }, t(keyConfigured ? 'configured' : 'missing')),
          editing ? null : h('span', { key: 'spacer', style: { flex: '1 1 auto' } }),
          editing ? null : h('button', {
            key: 'edit',
            type: 'button',
            onClick: open,
            style: {
              boxSizing: 'border-box',
              height: 26,
              borderRadius: 'var(--dsw-radius-md)',
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              padding: '0 10px',
              flex: 'none',
              border: '0.5px solid var(--dsw-alias-border-l3)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
            },
          }, t('edit')),
        ]),
        editing ? h('div', {
          key: 'editor',
          style: { display: 'flex', flexDirection: 'column', gap: 8 },
        }, [
          h('input', {
            key: 'input',
            type: 'password',
            value: draft,
            placeholder: keyConfigured ? t('placeholderSaved') : t('placeholder'),
            autoComplete: 'new-password',
            spellCheck: false,
            autoFocus: true,
            'aria-label': `${t('label')} (${keyRef})`,
            disabled: busy,
            onChange: (event) => {
              setDraft(event.target.value)
              setMessage(undefined)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void save()
              }
            },
            style: inputStyle,
          }),
          h('div', {
            key: 'actions',
            style: { display: 'flex', alignItems: 'center', gap: 8 },
          }, [
            h('button', {
              key: 'test',
              type: 'button',
              disabled: busy,
              onClick: () => { void test() },
              style: secondary,
            }, pending === 'test' ? t('testing') : t('test')),
            h('button', {
              key: 'cancel',
              type: 'button',
              disabled: busy,
              onClick: cancel,
              style: secondary,
            }, t('cancel')),
            h('button', {
              key: 'save',
              type: 'button',
              disabled: busy || trimmed.length === 0,
              onClick: () => { void save() },
              style: primary,
            }, pending === 'save' ? t('saving') : t('save')),
          ]),
        ]) : null,
        message === undefined ? null : h('p', {
          key: 'message',
          role: message.ok ? 'status' : 'alert',
          style: {
            margin: 0,
            fontSize: 12,
            lineHeight: '18px',
            color: message.ok
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-state-error-primary)',
          },
        }, message.text),
      ])
    }

    /** Services this client half needs before it can register its card. */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'connection']

    /**
     * Register the key card on the Models page.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'commandcode: copy dictionaries')
      const t = ctx.locale.bind(NS)

      const saveKey = async (value) => {
        const response = await ctx.remote.credentials.set(KEY_REF, value)
        return response.ok ? undefined : response.error.message
      }

      /**
       * Ask the host half for one real gateway request. The request lives on
       * the host, so the browser never talks to Command Code itself.
       * @param value - the typed literal, or an empty string for the stored key.
       * @returns the answer the host reported.
       */
      const testKey = async (value) => {
        const rpc = ctx.get('connection')?.rpc
        if (rpc === undefined || typeof rpc.call !== 'function') throw new Error(t('noHost'))
        const response = await rpc.call('/api', `${RPC_NAMESPACE}/test`, { args: { apiKey: value } })
        if (response?.ok !== true) {
          const failure = response?.error
          throw new Error(typeof failure === 'string' ? failure : failure?.message ?? t('noHost'))
        }
        return response.value
      }

      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: CARD_KEY,
        inject: () => ({ t, saveKey, testKey, keyRef: KEY_REF }),
      }, KeyCard))
    }

    return { inject, apply }
  },
})
