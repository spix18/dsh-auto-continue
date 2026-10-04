#!/usr/bin/env node
/**
 * Verification harness for dsh-auto-continue.
 *
 * Runs the real shipped files against stand-ins for the DSH runtime:
 *   • lib/index.js  — imported as a real ESM module and driven through a fake
 *     cordis ctx (inject / on / effect / agents) with fake timers, so the
 *     actual turn/end retry decision is executed rather than described.
 *   • lib/client.js — evaluated in a vm sandbox with a fake
 *     window.__ModuleLoader__ and a minimal React hook runtime, so the slot
 *     registrations and both components are really rendered and clicked.
 *
 * The plugin's settings file is redirected to a throwaway HOME for the whole
 * run: a test must never read or overwrite the operator's real config.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const STATE_URL = '/api/dsh-auto-continue/state'

let passed = 0
const failures = []
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log('  \u2713 ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  \u2717 ' + name)
    console.log('      ' + String((e && e.message) || e).split('\n').slice(0, 6).join('\n      '))
  }
}
function section(title) { console.log('\n' + title) }

// ── isolate the settings file ───────────────────────────────────────────────
const FAKE_HOME = path.join(os.tmpdir(), 'dsh-auto-continue-test-' + process.pid)
mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME
const SETTINGS_DIR = path.join(FAKE_HOME, '.dsh')

// ── fake timers (the host half schedules its continue 1–2 s out) ────────────
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let timers = []
function installFakeTimers() {
  timers = []
  globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t }
  globalThis.clearTimeout = (t) => { if (t) t.cleared = true }
}
function restoreFakeTimers() {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
async function flushTimers() {
  const due = timers.filter((t) => !t.cleared)
  timers = []
  for (const t of due) await t.fn()
  return due.length
}
const tick = () => new Promise((r) => realSetTimeout(r, 0))

// ── fake cordis ctx for the host half ───────────────────────────────────────
function makeHostCtx() {
  const routes = []
  const handlers = new Map()
  const disposers = []
  const agentMap = new Map()
  const ctx = {
    routes,
    handlers,
    agentMap,
    agents: { get: (id) => agentMap.get(id) },
    registeredAgent(id) {
      const rec = { sent: [], followup(m) { this.sent.push(m) } }
      agentMap.set(id, rec)
      return rec
    },
    inject(services, cb) {
      assert.ok(Array.isArray(services), 'ctx.inject expects a service array')
      assert.ok(services.includes('webServer'), 'the host half must inject webServer')
      cb({
        effect(fn) { const d = fn(); disposers.push(d); return d },
        webServer: { register(route) { routes.push(route); return () => {} } },
      })
      return { dispose() {} }
    },
    on(event, handler) { handlers.set(event, handler); return () => {} },
    effect(fn) { const d = fn(); disposers.push(d); return d },
  }
  return ctx
}

function makeRes() {
  const res = {
    status: null,
    body: '',
    writeHead(status) { res.status = status; return res },
    end(chunk) { if (chunk !== undefined) res.body += String(chunk); return res },
  }
  return res
}
function makeReq(method, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    async *[Symbol.asyncIterator]() { if (text) yield Buffer.from(text, 'utf8') },
  }
}
async function callRoute(route, method, body) {
  const res = makeRes()
  await route.handler(makeReq(method, body), res)
  assert.equal(res.status, 200, `${route.path} ${method} -> HTTP ${res.status} ${res.body}`)
  return JSON.parse(res.body)
}

// ── minimal React hook runtime for the browser half ─────────────────────────
// Faithful in the two ways the components depend on: `children` land in props
// exactly like React, and function components are expanded recursively with
// their own hook slot.
function makeMiniReact() {
  let current = null
  const makeSlot = () => ({ hooks: [], index: 0 })
  const withSlot = (slot, fn) => {
    const prev = current
    current = slot
    try { return fn() } finally { current = prev }
  }
  const createElement = (type, props, ...children) => {
    const flat = children
      .flat(Infinity)
      .filter((c) => c !== null && c !== undefined && c !== false && c !== true)
    const merged = { ...(props || {}) }
    if (flat.length) merged.children = flat.length === 1 ? flat[0] : flat
    return { type, props: merged, children: flat }
  }
  const React = {
    createElement,
    useState(init) {
      const slot = current
      const i = slot.index++
      if (!(i in slot.hooks)) slot.hooks[i] = typeof init === 'function' ? init() : init
      return [slot.hooks[i], (v) => { slot.hooks[i] = typeof v === 'function' ? v(slot.hooks[i]) : v }]
    },
    useRef(v) {
      const i = current.index++
      if (!(i in current.hooks)) current.hooks[i] = { current: v }
      return current.hooks[i]
    },
    useCallback(fn) { current.index++; return fn },
    useEffect(fn) {
      const i = current.index++
      if (!(i in current.hooks)) { current.hooks[i] = true; fn() }
    },
  }
  function expand(node) {
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (Array.isArray(node)) return node.map(expand)
    if (typeof node.type === 'function') return expand(withSlot(makeSlot(), () => node.type(node.props)))
    return { ...node, children: node.children.map(expand) }
  }
  function render(Component, props, slot) {
    // Reusing a slot models a re-render, so the hook cursor MUST restart at 0 —
    // otherwise the second pass reads and writes shifted hook slots.
    const s = slot || makeSlot()
    s.index = 0
    return expand(withSlot(s, () => Component(props || {})))
  }
  return { React, render, makeSlot }
}

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const n of node) textOf(n, out); return out }
  for (const n of node.children || []) textOf(n, out)
  return out
}
function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const n of node) findAll(n, pred, out); return out }
  if (pred(node)) out.push(node)
  for (const n of node.children || []) findAll(n, pred, out)
  return out
}
const text = (tree) => textOf(tree).join(' ')

async function main() {
  console.log('dsh-auto-continue \u2014 verification harness')
  console.log('package: ' + pkg.name + '@' + pkg.version)
  console.log('fake home: ' + FAKE_HOME)

  // ── manifest ─────────────────────────────────────────────────────────────
  section('manifest')

  await check('package name matches the published plugin id', () => {
    assert.equal(pkg.name, 'dsh-auto-continue')
  })

  await check('every path in `exports` and `files` exists on disk', () => {
    for (const [key, target] of Object.entries(pkg.exports)) {
      if (key === './package.json') continue
      assert.ok(existsSync(path.join(ROOT, target)), `exports["${key}"] -> ${target} is missing`)
    }
    for (const f of pkg.files) {
      if (f.includes('*')) continue
      assert.ok(existsSync(path.join(ROOT, f)), `files entry "${f}" is missing`)
    }
  })

  await check('the published tarball carries both halves the manifest points at', () => {
    assert.ok(pkg.files.includes('lib/index.js'), 'lib/index.js must ship (exports ".")')
    assert.ok(pkg.files.includes('lib/client.js'), 'lib/client.js must ship (exports "./client")')
    assert.ok(pkg.files.includes('cordis.patch.yml'), 'cordis.patch.yml must ship (dsh.bundle.patch)')
  })

  await check('dsh.client declares a web bundle and @deepseek-ai packages', () => {
    assert.equal(pkg.dsh.client.platform, 'web')
    assert.ok(Array.isArray(pkg.dsh.client.inject))
    assert.ok(pkg.dsh.client.inject.length > 0)
    for (const dep of pkg.dsh.client.inject) {
      assert.ok(dep.startsWith('@deepseek-ai/'), `"${dep}" is not a @deepseek-ai package`)
    }
  })

  await check('cordis.patch.yml inserts a row named after the package', () => {
    const yml = readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
    assert.match(yml, /-\s*insert:/, 'patch must be an insert layer')
    assert.match(yml, new RegExp('name:\\s*' + pkg.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'))
    assert.match(yml, /id:\s*auto-continue\b/)
  })

  await check('no stale dsh-auto-continue-429 identity survives in the manifests', () => {
    for (const f of ['package.json', 'cordis.patch.yml']) {
      const t = readFileSync(path.join(ROOT, f), 'utf8')
      assert.ok(!t.includes('auto-continue-429'), `${f} still mentions the old name`)
      assert.ok(!t.includes('haochi72'), `${f} still points at the previous owner`)
    }
  })

  await check('the browser bundle id equals the package name', () => {
    const src = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
    // strip line comments so the contract note at the top cannot satisfy this
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const m = code.match(/__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/)
    assert.ok(m, 'client.js must register through window.__ModuleLoader__.load({ id, factory })')
    assert.equal(m[1], pkg.name, 'the loader id must be the package name')
  })

  // ── host half ────────────────────────────────────────────────────────────
  section('host half (lib/index.js)')

  const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

  await check('exports the cordis plugin triple plus a default', () => {
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(typeof plugin.name, 'string')
    assert.ok(Array.isArray(plugin.inject))
    assert.ok(plugin.inject.includes('agents'), 'the host half needs the agents service')
    assert.equal(typeof plugin.default.apply, 'function')
    assert.equal(plugin.default.name, plugin.name)
  })

  await check('the declared VERSION matches package.json', () => {
    const m = readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8').match(/const VERSION\s*=\s*["']([^"']+)["']/)
    assert.ok(m, 'lib/index.js must declare a VERSION constant')
    assert.equal(m[1], pkg.version, 'VERSION and package.json version drifted apart')
  })

  await check('os.homedir() honours the sandbox HOME (settings stay isolated)', () => {
    assert.equal(os.homedir(), FAKE_HOME)
  })

  const ctx = makeHostCtx()
  await plugin.apply(ctx, {})
  const route = (p) => ctx.routes.find((r) => r.path === '/api/dsh-auto-continue' + p)
  const fire = (type, data, sessionId) =>
    ctx.handlers.get('session/event')({ id: sessionId || 'sess-1' }, { type, data })

  await check('registers all six routes under /api/dsh-auto-continue/', () => {
    assert.deepEqual(ctx.routes.map((r) => r.path).sort(), [
      '/api/dsh-auto-continue/hide-button',
      '/api/dsh-auto-continue/set-error-codes',
      '/api/dsh-auto-continue/set-max-retries',
      '/api/dsh-auto-continue/state',
      '/api/dsh-auto-continue/toggle',
      '/api/dsh-auto-continue/toggle-quick',
    ])
    for (const r of ctx.routes) assert.equal(r.kind, 'exact')
  })

  await check('subscribes to session/event and session/disposed', () => {
    assert.ok(ctx.handlers.has('session/event'), 'no session/event listener')
    assert.ok(ctx.handlers.has('session/disposed'), 'no session/disposed listener')
  })

  await check('GET /state reports version and the built-in retryable codes', async () => {
    const d = await callRoute(route('/state'), 'GET')
    assert.equal(d.version, pkg.version)
    assert.equal(typeof d.enabled, 'boolean')
    assert.equal(typeof d.quickOn, 'boolean')
    assert.equal(typeof d.buttonHidden, 'boolean')
    assert.equal(typeof d.maxRetries, 'number')
    assert.ok(Array.isArray(d.errorCodes))
    assert.deepEqual(d.builtinErrorCodes.slice().sort(), ['ACCOUNT_QUOTA', 'EMPTY_RESPONSE', 'QUOTA', 'RATE_LIMIT'])
  })

  await check('/state rejects non-GET with 405', async () => {
    const res = makeRes()
    await route('/state').handler(makeReq('POST'), res)
    assert.equal(res.status, 405)
  })

  await check('a RATE_LIMIT turn/end schedules exactly one jittered continue', async () => {
    installFakeTimers()
    try {
      const agent = ctx.registeredAgent('sess-1')
      fire('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '429' } } })
      assert.equal(timers.length, 1, 'expected one scheduled continue')
      assert.ok(timers[0].ms >= 1000 && timers[0].ms <= 2000, 'delay must be the 1-2 s jitter')
      await flushTimers()
      assert.equal(agent.sent.length, 1)
      const msg = agent.sent[0]
      assert.equal(msg.role, 'user')
      assert.equal(msg.content[0].type, 'text')
      assert.equal(msg.content[0].text, 'continue')
      assert.deepEqual(msg.source, { kind: 'plugin', plugin: 'auto-continue' })
      assert.ok(Object.isFrozen(msg), 'the injected message must be deeply frozen')
      assert.equal(typeof msg.id, 'string')
    } finally { restoreFakeTimers() }
  })

  await check('all four canonical retryable codes trigger the continue', () => {
    installFakeTimers()
    try {
      for (const code of ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'EMPTY_RESPONSE']) {
        timers = []
        fire('turn/end', { turn: 1, reason: { kind: 'error', error: { code, message: 'x' } } }, 'sess-codes')
        assert.equal(timers.length, 1, `${code} did not schedule a continue`)
      }
    } finally { restoreFakeTimers() }
  })

  await check('built-in codes match the top-level failure class, not a nested cause', async () => {
    // The built-in set is checked against LlmFailure.code exactly — dsh-llm's
    // documented contract is to route on `code`, never by parsing a message.
    // A nested cause therefore does NOT auto-trigger...
    installFakeTimers()
    try {
      timers = []
      fire('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'wrapped', cause: { code: 'EMPTY_RESPONSE' } } },
      }, 'sess-nested')
      assert.equal(timers.length, 0, 'a nested code must not match a built-in by itself')
    } finally { restoreFakeTimers() }
  })

  await check('...but a nested cause IS reachable through the user error-code list', async () => {
    await callRoute(route('/set-error-codes'), 'POST', { errorCodes: ['empty_response'] })
    installFakeTimers()
    try {
      timers = []
      fire('turn/end', {
        turn: 1,
        reason: { kind: 'error', error: { code: 'UNKNOWN', message: 'wrapped', cause: { code: 'EMPTY_RESPONSE' } } },
      }, 'sess-nested2')
      assert.equal(timers.length, 1, 'the configured code searches the whole error recursively')
    } finally { restoreFakeTimers() }
    await callRoute(route('/set-error-codes'), 'POST', { errorCodes: ['invalid_request_error'] })
  })

  await check('non-retryable ends never schedule a continue', () => {
    installFakeTimers()
    try {
      for (const reason of [
        { kind: 'completed' },
        { kind: 'blocked' },
        { kind: 'aborted', reason: { kind: 'user' } },
        { kind: 'error', error: { code: 'INVALID_CREDENTIAL', message: 'bad key' } },
        { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'too long' } },
      ]) {
        timers = []
        fire('turn/end', { turn: 1, reason }, 'sess-noop')
        assert.equal(timers.length, 0, `${JSON.stringify(reason)} must not continue`)
      }
    } finally { restoreFakeTimers() }
  })

  await check('max-tokens is still a retryable turn reason', () => {
    installFakeTimers()
    try {
      timers = []
      fire('turn/end', { turn: 1, reason: { kind: 'max-tokens' } }, 'sess-maxtok')
      assert.equal(timers.length, 1)
    } finally { restoreFakeTimers() }
  })

  await check('a successful turn resets the consecutive-failure counter', async () => {
    installFakeTimers()
    try {
      const agent = ctx.registeredAgent('sess-reset')
      for (let i = 0; i < 3; i++) {
        fire('turn/end', { turn: i, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, 'sess-reset')
        await flushTimers()
      }
      assert.equal(agent.sent.length, 3)
      fire('turn/end', { turn: 4, reason: { kind: 'completed' } }, 'sess-reset')
      fire('turn/end', { turn: 5, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, 'sess-reset')
      await flushTimers()
      assert.equal(agent.sent.length, 4)
      const d = await callRoute(route('/state'), 'GET')
      assert.equal(d.retryCounts['sess-reset'], 1, 'the counter must restart at 1 after a completed turn')
    } finally { restoreFakeTimers() }
  })

  await check('the consecutive-failure limit actually stops the loop', async () => {
    installFakeTimers()
    try {
      const agent = ctx.registeredAgent('sess-limit')
      await callRoute(route('/set-max-retries'), 'POST', { maxRetries: 2 })
      for (let i = 0; i < 6; i++) {
        fire('turn/end', { turn: i, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, 'sess-limit')
        await flushTimers()
      }
      assert.equal(agent.sent.length, 2, 'must stop after the configured limit')
      await callRoute(route('/set-max-retries'), 'POST', { maxRetries: 20 })
    } finally { restoreFakeTimers() }
  })

  await check('a user-typed message resets counters and cancels a pending continue', async () => {
    installFakeTimers()
    try {
      const agent = ctx.registeredAgent('sess-user')
      fire('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, 'sess-user')
      assert.equal(timers.length, 1)
      fire('user/message', { source: { kind: 'user' } }, 'sess-user')
      assert.ok(timers[0].cleared, 'the pending continue must be cancelled')
      await flushTimers()
      assert.equal(agent.sent.length, 0)
    } finally { restoreFakeTimers() }
  })

  await check("the plugin's own continue is not mistaken for a user message", () => {
    installFakeTimers()
    try {
      const agent = ctx.registeredAgent('sess-self')
      fire('user/message', { source: { kind: 'plugin', plugin: 'auto-continue' } }, 'sess-self')
      timers = []
      fire('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, 'sess-self')
      assert.equal(timers.length, 1)
      // the legacy label from the old dsh-auto-continue-429 build counts as ours too
      fire('user/message', { source: { kind: 'plugin', plugin: 'Auto-Continue' } }, 'sess-self')
      assert.equal(timers[0].cleared, false, 'the legacy label must be recognized as our own')
    } finally { restoreFakeTimers() }
  })

  await check('the master switch stops automatic continue', async () => {
    assert.equal((await callRoute(route('/toggle'), 'POST')).enabled, false)
    installFakeTimers()
    try {
      timers = []
      fire('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, 'sess-off')
      assert.equal(timers.length, 0, 'a disabled plugin must not continue')
    } finally { restoreFakeTimers() }
    assert.equal((await callRoute(route('/toggle'), 'POST')).enabled, true)
  })

  await check('the quick switch independently stops automatic continue', async () => {
    assert.equal((await callRoute(route('/toggle-quick'), 'POST')).quickOn, false)
    installFakeTimers()
    try {
      timers = []
      fire('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }, 'sess-quick')
      assert.equal(timers.length, 0, 'quick switch off must not continue')
    } finally { restoreFakeTimers() }
    assert.equal((await callRoute(route('/toggle-quick'), 'POST')).quickOn, true)
  })

  await check('hide-button toggles the composer switch visibility flag', async () => {
    assert.equal((await callRoute(route('/hide-button'), 'POST', { hidden: true })).buttonHidden, true)
    assert.equal((await callRoute(route('/hide-button'), 'POST', { hidden: false })).buttonHidden, false)
  })

  await check('set-max-retries validates its range and rejects junk', async () => {
    for (const bad of [0, 101, -5, 'abc', null]) {
      const res = makeRes()
      await route('/set-max-retries').handler(makeReq('POST', { maxRetries: bad }), res)
      assert.equal(res.status, 400, `maxRetries=${JSON.stringify(bad)} should be rejected`)
      assert.equal(JSON.parse(res.body).ok, false)
    }
    assert.equal((await callRoute(route('/set-max-retries'), 'POST', { maxRetries: 33 })).maxRetries, 33)
    await callRoute(route('/set-max-retries'), 'POST', { maxRetries: 20 })
  })

  await check('set-error-codes normalizes, dedupes, lowercases — and keeps phrases whole', async () => {
    const d = await callRoute(route('/set-error-codes'), 'POST', {
      errorCodes: ' 503 , 523,503 ,, Service Temporarily Unavailable \n 504 ',
    })
    assert.deepEqual(
      d.errorCodes,
      ['503', '523', 'service temporarily unavailable', '504'],
      'a multi-word provider message must survive as one entry',
    )
  })

  await check('set-error-codes accepts an array as well as a string', async () => {
    const d = await callRoute(route('/set-error-codes'), 'POST', { errorCodes: ['Output Token Limit Reached', 42] })
    assert.deepEqual(d.errorCodes, ['output token limit reached', '42'])
  })

  await check('settings persist to the isolated HOME, not the real one', () => {
    const file = path.join(SETTINGS_DIR, 'dsh-auto-continue.json')
    assert.ok(existsSync(file), 'settings file was not written under the fake HOME')
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(typeof saved.enabled, 'boolean')
    assert.ok(Array.isArray(saved.errorCodes))
  })

  await check('a legacy auto-continue-429.json is migrated on load', async () => {
    const alt = path.join(os.tmpdir(), 'dsh-ac-legacy-' + process.pid)
    mkdirSync(path.join(alt, '.dsh'), { recursive: true })
    writeFileSync(
      path.join(alt, '.dsh', 'auto-continue-429.json'),
      JSON.stringify({ enabled: true, quickOn: true, buttonHidden: false, maxRetries: 77, errorCodes: ['legacy-marker'] }),
    )
    const prev = process.env.USERPROFILE
    process.env.USERPROFILE = alt
    process.env.HOME = alt
    try {
      const fresh = await import(new URL('../lib/index.js', import.meta.url).href + '?legacy=' + Date.now())
      const c2 = makeHostCtx()
      await fresh.apply(c2, {})
      const state = await callRoute(c2.routes.find((r) => r.path === STATE_URL), 'GET')
      assert.equal(state.maxRetries, 77, 'the legacy retry limit was not carried over')
      assert.deepEqual(state.errorCodes, ['legacy-marker'], 'the legacy error codes were not carried over')
    } finally {
      process.env.USERPROFILE = prev
      process.env.HOME = prev
      rmSync(alt, { recursive: true, force: true })
    }
  })

  // ── browser half ─────────────────────────────────────────────────────────
  section('browser half (lib/client.js)')

  const clientSrc = readFileSync(path.join(ROOT, 'lib/client.js'), 'utf8')
  const { React, render, makeSlot } = makeMiniReact()

  let loaded = null
  let statePayload = {
    version: pkg.version,
    enabled: true,
    quickOn: true,
    buttonHidden: false,
    retryCount: 0,
    maxRetries: 20,
    errorCodes: ['invalid_request_error'],
  }
  const fetchCalls = []
  let pollFn = null
  let failFetch = false

  const sandbox = {
    console,
    URL,
    setTimeout: realSetTimeout,
    clearTimeout: realClearTimeout,
    setInterval: (fn) => { pollFn = fn; return 1 },
    clearInterval: () => { pollFn = null },
    document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init })
      if (failFetch) throw new Error('offline')
      return { ok: true, status: 200, async json() { return statePayload } }
    },
    require(name) {
      if (name === 'react') return React
      throw new Error('the browser half must not require ' + name)
    },
    window: { __ModuleLoader__: { load(entry) { loaded = entry } } },
  }
  sandbox.globalThis = sandbox
  runInContext(clientSrc, createContext(sandbox), { filename: 'lib/client.js' })

  await check('registers itself with the module loader under the package id', () => {
    assert.ok(loaded, 'window.__ModuleLoader__.load was never called')
    assert.equal(loaded.id, pkg.name)
    assert.equal(typeof loaded.factory, 'function')
  })

  const client = loaded.factory(sandbox.require)

  await check('exports the cordis client plugin shape', () => {
    assert.equal(client.inject.length, 1)
    assert.equal(client.inject[0], 'slots')
    assert.equal(typeof client.apply, 'function')
  })

  const slotCalls = []
  const clientEffects = []
  const registrations = []
  const clientCtx = {
    slots: {
      inject(key, cb) {
        slotCalls.push(key)
        const dispose = cb()
        assert.equal(typeof dispose, 'function', `slots.inject("${key}") must return a disposer`)
        return dispose
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
    effect(fn, effectName) {
      const dispose = fn()
      clientEffects.push({ name: effectName, dispose })
      return () => { if (typeof dispose === 'function') dispose() }
    },
  }

  await check('contributes to conversation.composer.bar and settings.section', () => {
    client.apply(clientCtx)
    assert.deepEqual(slotCalls.slice().sort(), ['conversation.composer.bar', 'settings.section'])
  })

  await check('the composer bar registers with only a name (a single slot rejects an id)', () => {
    const bar = registrations.find((r) => r.options.name === 'conversation.composer.bar')
    assert.ok(bar, 'the composer bar was not registered')
    assert.deepEqual(Array.from(Object.keys(bar.options)), ['name'])
    assert.equal(typeof bar.Component, 'function')
  })

  await check('the settings section registers as a list entry with id, order and label', () => {
    const s = registrations.find((r) => r.options.name === 'settings.section')
    assert.ok(s, 'the settings section was not registered')
    assert.equal(s.options.id, 'auto-continue')
    assert.equal(typeof s.options.order, 'number')
    assert.equal(s.options.label, 'Auto-Continue')
    assert.equal(typeof s.Component, 'function')
  })

  await check('every effect is named and returns a disposer (cordis cleanup contract)', () => {
    assert.equal(clientEffects.length, 3)
    for (const e of clientEffects) {
      assert.ok(typeof e.name === 'string' && e.name.length > 0, 'an effect is unnamed')
      assert.equal(typeof e.dispose, 'function', `effect "${e.name}" returned no disposer`)
    }
  })

  const Bar = registrations.find((r) => r.options.name === 'conversation.composer.bar').Component
  const Card = registrations.find((r) => r.options.name === 'settings.section').Component

  async function pushState(patch) {
    statePayload = { ...statePayload, ...patch }
    if (pollFn) pollFn()
    await tick()
    await tick()
  }

  await check('the store polled the state route on apply', () => {
    assert.ok(fetchCalls.length >= 1, 'apply never polled the state route')
    assert.ok(fetchCalls.every((c) => c.url === STATE_URL), 'unexpected fetch target: ' + fetchCalls.map((c) => c.url).join(', '))
  })

  await check('the composer bar renders the on state', async () => {
    await pushState({ enabled: true, quickOn: true, buttonHidden: false, retryCount: 0 })
    const t = text(render(Bar, {}))
    assert.ok(t.includes('Auto-continue'), 'missing the label: ' + t)
    assert.ok(t.includes('ON'), 'missing the ON state: ' + t)
  })

  await check('the composer bar renders the off state', async () => {
    await pushState({ quickOn: false })
    assert.ok(text(render(Bar, {})).includes('OFF'), 'missing the OFF state')
  })

  await check('the composer bar shows the failure counter while busy', async () => {
    await pushState({ quickOn: true, retryCount: 3, maxRetries: 20 })
    assert.ok(text(render(Bar, {})).includes('3/20'), 'expected 3/20 on the badge')
  })

  await check('the composer bar disappears when the plugin is disabled', async () => {
    await pushState({ enabled: false, retryCount: 0 })
    assert.equal(render(Bar, {}), null, 'a disabled plugin must render nothing')
  })

  await check('the composer bar disappears when the quick switch is hidden', async () => {
    await pushState({ enabled: true, buttonHidden: true })
    assert.equal(render(Bar, {}), null, 'buttonHidden must render nothing')
  })

  await check('the composer bar reacts to a click by posting to /toggle-quick', async () => {
    await pushState({ enabled: true, buttonHidden: false, quickOn: false })
    const before = fetchCalls.length
    const button = findAll(render(Bar, {}), (n) => n.type === 'button')[0]
    assert.ok(button, 'the composer bar did not render a button')
    await button.props.onClick()
    const posted = fetchCalls.slice(before)
    assert.ok(
      posted.some((c) => c.url.endsWith('/toggle-quick')),
      'the click did not post to /toggle-quick: ' + posted.map((c) => c.url).join(', '),
    )
  })

  await check('the settings page renders every control', async () => {
    await pushState({ enabled: true, buttonHidden: false, quickOn: true })
    const t = text(render(Card, {}))
    for (const expected of [
      'Auto-Continue',
      'Enable plugin',
      'Show the quick switch in the composer',
      'Consecutive failure limit',
      'Additional auto-continue error codes',
    ]) {
      assert.ok(t.includes(expected), `the settings page is missing "${expected}"`)
    }
    assert.ok(t.includes('v' + pkg.version), 'the settings page does not show the version')
  })

  await check('the settings page exposes two switches, a number input and a textarea', async () => {
    await pushState({ enabled: true, buttonHidden: false })
    const tree = render(Card, {})
    const switches = findAll(tree, (n) => n.type === 'button' && n.props.role === 'switch')
    assert.equal(switches.length, 2, 'expected the master switch and the quick-switch visibility toggle')
    assert.equal(switches[0].props['aria-checked'], 'true')
    const inputs = findAll(tree, (n) => n.type === 'input')
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].props.type, 'number')
    assert.equal(inputs[0].props.min, 1)
    assert.equal(inputs[0].props.max, 100)
    const areas = findAll(tree, (n) => n.type === 'textarea')
    assert.equal(areas.length, 1)
    assert.equal(areas[0].props.value, 'invalid_request_error')
  })

  await check('the settings page lists the built-in codes it cannot remove', async () => {
    const t = text(render(Card, {}))
    for (const code of ['RATE_LIMIT', 'QUOTA', 'ACCOUNT_QUOTA', 'EMPTY_RESPONSE']) {
      assert.ok(t.includes(code), `the settings page does not mention the built-in ${code}`)
    }
  })

  await check('editing the error-code box posts whole multi-word phrases', async () => {
    const slot = makeSlot()
    let tree = render(Card, {}, slot)
    const area = findAll(tree, (n) => n.type === 'textarea')[0]
    area.props.onChange({ target: { value: '503\nService Temporarily Unavailable' } })
    tree = render(Card, {}, slot)          // same slot => state persists, like a re-render
    const save = findAll(tree, (n) => n.type === 'button' && text(n).includes('Save error codes'))[0]
    assert.ok(save, 'the Save error codes button disappeared')
    const before = fetchCalls.length
    await save.props.onClick()
    const posted = fetchCalls.slice(before).find((c) => c.url.endsWith('/set-error-codes'))
    assert.ok(posted, 'clicking Save did not post to /set-error-codes')
    assert.deepEqual(JSON.parse(posted.init.body).errorCodes, ['503', 'Service Temporarily Unavailable'])
  })

  await check('editing the retry limit clamps before saving', async () => {
    const slot = makeSlot()
    let tree = render(Card, {}, slot)
    const input = findAll(tree, (n) => n.type === 'input')[0]
    input.props.onChange({ target: { value: '999' } })
    tree = render(Card, {}, slot)
    const save = findAll(tree, (n) => n.type === 'button' && text(n) === 'Save')[0]
    assert.ok(save, 'the Save button disappeared')
    const before = fetchCalls.length
    await save.props.onClick()
    const posted = fetchCalls.slice(before).find((c) => c.url.endsWith('/set-max-retries'))
    assert.ok(posted, 'clicking Save did not post to /set-max-retries')
    assert.equal(JSON.parse(posted.init.body).maxRetries, 100, '999 must clamp to 100')
  })

  await check('the settings page reports the host as unreachable when the poll fails', async () => {
    failFetch = true
    try {
      await pushState({})
      const t = text(render(Card, {}))
      assert.ok(t.includes('not reachable'), 'expected the offline status, got: ' + t)
    } finally {
      failFetch = false
      await pushState({})
    }
  })

  await check('a throwing poll never breaks the render', async () => {
    failFetch = true
    try {
      await pushState({})
      const t = text(render(Bar, {}))
      assert.ok(typeof t === 'string', 'the bar must still render while the host is down')
    } finally {
      failFetch = false
      await pushState({})
    }
  })

  // ── result ───────────────────────────────────────────────────────────────
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed')
  rmSync(FAKE_HOME, { recursive: true, force: true })
  if (failures.length) {
    console.log('\nfailures:')
    for (const f of failures) {
      console.log('  \u2717 ' + f.name)
      console.log('    ' + String((f.error && f.error.stack) || f.error).split('\n').slice(0, 5).join('\n    '))
    }
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('harness crashed:', e)
  rmSync(FAKE_HOME, { recursive: true, force: true })
  process.exit(1)
})
