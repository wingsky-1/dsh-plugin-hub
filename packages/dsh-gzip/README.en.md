# @wingsky-1/dsh-gzip
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-gzip)](https://www.npmjs.com/package/@wingsky-1/dsh-gzip)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

> ⚠️ **This package is being retired**: the HTTP response compression feature has been
> merged into [@wingsky-1/dsh-lan-proxy](../dsh-lan-proxy) (>=0.1.10), which now handles
> "forwarding + compression" in one package. Upgrade lan-proxy and uninstall this package:
>
> ```sh
> dsh plugin --profile web update @wingsky-1/dsh-lan-proxy    # requires >= 0.1.10
> curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/compression  # loopback check: continue only when it returns {"merged":true}
> dsh plugin --profile web remove @wingsky-1/dsh-gzip
> # Restart dsh web to take effect
> ```
>
> v0.1.10 is the final compatibility release: when the merged lan-proxy is detected (marker
> route `/api/dsh-lan-proxy/compression`), it skips its own installation and warns to
> uninstall. After v0.1.10 ships, the npm package will be marked deprecated; the source
> will be removed in a later release cycle (the aggregate package dsh-plugins-all has
> already dropped this package — family-bucket users migrate by upgrading the aggregate).

A response gzip compression plugin for the DSH Web GUI: enables gzip compression for
`/api` responses, static assets (`/assets/*` and index.html), and plugin client bundles
(`/plugins/<pkg>/client.js`) over remote / low-bandwidth links, fixing the
"history load failed: The user aborted a request. (internal)" problem and significantly
shrinking the transferred size of frontend assets.

## Why you need it

When the DSH Web GUI loads session history, a single page of history may contain all the
streaming chunk events, with a response body of 4~13MB that the server does not compress by
default; on the browser side, the RPC also has a hard 30s timeout. On low-bandwidth links
(easytier / ZeroTier / Tailscale / mobile networks) this times out and fails outright.

This plugin applies gzip compression to compressible responses on the server side: the same
page of history shrinks to about 1.2MB after compression, and measured load time drops from
about 36s to about 3s (in an isolated environment); the frontend main bundle (~744KB) and
each plugin's client.js compress to about 1/3~1/4 of their original size.

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-gzip
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-gzip
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-gzip
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-gzip@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-gzip
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-gzip
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-gzip
```

## Verification

```sh
# 1. Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-gzip/health
# → {"ok":true,"plugin":"dsh-gzip","mounted":"replace","handlers":{"api":"replace","plugins":"replace","fallback":"replace"},...}

# 2. Response header carries content-encoding: gzip
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3080/api/session.list \
  -H "Content-Type: application/json" -H "Accept-Encoding: gzip" \
  -d '{"type":"client-request","rpcId":"test","method":"session.list","payload":{}}' \
  | grep -i content-encoding
```

`mounted` reflects the actual takeover mode of `/api` (`replace` / `register-patch`);
`handlers` reports the status of the three takeover surfaces (api / plugins / fallback)
respectively — see "How it works" below.

## How it works

- **Compression conditions**: the request negotiates gzip via `Accept-Encoding` (q=0 is
  treated as a rejection), the response content-type is compressible (JSON / JSON-family /
  text), and it does not already carry a `content-encoding`.
- **Takeover scope (multi-branch, no ordering dependency)**:
  - All registered **prefix named routes** are fully taken over (including `/api`, `/plugins`,
    and any future third-party prefixes) — directly replacing the corresponding
    `route.handler` in `webServer.prefixes` (runtime replacement takes effect immediately);
  - **exact routes are also taken over** (`webServer.exact`, `DshRoute.kind:"exact"`) — the
    gzip wrapper is applied consistently with prefixes, fixing the problem that plugins'
    commonly used exact routes (large history JSON, each plugin's health, web-file-preview
    file previews, etc.) go uncompressed;
  - The **fallback slot** is taken over (`webServer.fallback`) — covering `/assets/*` static
    assets, `/`, and the SPA fallback's index.html;
  - `register` / `registerFallback` patches only serve as fallbacks, covering cases where this
    plugin is assembled first or re-registered later.
- **Compression level is configurable**: default level 1 (static-text scenarios 3~6ms/file,
  compression ratio about −66~−77%); the `level` config (1..9) is adjustable, and illegal
  values are auto-normalized.
- **Instance-level shadowing**: writeHead / write / end are replaced only on the current
  request's ServerResponse instance, without touching any prototype; they are naturally
  released when the request ends; gzip backpressure is bridged with the res drain event.

## Security model

- **Exemptions pass through as-is**: SSE (`text/event-stream`), zip exports, **HEAD requests**
  (no body), **requests with `Range`** (preserving range semantics), unnegotiated gzip,
  already carrying `content-encoding`, and incompressible content-types
  (`application/octet-stream`, `image/*`, etc.) — none of these are compressed and all pass
  through as-is. The core safeguard is the `content-type` whitelist check, independent of
  whether a route is exact or prefix.
- **Affects only the response body**: no caching semantics are applied (no Cache-Control /
  ETag is added); the health-check route has a loopback fence (non-loopback 403 / wrong
  method 405), accessible only from loopback.
- **No global side effects**: on uninstall, the replaced prefix / exact handler, fallback, and
  register / registerFallback are restored (identity-level restore for the `replace` case); the
  wrap is idempotent (a second apply after HMR reload does not double-wrap); when `enabled:
  false`, nothing is registered.
- **Relies on non-public fields**: the main hooks read `webServer.prefixes`, `webServer.exact`,
  and `webServer.fallback` (instance public fields but not official APIs), and `registerFallback`
  is also a non-official method (patched after an existence check). When the upstream changes
  the structure, it automatically degrades to a backup hook; if the timing is unfavorable it
  manifests as "not compressing, no error" — a safe degradation, diagnosable via the health
  route's `handlers` status.

## Positioning

A transitional solution: the root fix belongs upstream (slimming history responses / official
compression / timeout strategy); once upstream is fixed, this plugin naturally retires; even if
it fails, it only means "not compressing" and breaks no functionality.

## Development

```sh
# Source is in src/*.ts; after changes you must build (dsh imports lib artifacts directly)
pnpm --filter @wingsky-1/dsh-gzip build
node test/smoke.ts
```

The smoke test covers: q-value parsing, SSE / already-encoded / **HEAD / Range** exemptions,
real zlib compression/decompression consistency, level normalization and effect, full prefix
takeover (/api, /plugins), fallback takeover and registerFallback fallback, non-`/api` routes
unaffected, uninstall restore, health route (GET 200 / POST 405 / non-loopback 403 with
handlers), and `enabled: false` registers nothing.

## License

MIT. The compression wrapper logic is inspired by the upstream
[040822/dsh-gzip](https://github.com/040822/dsh-gzip) (MIT).
