# @wingsky-1/dsh-provider-usage
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-provider-usage)](https://www.npmjs.com/package/@wingsky-1/dsh-provider-usage)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

A DSH (DeepSeek Harness) Web GUI plugin: **OpenCode Go plan-usage floating pill + three-window mini charts**.

A persistent floating capsule sits at the top-right of the chat interface, showing the real-time
consumption percentage of the three OpenCode Go plan windows (color shifts with usage level:
\>80% yellow, \>95% red). Click to expand a detail panel:

- Three mini-chart cards (rolling 5-hour / weekly / monthly), each window with independently
  adaptive y-axis and x-axis time ticks, a 100% quota reference dashed line, and a reset marker
  line (derived back from `resetsAt`)
- Background sampling keeps history continuous (continues even when the browser is closed); data
  comes from the official `/v1/usage` interface (authoritative data, zero local computation)

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-provider-usage
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-provider-usage
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-provider-usage@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-provider-usage
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-provider-usage
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-provider-usage
```

## Data Source

> **Note**: this English README still describes pre-v2 behavior and lags behind the
> current implementation. The Chinese [README.md](README.md) is authoritative; for
> architecture diagrams (flow / sequence charts) see [architecture.md](docs/architecture.md).

The plugin calls the official OpenCode Go usage interface directly:

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

The response is cached with a 30-second TTL (configurable) to avoid high-frequency requests.

## API Key Resolution Order

1. Plugin config `config.apiKey` (explicit, optional)
2. Environment variable `OPENCODE_GO_API_KEY`
3. DSH credentials file `<DSH_HOME>/.credentials.yaml` (DSH_HOME takes priority, default `~/.dsh`)
   with `OPENCODE_GO_API_KEY`
4. OpenCode's own `~/.local/share/opencode/auth.json` entry `opencode-go`
   (falling back to `opencode`)

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Plugin on/off switch |
| `baseUrl` | `https://opencode.ai/zen/go/v1/usage` | Built-in opencode-go usage interface address (**configurable, i.e. the token-forwarding target**) |
| `timeoutMs` | `15000` | Request timeout (ms) |
| `cacheTtlMs` | `30000` | Usage cache TTL (ms) |
| `limits` | `{rolling:12, weekly:30, monthly:60}` | Display limits (USD/window) |
| `apiKey` | none | Explicit API Key (falls back to the credential resolution chain when absent) |
| `maxAgeDays` | `30` | History sampling retention days (1–365) |
| `sampleIntervalMs` | `300000` | Host background sampling interval (30s–1h; iterates all enabled adapters) |
| `persistFile` | none (default history root `<DSH_HOME>/dsh-provider-usage/`, multi-file buckets under its `history/` subdirectory) | History root override (its directory becomes the history root) |
| `adapters.host[]` | none | Custom host fetch-adapter candidates (`provider`/`file`/`enabled`, see below) |
| `adapters.client[]` | none | Custom client renderer files (`file`) |

### Adapter candidates and enabling

One provider may have multiple adapter candidates (built-in + user-injected); **only one is
enabled at any moment**:

- The built-in `opencode-go-builtin` is enabled by default;
- User adapters explicitly listed in the config are enabled by default (becoming the
  provider's current enabled adapter); `enabled: false` disables a candidate explicitly;
- Runtime switching: the settings panel (M3b) or `POST /api/dsh-provider-usage/adapters/select`
  (body `{ provider, adapterId }`); that provider's cache is invalidated immediately;
- When the current session's provider has no enabled adapter, the float widget hides and
  reappears automatically once an adapter is enabled.

## Routes (all loopback-fenced)

| Route | Description |
| --- | --- |
| `GET /api/dsh-provider-usage/stats[?provider=X]` | Usage statistics + embedded `summary` subtree (pill lightweight content) + `adapterId`/`hasAdapter` |
| `GET /api/dsh-provider-usage/history[?provider=&adapterId=&days=N]` | History sampling series (with `columns` declaration) |
| `GET /api/dsh-provider-usage/adapters.json` | Adapter candidate metadata (id/label/providers/source/file/enabled) |
| `POST /api/dsh-provider-usage/adapters/select` | Switch the enabled adapter (body `{provider, adapterId}`) |
| `GET /api/dsh-provider-usage/user/<n>.js` | User client renderer static serving |
| `GET /api/dsh-provider-usage/health` | Health check + adapter snapshot |

## Provider Adapter Development Guide

Adapting a custom relay takes two files (full example in
`docs/opt/usage-provider-adapter/examples/my-relay/`):

**1. Host fetch adapter `.mjs`** (default-exported contract object):

```js
export default {
  version: 1,
  id: "my-relay",            // unique adapter id (shown in the settings candidates list)
  label: "My Relay",
  providers: ["my-relay"],   // claimed provider names
  async fetchUsage(ctx) {    // required: fetch and normalize
    const res = await ctx.fetch("https://relay.example.com/v1/usage");
    const body = await res.json();
    return { ok: true, provider: "my-relay", label: "My Relay",
             fetchedAt: Date.now(), data: body };   // data format is yours
  },
  // optional summarize(ctx): custom pill text (derive from ctx.usage only, no network)
  // optional samplePoint(usage): declare history sample columns { cols, values }
};
```

Factory shortcut (auto-derives summarize/samplePoint):

```js
import { defineUsageAdapter } from "@wingsky-1/dsh-provider-usage";
export default defineUsageAdapter({
  id: "my-relay", label: "My Relay", providers: ["my-relay"],
  windows: [{ key: "credit", name: "Credit", limit: 100 }],
  async fetchUsage(ctx) { /* ...return data containing windows */ },
});
```

**2. Client renderer `.js`** (self-registers via the global bridge):

```js
window.__DSH_USAGE__?.registerRenderer({
  version: 1,
  providers: ["my-relay"],
  adapterId: "my-relay",     // optional: bind to an adapter; default renderer otherwise
  pill(summary) { return null; },  // optional: custom pill text
  render(ctx) {              // required: draw into ctx.mount; return cleanup (optional)
    const div = document.createElement("div");
    div.textContent = JSON.stringify(ctx.data?.data ?? {});
    ctx.mount.appendChild(div);
  },
});
```

**Wiring** (cordis.patch.yml / user patch layer):

```yml
plugins:
  ui-dsh-provider-usage:
    adapters:
      host:
        - provider: my-relay
          file: ~/.dsh/my-relay-host.mjs
      client:
        - file: ~/.dsh/my-relay-client.js
```

Paths support `~` expansion / absolute paths / DSH_HOME-relative. Load failures only warn
and skip that candidate without blocking the rest of the plugin.

## Security Model

- **Token is never written to disk, never logged, never sent to the browser side**: the API Key
  lives only in host-process memory; the browser only fetches display fields via `/stats`
- **`baseUrl` is configurable = your token is sent to that address**: only configure a trusted
  usage interface; default is the official `https://opencode.ai/zen/go/v1/usage`
- **stripSecrets guard (on by default; disable with `stripSecrets: false`)**: two-layer
  redaction over normalized returns (including summary text fields) — keys matching
  `secret/token/key/apikey` with string values (≥8 chars) are replaced with `<redacted>`;
  values matching secret-like patterns (`Bearer xxx` / `sk-xxx` / `api_key=xxx` / long hex)
  are redacted wholesale. Best-effort — **no absolute isolation is promised**
- **User host js runs with full Node permissions** (network/files/env), equivalent to writing
  your own plugin process; only load local files you trust — the plugin never pulls code from
  the network for execution
- **User client js** shares the trust level of other web plugins (browser sandbox); registered
  through the versioned bridge (contract mismatch only warns and skips)
- History sampling persists as multi-file storage (one file per `(provider, adapterId)` bucket,
  `0600` permissions tmp+rename atomic write); when upgrading from the legacy single file it is
  renamed to `.bak` and **kept (never deleted — cleanup is left to the user)**
- All routes are loopback-fenced (non-loopback 403 / wrong method 405); the `select` API limits
  parameter length to 128
- Official interface request frequency is controlled: GUI polling ≤1 request/60s + background
  sampling ≤1 request/5min (each with an additional 30s TTL cache suppressing duplicate
  requests), so it will not hit rate limits

## Verification

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-provider-usage/health

# Source is in src/, must build after changes
pnpm --filter @wingsky-1/dsh-provider-usage build
node test/smoke.ts
```

## License

MIT
