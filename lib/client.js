// dsh-auto-continue — 浏览器半 / browser half.
//
// Registers into two official DSH slots (no DOM scraping, no CSS-module hashes):
//   • conversation.composer.bar  — the quick on/off switch at the composer
//   • settings.section           — the "Auto-Continue" page under Settings
//
// 契约 / contract:
//   window.__ModuleLoader__.load({ id, factory(require) {...} }) — id 必须是包名
//   不 require 任何 @deepseek-ai/dsh-client-* 包 —— plain-JS 插件没有类型检查，
//   factory 里抛错会直接 blank 掉整个 slot entry。React 走 browser module table
//   （require('react') 是标准方式，React 在冻结的 PLATFORM_MODULES 里）。
//   样式只用 --dsw-alias-* / --dsw-radius-* 主题 token，全部带 fallback，
//   这样浅色/深色主题都自动跟随。
//
// The host half owns the truth: this module only reads /api/dsh-auto-continue/state
// and posts to the sibling action routes. Every control re-syncs from the server
// response, so two open windows never disagree.

window.__ModuleLoader__.load({
  id: 'dsh-auto-continue',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // ── constants ────────────────────────────────────────────────────────
    const API = '/api/dsh-auto-continue'
    const POLL_MS = 2000
    const MIN_RETRIES = 1
    const MAX_RETRIES = 100
    // Kept in step with RETRYABLE_ERROR_CODES in lib/index.js.
    const BUILTIN_CODES = ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'EMPTY_RESPONSE']
    const LOG = '[dsh-auto-continue]'

    // ── store ────────────────────────────────────────────────────────────
    // One poller feeds both slot components, so the composer switch and the
    // Settings page always show the same numbers.
    const INITIAL = {
      enabled: true,
      quickOn: true,
      buttonHidden: false,
      retryCount: 0,
      maxRetries: 20,
      errorCodes: [],
      version: '',
      online: false,
    }
    let snapshot = INITIAL
    const listeners = new Set()

    function getSnapshot() { return snapshot }
    function subscribe(fn) {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
    function equal(a, b) {
      const ka = Object.keys(a)
      if (ka.length !== Object.keys(b).length) return false
      for (const k of ka) if (a[k] !== b[k]) return false
      return true
    }
    function setState(patch) {
      const next = { ...snapshot, ...patch }
      if (equal(next, snapshot)) return         // keep the 2 s poll render-free
      snapshot = next
      for (const fn of [...listeners]) {
        try { fn() } catch (e) { console.error(LOG, 'listener failed', e) }
      }
    }

    async function request(path, init) {
      const body = init && init.body ? init.body : null
      const res = await fetch(API + path, {
        credentials: 'same-origin',
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
      })
      let data = null
      try { data = await res.json() } catch { /* non-JSON error page */ }
      if (!res.ok) {
        const err = new Error((data && data.error) || ('HTTP ' + res.status))
        err.payload = data
        throw err
      }
      return data || {}
    }

    async function refresh() {
      try {
        const d = await request('/state')
        const codes = Array.isArray(d.errorCodes) ? d.errorCodes : []
        setState({
          enabled: !!d.enabled,
          quickOn: !!d.quickOn,
          buttonHidden: !!d.buttonHidden,
          retryCount: Number(d.retryCount) || 0,
          maxRetries: Number(d.maxRetries) || 20,
          // keep array identity when unchanged so the poll never re-renders
          errorCodes: codes.join('\u0000') === snapshot.errorCodes.join('\u0000') ? snapshot.errorCodes : codes,
          version: typeof d.version === 'string' ? d.version : '',
          online: true,
        })
      } catch {
        setState({ online: false })
      }
    }

    // ── actions (each re-syncs from the authoritative server response) ───
    async function toggleMaster(next) {
      setState({ enabled: next })                       // optimistic
      try {
        const d = await request('/toggle', { body: '{}' })
        setState({ enabled: !!d.enabled })
      } catch (e) {
        console.error(LOG, 'toggle failed', e)
        setState({ enabled: !next })
      }
    }

    async function toggleQuick(next) {
      setState({ quickOn: next })
      try {
        const d = await request('/toggle-quick', { body: '{}' })
        setState({ quickOn: !!d.quickOn })
      } catch (e) {
        console.error(LOG, 'quick toggle failed', e)
        setState({ quickOn: !next })
      }
    }

    async function setButtonHidden(hidden) {
      setState({ buttonHidden: hidden })
      try {
        const d = await request('/hide-button', { body: JSON.stringify({ hidden }) })
        setState({ buttonHidden: !!d.buttonHidden })
      } catch (e) {
        console.error(LOG, 'hide-button failed', e)
        setState({ buttonHidden: !hidden })
      }
    }

    async function saveMaxRetries(value) {
      const d = await request('/set-max-retries', { body: JSON.stringify({ maxRetries: value }) })
      setState({ maxRetries: Number(d.maxRetries) || snapshot.maxRetries })
    }

    async function saveErrorCodes(codes) {
      const d = await request('/set-error-codes', { body: JSON.stringify({ errorCodes: codes }) })
      setState({ errorCodes: Array.isArray(d.errorCodes) ? d.errorCodes : [] })
    }

    function clampRetries(raw) {
      const n = parseInt(String(raw), 10)
      if (!Number.isFinite(n)) return 20
      return Math.min(MAX_RETRIES, Math.max(MIN_RETRIES, n))
    }

    // ── hooks ────────────────────────────────────────────────────────────
    function useStore() {
      const [s, setS] = useState(getSnapshot)
      useEffect(() => {
        setS(getSnapshot())
        return subscribe(() => setS(getSnapshot()))
      }, [])
      return s
    }

    function useFlash() {
      const [msg, setMsg] = useState(null)
      const timer = useRef(null)
      const flash = useCallback((text, ok) => {
        setMsg({ text, ok })
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setMsg(null), 2600)
      }, [])
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      return [msg, flash]
    }

    function useHover() {
      const [hover, setHover] = useState(false)
      return [hover, { onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false) }]
    }

    // ── primitives (theme tokens only, every one with a light/dark fallback) ──
    function Switch(props) {
      const on = !!props.on
      const disabled = !!props.disabled
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': on ? 'true' : 'false',
        'aria-label': props.label,
        title: props.title,
        disabled,
        onClick: (e) => { e.stopPropagation(); if (!disabled) props.onChange(!on) },
        style: {
          position: 'relative', flex: '0 0 auto',
          width: 36, height: 20, padding: 0,
          borderRadius: 10, border: 'none',
          background: on
            ? 'var(--dsw-alias-brand-primary, #4c8dff)'
            : 'var(--dsw-alias-border-l3, #c9c9c9)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 0.18s ease',
        },
      }, h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute', top: 2, left: on ? 18 : 2,
          width: 16, height: 16, borderRadius: '50%',
          background: 'var(--dsw-alias-switch-thumb, #ffffff)',
          boxShadow: '0 1px 3px rgba(0,0,0,0.28)',
          transition: 'left 0.18s ease',
        },
      }))
    }

    function Button(props) {
      const [hover, hoverProps] = useHover()
      const primary = props.kind === 'primary'
      const disabled = !!props.disabled
      return h('button', {
        type: 'button',
        disabled,
        onClick: props.onClick,
        ...hoverProps,
        style: {
          height: 28, padding: '0 12px',
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2, #dcdcdc)',
          background: primary
            ? (hover ? 'var(--dsw-alias-button-primary-hover, #3a7bf0)' : 'var(--dsw-alias-button-primary-fill, #4c8dff)')
            : (hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))' : 'transparent'),
          color: primary
            ? 'var(--dsw-alias-label-primary-inverted, #ffffff)'
            : 'var(--dsw-alias-label-primary, #1a1a1a)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 0.15s ease',
        },
      }, props.children)
    }

    function Row(props) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, padding: '12px 14px',
          borderBottom: props.last ? 'none' : '1px solid var(--dsw-alias-border-l1, #efefef)',
        },
      },
      h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
        h('div', {
          style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #1a1a1a)' },
        }, props.title),
        props.hint
          ? h('div', {
              style: { marginTop: 2, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
            }, props.hint)
          : null,
      ),
      h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 } }, props.children),
      )
    }

    function Flash(props) {
      if (!props.msg) return null
      return h('span', {
        style: {
          marginLeft: 8, fontSize: 12,
          color: props.msg.ok
            ? 'var(--dsw-alias-state-success-primary, #17a34a)'
            : 'var(--dsw-alias-state-error-primary, #e5484d)',
        },
      }, (props.msg.ok ? '\u2713 ' : '\u2717 ') + props.msg.text)
    }

    // ── slot: conversation.composer.bar ──────────────────────────────────
    // ComposerBarOwnerProps are supplied by the host (variant / disabled / …);
    // they are intentionally ignored — this control is a profile-wide switch.
    function ComposerBar() {
      const s = useStore()
      const [hover, hoverProps] = useHover()
      if (!s.enabled || s.buttonHidden) return null

      const on = s.quickOn
      const busy = s.retryCount > 0
      return h('button', {
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        title: on
          ? 'Auto-continue is ON \u2014 this session resumes by itself after a rate limit, an exhausted quota, an empty response, or a configured error. Click to turn it off.'
          : 'Auto-continue is OFF \u2014 a turn that dies on a rate limit will just stop. Click to turn it on.',
        onClick: () => toggleQuick(!on),
        ...hoverProps,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 24, padding: '0 9px', margin: 0,
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          border: '1px solid ' + (on
            ? 'var(--dsw-alias-state-success-secondary, rgba(23,163,74,0.35))'
            : 'var(--dsw-alias-border-l2, rgba(0,0,0,0.14))'),
          background: on
            ? 'var(--dsw-alias-state-success-tertiary, rgba(23,163,74,0.12))'
            : (hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))' : 'transparent'),
          color: on
            ? 'var(--dsw-alias-state-success-primary, #17a34a)'
            : 'var(--dsw-alias-label-tertiary, #9a9a9a)',
          cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
          transition: 'background 0.15s ease, border-color 0.15s ease',
        },
      },
      h('span', { 'aria-hidden': 'true', style: { fontSize: 13, lineHeight: 1 } }, '\u21bb'),
      h('span', null, 'Auto-continue'),
      h('span', { style: { fontWeight: 600, opacity: 0.95 } }, on ? 'ON' : 'OFF'),
      busy
        ? h('span', {
            title: s.retryCount + ' of ' + s.maxRetries + ' consecutive failures used in this session',
            style: {
              marginLeft: 1, padding: '0 5px', height: 16, lineHeight: '16px',
              borderRadius: 8, fontSize: 10, fontWeight: 600,
              background: 'var(--dsw-alias-state-warn-secondary, rgba(230,150,0,0.18))',
              color: 'var(--dsw-alias-state-warn-primary, #b26a00)',
            },
          }, s.retryCount + '/' + s.maxRetries)
        : null,
      )
    }

    // ── slot: settings.section ───────────────────────────────────────────
    function SettingsCard() {
      const s = useStore()
      const [retries, setRetries] = useState(String(s.maxRetries))
      const [retriesDirty, setRetriesDirty] = useState(false)
      const [codes, setCodes] = useState(s.errorCodes.join('\n'))
      const [codesDirty, setCodesDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      const [retriesMsg, flashRetries] = useFlash()
      const [codesMsg, flashCodes] = useFlash()

      // The 2 s poll must never clobber what the user is currently typing.
      const serverRetries = useRef(s.maxRetries)
      useEffect(() => {
        if (serverRetries.current !== s.maxRetries) {
          serverRetries.current = s.maxRetries
          if (!retriesDirty) setRetries(String(s.maxRetries))
        }
      }, [s.maxRetries, retriesDirty])

      const serverCodes = useRef(s.errorCodes.join('\n'))
      useEffect(() => {
        const joined = s.errorCodes.join('\n')
        if (serverCodes.current !== joined) {
          serverCodes.current = joined
          if (!codesDirty) setCodes(joined)
        }
      }, [s.errorCodes, codesDirty])

      const commitRetries = useCallback(async () => {
        const value = clampRetries(retries)
        setRetries(String(value))
        setBusy(true)
        try {
          await saveMaxRetries(value)
          setRetriesDirty(false)
          flashRetries('Saved', true)
        } catch (e) {
          flashRetries(e.message || 'Save failed', false)
        } finally {
          setBusy(false)
        }
      }, [retries, flashRetries])

      const commitCodes = useCallback(async () => {
        const list = codes.split(/[\n,]+/).map((c) => c.trim()).filter(Boolean)
        setBusy(true)
        try {
          await saveErrorCodes(list)
          setCodesDirty(false)
          flashCodes('Saved', true)
        } catch (e) {
          flashCodes(e.message || 'Save failed', false)
        } finally {
          setBusy(false)
        }
      }, [codes, flashCodes])

      const dot = !s.online
        ? 'var(--dsw-alias-state-error-primary, #e5484d)'
        : (s.enabled && s.quickOn
            ? 'var(--dsw-alias-state-success-primary, #17a34a)'
            : 'var(--dsw-alias-label-quaternary, #b0b0b0)')

      const status = !s.online
        ? 'Host half not reachable'
        : !s.enabled
          ? 'Plugin disabled'
          : !s.quickOn
            ? 'Enabled, quick switch off'
            : s.retryCount > 0
              ? 'Continuing \u2014 ' + s.retryCount + '/' + s.maxRetries + ' failures this session'
              : 'Enabled and watching for retryable failures'

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, #e5e5e5))',
          background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-3, #ffffff))',
          borderRadius: 'var(--dsw-radius-panel, 12px)',
          overflow: 'hidden',
        },
      },
      // header
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 14px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1, #efefef)',
        },
      },
      h('span', {
        'aria-hidden': 'true',
        style: { width: 8, height: 8, borderRadius: '50%', background: dot, flex: '0 0 auto' },
      }),
      h('span', {
        style: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #1a1a1a)' },
      }, 'Auto-Continue'),
      s.version
        ? h('span', {
            style: { fontSize: 11, color: 'var(--dsw-alias-label-quaternary, #b0b0b0)' },
          }, 'v' + s.version)
        : null,
      h('span', {
        style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
      }, status),
      ),

      h('div', {
        style: {
          padding: '10px 14px', fontSize: 12, lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
          borderBottom: '1px solid var(--dsw-alias-border-l1, #efefef)',
        },
      }, 'When a turn ends on a retryable failure, the plugin waits 1\u20132 s and sends "continue" as a normal user message, so the model picks the work back up. Any successful turn resets the counter.'),

      // master switch
      h(Row, {
        title: 'Enable plugin',
        hint: 'Turning this off hides the composer switch and stops every automatic continue.',
      }, h(Switch, {
        on: s.enabled,
        label: 'Enable plugin',
        onChange: (v) => toggleMaster(v),
      })),

      // quick switch visibility
      h(Row, {
        title: 'Show the quick switch in the composer',
        hint: 'Adds the Auto-continue button next to the composer so you can flip it without opening Settings.',
      }, h(Switch, {
        on: !s.buttonHidden,
        label: 'Show the quick switch in the composer',
        disabled: !s.enabled,
        onChange: (v) => setButtonHidden(!v),
      })),

      // retry limit
      h(Row, {
        title: 'Consecutive failure limit',
        hint: 'Stop after this many failures (' + MIN_RETRIES + '\u2013' + MAX_RETRIES + '). Any successful turn resets the count.',
      },
      h('input', {
        type: 'number', min: MIN_RETRIES, max: MAX_RETRIES, step: 1,
        value: retries,
        'aria-label': 'Consecutive failure limit',
        onChange: (e) => { setRetries(e.target.value); setRetriesDirty(true) },
        onKeyDown: (e) => { if (e.key === 'Enter') commitRetries() },
        onBlur: () => { if (retriesDirty) setRetries(String(clampRetries(retries))) },
        style: {
          width: 72, height: 28, padding: '0 8px',
          fontFamily: 'inherit', fontSize: 12, textAlign: 'center',
          color: 'var(--dsw-alias-label-primary, #1a1a1a)',
          background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
          border: '1px solid var(--dsw-alias-border-l2, #dcdcdc)',
          borderRadius: 'var(--dsw-radius-sm, 6px)',
        },
      }),
      h(Button, { onClick: commitRetries, disabled: busy || !retriesDirty, kind: retriesDirty ? 'primary' : undefined }, 'Save'),
      h(Flash, { msg: retriesMsg }),
      ),

      // error codes
      h('div', { style: { padding: '12px 14px', borderTop: 'none' } },
        h('div', {
          style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #1a1a1a)' },
        }, 'Additional auto-continue error codes'),
        h('div', {
          style: { marginTop: 2, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
        }, 'Comma or new-line separated. Matched case-insensitively against the whole error (code, message and every nested field), so provider wording like "503" or "service temporarily unavailable" works too.'),
        h('textarea', {
          value: codes,
          'aria-label': 'Additional auto-continue error codes',
          spellCheck: false,
          rows: 4,
          onChange: (e) => { setCodes(e.target.value); setCodesDirty(true) },
          style: {
            display: 'block', width: '100%', marginTop: 8, minHeight: 74,
            padding: '8px 10px', boxSizing: 'border-box', resize: 'vertical',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: 12, lineHeight: '18px',
            color: 'var(--dsw-alias-label-primary, #1a1a1a)',
            background: 'var(--dsw-alias-bg-layer-1, #f7f7f7)',
            border: '1px solid var(--dsw-alias-border-l2, #dcdcdc)',
            borderRadius: 'var(--dsw-radius-sm, 6px)',
          },
        }),
        h('div', {
          style: { display: 'flex', alignItems: 'center', marginTop: 8 },
        },
        h(Button, { onClick: commitCodes, disabled: busy || !codesDirty, kind: codesDirty ? 'primary' : undefined }, 'Save error codes'),
        h(Flash, { msg: codesMsg }),
        ),
        h('div', {
          style: { marginTop: 10, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary, #8a8a8a)' },
        },
        'Always on, and not removable here: ',
        h('code', {
          style: {
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
          },
        }, BUILTIN_CODES.join(', ')),
        '. RATE_LIMIT is a 429; QUOTA and ACCOUNT_QUOTA mean a balance or account allowance ran out; EMPTY_RESPONSE is a provider completion that carried no content at all.',
        ),
      ),
      )
    }

    // ── registration ─────────────────────────────────────────────────────
    // A throw inside slots.register blanks the whole slot entry, so every
    // registration path is guarded and degrades to a no-op disposer.
    function contribute(ctx, key, options, Component, what) {
      const fail = (e) => console.error(LOG, 'could not register ' + what + ':', e)
      try {
        return ctx.slots.inject(key, () => {
          try {
            return ctx.slots.register(options, Component)
          } catch (e) {
            fail(e)
            return () => {}
          }
        })
      } catch (e) {
        fail(e)
        return () => {}
      }
    }

    const inject = ['slots']

    function apply(ctx) {
      // single poller for both contributions; paused while the tab is hidden
      ctx.effect(() => {
        refresh()
        const timer = setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
        const onVisible = () => { if (!document.hidden) refresh() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, 'auto-continue-poll')

      ctx.effect(
        () => contribute(ctx, 'conversation.composer.bar', { name: 'conversation.composer.bar' }, ComposerBar, 'conversation.composer.bar'),
        'auto-continue-composer-bar',
      )

      ctx.effect(
        () => contribute(
          ctx,
          'settings.section',
          { name: 'settings.section', id: 'auto-continue', order: 205, label: 'Auto-Continue' },
          SettingsCard,
          'settings.section',
        ),
        'auto-continue-settings-section',
      )
    }

    return { inject, apply }
  },
})
