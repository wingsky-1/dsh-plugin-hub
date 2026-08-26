# @wingsky-1/dsh-lan-proxy
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-lan-proxy)](https://www.npmjs.com/package/@wingsky-1/dsh-lan-proxy)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

LAN access to the dsh web UI: listens on `0.0.0.0:<port>` and forwards HTTP/HTTPS and
WebSocket/wss to the loopback web server (default `127.0.0.1:3080`).

- Rewrites Host/Origin to pass the /api browser trust perimeter
- Accepts only IP-literal or localhost Host headers (**DNS rebinding protection**)
- HTTPS runs by default alongside (3443); the certificate is configurable or auto-generated self-signed

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

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

> ⚠️ **Installing opens ports**: this plugin listens on `0.0.0.0:3081` (HTTP) and
> `0.0.0.0:3443` (HTTPS), making your dsh web reachable by every device on the LAN.
> Uninstall it (see remove above) when not needed.

## Configuration

| Key | Default | Description |
|---|---|---|
| `host` | `0.0.0.0` | Listen address |
| `port` | `3081` | HTTP listen port |
| `httpsPort` | `3443` | HTTPS listen port |
| `targetHost` | `127.0.0.1` | Loopback upstream host (**loopback addresses only**) |
| `targetPort` | auto | Upstream port (defaults to the web server's actual bound port) |
| `httpsEnabled` | `true` | Whether to run HTTPS alongside |
| `tlsCertFile` / `tlsKeyFile` | none | Custom certificate (mkcert, etc.) |
| `wsCompressEnabled` | `true` | Whether to apply compressed bridging to WebSockets matching `wsCompressPaths` |
| `wsCompressPaths` | `/api/events.mux, /api/events.host` | Path allowlist participating in WebSocket compression |
| `httpCompressEnabled` | `true` | Master switch for HTTP response compression (Brotli/gzip negotiation, merged from dsh-gzip) |
| `httpCompressLevel` | `1` | Compression preset 0..3: `0` default / `1` low (gzip 1 / br 2, fastest) · `2` medium (gzip 5 / br 5, balanced) / `3` high (gzip 9 / br 9, best ratio) — effective for **both** gzip and Brotli; legacy integer values 4..9 are migrated to 3 automatically |

GUI settings entry: Settings → Plugins → "LAN Access" card (saved changes apply hot).

## WebSocket Compression (wss event stream)

- For WebSocket upgrades matching `wsCompressPaths` (default session event streams
  `/api/events.mux`, `/api/events.host`), lan-proxy performs **termination + permessage-deflate**:
  the browser segment is compressed (the browser negotiates and decompresses automatically),
  the DSH segment is plaintext, then both directions are bridged and forwarded.
- Benefit: events.mux/events.host are dsh's real-time event streams (session traces/progress);
  uncompressed, traffic is heavy over remote/slow links — permessage-deflate measures roughly
  **75~79%** savings in practice.
- Even if the DSH server later enables permessage-deflate itself, the DSH segment here never
  negotiates compression; the two segments are independent, so there is **no double compression
  and no conflict**.
- **Half-open liveness probe (keep-alive)**: the bridge pings the browser segment and the DSH
  segment **independently** every 30s; a ping with no pong by the next cycle (~30~60s of
  silence) marks that side half-open and terminates it — close/error semantics therefore hold
  even under half-open connections, and the existing mutual-teardown logic closes the other
  end. When a mobile OS silently kills TCP in background, the bridge no longer deadlocks
  (Refs #268). A termination logs `lan-proxy: ws-bridge half-open detected, terminating
  (intervalMs=...)` at warn level, distinct from ordinary upstream error warnings.
- All other WebSocket paths remain TCP byte passthrough (unaffected).

## HTTP Response Compression (Brotli/gzip, merged from dsh-gzip)

- Since v0.1.10, the HTTP response compression capability of the standalone dsh-gzip plugin (source removed from this repository)
  has been merged into this plugin, implemented at the **forwarding layer** via the
  battle-tested [compression](https://www.npmjs.com/package/compression) middleware
  (inlined at build time): for requests served through
  this plugin, compressible responses (JSON / text) from `/api` (RPC), `/plugins`
  (client bundles), and static assets/index.html negotiate compression automatically — Brotli when the client's Accept-Encoding includes br, gzip fallback otherwise; SSE
  (text/event-stream), zip exports, already-encoded responses, HEAD, Range requests,
  and responses under 1KB pass through untouched.
- Benefit: large JSON responses such as session history (4~13MB uncompressed) often hit
  the browser RPC 30s timeout over remote/slow links ("history load failed"); after compression
  they are ~1.2MB — measured in an isolated environment at ~36s down to ~3s.
- The middleware sits on the forwarder's own listener chain and does not modify dsh web
  or any other plugin's runtime behavior; set `httpCompressEnabled: false` to turn it off.
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

## HTTPS Support

- **Certificate sources (two tiers)**: ① configure `tlsCertFile`/`tlsKeyFile` (official
  certificate or mkcert local CA, zero browser warnings); ② auto-generate a self-signed
  certificate (built-in `selfsigned` library generates and caches it to `<DSH_HOME>/lan-proxy/`,
  private key permission 0600, no host openssl required)
- The self-signed certificate needs a one-time manual "proceed" on first visit; for zero warnings
  on LAN devices, mkcert is recommended

## Security Model

- **Egress target allowlist (L1)**: `targetHost` allows only loopback addresses (localhost /
  127.0.0.1 / ::1), double-checked at both the config layer and the runtime entry — **prevents
  open forwarding / SSRF**
- **DNS rebinding protection**: only requests whose Host is an IP literal or `localhost` are
  accepted; domain names are always rejected with 403/disconnect; IP literals are safe on any port
- **Credential surface**: dsh settings RPC is readable/writable on loopback only; remote devices
  reached through this plugin can read/write server settings (including **credential-class data**)
  within the browser trust perimeter — make sure your LAN is trusted, or disable this plugin
- **Private key permission**: auto-generated self-signed private keys are written with 0600
- **Open port reminder**: `0.0.0.0` listening is visible to every device on the LAN
- **HTTP response compression**: compression happens at the forwarding layer and only applies
  to the link between this plugin and the LAN client; it never touches dsh web's response
  generation, adds no reachable data surface, and only costs a small amount of CPU (disable
  via `httpCompressEnabled: false`). The loopback fence on health/marker routes applies to
  requests hitting the loopback web directly; requests forwarded through this plugin are
  trusted by design (see Credential surface)

## Verification

```sh
# Health check (loopback; includes compression config, active state and negotiation counters)
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health

# Merged-compression marker route (loopback)
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/compression

# LAN access (from another device)
curl http://<your-LAN-IP>:3081/api/dsh-lan-proxy/health
```

## Known Limitations

- HTTPS self-signed certificates are generated by a built-in library with no external command
  dependency (when unavailable and no certificate file is configured, the HTTPS channel
  auto-degrades and shuts down)
- When changing network segments causes the IP to change, the self-signed certificate must be
  regenerated or config.json updated
- WebSockets matching `wsCompressPaths` go through "termination + compressed bridging" (one extra
  hop, extra compression CPU); enabling it is only recommended for high-traffic paths like events;
  all other WebSockets stay passthrough

## License

MIT
