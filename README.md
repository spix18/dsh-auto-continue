# dsh-auto-continue

[![npm version](https://img.shields.io/npm/v/dsh-auto-continue?color=cb3837&label=npm)](https://www.npmjs.com/package/dsh-auto-continue)
[![npm downloads](https://img.shields.io/npm/dm/dsh-auto-continue?color=cb3837)](https://www.npmjs.com/package/dsh-auto-continue)
[![license](https://img.shields.io/npm/l/dsh-auto-continue?color=blue)](https://github.com/spix18/dsh-auto-continue/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/spix18/dsh-auto-continue?color=yellow)](https://github.com/spix18/dsh-auto-continue)

**Auto-continue plugin for DeepSeek Harness (DSH)** — when a turn dies on a rate limit, a quota
exhaustion or an empty response, the plugin waits a moment and **sends `continue` for you**, so a long
task survives a 429 instead of stopping dead. It keeps trying until the turn succeeds or a
configurable consecutive-failure limit is hit, and any successful turn resets the counter to zero.

[中文说明 →](README.zh-CN.md)

## Install

**Requirements:** Node ≥ 20 · DSH ≥ 0.2.0-rc.2

```bash
# 1. install the plugin into your DSH profile
dsh plugin --profile web add dsh-auto-continue

# 2. restart DSH  (the browser half is served at startup)
# 3. open  Settings → Auto-Continue  in the sidebar to configure it
```

That's it — the quick switch appears at the bottom of the composer straight away, and the plugin is
already working with sensible defaults. Set **Consecutive failure limit** to anything from 1 to 100
(default 20), and add extra error codes if your provider returns something unusual.

<details>
<summary>Other ways to install / verify</summary>

```bash
# from a local checkout (editable)
git clone https://github.com/spix18/dsh-auto-continue
dsh plugin --profile web add "file:$PWD/dsh-auto-continue"

# headless profile instead of web
dsh plugin --profile headless add dsh-auto-continue

# run the verification harness (55 assertions over both halves, no DSH needed)
node test/run.mjs
```

If you installed from a checkout, re-run `dsh plugin --profile web add "file:$PWD/dsh-auto-continue"`
after editing, then restart DSH.
</details>

## Features

| | |
|---|---|
| 🔄 **Turn-level auto-continue** | Runs *after* dsh-llm's own step-level retries are exhausted — the last line of defence for a turn that already failed |
| 🚦 **Knows the real failure classes** | `RATE_LIMIT` (429), `QUOTA`, `ACCOUNT_QUOTA` and `EMPTY_RESPONSE` are built in, always on |
| ➕ **Your own error codes** | Add any code from Settings — a recursive search, so a provider message buried in an error `cause` still matches |
| 🎛 **Quick switch in the composer** | A pill at the bottom of the input area: click to arm or disarm without leaving the conversation |
| ⚙️ **Settings page** | Its own section in the sidebar (Settings → **Auto-Continue**), rendered through DSH's official slot API — no DOM scraping |
| 🧮 **Per-session counter** | A failing session stops on its own; other sessions are unaffected. Any successful turn resets the count |
| ✋ **Manual message resets** | Send a message yourself and every counter goes back to zero — auto-continues are not "interference" |
| ⏱️ **Random 1–2 s backoff** | Deliberately flat, not growing: it rides out a sliding rate-limit window instead of backing off past it |
| 💾 **Settings persist** | Stored in `~/.dsh/dsh-auto-continue.json` |

## How it works

```
LLM returns 429 / quota exhausted / an empty response
  ↓
dsh-llm retries the step itself (built in: 5 attempts, 500ms → 10s backoff)
  ↓
retries exhausted → the turn ends with  reason.kind === 'error'  or  'max-tokens'
  ↓
★ this plugin steps in
  ↓
wait 1–2 s at random → send "continue" → a fresh turn starts ✅
  ↓
…if it fails again, repeat up to the consecutive-failure limit
  ↓
any turn that ends normally → counter back to 0 🎉
  ↓
limit reached → stop and wait for you
```

Built-in codes are matched against `LlmFailure.code` **exactly** — DSH's documented contract is to
route on the code, never by parsing a message. Codes you add yourself are matched against the whole
recursive error, so an odd provider payload still gets caught.

`SERVER`, `TIMEOUT` and `TRANSPORT` are intentionally *not* built in: dsh-llm already retries those
inside the step, and continuing the turn on top of that would double up.

## Settings

Open **Settings → Auto-Continue**.

| Control | What it does |
|---|---|
| **Enable plugin** | Master switch. Turning it off hides the composer pill and stops all auto-continues |
| **Show the quick switch in the composer** | Hides just the pill; auto-continue keeps working |
| **Consecutive failure limit** | 1–100 (default 20). Any successful turn resets the count |
| **Additional auto-continue error codes** | Comma- or newline-separated. Multi-word provider messages are kept whole |

## Configuration (optional)

Declare overrides in `cordis.patch.yml` or your profile config:

```yaml
- id: auto-continue
  name: dsh-auto-continue
  config:
    maxRetries: 20                 # consecutive failures before giving up
    continueMessage: "continue"    # the text sent as the follow-up turn
    errorCodes: ["invalid_request_error"]
```

## Architecture

A standard two-half DSH plugin (Cordis):

```
dsh-auto-continue/
├── package.json          # dsh.bundle.patch + dsh.client declarations
├── cordis.patch.yml      # bundle patch: inserts the plugin row
├── lib/
│   ├── index.js          # host: error interception, backoff, continue, HTTP routes
│   └── client.js         # browser: composer bar + Settings section (React via slots)
├── test/run.mjs          # verification harness (55 assertions, both halves)
├── LICENSE               # MIT
└── README.md
```

**Host half** (`lib/index.js`)

| Hook | Purpose |
|---|---|
| `ctx.inject(["webServer"])` | Six HTTP routes under `/api/dsh-auto-continue/*` for the browser half |
| `ctx.on("session/event", …)` | Watches `turn/end` for a retryable reason, then schedules the continue |
| `ctx.agents.get(id).followup(…)` | Sends the `continue` user message |

**Browser half** (`lib/client.js`) — React registered through DSH's official slot API
(`@deepseek-ai/dsh-client-ui-slots`) instead of scraping CSS-module hashes:

- `conversation.input.left` → the quick-switch pill in the composer tool row
- `settings.section` → the Settings → **Auto-Continue** page
- Polls `GET /api/dsh-auto-continue/state` every 2 s, pausing while the tab is hidden
- Every registration is wrapped so a failure can never blank the slot
- Both seats are `kind: 'list'` slots, so the plugin can never displace a core
  plugin's own entry — see [Slot safety](#slot-safety)

## Slot safety

DSH slots come in kinds. A `list` slot is keyed by `id`, so any number of
plugins can contribute to it. A `single` slot holds exactly one entry — and the
core plugin that owns it occupies that entry itself, at the end of its own
`apply`. `ctx.slots.register` throws `single slot "<name>" already has a
registration` for a second one.

That throw happens **inside the owning plugin's own `apply`**. So a collision
does not merely fail the newcomer — it kills the core plugin's fiber and every
plugin waiting on the service that plugin provides.

v0.4.2 claimed `conversation.composer.bar` (`kind: 'single'`, occupied by
`@deepseek-ai/dsh-client-ui-conversation`). At web boot that plugin failed,
`uiConversation` never appeared, and seven dependents went down with it:

```
web boot: 8 entries did not activate
@deepseek-ai/dsh-client-ui-conversation: failed
@deepseek-ai/dsh-client-ui-chat: pending (waiting for service: uiConversation)
@deepseek-ai/dsh-client-ui-workflow-run: pending (waiting for service: uiConversation)
… and 5 more
```

**v0.4.3 moved the switch to a `list` slot**, which fixed the outage — but to
`conversation.input.dock`, documented as *"full-width entries above the composer
card"*. A 24 px pill in a strip built for full-width entries gets stretched edge
to edge by the container's `align-items: stretch`, which is exactly how it
looked.

**v0.4.4 moved it to `conversation.input.left`** — *"compact controls at the
left of the composer tool row"*, the shape this control actually is. The test
suite now records the documented shape of every slot this plugin touches, so
neither the collision nor the mismatch can come back.

## Permissions

- **No filesystem access beyond settings** — only `~/.dsh/dsh-auto-continue.json` (< 1 KB)
- **Never reads your API key** — it reuses DSH's own agent / `followup` channel
- **No outbound network** — all HTTP routes go through DSH's built-in web server (loopback only)

Upgrading from the old `dsh-auto-continue-429`? Your existing retry limit and error-code list are
read from `~/.dsh/auto-continue-429.json` once, then written to the new file.

## Debugging

Host-side log lines (DSH stdout):

```
[Auto-Continue] Session sess_xxx failure 3/20, sending continue in 1862ms
[Auto-Continue] Sent continue to session sess_xxx
[Auto-Continue] Consecutive failure limit of 20 reached, stopping automatic continue
```

Settings file:

```
~/.dsh/dsh-auto-continue.json
→ {"enabled": true, "quickOn": true, "buttonHidden": false, "maxRetries": 20, "errorCodes": [...]}
```

## Support

If you find this useful, you can support development at **[ko-fi.com/spix18](https://ko-fi.com/spix18)**. ☕

## License

**MIT** © 2026
