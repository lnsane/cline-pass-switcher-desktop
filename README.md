# Cline Pass Switcher — Desktop

[English](README.md) · [中文](README.zh-CN.md)

An Electron desktop app around the same "Cline Pass upstream observer / switching proxy" that
the CLI version provides: a real window, a tray icon, launch-at-login — no terminal, no commands,
no web console to poke at.

The proxy core is the original zero-dependency Node code (a verbatim copy of `server.js` with a
small surgical change at the end of the file — see below), so learning results accumulated by the
CLI version (upstream lists, availability status, request history) carry over directly.

---

## What it solves

For Cline Pass subscription models (`cline-pass/*`), the `provider.*` field in the request body is
**dropped** by the Cline gateway, which then picks an upstream itself via its planner. Only `:free`
variants in the catalog actually pass `provider.only` through to OpenRouter. So "which upstream am
I actually hitting, can I pin it, and is that pin still alive?" is invisible from the client side.

This app makes that visible and controllable:

| Capability | Description |
|---|---|
| Pipeline detection | Detects whether each model uses `direct` (OpenRouter — injects top-level `provider`) or `planner` (Vercel AI Gateway — injects `providerOptions.gateway`) |
| Upstream enumeration | Reads the list of available upstreams for a model out of a single tiny real request's response metadata |
| Ordered pinning | Gives each model a "pin chain": try each upstream in order, falling to the next on the first failure. Plus an exclude list (takes priority over selection) |
| Pin verification | Pins each upstream in the chain once to test whether the gateway actually honors it; results are saved as status (available / rate-limited / unpinnable / key issue) |
| Account pool | Round-robin or manual selection across multiple accounts, with per-account connectivity tests |
| Official quota | Reads Cline's own usage API for the 5-hour / weekly / monthly windows |
| Request history | The upstream each proxied request actually hit, the backing model, duration, attempt path, and which account was used |
| Usage statistics | Daily trends (today by hour / 7 / 31 / 60 / 90 days) and a newest-first request list for tokens, cache hits, and spend — updating **live** as requests flow through. Proxied requests use the **real cost reported by the upstream**; a scan of Claude Code session files fills in requests that bypassed the proxy (deduplicated) — so **stats work even with the proxy off** |
| DeepSeek CNY pricing | DeepSeek models are also priced from **DeepSeek's official CNY list price**, including peak/off-peak (peak is exactly double). Shown **alongside** — never merged with — the USD upstream invoice, each with its own subtotal |
| Desktop integration | Tray resident, close-to-tray, launch at login, port/key editable in the window, one-click config export/import |
| CC Switch integration | A single `ccswitch://` deep link turns this proxy into a CC Switch provider, including its usage-query script |
| Dual protocol | The proxy serves both `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic), so Claude Code can connect directly without a third-party protocol converter |
| Write Claude Code config | One click to merge this proxy into `~/.claude/settings.json` (touches only its own keys, backs up first, restorable) |
| Bilingual UI | Auto-switches between Chinese and English based on the system language; can also be set manually in Settings |

To downstream clients it is two proxies at once:

- **OpenAI-compatible**: Base URL `http://127.0.0.1:<port>/v1`, uses `/v1/chat/completions`
- **Anthropic Messages**: point `ANTHROPIC_BASE_URL` at this port, uses `/v1/messages`. The upstream
  only speaks Chat, so the proxy translates the Anthropic side (request, response, and streaming SSE
  in both directions) — Claude Code connects directly, no cc-switch-style converter needed.

Both protocols support tool calling (`tool_use` / `tool_calls` mapped both ways) and streaming.
Use the model name as-is: `cline-pass/xxx`.

---

## Getting started

### Install (Windows)

