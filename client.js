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
    /**
     * The shell's standard controls. The settings switch must be the same
     * primitive the host rows use, or it drifts from the real control; the row
     * still owns a local fallback for shells that do not expose the module.
     */
    const primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch (_missingPrimitives) {
        return undefined
      }
    })()
    const StandardSwitch = primitives?.Switch

    /** Fixed credential reference shared with the Host adapter. */
    const KEY_REF = 'COMMANDCODE_API_KEY'
    /** Loader entry id of the provider row; the page dispatches this as entryKey. */
    const CARD_KEY = 'commandcode-provider'
    /** Host entry id whose settings namespace also backs the always-show switch. */
    const SETTINGS_NS = CARD_KEY
    /** Client locale namespace owned by this plugin. */
    const NS = 'commandcode'
    /** Provider route id the quota belongs to; the dock entry is hidden for every other model. */
    const PROVIDER_ID = 'commandcode'
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
      'quota.label': '额度',
      'quota.fiveHour': '5小时',
      'quota.weekly': '周',
      'quota.monthly': '月',
      'quota.title': 'Command Code 额度',
      'quota.plan': '套餐 {plan}',
      'quota.limited': '已触发额度限制',
      'quota.usedOf': '已用 {used} / {limit}',
      'quota.remaining': '剩余 {remaining}',
      'quota.resetsIn': '{when}后重置',
      'quota.renewsIn': '{when}后续期',
      'quota.minutes': '{minutes} 分钟',
      'quota.hoursMinutes': '{hours} 小时 {minutes} 分',
      'quota.daysHours': '{days} 天 {hours} 小时',
      'quota.updated': '更新于 {time}',
      'quota.refresh': '刷新',
      'quota.refreshing': '刷新中…',
      'quota.failed': '读取失败：{message}',
      'quota.unavailable': '额度 ?',
      'quota.none': '暂无滚动额度窗口',
      'quota.extra': '充值 {purchased} · 赠送 {free}',
      'quota.aria': 'Command Code 额度：{summary}',
      'quota.setting.title': '始终展示CommandCode用量统计',
      'quota.setting.description': '打开后，即使当前模型不是 Command Code，对话底部也会显示 Command Code 的 5 小时 / 周 / 月用量；关闭时只在选择 Command Code 模型时显示。',
      'quota.setting.failed': '保存失败，请重试。',
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
      'quota.label': 'Quota',
      'quota.fiveHour': '5h',
      'quota.weekly': 'wk',
      'quota.monthly': 'mo',
      'quota.title': 'Command Code quota',
      'quota.plan': '{plan} plan',
      'quota.limited': 'Usage limit reached',
      'quota.usedOf': '{used} of {limit} used',
      'quota.remaining': '{remaining} left',
      'quota.resetsIn': 'resets in {when}',
      'quota.renewsIn': 'renews in {when}',
      'quota.minutes': '{minutes}m',
      'quota.hoursMinutes': '{hours}h {minutes}m',
      'quota.daysHours': '{days}d {hours}h',
      'quota.updated': 'Updated {time}',
      'quota.refresh': 'Refresh',
      'quota.refreshing': 'Refreshing…',
      'quota.failed': 'Could not read quota: {message}',
      'quota.unavailable': 'Quota ?',
      'quota.none': 'No rolling quota windows reported',
      'quota.extra': 'Extra {purchased} · free {free}',
      'quota.aria': 'Command Code quota: {summary}',
      'quota.setting.title': 'Always show Command Code usage stats',
      'quota.setting.description': 'Keep the Command Code 5-hour, weekly, and monthly usage in the chat status bar even when another model is selected. When off, it appears only for Command Code models.',
      'quota.setting.failed': 'Could not save the setting. Try again.',
    }

    /** Failure text of anything thrown across the card's awaits. */
    function detail(cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }

    /** How often the dock refreshes its reading; the host caches for 20 seconds. */
    const QUOTA_POLL_MS = 60_000

    /** Stable fallback for slot contexts without the standard `useProjection` seat. */
    const noProjection = () => undefined

    /** Credits are dollars in the billing API: whole caps stay whole, usage shows cents. */
    function quotaMoney(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `$${Number.isInteger(value) ? String(value) : value.toFixed(2)}`
    }

    /** Rounded, bounded percentage for the compact pill and the panel value. */
    function quotaPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return `${Math.round(Math.min(100, Math.max(0, value)))}%`
    }

    /** Time before a reset in the coarsest useful unit. */
    function quotaCountdown(resetsAt, t, now) {
      if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined
      const minutes = Math.max(0, Math.ceil((resetsAt - now) / 60_000))
      if (minutes < 60) return t('quota.minutes', { minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('quota.hoursMinutes', { hours, minutes: minutes % 60 })
      return t('quota.daysHours', { days: Math.floor(hours / 24), hours: hours % 24 })
    }

    /** Local clock time of the reading that fed the panel. */
    function quotaClock(epoch) {
      if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return '—'
      const date = new Date(epoch)
      if (Number.isNaN(date.getTime())) return '—'
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    }

    /** Color ramp for a used share: normal, warning from 75%, error from 90%. */
    function quotaTint(percent) {
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary)'
      if (percent >= 75) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-business-primary)'
    }

    /**
     * One row per reported quota: the two rolling windows and the derived
     * monthly pool. Unknown windows are skipped rather than shown as zero.
     * @param data - host usage snapshot.
     * @param t - locale seat.
     * @param now - reading time for countdowns.
     * @returns rows carrying a label, a percentage, and detail lines.
     */
    function quotaRows(data, t, now) {
      const rows = []
      const addWindow = (key, label, window) => {
        if (window === undefined || window === null || typeof window.percent !== 'number') return
        const parts = []
        if (typeof window.used === 'number' && typeof window.limit === 'number') {
          parts.push(t('quota.remaining', { remaining: quotaMoney(Math.max(0, window.limit - window.used)) }))
        }
        const countdown = quotaCountdown(window.resetsAt, t, now)
        if (countdown !== undefined) parts.push(t('quota.resetsIn', { when: countdown }))
        rows.push({
          key,
          label,
          percent: window.percent,
          used: t('quota.usedOf', { used: quotaMoney(window.used), limit: quotaMoney(window.limit) }),
          note: parts.length === 0 ? undefined : parts.join(' · '),
        })
      }
      addWindow('fiveHour', t('quota.fiveHour'), data?.windows?.fiveHour)
      addWindow('weekly', t('quota.weekly'), data?.windows?.weekly)
      const monthly = data?.monthly
      if (monthly !== undefined && monthly !== null && typeof monthly.percent === 'number') {
        const parts = [t('quota.remaining', { remaining: quotaMoney(monthly.remaining) })]
        const countdown = quotaCountdown(monthly.renewsAt, t, now)
        if (countdown !== undefined) parts.push(t('quota.renewsIn', { when: countdown }))
        const purchased = data?.balance?.purchased ?? 0
        const free = data?.balance?.free ?? 0
        if (purchased > 0 || free > 0) {
          parts.push(t('quota.extra', { purchased: quotaMoney(purchased), free: quotaMoney(free) }))
        }
        rows.push({
          key: 'monthly',
          label: t('quota.monthly'),
          percent: monthly.percent,
          used: t('quota.usedOf', { used: quotaMoney(monthly.used), limit: quotaMoney(monthly.limit) }),
          note: parts.join(' · '),
        })
      }
      return rows
    }

    /** The compact one-line reading shared by the pill and its accessible name. */
    function quotaSummary(rows) {
      return rows.map(row => `${row.label} ${quotaPercent(row.percent)}`).join(' · ')
    }

    /** A small descending-bars glyph: the three quota windows, longest first. */
    function QuotaIcon() {
      return h('svg', { viewBox: '0 0 14 14', width: 14, height: 14, 'aria-hidden': true }, [
        h('rect', { key: 'a', x: 1, y: 2.4, width: 12, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.9 }),
        h('rect', { key: 'b', x: 1, y: 5.9, width: 8, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.65 }),
        h('rect', { key: 'c', x: 1, y: 9.4, width: 4.5, height: 2.2, rx: 1.1, fill: 'currentColor', opacity: 0.4 }),
      ])
    }

    /**
     * Quota reading pinned in the composer dock — the status strip under the
     * chat input. It is scoped to the session's selected model: only a
     * `commandcode` provider renders it (and only then does it poll), so a
     * DeepSeek conversation never shows a Command Code reading. It refreshes on
     * activation, once a minute, and when the page becomes visible. Clicking
     * opens the full reading with reset countdowns and the remaining credit
     * balance; the 刷新 button bypasses the host's short cache.
     * @param props - injected copy, the host quota call, the session
     *   projection selector, and the settings switch hook the slot kit supplies.
     * @returns the pill and its panel, or nothing for another provider.
     */
    function QuotaBar({ t, fetchQuota, useProjection, useQuotaConfig, pollMs = QUOTA_POLL_MS }) {
      const [state, setState] = React.useState({ phase: 'loading' })
      const [open, setOpen] = React.useState(false)
      const [refreshing, setRefreshing] = React.useState(false)
      const rootRef = React.useRef(null)
      const alive = React.useRef(true)
      const ticket = React.useRef(0)
      // The standard session kit exposes the durable model selection as the
      // `modelSelection` projection; `next` is the active provider/model.
      const project = typeof useProjection === 'function' ? useProjection : noProjection
      const selection = project('modelSelection')
      // Settings → General can override the provider gate for every conversation.
      const settings = typeof useQuotaConfig === 'function' ? useQuotaConfig : noProjection
      const alwaysShow = settings((snapshot) => snapshot?.value?.alwaysShowUsage === true) === true
      const active = alwaysShow || selection?.next?.provider === PROVIDER_ID

      const load = React.useCallback(async (force) => {
        const current = ++ticket.current
        try {
          const answer = await fetchQuota(force === true)
          if (!alive.current || current !== ticket.current) return
          if (answer !== undefined && answer !== null && answer.configured === false) {
            setState({ phase: 'empty' })
            return
          }
          if (answer === undefined || answer === null || typeof answer !== 'object') {
            setState({ phase: 'error', error: 'empty response' })
            return
          }
          setState({ phase: 'ready', data: answer })
        } catch (cause) {
          if (!alive.current || current !== ticket.current) return
          setState({ phase: 'error', error: detail(cause) })
        }
      }, [fetchQuota])

      // Collapse the popover and drop a refresh spinner when the model leaves
      // Command Code; the pill itself is unmounted below, so neither a stale
      // panel nor a stuck spinner may reopen on the way back.
      React.useEffect(() => {
        if (active) return
        if (open) setOpen(false)
        if (refreshing) setRefreshing(false)
      }, [active, open, refreshing])

      React.useEffect(() => {
        if (!active) return undefined
        alive.current = true
        void load(false)
        let timer
        if (pollMs > 0) timer = setInterval(() => { void load(true) }, pollMs)
        const visible = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') void load(true)
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visible)
        return () => {
          alive.current = false
          if (timer !== undefined) clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visible)
        }
      }, [active, load, pollMs])

      React.useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const outside = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
        }
        const escape = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', outside)
        document.addEventListener('keydown', escape)
        return () => {
          document.removeEventListener('pointerdown', outside)
          document.removeEventListener('keydown', escape)
        }
      }, [open])

      if (!active || state.phase === 'loading' || state.phase === 'empty') return null

      const ready = state.phase === 'ready'
      const rows = ready ? quotaRows(state.data, t, Date.now()) : []
      const summary = ready && rows.length > 0 ? quotaSummary(rows) : t('quota.unavailable')
      const aria = ready && rows.length > 0 ? t('quota.aria', { summary }) : t('quota.label')

      const refresh = async () => {
        setRefreshing(true)
        await load(true)
        if (alive.current) setRefreshing(false)
      }

      const trigger = h('button', {
        key: 'trigger',
        type: 'button',
        className: 'dsh-cc-quota-trigger',
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-label': aria,
        title: aria,
        onClick: () => { setOpen(!open) },
        style: {
          boxSizing: 'border-box',
          border: 'none',
          borderRadius: 'var(--dsw-radius-sm)',
          background: open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          color: open ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary)',
          font: 'inherit',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 'inherit',
          whiteSpace: 'nowrap',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '1px 8px',
        },
      }, [
        h(QuotaIcon, { key: 'icon' }),
        h('span', { key: 'label', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, summary),
      ])

      const panel = h('div', {
        key: 'panel',
        role: 'dialog',
        'aria-label': t('quota.title'),
        style: {
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1100,
          boxSizing: 'border-box',
          width: 264,
          maxWidth: 'calc(100vw - 24px)',
          padding: 12,
          borderRadius: 'var(--dsw-radius-lg)',
          background: 'var(--dsw-specific-menu)',
          boxShadow: 'var(--dsw-elevation-prominent)',
          backdropFilter: 'var(--dsw-menu-backdrop-filter)',
          color: 'var(--dsw-alias-label-secondary)',
          font: 'inherit',
          fontSize: 12,
          lineHeight: '20px',
          fontVariantNumeric: 'tabular-nums',
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
          h(QuotaIcon, { key: 'icon' }),
          h('span', {
            key: 'title',
            style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
          }, t('quota.title')),
          ready && state.data?.plan?.name !== undefined
            ? h('span', {
                key: 'plan',
                style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)' },
              }, t('quota.plan', { plan: state.data.plan.name }))
            : null,
        ]),
        ready && state.data?.exceeded === true
          ? h('div', {
              key: 'limited',
              style: {
                marginTop: 6,
                color: 'var(--dsw-alias-state-error-primary)',
                fontSize: 11,
                lineHeight: '16px',
              },
            }, t('quota.limited'))
          : null,
        ready && rows.length === 0
          ? h('div', {
              key: 'none',
              style: {
                marginTop: 8,
                color: 'var(--dsw-alias-label-tertiary)',
                fontSize: 11,
                lineHeight: '16px',
              },
            }, t('quota.none'))
          : null,
        ...rows.map(row => h('div', { key: row.key, style: { marginTop: 10 } }, [
          h('div', {
            key: 'head',
            style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
          }, [
            h('span', { key: 'label' }, row.label),
            h('span', {
              key: 'value',
              style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 500 },
            }, quotaPercent(row.percent)),
          ]),
          h('div', {
            key: 'bar',
            style: {
              height: 4,
              margin: '6px 0 4px',
              borderRadius: 999,
              background: 'var(--dsw-alias-interactive-bg-hover)',
              overflow: 'hidden',
            },
          }, h('div', {
            style: {
              width: `${Math.min(100, Math.max(0, row.percent))}%`,
              height: '100%',
              background: quotaTint(row.percent),
            },
          })),
          h('div', {
            key: 'used',
            style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px' },
          }, row.used),
          row.note === undefined ? null : h('div', {
            key: 'note',
            style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px' },
          }, row.note),
        ])),
        h('div', {
          key: 'foot',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginTop: 12,
            paddingTop: 10,
            borderTop: '0.5px solid var(--dsw-alias-border-l2)',
          },
        }, [
          ready
            ? h('span', {
                key: 'updated',
                style: { flex: '1 1 auto', color: 'var(--dsw-alias-label-tertiary)', fontSize: 11, lineHeight: '16px' },
              }, t('quota.updated', { time: quotaClock(state.data?.fetchedAt) }))
            : h('span', {
                key: 'error',
                role: 'alert',
                style: { flex: '1 1 auto', color: 'var(--dsw-alias-state-error-primary)', fontSize: 11, lineHeight: '16px' },
              }, t('quota.failed', { message: state.error })),
          h('button', {
            key: 'refresh',
            type: 'button',
            disabled: refreshing,
            onClick: () => { void refresh() },
            style: {
              boxSizing: 'border-box',
              height: 24,
              padding: '0 10px',
              border: '0.5px solid var(--dsw-alias-border-l3)',
              borderRadius: 'var(--dsw-radius-md)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary)',
              font: 'inherit',
              fontSize: 12,
              lineHeight: '18px',
              cursor: refreshing ? 'default' : 'pointer',
              opacity: refreshing ? 0.5 : 1,
              flex: 'none',
            },
          }, refreshing ? t('quota.refreshing') : t('quota.refresh')),
        ]),
      ])

      return h('div', {
        ref: rootRef,
        'data-composer-quota': 'commandcode',
        style: {
          position: 'relative',
          display: 'inline-flex',
          flex: 'none',
          minWidth: 0,
          fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
          lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
        },
      }, [trigger, open ? panel : null])
    }

    /**
     * Settings → General switch that pins the quota pill on for every
     * conversation. The value lives in this plugin's settings section, so the
     * quota component sees it live through the shared settings mirror.
     * @param props - the settings value hook, the writer, and localized copy.
     * @returns the General Settings row.
     */
    function AlwaysShowUsageRow({ useQuotaConfig, setAlwaysShow, t }) {
      const read = typeof useQuotaConfig === 'function' ? useQuotaConfig : noProjection
      const enabled = read((snapshot) => snapshot?.value?.alwaysShowUsage === true) === true
      const [busy, setBusy] = React.useState(false)
      const [failed, setFailed] = React.useState(false)

      const toggle = async (next) => {
        if (busy) return
        const target = typeof next === 'boolean' ? next : !enabled
        setFailed(false)
        setBusy(true)
        try {
          await setAlwaysShow(target)
        } catch {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }

      // The host's own switch first; the hand-rolled control is only a fallback
      // for a shell whose module table omits the primitives package.
      const control = StandardSwitch !== undefined && StandardSwitch !== null
        ? h(StandardSwitch, {
            key: 'switch',
            checked: enabled,
            disabled: busy,
            label: t('quota.setting.title'),
            onChange: (next) => { void toggle(next) },
          })
        : h('button', {
            key: 'switch',
            type: 'button',
            role: 'switch',
            className: 'dsh-cc-quota-switch',
            'aria-checked': enabled,
            'aria-label': t('quota.setting.title'),
            disabled: busy,
            onClick: () => { void toggle(!enabled) },
            style: {
              boxSizing: 'border-box',
              position: 'relative',
              width: 36,
              height: 20,
              padding: 0,
              border: 'none',
              borderRadius: 999,
              background: enabled
                ? 'var(--dsw-alias-state-business-primary)'
                : 'var(--dsw-alias-interactive-bg-hover-solid)',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.5 : 1,
              flex: 'none',
              transition: 'background .12s',
            },
          }, h('span', {
            'aria-hidden': true,
            style: {
              position: 'absolute',
              top: 2,
              left: 2,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: 'var(--dsw-alias-switch-thumb, var(--dsw-alias-label-primary-foreground))',
              transform: enabled ? 'translateX(16px)' : 'translateX(0)',
              transition: 'transform .12s',
              display: 'block',
            },
          }))

      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 24,
          padding: '16px 0',
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        },
      }, [
        h('div', { key: 'copy', style: { minWidth: 0 } }, [
          h('div', {
            key: 'title',
            style: { fontSize: 14, lineHeight: '20px' },
          }, t('quota.setting.title')),
          h('div', {
            key: 'description',
            style: {
              color: 'var(--dsw-alias-label-secondary)',
              marginTop: 4,
              fontSize: 12,
              lineHeight: '18px',
            },
          }, t('quota.setting.description')),
          failed ? h('div', {
            key: 'failed',
            role: 'alert',
            style: {
              color: 'var(--dsw-alias-state-error-primary)',
              marginTop: 4,
              fontSize: 12,
              lineHeight: '18px',
            },
          }, t('quota.setting.failed')) : null,
        ]),
        control,
      ])
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

    /** Services this client half needs before it can register its contributions. */
    const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'connection', 'configForms']

    /**
     * Register the key card on the Models page.
     * @param ctx - client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'commandcode: copy dictionaries')
      const t = ctx.locale.bind(NS)
      // The provider entry's own settings namespace also carries the quota
      // preference, so Settings → General and the composer read one value.
      const quotaSettings = ctx.configForms.get(SETTINGS_NS)

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

      /**
       * Ask the host half for the current quota reading. Only the host knows
       * the stored key, so the browser never calls Command Code itself.
       * @param force - bypass the host's short-lived cache.
       * @returns the host snapshot, including `configured: false` with no key.
       */
      const fetchQuota = async (force) => {
        const rpc = ctx.get('connection')?.rpc
        if (rpc === undefined || typeof rpc.call !== 'function') throw new Error(t('noHost'))
        const response = await rpc.call('/api', `${RPC_NAMESPACE}/usage`, { args: { force: force === true } })
        if (response?.ok !== true) {
          const failure = response?.error
          throw new Error(typeof failure === 'string' ? failure : failure?.message ?? t('noHost'))
        }
        return response.value
      }

      // Hover and focus styling for the quota controls; the rest is inline to
      // stay self-contained, but inline styles cannot express a pseudo-class.
      const styleId = 'dsh-commandcode/quota'
      if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-commandcode'
        style.dataset.pluginCss = styleId
        style.textContent = '.dsh-cc-quota-trigger:hover{'
          + 'background:var(--dsw-alias-interactive-bg-hover);'
          + 'color:var(--dsw-alias-label-secondary)}'
          + '.dsh-cc-quota-switch:focus-visible{outline:2px solid '
          + 'var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}'
        document.head.appendChild(style)
      }

      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: CARD_KEY,
        inject: () => ({ t, saveKey, testKey, keyRef: KEY_REF }),
      }, KeyCard))

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'commandcode-quota',
        order: 2,
        locale: NS,
        inject: () => ({ t, fetchQuota, hooks: { quotaConfig: quotaSettings } }),
      }, QuotaBar))

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'commandcode-always-show-usage',
        order: 20,
        locale: NS,
        inject: () => ({
          t,
          hooks: { quotaConfig: quotaSettings },
          setAlwaysShow: async (enabled) => {
            const saved = await quotaSettings.set('alwaysShowUsage', enabled)
            if (!saved) throw new Error(t('quota.setting.failed'))
          },
        }),
      }, AlwaysShowUsageRow))
    }

    return { inject, apply }
  },
})
