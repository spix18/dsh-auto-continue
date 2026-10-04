// dsh-auto-continue — 浏览器半 / browser half.
//
// Registers into two official DSH slots (no DOM scraping, no CSS-module hashes):
//   • conversation.input.left    — the quick on/off switch in the composer tool row
//   • settings.section           — the "Auto-Continue" page under Settings
//
// Both are kind:'list' slots. A kind:'single' slot belongs to whichever core
// plugin occupies it, and a second registration throws inside THAT plugin's
// apply — which kills its fiber and every plugin depending on its service.
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
      builtinCodes: BUILTIN_CODES,
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
        // The host owns RETRYABLE_ERROR_CODES; BUILTIN_CODES is only what we
        // paint before the first successful poll.
        const builtins = Array.isArray(d.builtinErrorCodes) && d.builtinErrorCodes.length
          ? d.builtinErrorCodes
          : snapshot.builtinCodes
        setState({
          enabled: !!d.enabled,
          quickOn: !!d.quickOn,
          buttonHidden: !!d.buttonHidden,
          retryCount: Number(d.retryCount) || 0,
          maxRetries: Number(d.maxRetries) || 20,
          // keep array identity when unchanged so the poll never re-renders
          errorCodes: codes.join('\u0000') === snapshot.errorCodes.join('\u0000') ? snapshot.errorCodes : codes,
          builtinCodes: builtins.join('\u0000') === snapshot.builtinCodes.join('\u0000') ? snapshot.builtinCodes : builtins,
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

    // Re-evaluated on every render rather than subscribed: the plugin re-renders
    // on each state change, and a plain guarded read keeps the vm harness (which
    // has no matchMedia) working.
    function prefersReducedMotion() {
      try {
        return typeof window !== 'undefined'
          && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      } catch {
        return false
      }
    }

    // ── primitives (theme tokens only, every one with a light/dark fallback) ──
    function Switch(props) {
      const on = !!props.on
      const disabled = !!props.disabled
      const reduced = prefersReducedMotion()
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
          width: 40, height: 24, padding: 0,
          borderRadius: 12, border: 'none',
          background: on
            ? 'var(--dsw-alias-brand-primary, #0f1115)'
            : 'var(--dsw-alias-border-l3, #0000001f)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: reduced ? 'none' : 'background 0.18s ease',
        },
      }, h('span', {
        'aria-hidden': 'true',
        style: {
          position: 'absolute', top: 2, left: 2,
          width: 20, height: 20, borderRadius: '50%',
          background: 'var(--dsw-alias-switch-thumb, #ffffff)',
          boxShadow: 'var(--dsw-shadow-lv1, 0 2px 4px 0 #0000000d)',
          transform: on ? 'translateX(16px)' : 'translateX(0)',
          transition: reduced ? 'none' : 'transform 0.18s ease',
        },
      }))
    }

    function Button(props) {
      const [hover, hoverProps] = useHover()
      const primary = props.kind === 'primary'
      const disabled = !!props.disabled
      const reduced = prefersReducedMotion()
      return h('button', {
        type: 'button',
        disabled,
        onClick: props.onClick,
        ...hoverProps,
        style: {
          height: 28, padding: '0 12px',
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
          borderRadius: 'var(--dsw-radius-sm, 8px)',
          border: primary ? 'none' : '1px solid var(--dsw-alias-border-l2, #0000001a)',
          background: primary
            ? (hover ? 'var(--dsw-alias-button-primary-hover, #43454a)' : 'var(--dsw-alias-button-primary-fill, #0f1115)')
            : (hover ? 'var(--dsw-alias-interactive-bg-hover, #2631480f)' : 'transparent'),
          color: primary
            ? 'var(--dsw-alias-label-primary-inverted, #ffffff)'
            : 'var(--dsw-alias-label-primary, #0f1115)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: reduced ? 'none' : 'background 0.15s ease',
        },
      }, props.children)
    }

    function Row(props) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, padding: '12px 14px',
          borderBottom: props.last ? 'none' : '1px solid var(--dsw-alias-border-l1, #0000000a)',
        },
      },
      h('div', { style: { minWidth: 0, flex: '1 1 auto' } },
        h('div', {
          style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #0f1115)' },
        }, props.title),
        props.hint
          ? h('div', {
              style: { marginTop: 2, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #61666b)' },
            }, props.hint)
          : null,
      ),
      h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 } }, props.children),
      )
    }

    function Flash(props) {
      if (!props.msg) return null
      // The glyph carries the meaning redundantly (shape + colour), so it is
      // hidden from AT and the semantic colour lives on it rather than on the
      // message text — which stays a readable label token.
      return h('span', {
        role: 'status',
        'aria-live': 'polite',
        style: { marginLeft: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary, #61666b)' },
      },
      h('span', {
        'aria-hidden': 'true',
        style: {
          color: props.msg.ok
            ? 'var(--dsw-alias-state-success-primary, #22c55e)'
            : 'var(--dsw-alias-state-error-primary, #ec1313)',
        },
      }, props.msg.ok ? '\u2713 ' : '\u2717 '),
      props.msg.text)
    }

    // ── slot: conversation.input.left ────────────────────────────────────
    // "Compact controls at the left of the composer tool row", kind: 'list' —
    // several plugins share the seat, so claiming one cannot displace anybody.
    //
    // Pick the slot whose DOC describes the shape you are rendering, not merely
    // a slot that accepts a registration. conversation.input.dock is documented
    // as "Full-width entries above the composer card" (it carries the queue
    // strip); a 24px pill placed there is stretched edge to edge by the
    // container's default align-items: stretch. conversation.input.left is the
    // compact tool row, which is what this control is.
    //
    // NEVER target a kind:'single' slot here: those are occupied by the core
    // plugin that owns them, and a second registration throws inside that
    // plugin's own apply, killing its fiber and every dependent of it.
    // Owner props (variant / disabled / …) are intentionally ignored: this is
    // a profile-wide switch, not per-session composer state.
    function ComposerBar() {
      const s = useStore()
      const [hover, hoverProps] = useHover()
      if (!s.enabled || s.buttonHidden) return null

      const on = s.quickOn
      const busy = s.retryCount > 0
      const reduced = prefersReducedMotion()
      const spoken = on ? 'Auto-continue is ON' : 'Auto-continue is OFF'
      return h('button', {
        type: 'button',
        'aria-pressed': on ? 'true' : 'false',
        // Contains the visible label verbatim (WCAG 2.5.3 Label in Name) and
        // states the action, so the control reads without its tooltip. The
        // counter is inside the button, so its text is folded into the name.
        'aria-label': spoken
          + (on ? ' \u2014 click to turn it off.' : ' \u2014 click to turn it on.')
          + (busy ? ' ' + s.retryCount + ' of ' + s.maxRetries + ' consecutive failures used this session.' : ''),
        title: on
          ? 'Auto-continue is ON \u2014 this session resumes by itself after a rate limit, an exhausted quota, an empty response, or a configured error. Click to turn it off.'
          : 'Auto-continue is OFF \u2014 a turn that dies on a rate limit will just stop. Click to turn it on.',
        onClick: () => toggleQuick(!on),
        ...hoverProps,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          alignSelf: 'center', flex: '0 0 auto',
          height: 24, padding: '0 9px', margin: 0,
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1,
          minWidth: 0, maxWidth: '100%',
          borderRadius: 'var(--dsw-radius-sm, 8px)',
          border: '1px solid ' + (on
            ? 'var(--dsw-alias-state-success-secondary, #4ed17e)'
            : 'var(--dsw-alias-border-l2, #0000001a)'),
          background: on
            ? 'var(--dsw-alias-state-success-tertiary, #e6faed)'
            : (hover ? 'var(--dsw-alias-interactive-bg-hover, #2631480f)' : 'transparent'),
          color: on
            ? 'var(--dsw-alias-label-primary, #0f1115)'
            : 'var(--dsw-alias-label-secondary, #61666b)',
          cursor: 'pointer', userSelect: 'none',
          transition: reduced ? 'none' : 'background 0.15s ease, border-color 0.15s ease',
        },
      },
      h('span', { 'aria-hidden': 'true', style: { fontSize: 13, lineHeight: 1 } }, '\u21bb'),
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, 'Auto-continue'),
      h('span', { style: { fontWeight: 600 } }, on ? 'ON' : 'OFF'),
      busy
        ? h('span', {
            title: s.retryCount + ' of ' + s.maxRetries + ' consecutive failures used in this session',
            style: {
              marginLeft: 1, padding: '0 5px', height: 16, lineHeight: '16px',
              flex: '0 0 auto',
              borderRadius: 8, fontSize: 10, fontWeight: 600,
              background: 'var(--dsw-alias-state-warn-tertiary, #fef5e7)',
              color: 'var(--dsw-alias-label-primary, #0f1115)',
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
        ? 'var(--dsw-alias-state-error-primary, #ec1313)'
        : (s.enabled && s.quickOn
            ? 'var(--dsw-alias-state-success-primary, #22c55e)'
            : 'var(--dsw-alias-label-tertiary, #81858c)')

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
          border: '1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2, #0000001a))',
          background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-3, #ffffff))',
          borderRadius: 'var(--dsw-radius-panel, 28px)',
          overflow: 'hidden',
        },
      },
      // header
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '14px 14px 12px',
          borderBottom: '1px solid var(--dsw-alias-border-l1, #0000000a)',
        },
      },
      h('span', {
        'aria-hidden': 'true',
        style: { width: 8, height: 8, borderRadius: '50%', background: dot, flex: '0 0 auto' },
      }),
      h('h2', {
        style: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #0f1115)' },
      }, 'Auto-Continue'),
      s.version
        ? h('span', {
            style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary, #61666b)' },
          }, 'v' + s.version)
        : null,
      h('span', {
        style: { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #61666b)' },
      }, status),
      ),

      h('div', {
        style: {
          padding: '10px 14px', fontSize: 12, lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary, #61666b)',
          borderBottom: '1px solid var(--dsw-alias-border-l1, #0000000a)',
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
          color: 'var(--dsw-alias-label-primary, #0f1115)',
          background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
          border: '1px solid var(--dsw-alias-border-l2, #0000001a)',
          borderRadius: 'var(--dsw-radius-sm, 8px)',
        },
      }),
      h(Button, { onClick: commitRetries, disabled: busy || !retriesDirty, kind: retriesDirty ? 'primary' : undefined }, 'Save'),
      h(Flash, { msg: retriesMsg }),
      ),

      // error codes
      h('div', { style: { padding: '12px 14px', borderTop: 'none' } },
        h('div', {
          style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary, #0f1115)' },
        }, 'Additional auto-continue error codes'),
        h('div', {
          style: { marginTop: 2, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #61666b)' },
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
            color: 'var(--dsw-alias-label-primary, #0f1115)',
            background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
            border: '1px solid var(--dsw-alias-border-l2, #0000001a)',
            borderRadius: 'var(--dsw-radius-sm, 8px)',
          },
        }),
        h('div', {
          style: { display: 'flex', alignItems: 'center', marginTop: 8 },
        },
        h(Button, { onClick: commitCodes, disabled: busy || !codesDirty, kind: codesDirty ? 'primary' : undefined }, 'Save error codes'),
        h(Flash, { msg: codesMsg }),
        ),
        h('div', {
          style: { marginTop: 10, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #61666b)' },
        },
        'Always on, and not removable here: ',
        h('code', {
          style: {
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            color: 'var(--dsw-alias-label-secondary, #61666b)',
          },
        }, (s.builtinCodes && s.builtinCodes.length ? s.builtinCodes : BUILTIN_CODES).join(', ')),
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
        () => contribute(
          ctx,
          'conversation.input.left',
          { name: 'conversation.input.left', id: 'auto-continue' },
          ComposerBar,
          'conversation.input.left',
        ),
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