Grab a build from the [Releases](https://github.com/lnsane/cline-pass-switcher-desktop/releases) page:

- `ClinePassSwitcher-Setup-<version>.exe` — installer (choose install dir, creates shortcuts)
- `ClinePassSwitcher-Portable-<version>.exe` — single-file portable

On first launch, go to **Accounts**, add your Cline Pass API key (starts with `sk_`), and save.
The proxy is then ready.

> These builds are **not code-signed**. With Smart App Control enabled, Windows blocks the
> installer (unsigned exe caught by the WDAC policy). Use the portable build, or see
> [Known limitations](#known-limitations).

### Run from source

```bash
npm install
npm run dev                      # launch the window in dev mode
node src/main/engine/engine.js   # run just the CLI engine (equivalent to the original server.js)
```

### Build locally

Building (not packaging) is much faster and is unaffected by code-signing restrictions:

```bat
scripts\build-win.bat              :: Windows: dist\win-unpacked\Cline Pass Switcher.exe
```

```bash
bash scripts/build-mac.sh          # macOS:   dist/mac*/Cline Pass Switcher.app
```

On Windows you can just **double-click** `scripts\build-win.bat`, or run it from cmd. Both
accept `--clean` (wipe `dist/` first) and `--run` (launch when done); the macOS script also
takes `--arm64` / `--x64`.

> **Windows users**: `build-win.sh` needs bash and will not run on Windows — use the `.bat`.
> Each script only builds for its own platform (Windows can't produce a mac bundle, and vice
> versa); push a tag to let CI build the other one.

> **A running instance is protected**: if you're currently using the app from
> `dist\win-unpacked\` (often the everyday copy, possibly holding your proxy port), the script
> **stops and tells you which PIDs** instead of deleting those files or killing the process for
> you. Quit that instance first, or use `--run` to have the script relaunch it afterwards.

To produce real installers locally:

```bash
npm run dist:win     # Windows: nsis installer + portable single file (x64)
npm run dist:mac     # macOS: dmg (x64 + arm64) — must run on macOS
npm run pack         # unpacked directory only (for debugging)
```

Downloading Electron and the packaging toolchain is slow from mainland China; use mirrors:

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist:win
```

> `dmg` can only be built on macOS (it needs `hdiutil`), and Windows packages only on Windows.

---

## Continuous integration & releases

Two GitHub Actions workflows are included.

**`.github/workflows/ci.yml`** — runs on every push to `main` and on pull requests:

1. Syntax-checks every source file, unit-tests the protocol translator and usage module, and boots
   the engine to confirm it answers
2. Builds an unpacked app on both `windows-latest` and `macos-latest`, uploaded as downloadable
   artifacts (kept 14 days)

Tests that hit the real upstream (`test:live`, `test:e2e`) are **not** in CI — they need a Cline
account key, which does not belong in a public repo's CI.

**`.github/workflows/release.yml`** — produces the real installers:

```bash
git tag v2.2.0
git push origin v2.2.0
```

That builds `Setup.exe` + `Portable.exe` on Windows and `x64`/`arm64` `dmg` on macOS, then publishes
them to a GitHub Release with download notes. You can also trigger it manually from the Actions tab
(useful for a dry run without publishing).

Bump the version in `package.json` before tagging — the artifact filenames carry it, which is how you
tell builds apart.

---

## Project layout

```
src/
  main/
    main.js                Electron main process: window, tray, lifecycle, IPC, hosts the engine
    claude-config.js       Merge/backup/restore logic for ~/.claude/settings.json (pure, testable)
    preload.cjs            Preload script (CJS: preload must be CommonJS under sandbox)
    engine/
      engine.js            Proxy core (the original server.js, tail rewritten to export start/stop)
      usage.js             Usage statistics: per-request ledger, daily rollups, pricing, session scan
      anthropic.js         Anthropic Messages <-> OpenAI Chat translation (requests, responses, SSE)
      public/index.html    Landing page served at the proxy port root
  renderer/                UI (no framework — plain DOM + classic <script> tags)
    index.html             Custom title bar, sidebar nav, view container, log drawer
    styles.css             Dark theme; data palette validated against this app's surface colors
    js/
      i18n.js              Language detection, translation table lookup, DOM translation
      locale-en.js         English strings (keys are the Chinese source text)
      locale-patterns.js   Regex patterns for runtime-built text ("Upstreams (4)", "3d 11h")
      util.js              DOM / formatting / toasts / modals / badges / meters
      ccswitch.js          Import to CC Switch: builds the ccswitch:// deep link and usage script
      claudeconfig.js      Write Claude Code config: preview/confirm/restore ~/.claude/settings.json
      api.js               HTTP client for the embedded engine's API
      app.js               Shell: bootstrap, routing, engine state, log drawer
      views/               overview / accounts / models / playground / usage / history / catalog / settings
resources/seed/            Initial learning results injected on first run
build/icon.png             App icon (generated by scripts/make-icon.mjs)
scripts/                   Build scripts, tests, CDP driver, upstream probes
.github/workflows/         CI (verify + build) and Release (installers)
```

### Main process vs. renderer

- The engine (HTTP proxy + `/api/*` control plane) runs in the **main process**, listening on
  `127.0.0.1`, default port `3123` (same as the CLI version).
- The renderer is a plain static page that talks to `http://127.0.0.1:<port>/api/*` over `fetch`.
- Two things must go through main-process IPC rather than renderer `fetch`:
  - **Quota API** (`quota:fetch`): calling Cline directly from the renderer hits CORS.
  - **Real proxy calls** (`proxy:chat`): the `X-Cline-*` response metadata is not readable from a
    renderer `fetch`.
- The window enables `contextIsolation` + `sandbox`; the renderer only gets the controlled `window.cp`
  surface and has no access to Node.

### Where data lives

The engine keeps its `DATA_DIR` convention; the main process sets it to Electron's user-data
directory **before** importing the engine:

| Platform | Path |
|---|---|
| Windows | `%APPDATA%\Cline Pass Switcher\` |
| macOS | `~/Library/Application Support/Cline Pass Switcher/` |
| Linux | `~/.config/Cline Pass Switcher/` |

Contents:

- `config.json` — port, account pool, downstream key (`proxyKey`), `publicBaseUrl`, per-model pinning.
  **Contains a plaintext key; do not share.**
- `metadata.json` — learning results: upstream lists and status, catalog cache, request history (last 100).
- `usage/` — the usage ledger, kept in its own directory (**deliberately not folded into metadata.json**; see below):
  - `usage.jsonl` — per-request detail, append-only, never rewritten
  - `usage_daily.json` — daily rollups by account × upstream × model (the trend chart reads this
    instead of scanning the full detail log)
  - `usage_sync.json` — incremental cursors for the session scan
  - `pricing.json` — your own per-model prices (optional; overrides the built-in table)
- `app-settings.json` — desktop behavior: launch at login, close-to-tray, window size, last view, UI language.

**Settings → Data** opens this directory, and can export/import the config.

---

## Import to CC Switch

[CC Switch](https://github.com/farion1231/cc-switch) is a provider switcher for Claude Code / Codex.
Both **Overview → Client setup** and **Settings → Data** have an **Import to CC Switch** button: pick
a model alias, confirm, and it opens CC Switch's own "confirm provider import" dialog for you to
review before importing.

### Why a deep link instead of writing its database

Since v3, CC Switch stores providers in SQLite (`~/.cc-switch/cc-switch.db`). A single "import" has to
do four things at once — insert the providers row, write the live config, switch the current provider,
and save the usage script — and its own `ProviderService` guarantees those stay consistent. Writing the
database from outside bypasses all of that and will eventually corrupt something. So this app only
generates a `ccswitch://v1/import` deep link and lets CC Switch do the persisting.

### What the deep link carries

| Field | Contents |
|---|---|
| `endpoint` / `homepage` | The local proxy address (default `http://127.0.0.1:3199/v1`); if a public proxy address is configured, that can be chosen instead |
| `model` and the three aliases | The same model written into `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`, so switching Opus / Sonnet / Haiku in Claude Code all use this upstream |
| `config.env` | `ANTHROPIC_DEFAULT_FABLE_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`, so Fable and subagents never leak back to the official Anthropic endpoint |
| `usageScript` | CC Switch's usage-script contract `({ request, extractor })`, using `{{apiKey}}` / `{{baseUrl}}` placeholders to read Cline's official 5-hour / weekly / monthly quota |

### Two easy mistakes

- **The usage script needs the Cline account key, not this proxy's key.** The quota API authenticates
  against the upstream account, so `usageApiKey` takes the `sk_` key of the first enabled account
  (Bearer auth is enough — no cookie needed).
- **CC Switch requires a non-empty API key, while this proxy has no auth by default.** In that case the
  placeholder `local-proxy-no-key` is used — the proxy does not check it, so it works. For a real key,
  generate one in **Settings → Access & security**.

> The deep link contains a plaintext key. Do not paste it into chat windows or anywhere else.

---

## Usage statistics

The **Usage** view shows requests, tokens, cache hit rate, and spend as daily trends plus per-request
detail. There are **two data sources**, merged and deduplicated by request id so nothing is counted twice:

| Source | Coverage | Tokens | Spend |
|---|---|---|---|
| **Proxy** | Requests through this proxy | `usage` from the upstream response | **The upstream gateway's real cost** (`provider_metadata.gateway.cost`) |
| **Session** | Requests imported by "Scan sessions" that bypassed the proxy | `usage` from Claude Code's session files | Estimated from the pricing table (marked "est.") |

### Why spend is split into "real" and "estimated"

When a request goes through the proxy, the upstream includes its own billed amount in the final chunk
of the response. That is **the most accurate number available**, so it is used directly. Session files
have no such field — only token counts — so those are estimated from a pricing table (220 entries built
in, sourced from models.dev) and explicitly labeled "est." in the UI. The two are accumulated
separately and **never blended**, so an estimate is never passed off as a real bill.

To price your own models, write `usage/pricing.json` or call `POST /api/usage/pricing` with
`{ "model-name": { "i": input, "o": output, "cr": cacheRead, "cc": cacheWrite } }` in USD per million
tokens. Custom entries override the built-in table.

### Statistics work without the proxy

**Scan sessions** reads Claude Code's session files (by default `~/.claude/projects/**/*.jsonl`; it also
honors `CLAUDE_CONFIG_DIR`) **incrementally**: it remembers each file's read offset and parses only new
bytes, so the second scan is far faster (measured on 103 files: 312 ms first, 5 ms after). If a file is
truncated or rewritten, it is rescanned from the start.

Deduplication is **required**, not an optimization: across 8,747 session records there were 308 duplicate
`message.id` values (Claude Code writes one line per content block for the same response). Without
dedup, the stats would be inflated by roughly 40%.

### Why the ledger lives in its own `usage/` directory

`metadata.json` holds "learning results", is rewritten in full on every request, and already caps history
at 100 entries. Folding per-request usage into it would put the learning data at risk of truncation and
inflate the per-request disk write to megabytes. So detail goes to an **append-only `usage.jsonl`** —
appends never rewrite, so a crash loses at most the last line. Daily rollups are small and stored
separately so the trend chart can read them quickly.

**Clean up old records** deletes per-request detail older than 90 days (rollups and totals are unaffected).

### Ranges and live updates

The trend chart has five ranges: **today** (bucketed by hour, 00–23), **7 / 31 / 60 / 90 days**. Today is
hourly because a single point can't show a trend. The request list is **newest first**.

New requests update the view **live**: the engine pushes each recorded request to the UI through an
internal callback over the existing main-process channel (no extra port), with a 30-second fallback poll
in case an event is dropped. Leaving the view stops both.

### DeepSeek CNY pricing

DeepSeek models are *also* priced from the **official CNY list price** (CNY per million tokens), on top of
the USD upstream invoice:

| Model | Cached input | Uncached input | Output |
|---|---|---|---|
| `deepseek-flash` (DeepSeek-V4.1-Flash) | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

Each cell is **off-peak / peak**. Peak is Mon–Fri 09:00–12:00 and 14:00–18:00 **Beijing time, excluding
Chinese public holidays**; everything else (weekends and holidays all day) is off-peak, and the off-peak
rate is **exactly half** the peak rate. Holidays follow the State Council's 2026 schedule
(`国办发明电〔2025〕7号`, 33 days including a 9-day Spring Festival).

Four things worth being explicit about:

- **The two currencies are never merged.** CNY comes from the official list price and is independent of
  which upstream served the request; USD is the gateway's real invoice. Adding them, or converting at
  some exchange rate, would produce a number carrying a hidden FX assumption — so they are shown side by
  side, each with its own subtotal.
- **Nothing is force-priced.** Only DeepSeek models have an official CNY price. `k3` / `glm` / `qwen` and
  the rest stay "no CNY price" rather than being given someone else's rate and passing for ¥0.
- **Cache writes are billed as uncached input** — the official table has no cache-write tier. This rounds
  *up*, so it can't understate the bill.
- **Make-up workdays count as weekends (off-peak).** The official wording names Mon–Fri as peak and
  weekends as off-peak all day, and the make-up days all fall on Saturdays/Sundays. That is a literal
  reading, recorded in the source comments so it can be audited.

Peak/off-peak is decided in **Beijing time regardless of the machine's timezone** (cross-checked in tests
under four timezones). Records written *before* this feature have no CNY field and show ¥0 — click
**Recalculate CNY** in the detail panel to price the whole history from the official table (idempotent;
amounts are re-derived, never accumulated).

