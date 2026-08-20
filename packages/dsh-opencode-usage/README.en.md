# @wingsky-1/dsh-opencode-usage

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
dsh plugin --profile web add @wingsky-1/dsh-opencode-usage
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-opencode-usage
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-opencode-usage
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

If the registry has not synced the latest yet, or the latest has issues in your environment,
append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-opencode-usage@0.1.8
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-opencode-usage
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-opencode-usage
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-opencode-usage
```

## Data Source

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
| `baseUrl` | `https://opencode.ai/zen/go/v1/usage` | Usage interface address (**configurable, i.e. the token-forwarding target**) |
| `timeoutMs` | `15000` | Request timeout (ms) |
| `cacheTtlMs` | `30000` | Usage cache TTL (ms) |
| `limits` | `{rolling:12, weekly:30, monthly:60}` | Display limits (USD/window) |
| `apiKey` | none | Explicit API Key (falls back to the credential resolution chain when absent) |
| `maxAgeDays` | `14` | History sampling retention days (1–365) |
| `sampleIntervalMs` | `300000` | Host background sampling interval (30s–1h) |
| `persistFile` | `<DSH_HOME>/dsh-opencode-usage/history.json` | History sampling persistence path |

## Routes (all loopback-fenced)

| Route | Description |
| --- | --- |
| `GET /api/dsh-opencode-usage/stats` | Usage statistics (TTL cached) |
| `GET /api/dsh-opencode-usage/history[?days=N]` | History sampling series |
| `GET /api/dsh-opencode-usage/health` | Health check |

## Security and Boundaries

- **Token is never written to disk, never logged, never sent to the browser side**: the API Key
  lives only in host-process memory; the browser only fetches percentage values via `/stats`
  (the `src/index.ts` credential resolution chain and the `stats` route never return the token)
- **`baseUrl` is configurable = your token is sent to that address**: only configure a trusted
  usage interface; default is the official `https://opencode.ai/zen/go/v1/usage`
- History sampling is persisted with `0600` permissions (tmp + rename atomic write); the
  directory defaults to `<DSH_HOME>/dsh-opencode-usage/`
- All routes are loopback-fenced (non-loopback 403 / wrong method 405)
- Official interface request frequency is controlled: GUI polling ≤1 request/60s + background
  sampling ≤1 request/5min (each with an additional 30s TTL cache suppressing duplicate
  requests), so it will not hit rate limits

## Verification

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-opencode-usage/health

# Source is in src/, must build after changes
pnpm --filter @wingsky-1/dsh-opencode-usage build
node test/smoke.mjs
```

## License

MIT
