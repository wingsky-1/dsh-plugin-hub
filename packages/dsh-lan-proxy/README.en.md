# @wingsky-1/dsh-lan-proxy
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-lan-proxy)](https://www.npmjs.com/package/@wingsky-1/dsh-lan-proxy)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

LAN access to the dsh web UI: listens on `0.0.0.0:<port>` and forwards HTTP/HTTPS and
WebSocket/wss to the loopback web server (default `127.0.0.1:3080`).

[简体中文](README.md) | **English**

## Quick navigation

[Before you start](#before-you-start) · [Security Model](#security-model) · [Quick start](#quick-start) · [Common configuration](#common-configuration) · [Verification and troubleshooting](#verification-and-troubleshooting) · [Detailed reference](#detailed-reference) · [Development and architecture](#development-and-architecture)

<a id="before-you-start"></a><a id="user-content-before-you-start"></a>
## Before you start

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

- Rewrites Host/Origin to pass the /api browser trust perimeter
- Accepts only IP-literal or localhost Host headers (**DNS rebinding protection**)
- HTTPS runs by default alongside (3443); the certificate is configurable or auto-generated self-signed

<a id="security-model"></a><a id="user-content-security-model"></a>
## Security Model

- **Egress target allowlist (L1)**: `targetHost` allows only loopback addresses (localhost /
  127.0.0.1 / ::1), double-checked at both the config layer and the runtime entry — **prevents
  open forwarding / SSRF**
- **DNS rebinding protection**: only requests whose Host is an IP literal or `localhost` are
  accepted; domain names are always rejected with 403/disconnect; IP literals are safe on any port
- **Credential surface**: dsh settings RPC is readable/writable on loopback only; remote devices
  reached through this plugin can read/write server settings (including **credential-class data**)
  within the browser trust perimeter — make sure your LAN is trusted, or disable this plugin
- **Bridge header passthrough**: the WS bridge forwards inbound headers (including
  authentication cookies — since dsh 0.1.2 `/api/remote.mux` upgrades require cookie
  authentication, dropping them results in 401 and connection failure), overriding only
  Host/Origin to the loopback target and stripping hop-by-hop and WebSocket handshake-only
  headers; the upstream is forced to loopback by `targetHost`, so credentials are sent only to the
  local loopback upstream (this does not promise cross-process isolation). **Compression-bomb surface**: the browser-segment permessage-deflate
  decompression is an amplification point (a hostile LAN client sending highly-compressed frames
  makes the proxy process decompress) — acceptable within the "LAN-trusted" threat model (same
  trust boundary as `injectToken`)
- **Private key permission**: auto-generated self-signed private keys are written with 0600; one-click CA private keys (CA + leaf) and .bak files are always 0600 (write + chmodSync double cover), and the certs/ directory is 0700
- **Certificate serving surface (issue #911)**: the download route only serves public keys (loopback fence + GET only + no Cookie required). Only the first CERTIFICATE block is served; a mispointed private key always yields 404; responses are not cached. Without a CA nothing is served with 404 (self-signed/orphan leaves cannot establish trust once installed)
- **One-click CA action surface (issue #930)**: POST-only writes (loopback fence + POST allowlist + requires a writable settings service). The CA private key filename is fixed (ca-key.pem) and never served; failure responses carry only fixed codes (ca-generate-failed, etc.) while paths and key material stay in server logs. Rotation replaces only the leaf by default (the CA is reused, installed devices keep working); rotating the CA is a separate dangerous action (trust on all installed devices breaks and each must reinstall). Superseded materials move to timestamped .bak files with only the most recent one kept
- **Open port reminder**: `0.0.0.0` listening is visible to every device on the LAN
- **HTTP response compression**: compression happens at the forwarding layer and only applies
  to the link between this plugin and the LAN client; it never touches dsh web's response
  generation, adds no reachable data surface, and only costs a small amount of CPU (disable
  via `httpCompressEnabled: false`). The loopback fence on health/marker routes applies to
  requests hitting the loopback web directly; requests forwarded through this plugin are
  trusted by design (see Credential surface). Diagnostic metadata in the health response —
  the absolute `configDir` path and compression negotiation counters — is forwarded unchanged
  and is visible to LAN devices
### injectToken automatic injection (issue #380)

DSH browser-session authentication (launch token + persistent signed cookie) cannot be disabled.
The token changes on restart and is printed only in the local terminal, so fixed LAN devices cannot
obtain it themselves. Through the connection service’s public `authenticatedUrl()` API, the proxy
reads the current token dynamically and adds it only at the minting entry (`GET /` without a
session cookie), letting LAN devices enter without manual steps. Trade-offs and mitigations:

- **Equivalent to trusting the entire LAN**: any client that can reach this port gets full DSH
  control without a token, including bash access to the host. Enable only on trusted home/office
  networks; turn it off in the settings card on untrusted segments.
- **On by default (maintainer decision)**: comparable precedents (Home Assistant’s
  `trusted_networks` authentication provider and qBittorrent WebUI’s "Bypass authentication for
  clients") require explicit configuration by default. This plugin defaults on for fixed home-LAN
  use, with warnings in the startup banner, settings card and this section as mitigation.
- **Turning it off does not revoke issued cookies**: logged-in devices remain able to enter
  during the cookie lifetime (30 days by default). Clear the DSH credentials store to revoke access immediately.
- **Invalid-cookie recovery**: after a credentials reset, a browser may retain an invalid cookie
  until Max-Age and cannot obtain a new token, causing a 401 deadlock. On an upstream 401 the
  forwarder replays once with the token so upstream remints the cookie transparently.
- **Residual cross-site surface**: a hostile public page can trigger a cross-site GET to
  `http://<LAN-IP>:3081/` and mint a cookie, but cannot read the response (CORS opaque);
  subsequent cross-site requests omit it under `SameSite=Strict`, and the sec-fetch-site fence
  rejects `POST /api`. Token and cookie never appear in the browser address bar or history.
- **Non-injection boundary**: only `GET /` without a token parameter is eligible. WebSocket,
  non-root paths, requests already carrying a token, and unavailable providers pass through
  unchanged. A password page (trust narrowed to those who know the password) is a future direction.

### ownsHostCompat compatibility injection (issue #856, off by default)

 through the official
  webServer index injection hook, a self-conditioned script is injected into **non-loopback**
  pages, declaring `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`. This **forges an
  upstream topology fact** — served pages are not supposed to carry that global. It is **not a
  server-side authorization change**: the `/api` fence, launch token and session-cookie auth are
  unchanged; only the page-side fact is.
  - **Unlocked behaviours**: (1) settings persistence moves from memory scope back to host scope
    and is written to `<DSH_HOME>/settings.yaml` (created with `flag: "wx"` when missing);
    (2) the host-native "open settings file" action (the settings page can ask the host to open
    that file).
  - **Remote and local pages become indistinguishable in the UI**: `isLoopback` is the only
    local/remote signal, and in compat mode a LAN page has the same value as a `127.0.0.1` page.
  - **Injection bounds**: the script element lands in every index.html served through this
    plugin (loopback pages included), but the script is self-conditioned — it returns
    immediately when the page already carries `__DSH_TRANSPORT__` (compositions that bring
    their own transport, e.g. desktop-host, are untouched) or when the authority is loopback
    (localhost / [::1] / 127/8), writing neither transport nor marker. A loopback page
    receiving the script element and a loopback page being altered are two different things;
    the latter never happens.
  - **How to turn it off**: Settings → Plugins → dsh-lan-proxy, disable "Declare ownsHost to
    non-loopback pages (compat)" (composition-level config: `ownsHostCompat: false`), then
    reload the page.
  - **Zero-forgery alternative**: `ssh -L 3080:127.0.0.1:3080 <host>` and browse
    `http://127.0.0.1:3080/` — the page authority is already loopback, so settings persistence
    works without impersonating any topology fact.
  - **Failure visibility**: the verdict has **four states** (local page / compat active /
    upstream contract drift / switch off). Neither fault state depends on the settings card, and
    there are three visibility surfaces — but they do not cover the same ground:
    (1) **devtools console** — on page load (at the very top of `apply`) one
    `[dsh-lan-proxy]` warning is logged, once per page assembly (not on every render), so it
    never floods, and it does not depend on the settings surface being available; this is the
    only fault-state outlet that reflects the **page-side fact** (whether the injection actually
    took effect); (2) the **startup banner's**
    `ownsHostCompat: ON/OFF` line; (3) the `ownsHostCompat` field of
    `GET /api/dsh-lan-proxy/health`. (2) and (3) only report the host-side switch — they cannot
    answer whether upstream has drifted. The settings card also shows a persistent four-state
    verdict line, but only while the card is mounted (see the next item).
  - **Known limitation (both fault states are unreachable on the page)**: the card is registered
    on the `settings.plugin.item` slot, and that plugin list only has entries while the settings
    scope is available — when upstream downgrades a non-loopback page's settings surface to
    memory scope the plugin list is empty and the card is not mounted
    (dsh-client-ui-settings-plugins only calls renderSlot when namespaces is non-empty). The crux
    is that **the same `isLoopback` signal decides both whether the card mounts and what the
    four-state verdict is**, so `contract-drift` (upstream removed/renamed/reordered the
    `ownsHost` predicate and the injection is dead) and `compat-off` (switch off) — precisely
    the two states that most need to be seen — have no carrier on the page. Measured on a
    non-loopback authority with the switch off, the plugin list is empty and the card is not
    mounted, so the verdict line at the bottom of the card never appears either. Those two states
    are therefore visible only through (1) the devtools warning (page-side drift) plus (2)/(3)
    the banner and health field (host-side switch). Changing the switch happens host-side only:
    `dsh-lan-proxy.ownsHostCompat` in `settings.yaml`, the `cordis.patch.yml` base layer in a
    profile, or a loopback browser on the settings page.

<a id="quick-start"></a><a id="user-content-quick-start"></a>
## Quick start

> **Installing opens ports**: this plugin listens on `0.0.0.0:3081` (HTTP) and
> `0.0.0.0:3443` (HTTPS), making your dsh web reachable by every device on the LAN.
> Uninstall it (see Uninstall plugins below) when not needed.

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Access

From a trusted LAN device, open `https://<server-IP>:3443/` (or `http://<server-IP>:3081/`). A self-signed certificate requires a one-time manual "proceed"; see HTTPS Support.

### Verify

From the host, check the health endpoint:

```sh
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health
```

<a id="common-configuration"></a><a id="user-content-common-configuration"></a>
## Configuration

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch (off stops the forwarder listeners) |
| `host` | `0.0.0.0` | Listen address |
| `port` | `3081` | HTTP listen port |
| `httpsPort` | `3443` | HTTPS listen port |
| `targetHost` | `127.0.0.1` | Loopback upstream host (**loopback addresses only**) |
| `targetPort` | auto | Upstream port (defaults to the web server's actual bound port) |
| `httpsEnabled` | `true` | Whether to run HTTPS alongside |
| `tlsCertFile` / `tlsKeyFile` | none | Custom certificate (mkcert, etc.) |
| `tlsCaCertFile` | none | Self-built LAN CA public key (PEM, read-only) |
| `printBanner` | `true` | Print the startup banner with LAN access URLs |
| `wsBridgeEnabled` | `true` | Bridge switch; disabling it drops keep-alive and compression. |
| `wsCompressEnabled` | `true` | Whether to apply compressed bridging to WebSockets matching `wsCompressPaths` (compression only; does not affect bridge keep-alive) |
| `wsCompressPaths` | `/api/remote.mux` | Path allowlist participating in WebSocket compression (empty = bridged without compression, keep-alive unaffected) |
| `wsDeflatePolicy` | `{browser:true, uaDeny:[iPhone…]}` | Browser compression policy and UA exclusions. |
| `httpCompressEnabled` | `true` | Forwarding-layer gzip/Brotli switch. |
| `httpCompressLevel` | `1` | Compression preset 0..3 for gzip and Brotli. |
| `injectToken` | `true` | Token-free LAN access; on by default. See Security Model. |
| `ownsHostCompat` | `false` | Forge the page-side host fact; off by default. See Security Model. |

GUI settings entry: Settings → Plugins → "LAN Access" card (saved changes apply hot).

### Configuration storage (single channel)

- All configuration lives in the dsh official settings store (the
  `dsh-lan-proxy` namespace registered via `settings.register`, persisted in the
  host-managed settings document); composition-layer `cordis.patch.yml` config
  acts as the base layer. Hot reload is driven by the official `scope.watch` —
  no restart needed.
<details>
<summary>Legacy config.json migration</summary>

- This plugin no longer maintains its own `~/.dsh/lan-proxy/config.json`. On
  the first start after upgrading, a legacy config.json is migrated once into
  the official store: the original file is atomically renamed and kept as
  `config.json.migrated.bak`. If persisting into the official store fails, the
  rename is rolled back and retried on next start; if the process exits before
  the write completes (interrupted), the leftover backup is detected on next
  start and its content is replayed into the store, with a log note.
  Delete that backup manually once everything works. Editing
  config.json afterwards has **no effect**.

</details>

### Configuration details

#### `wsBridgeEnabled`

WebSocket bridge master switch (issue #552): `true` = all WS upgrades go through "termination + bridge" (keep-alive base: auto-answers upstream Pings + half-open probes); `false` = TCP byte passthrough (explicitly drops keep-alive and compression — mobile backgrounding can be killed by upstream heartbeat and cause frequent reconnect loops, see "WebSocket Bridge & Compression")

#### `wsDeflatePolicy`

Compression negotiation policy: `browser: false` disables compression globally; `uaDeny` lists UA fragments denied compression (iOS Safari is denied by default)

#### `httpCompressEnabled`

Master switch for HTTP response compression (the forwarding layer negotiates gzip/Brotli for compressible responses; Brotli's effective condition is documented in "HTTP Response Compression", merged from dsh-gzip)

#### `httpCompressLevel`

Compression preset 0..3: `0` default / `1` low (gzip 1 / br 2, fastest) · `2` medium (gzip 5 / br 5, balanced) / `3` high (gzip 9 / br 9, best ratio) — the gzip and Brotli parameters are both passed down; legacy integer values 4..9 are migrated to 3 automatically

#### `injectToken`

Auto-inject the current launch token on the first `GET /` to mint a session cookie; replay once after an upstream 401 to recover an invalid cookie (issue #380). See Security Model

#### `ownsHostCompat`

Declare `ownsHost` to non-loopback pages (issue #856): **forges an upstream topology fact**, unlocking settings persistence to `<DSH_HOME>/settings.yaml` and the host-native "open settings file" action; remote and local pages become indistinguishable in the UI. Off by default — trade-offs, how to disable it and the `ssh -L` zero-forgery alternative are in the Security Model

<a id="verification-and-troubleshooting"></a><a id="user-content-verification-and-troubleshooting"></a>
## Verification and troubleshooting

```sh
# Health check (loopback; includes compression config, active state and negotiation counters)
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health

# Merged-compression marker route (loopback)
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/compression

# LAN access (from another device)
curl http://<your-LAN-IP>:3081/api/dsh-lan-proxy/health
```

### Known Limitations

- HTTPS self-signed certificates are generated by a built-in library with no external command
  dependency (when unavailable and no certificate file is configured, the HTTPS channel
  auto-degrades and shuts down)
- When changing network segments causes the IP to change, the self-signed certificate must be
  regenerated or the settings (certificate file paths) updated
- WS bridging applies to all WebSockets by default (keep-alive base); compression only applies
  to paths matching `wsCompressPaths` (one extra hop, extra compression CPU). Bridging is a
  parsing termination proxy: subprotocol and close codes are not preserved across ends (the dsh
  client does not depend on either — verified zero impact)
- With `wsBridgeEnabled=false` all WebSockets go passthrough (saves one hop of CPU), but mobile
  backgrounding >4~6s gets killed by the upstream heartbeat and causes frequent reconnect
  loops — only recommended for setups with no mobile clients

<a id="detailed-reference"></a><a id="user-content-detailed-reference"></a>
## Detailed reference

### WebSocket Bridge & Compression (wss event stream)

- **Bridging is the default base (issue #552)**: while `wsBridgeEnabled` is on (default),
  **all** WebSocket upgrades go through "termination + bridge" — lan-proxy speaks ws on both
  the browser segment and the DSH segment and forwards frames both ways. Bridging provides two
  capabilities that are **independent of compression**:
  - **Automatic upstream Ping reply**: the dsh upstream (api-gateway) sends one WS Ping on
    `/api/remote.mux` every 2s and calls `terminate()` after 2 cycles (~4~6s) without a Pong.
    The bridge's upstream connection auto-replies Pongs via the ws library — mobile
    backgrounding / screen-off / brief freezes no longer trip the upstream kill; the connection
    survives until the device returns (no more "disconnect → reconnect" loops).
  - **Half-open liveness probe (Refs #268)**: the bridge pings the browser segment and the DSH
    segment **independently** every 30s; a ping with no pong by the next cycle (~30~60s of
    silence) marks that side half-open and terminates it. A termination logs
    `lan-proxy: ws-bridge half-open detected, terminating (intervalMs=...)` at warn level.
- **Compression is an optional enhancement on top of the bridge**: when a path matches
  `wsCompressPaths` (default `/api/remote.mux` — the Remote-stream mux endpoint owned by
  api-gateway since dsh 0.1.2, replacing the old `/api/events.mux`, `/api/events.host`)
  **and** `wsCompressEnabled` is on, the browser segment negotiates permessage-deflate (the
  browser decompresses automatically) while the DSH segment stays plaintext, then both
  directions are bridged and forwarded. Benefit: remote.mux carries heavy real-time frames —
  permessage-deflate measures roughly **75~79%** savings in practice.
- **Clearing the compression allowlist / turning compression off no longer drops keep-alive**
  (issue #552): `wsCompressPaths=[]` or `wsCompressEnabled=false` only disables compression;
  the bridge (Pong reply + probes) stays active.
- Even if the DSH server later enables permessage-deflate itself, the DSH segment here never
  negotiates compression; the two segments are independent, so there is **no double compression
  and no conflict**.
- **Bridging is not byte-transparent**: it terminates and re-originates the WS connection, so
  subprotocol (Sec-WebSocket-Protocol) negotiation and close codes are not preserved across
  ends (the dsh client currently depends on neither — verified zero impact); treat this as the
  contract for generic/future endpoints.
- **Explicitly disabling the bridge** (`wsBridgeEnabled=false`): all WS goes through TCP byte
  passthrough (saves one hop of CPU), but loses Pong reply and probes — mobile backgrounding
  >4~6s gets killed by the upstream heartbeat and causes frequent reconnects; only recommended
  for setups with no mobile clients.

### HTTP Response Compression (Brotli/gzip, merged from dsh-gzip)

- Since v0.1.10, the HTTP response compression capability of the standalone dsh-gzip plugin (source removed from this repository)
  has been merged into this plugin, implemented at the **forwarding layer** via the
  battle-tested [compression](https://www.npmjs.com/package/compression) middleware
  (inlined at build time): for requests served through
  this plugin, compressible responses (JSON / text) from `/api` (RPC), `/plugins`
  (client bundles), and static assets/index.html negotiate compression automatically; SSE
  (text/event-stream), zip exports, already-encoded responses, HEAD, Range requests,
  and responses under 1KB pass through untouched.
- **When Brotli actually applies (measured)**: dsh's own web server already ships gzip
  compression (`compression: gzip`) and negotiates gzip only. Two cases therefore exist on
  this path:

  | Client `Accept-Encoding` | Upstream | Final response through this plugin |
  |---|---|---|
  | `br, gzip` (mainstream browsers) | gzip | gzip (already encoded, this layer defers instead of re-compressing) |
  | `gzip` | gzip | gzip (same) |
  | `br` (br only) | raw | **br** |

  In other words, this layer's Brotli applies only when the upstream left the response
  uncompressed and the client declared br alone. Mainstream browsers declare gzip as well,
  so what arrives is the upstream gzip and the **extra Brotli ratio is not realized** on
  this path; that case is still far better than no compression (the same response measured
  322900 → 5065 bytes). The two layers never double-compress.
- Benefit: large JSON responses such as session history (4~13MB uncompressed) often hit
  the browser RPC 30s timeout over remote/slow links ("history load failed"); after compression
  they are ~1.2MB — measured in an isolated environment at ~36s down to ~3s.
- The middleware sits on the forwarder's own listener chain and does not modify dsh web
  or any other plugin's runtime behavior; set `httpCompressEnabled: false` to turn this
  layer's compression off (when the client also accepts gzip, the upstream's own gzip still
  compresses such responses, so the switch does not change their on-wire size).
  Note: traffic that reaches the loopback web directly (local browser on `127.0.0.1:3080`,
  not through this plugin) is outside the compression surface — loopback links do not
  need compression.
- **Migrating from dsh-gzip**: upgrade this plugin, confirm compression is active, then
  uninstall the standalone gzip package:

  ```sh
  dsh plugin --profile web update @wingsky-1/dsh-lan-proxy    # requires >= 0.1.10
  curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health      # loopback check: continue when httpCompressMounted is true
  dsh plugin --profile web remove @wingsky-1/dsh-gzip
  # Restart dsh web to take effect
  ```

- When legacy gzip@0.1.9 (no detection logic) coexists with this plugin, the
  content-encoding check still guarantees responses are compressed at most once
  (verified for every assembly order) — responses are never corrupted; uninstall it
  promptly to keep health diagnostics unambiguous.

### HTTPS Support

- **Certificate sources (two tiers)**: ① configure `tlsCertFile`/`tlsKeyFile` (official
  certificate or mkcert local CA, zero browser warnings); ② auto-generate a self-signed
  certificate (built-in `selfsigned` library generates and caches it to `<DSH_HOME>/@wingsky-1/dsh-lan-proxy/` (legacy lan-proxy dir is migrated on first boot),
  private key permission 0600, no host openssl required)
- The self-signed certificate needs a one-time manual "proceed" on first visit; for zero warnings
  on LAN devices, a self-built LAN CA is recommended (install once per device, see below)
- **One-click local CA (issue #930)**: on the settings page, the LAN access card offers "Generate local CA", issuing a 10-year CA plus a 398-day leaf into the managed directory `<DSH_HOME>/@wingsky-1/dsh-lan-proxy/certs/` (CA public key `ca-cert.pem` / private key `ca-key.pem` / leaf `leaf-cert.pem` + `leaf-key.pem`) with the three keys filled back automatically. "Rotate leaf certificate" only replaces the leaf by default (the CA is unchanged, installed devices keep working); "Rotate CA" is dangerous. As a zero-code alternative, mkcert works the same way (same hint as above)
- **Install certificates on mobile devices (issue #911; #930 Phase 1: no CA, no download)**: after configuring tlsCaCertFile (CA public key), the settings-page download link serves the CA (open the link directly in a browser). Without a CA the download link always yields 404 (neither the self-signed mode nor a custom orphan leaf is served: installing them cannot establish trust) — generate a local CA from the settings page first, or configure a CA public key and retry. iPhone: install the profile then enable trust in Certificate Trust Settings; Android: install the CA certificate under Security settings; Windows: double-click into Trusted Root Certification Authorities

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-lan-proxy
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

<details>
<summary>Installation variants: version pinning and npx</summary>

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-lan-proxy
```

</details>

<a id="development-and-architecture"></a><a id="user-content-development-and-architecture"></a>
## Development and architecture

For architecture and runtime mechanisms, see the [TOGAF 4A architecture document](../../docs/architecture/dsh-lan-proxy.md) (in Chinese): Business, Application, Data, and Technology views.

Tests are maintained by layer under `test/{unit,integration,e2e,client}/`. Unit and integration tests import `src/**` directly; e2e smoke tests run the `lib/` artifact (`import "../../lib/index.js"`). Stryker reuses the assertions via the lib→src hook, without hand-synced copies.

<a id="configuration-contract-appendix"></a><a id="user-content-configuration-contract-appendix"></a>
## Configuration contract appendix

| Key | Host default | Client display default | Patch declaration |
|---|---|---|---|
| `port` | `3081` | `3081` | Not declared |
| `httpsPort` | `3443` | `3443` | Not declared |
| `host` / `targetHost` | `"0.0.0.0"` / `"127.0.0.1"` | No such key | Not declared |
| `targetPort` | No default; follows the loopback web server actual port | No such key | Not declared |
| `injectToken` | `true` | `true` | Not declared |
| `ownsHostCompat` | `false` | `false` | Not declared |
| `enabled` / `httpsEnabled` / `printBanner` / `wsBridgeEnabled` / `wsCompressEnabled` / `httpCompressEnabled` | `true` | `true` | Not declared |
| `httpCompressLevel` | `1` (0-3) | `1` | Not declared |
| `wsCompressPaths` / `wsDeflatePolicy` / `tlsCertFile` / `tlsKeyFile` | `["/api/remote.mux"]` / `{browser:true, uaDeny:[iPhone,iPad,iPod]}` / no default | `["/api/remote.mux"]` / no such key / `""` | Not declared |

Host defaults come from `DEFAULT_OPTIONS` in `src/server/shared/defaults.ts` and `DEFAULT_DEFLATE_POLICY` in `src/server/shared/deflate.ts`, applied via `Config` / `DEFAULT_CONFIG` in `src/server/config/impl/model.ts`; client defaults come from `DEFAULTS` in `src/client/shared/defaults.ts`; `cordis.patch.yml` (`ui-dsh-lan-proxy`) carries no `config` on either the standalone or aggregate row. `injectToken` on is equivalent to trusting the whole LAN, and `ownsHostCompat` on declares `ownsHost` to non-loopback pages; see "Security Model" for details. The code above is the single source of truth; where docs and code disagree, the code prevails.

## License

MIT