> **Token accounting** uses the Anthropic convention throughout — `input` **excludes** cached tokens,
> which are reported separately. The upstream's OpenAI-style `prompt_tokens` includes them, so the proxy
> subtracts them first. Otherwise the more cache hits, the more inflated the context reading gets
> (measured: a single request with 530,000 cached tokens).

---

## Write Claude Code config

Both **Overview → Client setup** and **Settings → Data** have a **Write Claude Code config** button:
it merges this proxy's environment variables into `~/.claude/settings.json` so Claude Code connects
straight to the proxy with no middleman.

These 12 keys are written (`*_MODEL` and `*_MODEL_NAME` carry the same real model name, so switching
Haiku / Sonnet / Opus / Fable or spawning subagents never leaks back to the official Anthropic endpoint):

```
ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL and their _NAME
CLAUDE_CODE_SUBAGENT_MODEL
```

### Context window (200K / 1M)

Claude Code does not recognise these model names, so it assumes a **200K** context window and
auto-compacts early — even though the upstream channels are much larger (a probe of
`cline-pass/glm-5.3-flash` reports 1,048,576). The dialog has a **Context window** selector:

| Choice | What is written |
|---|---|
| 200K (default) | Nothing. `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is **removed** from the file if a previous run added it |
| 1M | `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` |

The hint line under the selector tells you what the model actually measures, and warns if you pick a
value **larger** than the probed size — the excess is rejected upstream. If there is no probe data yet
it says so rather than assuming 1M is available.

Switching back to 200K deletes the key instead of leaving the old value behind, so the dialog never
claims a setting took effect that did not.

**Why the env var and not a `[1m]` model suffix.** Claude Code supports both, but they differ in an
important way: the `[1m]` suffix is read as a literal string, so it would be sent on the wire in the
`model` field where an upstream may not accept it, and it hard-codes exactly 1M. The env var is
honoured precisely for model IDs Claude Code does **not** recognize — which is exactly what
`cline-pass/*` is — and it can state any real window size (some channels here report 1,310,720). This
tool is a proxy front-end, so the value that reaches the upstream stays a clean model ID.

Note this value tells Claude Code what to *assume* for auto-compaction; it does not make the upstream
serve more than it actually can. That is why the dialog checks it against probe data.

### What it does to your config

| Behavior | Detail |
|---|---|
| Touches only its own keys | Other top-level keys (permissions, hooks…) and unrelated env vars are preserved verbatim — no wholesale overwrite |
| Deletes only its own keys | The only deletion ever performed is `CLAUDE_CODE_MAX_CONTEXT_TOKENS` when you pick the default; any other key name passed in for removal is ignored |
| Always backs up first | To `settings.json.bak-<timestamp>`; the dialog has a **Restore from backup** button |
| Refuses invalid JSON | If the existing file is not valid JSON it **gives up** rather than guessing at a fix; the original file is left byte-for-byte untouched |
| Atomic write | Writes a temp file and renames, so a half-written config never appears |
| Idempotent restore | Clicking Restore repeatedly always lands on the pre-write state (the safety backup taken before restoring is stored as `.pre-restore-`, so it is never mistaken for a restore target) |

### One more thing worth knowing

- **Restart Claude Code** (or start a new session) for the change to take effect.

---

## Interface language

The UI follows the system language by default: a Chinese system gets Chinese, everything else gets
English. You can override it in **Settings → Desktop app → Interface language** (`Follow system` /
`中文` / `English`); the choice is remembered.

Switching languages reloads the renderer. Translation happens by walking the DOM after rendering, so
there is no per-string plumbing in the view code — and because user data (account names, model IDs,
URLs) is not in the translation table, it is left untouched rather than mistranslated.

The interface language does **not** affect the language models reply in.

---

## The one change to the core

`src/main/engine/engine.js` is a verbatim copy of the original `server.js` with only the **end of the
file** replaced: the original `http.createServer(...)` / `server.listen(...)` block became a set of
exported functions plus a "only auto-start when run directly" check.

```js
export { start, stop, config, META, USAGE, saveConfig, saveMeta, isConfigured, publicProxyBase,
         enabledAccounts, probeModel, validateUpstreams, fetchOfficialModels, learnUpstreamStatus };

const isDirectRun = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isDirectRun) start().then(...).catch(...);
```

`start({ host, port })` returns `Promise<{ host, port }>` (rejects on `EADDRINUSE`, which the UI uses to
prompt for another port), and `stop()` calls `closeAllConnections()` before `close()` so restarting does
not hang on long-lived connections. The ~900 lines of upstream detection / pinning / fallback logic in
between are **untouched** — that is the most valuable part of this project.

---

## Testing

Protocol translation (Anthropic ↔ OpenAI Chat) and usage statistics both have layered tests, each runnable alone:

| Command | What it covers | Needs upstream? |
|---|---|---|
| `npm run test:unit` | `anthropic.js`: request/response/streaming state machine (chunk-boundary buffering, event ordering, tool-argument fragments) | No |
| `npm run test:live` | Real upstream: non-streaming, streaming, tool calls, tool results fed back, count_tokens, path variants, plus `/v1/chat/completions` regression | Yes |
| `npm run test:auth` | Auth: `x-api-key` (what Claude Code uses) and `Authorization: Bearer`, plus console-endpoint auth | No (only count_tokens hits upstream) |
| `npm run test:claudecfg` | Merging, backup, restore, and invalid-JSON refusal for `~/.claude/settings.json` (entirely in a temp dir; never touches your real config) | No |
| `npm run test:usage` | Usage core: token accounting, pricing lookup and estimation, daily rollups, dedup, detail pruning, incremental session scan | No |
| `npm run test:usage-live` | Usage end-to-end: boots an isolated instance against the real upstream, verifies tokens/cache/cost are recorded, cross-source dedup, pricing overrides | Yes |
| `npm run test:e2e` | The **real Claude Code client** pointed at this proxy: one conversation plus one tool call | Yes |
| `npm run test:usage-e2e` | Same, plus: with the proxy stopped, session scanning still recovers the usage | Yes |

The later ones take environment variables for their target and default to a test instance on port 3251:

```bash
# Start an isolated instance on another port (with its own config copy — does not disturb a running one)
DATA_DIR=/tmp/eng-test node src/main/engine/engine.js

BASE=http://127.0.0.1:3251 PROXY_KEY=<proxy key> npm run test:live
BASE=http://127.0.0.1:3251 KEY=<proxy key> npm run test:e2e
```

`npm run probe` is an upstream health probe: it asks Cline directly whether a given model is available right now.

> Note: sending a request body containing Chinese text with `curl` from Git Bash encodes it as GBK and the
> upstream receives mojibake. Test scripts use Node's `fetch` (UTF-8) for this reason — avoid `curl` with
> non-ASCII bodies.

---

## Known limitations

- **Port conflict with the CLI version**: both default to `3123`. Running both at once means whichever
  starts second reports "port already in use". Change the port in Settings (the desktop app's own config
  uses `3199` by default in this repo's author's setup). The engine **never kills** whatever holds a port —
  it logs `EADDRINUSE` and asks you to pick another.
- **Unsigned builds and Smart App Control**: the installers are not code-signed. With Smart App Control
  enabled (Windows 11), Windows blocks them (`VerifiedAndReputablePolicyState = 1` in
  `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`; events land in
  `Microsoft-Windows-CodeIntegrity/Operational` as ID 3118). The **unpacked build and the portable
  executable are unaffected** — this is an environment restriction, not a defect. Options: use the
  portable build, run the unpacked output of `scripts/build-win.bat`, or turn Smart App Control off
  (irreversible without reinstalling Windows).
- **macOS Gatekeeper**: unsigned `.app`/`.dmg` are blocked on first open. Right-click → Open, or run
  `xattr -cr "/Applications/Cline Pass Switcher.app"`.
- **`dmg` must be built on macOS**, and Windows packages on Windows.

---

## License

MIT
