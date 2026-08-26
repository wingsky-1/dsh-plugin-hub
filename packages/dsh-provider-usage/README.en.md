# @wingsky-1/dsh-provider-usage
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-provider-usage)](https://www.npmjs.com/package/@wingsky-1/dsh-provider-usage)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH (DeepSeek Harness) Web GUI plugin: a **generic multi-provider usage statistics
framework** (v2 adapter contract).

A persistent capsule at the top-right of the chat view shows usage for the current model
provider; click it to open a detail panel. Two adapters work out of the box —
**DeepSeek official** (balance + peak/valley countdown badge + daily usage estimation)
and **OpenCode Go** (official `/v1/usage`, three windows); any other data source can be
plugged in by writing one mjs adapter file against the v2 contract (detect/add/toggle on
the settings page, see "Adapter development guide"). Rendering happens on the **host
side** — adapters return HTML, the client only injects it, and API keys never reach
the browser.

## Core advantages

- **Generic framework, works out of the box**: one v2 adapter contract carries any
  provider; DeepSeek official and OpenCode Go adapters are built in — usage shows up
  right after install
- **Any data source takes one mjs file**: three exports (`fetchData` / `formatCapsule` /
  `formatPanel`) complete an integration; detect/add/toggle hot-swappable from the
  settings page, file edits auto hot-reload
- **Daily usage even without a usage API**: the built-in DeepSeek adapter estimates
  daily usage via a balance-difference conservation formula (top-up/grant disturbances
  cancel out, abnormal windows excluded), plus a peak/valley countdown badge and a
  15-day usage bar panel
- **Keys never leave the host**: fetching runs host-side with keys kept and used only
  on the host, never sent to the browser (credential-chain / env injection recommended;
  an explicit `apiKey` config persists in host config files, 0600-protected); rendered
  output goes through double sanitization (`esc()` escaping duty + structured
  sanitization fallback) for a two-layer XSS defense
- **Recoverable history, cache-backed performance**: daily-sharded JSONL persistence
  (0600) with age/size auto-cleanup; in-process panel render cache + stats cache +
  background warmup — repeated requests with unchanged data cost zero recompute

> 中文文档：[README.md](README.md)（authoritative）。架构图解（flow / sequence charts）：
> [docs/architecture.md](docs/architecture.md)；适配器开发引导：[docs/adapter-guide.md](docs/adapter-guide.md)。

## Install

Prerequisite: DeepSeek Harness installed and `dsh web` runnable (if `dsh` is not globally
installed, see below).

### Add

```sh
dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

### Remove

```sh
dsh plugin --profile web remove @wingsky-1/dsh-provider-usage
```

### Update

```sh
dsh plugin --profile web update @wingsky-1/dsh-provider-usage
```

> Restart `dsh web` once after add / remove / update (bundles are composed at startup only).

### Without a global dsh install

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

## How it works (v2)

```
Host (Node)                                    Client (browser)
─────────────────────────────                 ─────────────────────
Warmup timer (5min) ─┐
                     ├→ getStats()             60s polling /stats (re-checks the
Client polling ──────┘   │ Mutex                  session provider before each fetch, #71)
                         │ 60s cache           Capsule frame ← capsuleHtml
                         │ 5s fetch timeout     Panel frame ← panelHtml (/history, 90s fallback cache)
                         ↓
                   adapter.fetchData(ctx)   ← user .mjs (apiEndpoint/staticPath/apiKey injected)
                         ↓
                   daily-sharded JSONL history ──→ panel render cache cleared (primary invalidation)
                         ↓
                   adapter.formatCapsule/Panel() → sanitize → HTML
```

The built-in adapters `opencode-go-builtin` (OpenCode Go official `/v1/usage`, three
windows) and `deepseek-official-builtin` (DeepSeek official balance + peak/valley
countdown badge, see below) work out of the box.

> Provider-follow semantics: switching sessions refreshes immediately; in-session
> model/provider switches have no host push signal, so every fetch re-validates the
> provider first — follow within at most one polling cycle (#71).

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Plugin switch |
| `adapter` | none | User adapter mjs path (built-in opencode-go by default) |
| `provider` | `opencode-go` | Model provider name to associate |
| `staticPath` | none | API path (injected into fetchData, appended to apiEndpoint) |
| `apiEndpoint` | none | API base URL (optional; explicit config wins over credential chain) |
| `apiKey` | none | Explicit key (optional; falls back to the credential chain, never echoed in settings) |
| `historyDir` | `<DSH_HOME>/dsh-provider-usage/` | History storage root |
| `warmupIntervalMs` | `300000` | Background warmup interval |
| `cacheDurationMs` | `30000` | Cache freshness (ms, floor 5000; lowered from 60000 in #198 so peak/valley badge flips propagate end-to-end within ~95s = 30s host cache + 60s client polling + render margin) |
| `fetchTimeoutMs` | `5000` | Forced fetchData timeout (**fixed, not configurable**; raised 2s→5s in #208, user values ignored) |
| `autoReload` | `true` | Hot reload on adapter file edits (enabled by default; set `false` to disable) |

## Capsule placement

The usage capsule (floating pill in the conversation corner) and its panel can be repositioned:
Settings → Plugins → "用量统计" → "胶囊位置" — pick an anchor (top-right / top-left / bottom-right /
bottom-left), offsets (horizontal / vertical / panel gap) and a z-index base, then hit Save. It takes
effect **immediately across all devices** (persisted to `ui.json` and broadcast over SSE; no restart).
Defaults: top-right / 0 / 48 / 10 / 40 — the capsule uses **fixed positioning** and never shifts with the
scrolling conversation (no avoidance-related jitter; it stays put while scrolling); the horizontal 0
keeps the capsule's right edge flush with the container's right edge (right-aligned); the vertical 48
places the capsule just below the MCP-manager float (also top-right, 8px from the top) by default,
so the two floats never overlap out of the box. The capsule and the MCP float do not probe or
dodge each other — each is positioned solely by its own plugin config; the 10px panel gap keeps the
panel tight under the capsule. The z-index base (default 40, matching the CSS default
`z-index: 40`; the panel derives base + 30) is clamped to 1-9000.

**Mobile / tablet adaptation** (issue #128): the breakpoint is decided from the conversation
container's viewport width rather than a window media query — on narrow screens (<=480px,
portrait phones / very narrow splits) the panel goes near full-width, cards reflow, and buttons
get touch targets of about 44px; the tablet tier (<=834px) transitions; desktop is unchanged.
Final capsule coordinates are clamped to the viewport in JS (safe-area semantics: the host has
no `viewport-fit=cover`, so `env(safe-area-inset-*)` is always 0 and this degrades naturally to
a plain clamp); the on-screen keyboard is followed via `visualViewport` resize, and orientation
changes recompute on the next frame.

**Cross-package avoidance contract (from issue #116, must not be reverted)**: this plugin's
default `offsetY: 48` relies on the dsh-mcp-manager float's default position (`top-right`,
8px from the top, ~26px tall) to sit right below it. Changing that default requires evaluating
the MCP manager's default anchor / offsets in lockstep; reverting either side is a cross-package
behavioral contract change.

## Built-in DeepSeek official adapter (deepseek-official-builtin)

Claims provider `deepseek-official` and talks to the DeepSeek official
"get user balance" endpoint `GET https://api.deepseek.com/user/balance`
(see [api-docs.deepseek.com/api/get-user-balance](https://api-docs.deepseek.com/api/get-user-balance)).

### Data semantics

- **CNY only**: when the official `balance_infos[]` array contains multiple currencies,
  only the `currency === "CNY"` entry is used; everything else (e.g. USD) is ignored.
  Amounts are strictly parsed from the official string fields (invalid/missing → `null`,
  NaN never persisted).
- No CNY entry (USD-only or empty array) yields a normal frame with
  `balance/toppedUp/grantedBalance = null` (no throw); the capsule shows a
  "DeepSeek 余额 --" placeholder.
- `is_available=false` marks an unavailable account: the frame is still recorded and its
  balance displayed, but it **never serves as a conservation endpoint** for daily usage —
  adjacent intervals skip usage derivation and are labeled as unavailable in the panel,
  so bans/balance wipes are not mistaken for consumption.

### Daily usage derivation (balance-delta conservation)

The official API has no usage endpoint, so daily usage is derived from balance deltas
between consecutive samples:

```
usage = (totalPrev − totalCur) + ΔtoppedUp + Δgranted
```

Top-ups (+X credited: total −X, toppedUp +X) and grant expiries/refunds (−G debited:
total −G, granted −G) cancel out automatically. Missing components degrade
**component-by-component**: without granted, only the toppedUp correction applies
(and vice versa); with both missing it degrades to the raw balance delta (legacy history
shards), and the panel summary notes that some days use the net-change caliber.
Intervals spanning more than 27h (sampling interruption) are excluded from bars and
totals to prevent malformed giant columns.

### Two-card panel and peak/valley badge

- Card 1: CNY balance headline + 24h fluctuation line chart (unified time anchor,
  trend arrow tolerance ±0.005, downsampling ≤300 points).
- Card 2: daily usage bar chart over the last 15 calendar days (closed-loop baseline;
  blue bars up for consumption, green bars down for net gains, anomalies labeled only).
- The capsule always carries a **peak/valley countdown badge** (pure local-time
  computation, independent of remote data — rendered even on fetch failures):
  - Windows are **fixed UTC weekday windows** `01:00–04:00 / 06:00–10:00`
    (half-open intervals), per
    [api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing),
    verified on **2026-08-26**; hard-coded constants with no config knob, weekends are
    off-peak all day.
  - Off-peak shows the countdown to the next peak start (e.g. `⚡谷 · 距峰 02:41`);
    peak shows the countdown to the next valley switch; the tooltip documents the UTC
    window definition plus a server-timezone hint.

## API key resolution order (V1 config chain)

1. Plugin config `apiKey` (explicit)
2. Environment variable `{PROVIDER}_API_KEY` (uppercase, hyphens → underscores)
3. opencode-go legacy env var `OPENCODE_GO_API_KEY`
4. `{PROVIDER}_API_KEY` in `<DSH_HOME>/.credentials.yaml`
   (opencode-go also probes the legacy name `OPENCODE_GO_API_KEY`)
5. opencode-go compatibility: `~/.local/share/opencode/auth.json` entry
   `opencode-go` (or `opencode`)

> **DeepSeek official adapter three-level key chain**: plugin config `apiKey` injection →
> credential-chain derived env (provider `deepseek-official` → `DEEPSEEK_OFFICIAL_API_KEY`)
> → adapter-local `DEEPSEEK_API_KEY` self-check fallback (shared with the llm layer,
> covering "llm works but balance API 401"; this fallback is an adapter implementation
> detail, not a shared provider-config special case). With all three absent, fetching
> reports `no-api-key` and degrades to a stale frame (the peak/valley badge still renders).

## Routes (all loopback-fenced)

| Route | Description |
| --- | --- |
| `GET /api/dsh-provider-usage/stats?provider=X` | Usage stats + `capsuleHtml` + `status`/`adapterVersion` |
| `GET /api/dsh-provider-usage/history?provider=X&days=N` | History query + `panelHtml` + query `range` (in-process render cache, see below) |
| `GET /api/dsh-provider-usage/health` | Health check + adapter snapshot + error log |
| `GET /api/dsh-provider-usage/adapters.json` | Adapter candidate metadata (same source as the settings page list, incl. `modelProviders`) |
| `POST /api/dsh-provider-usage/adapters/select` | Switch / clear the enabled adapter |
| `POST /api/dsh-provider-usage/adapters/inspect` | Preview an adapter file (echo exports, no registration) |
| `POST /api/dsh-provider-usage/adapters/add` | Register a user adapter file (settings page flow) |

## /history render cache

`panelHtml` served by `/history` is cached in the host process (issue #105, sub-item 1);
repeated requests skip recomputation while data is unchanged:

- **Hit condition**: within the same process, `(provider, enabled adapter, normalized query
  window)` all unchanged. The window is normalized at **calendar-day granularity** — the
  per-request drift of `end=Date.now()` never enters the cache key; repeated requests within
  the same calendar day hit the same entry. Different `days` values normalize to different
  entries and never cross-contaminate. Hits replay a snapshot of the return-value string
  layer (`{panelHtml, error, at}`) only — entries are never cached; the response `range`
  still echoes the request's real start/end.
- **Invalidation (four points)**: primary = full clear on **successful history append**
  (new data landed, all panel entries dropped at once); plus three sync hooks —
  **select** (switch/clear enabled adapter), **add** (register new adapter), and
  **hot reload** (adapter file changed and reloaded).
- **Fallback TTL**: compile-time constant `90000`ms (90s, mid-point of the bounded
  [60s, 120s] range), not a config key; it is only a fallback, not the primary mechanism.
  In production the hit ratio is gated by warmup period (5min) × stats cache TTL (60s):
  client polls between two appends all hit.
- **Not cached**: pipeline errors and no-adapter / no-enabled-adapter structured responses
  are never cached — once the condition clears, the next request recomputes immediately and
  may succeed instead of replaying a stale error or placeholder.
- **No conditional-request negotiation**: no ETag / Last-Modified headers, no 304 short-circuit;
  clients keep `cache: "no-store"` — this cache is purely server-side with zero client changes.

## Adapter development guide (v2 contract)

Any data source plugs in with one mjs file (full example:
`examples/usage-adapter.example.mjs`; agent-oriented walkthrough:
[docs/adapter-guide.md](docs/adapter-guide.md)):

```js
// my-stats.mjs
export const version = 2;                    // required: contract version (fixed 2)
export const name = "my-stats";              // required: unique name (^[A-Za-z0-9_-]{2,64}$)
export const label = "My Stats";             // optional: display name
export const providers = ["my-relay"];       // required: claimed providers
export const retention = { maxAgeDays: 30 }; // optional: retention policy

/** Required: fetch raw data (runs on the host; args injected by the plugin) */
export async function fetchData({ apiEndpoint, staticPath, apiKey, signal, timeoutMs }) {
  const res = await fetch(apiEndpoint + staticPath, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!res.ok) throw new Error(`http-${res.status}`);
  return res.json(); // return only the minimal dataset needed for display
}

/** Required: capsule content (host side, returns an HTML string) */
export function formatCapsule({ data, status, esc }) {
  return `<span style="font-weight:600">${esc(data.visits ?? 0)} visits</span>`;
}

/** Required: panel content (host side, returns an HTML string) */
export function formatPanel({ entries, range, truncated, esc }) {
  const rows = entries.slice(-60).map((e) =>
    `<tr><td>${esc(new Date(e.time).toLocaleString())}</td><td>${esc(e.data.visits)}</td></tr>`).join("");
  return `<table>${rows}</table>`;
}
```

**Wiring** — recommended via the settings page (no config-file editing, no restart):

1. Open dsh Settings → Plugins → "Usage Stats"
2. Under the target provider click "+ Add adapter", enter the mjs file path
   (`~` expansion / absolute paths supported)
3. Click "Inspect" to echo the exports → confirm add (auto-persisted and hot-registered
   as the provider's enabled adapter)
4. Toggle candidates on/off; changes take effect immediately and persist

Alternatively declare in cordis.patch.yml (optional overlay, loaded at startup):

```yml
plugins:
  '@wingsky-1/dsh-provider-usage':
    adapter: ~/dsh/my-stats.mjs
    provider: my-relay
    staticPath: /api/usage
    # autoReload is enabled by default; to disable (security/stability concerns):
    # autoReload: false
```

Load failures are rejected fail-fast and logged (visible in the settings panel) without
affecting other plugin features. Path safety: relative paths must land inside `DSH_HOME`
or the plugin home; non-normalized forms (`../` traversal) are rejected with 400.

## Security model

- **Adapter code = full Node permissions on the host** (network/fs/env), equivalent to
  writing your own in-process plugin; only load local files you trust — the plugin never
  pulls code from the network for execution
- **Keys never reach the browser**: apiKey lives only in host-process memory and is
  injected into fetchData as an argument; adapter files never contain key values
  (equally true for the built-in DeepSeek official adapter: three-level key chain above,
  no key substring in stats/history/adapters responses nor in capsule/panel HTML)
- **Two-layer XSS defense**: external API strings must be escaped with `esc()` before
  being placed into HTML (documented obligation); the plugin additionally sanitizes all
  format output on the host (script/iframe/on* attributes/javascript: removal). The
  sanitizer also closes HTML entity-encoded variants — named / decimal / hex, with or
  without trailing semicolons are decoded before matching, and protocol-like payloads
  are located after stripping tab/LF/CR per WHATWG URL semantics (the jav&#9;ascript:
  family included); sanitization only removes and iterates under a generous iteration
  bound with fail-closed empty output beyond it (bounding worst-case CPU cost) — the
  decoded view is used solely for locating matches and never written back, so
  legitimately escaped text passes through untouched
- **Hot reload is on by default** (`autoReload`, can be disabled explicitly); when
  enabled it polls mtime+size, atomically swaps in
  the new version only after validation passes, and keeps the old version on failure
- **Timeout discipline**: fetchData gets a forced 5s timeout (fixed, not configurable) + AbortSignal; when the lock
  is busy requests degrade to cache instead of queueing — page requests are never blocked
- **Fail-fast loading**: missing exports / wrong types / invalid names are rejected with
  diagnosable errors
- **History**: daily-sharded JSONL (`0600` permissions) with automatic age/size pruning;
  raw data is serialization-checked before persistence
- All routes loopback-fenced (403 non-loopback / 405 wrong method); minimal information
  disclosure on admin endpoints (user files shown as basename only); request rate is
  bounded (polling ≤1/60s + warmup ≤1/5min + 60s TTL cache)

## Verify

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-provider-usage/health

# Source lives in src/, rebuild after changes
pnpm --filter @wingsky-1/dsh-provider-usage build
node test/smoke.ts
```

## License

MIT
