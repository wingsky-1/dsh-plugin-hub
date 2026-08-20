# @wingsky-1/dsh-lan-proxy

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

If the registry has not synced the latest yet, or the latest has issues in your environment,
append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy@0.1.8
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
- All other WebSocket paths remain TCP byte passthrough (unaffected).

## HTTPS Support

- **Certificate sources (two tiers)**: ① configure `tlsCertFile`/`tlsKeyFile` (official
  certificate or mkcert local CA, zero browser warnings); ② auto-generate a self-signed
  certificate (`openssl` generates and caches it to `<DSH_HOME>/lan-proxy/`, private key
  permission 0600)
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

## Verification

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3081/api/lan-proxy/health

# LAN access (from another device)
curl http://<your-LAN-IP>:3081/api/dsh-gzip/health
```

## Known Limitations

- HTTPS requires system `openssl` (when unavailable and no certificate file is configured, the
  HTTPS channel auto-degrades and shuts down)
- When changing network segments causes the IP to change, the self-signed certificate must be
  regenerated or config.json updated
- WebSockets matching `wsCompressPaths` go through "termination + compressed bridging" (one extra
  hop, extra compression CPU); enabling it is only recommended for high-traffic paths like events;
  all other WebSockets stay passthrough

## License

MIT
