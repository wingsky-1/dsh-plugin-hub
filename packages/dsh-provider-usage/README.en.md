# @wingsky-1/dsh-provider-usage
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-provider-usage)](https://www.npmjs.com/package/@wingsky-1/dsh-provider-usage)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

DSH (DeepSeek Harness) Web GUI plugin: **usage statistics float widget** (v2 contract rewrite).

A persistent capsule at the top-right of the chat view shows usage for the current model
provider; click it to open a detail panel. Rendering happens on the **host side** — user
adapters return HTML, the client only injects it.

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
                     ├→ getStats()             60s polling /stats
Client polling ──────┘   │ Mutex                  ↓
                         │ 60s cache           Capsule frame ← capsuleHtml
                         │ 2s fetch timeout     Panel frame ← panelHtml (/history)
                         ↓
                   adapter.fetchData(ctx)   ← user .mjs (apiEndpoint/staticPath/apiKey injected)
                         ↓
                   daily-sharded JSONL history
                         ↓
                   adapter.formatCapsule/Panel() → sanitize → HTML
```

The built-in adapter `opencode-go-builtin` (OpenCode Go official `/v1/usage`, three
windows) works out of the box.

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
| `cacheDurationMs` | `60000` | Cache freshness (ms) |
| `fetchTimeoutMs` | `2000` | Forced fetchData timeout (500–30000ms) |
| `autoReload` | `true` | Hot reload on adapter file edits (enabled by default; set `false` to disable) |

## Capsule placement

The usage capsule (floating pill in the conversation corner) and its panel can be repositioned:
Settings → Plugins → "用量统计" → "胶囊位置" — pick an anchor (top-right / top-left / bottom-right /
bottom-left) and offsets (horizontal / vertical / panel gap), then hit Save. It takes effect
**immediately across all devices** (persisted to `ui.json` and broadcast over SSE; no restart).
Defaults: top-right / 0 / 48 / 10 — the capsule uses **fixed positioning** and never shifts with the
scrolling conversation (no avoidance-related jitter; it stays put while scrolling); the horizontal 0
keeps the capsule's right edge flush with the container's right edge (right-aligned); the vertical 48
places the capsule just below the MCP-manager float (also top-right, 8px from the top) by default,
so the two floats never overlap out of the box. The capsule and the MCP float do not probe or
dodge each other — each is positioned solely by its own plugin config; the 10px panel gap keeps the
panel tight under the capsule.

## API key resolution order (V1 config chain)

1. Plugin config `apiKey` (explicit)
2. Environment variable `{PROVIDER}_API_KEY` (uppercase, hyphens → underscores)
3. opencode-go legacy env var `OPENCODE_GO_API_KEY`
4. `{PROVIDER}_API_KEY` in `<DSH_HOME>/.credentials.yaml`
   (opencode-go also probes the legacy name `OPENCODE_GO_API_KEY`)
5. opencode-go compatibility: `~/.local/share/opencode/auth.json` entry
   `opencode-go` (or `opencode`)

## Routes (all loopback-fenced)

| Route | Description |
| --- | --- |
| `GET /api/dsh-provider-usage/stats?provider=X` | Usage stats + `capsuleHtml` + `status`/`adapterVersion` |
| `GET /api/dsh-provider-usage/history?provider=X&days=N` | History query + `panelHtml` + query `range` |
| `GET /api/dsh-provider-usage/health` | Health check + adapter snapshot + error log |
| `GET /api/dsh-provider-usage/adapters.json` | Adapter candidate metadata (same source as the settings page list, incl. `modelProviders`) |
| `POST /api/dsh-provider-usage/adapters/select` | Switch / clear the enabled adapter |
| `POST /api/dsh-provider-usage/adapters/inspect` | Preview an adapter file (echo exports, no registration) |
| `POST /api/dsh-provider-usage/adapters/add` | Register a user adapter file (settings page flow) |

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
- **Two-layer XSS defense**: external API strings must be escaped with `esc()` before
  being placed into HTML (documented obligation); the plugin additionally sanitizes all
  format output on the host (script/iframe/on* attributes/javascript: removal). The
  sanitizer also closes HTML entity-encoded variants — named / decimal / hex, with or
  without trailing semicolons are decoded before matching; sanitization only removes:
  the decoded view is used solely for locating matches and never written back, so
  legitimately escaped text passes through untouched
- **Hot reload is off by default**; when enabled it polls mtime+size, atomically swaps in
  the new version only after validation passes, and keeps the old version on failure
- **Timeout discipline**: fetchData gets a forced 2s timeout + AbortSignal; when the lock
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
