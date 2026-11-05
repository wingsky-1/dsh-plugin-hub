# dsh-lan-proxy retirement and migration

Status: `@wingsky-1/dsh-lan-proxy` is no longer independently maintained and has
been removed from the current source tree and the `@wingsky-1/dsh-plugins-all`
bundle. Published npm versions remain explicitly installable, but they will not
receive later DSH rc adaptations. See
[#1159](https://github.com/wingsky-1/dsh-plugin-hub/issues/1159) for the
retirement discussion.

This guide is for deployments that installed the old package. The current
compatibility baseline is DSH `0.2.2-rc.1` with Cordis `4.1.0`. The facts below
come from the official npm package types and CLI declarations, the inspected
upstream implementation, and this repository's source. A native LAN combination
listed here is not a compatibility claim until the deployment has verified it.

## This is not an equivalent replacement

The native DSH entry point covers binding a LAN address, serving HTTPS, and
negotiating gzip for HTTP. The old package differs in authentication,
certificate lifecycle, compression scope, WebSocket behavior, and security
fences. Removing the old package does not mean that every plugin works through
the new LAN entry point.

The target security model for plugin HTTP APIs retains a loopback fast path. A
non-loopback short request may enter only when the official
`ctx.connection.requestRejection(req)` validation returns `undefined`. That
seam covers Host/Origin, cross-site, cookie and API peer checks; missing or
throwing validation and 401/403 responses must fail closed. A non-loopback SSE
or other long stream must additionally retain the admitted `PeerScope` from
`ctx.connection.admit` and bind closure to that peer lifecycle. Peer release must
remove it from streams/broadcast tables and close it, so no later frame is sent
to a released peer. A new deployment must complete per-plugin authentication and
long-connection acceptance in its target environment before exposing native LAN
access. A successful TLS handshake, a LAN address, or a client-supplied
forwarded-address header does not authenticate the caller.

## Evidence boundary for native capabilities

The following facts were verified against the DSH `0.2.2-rc.1` official npm
tree's CLI declarations, types, and inspected implementation, together with this
repository's source:

- `--host` accepts one concrete local IPv4/IPv6 address and rejects wildcard
  binding;
- `--public-url` advertises an external HTTP(S) root and grants no trust;
- `--trusted-host` extends accepted Host/Origin authorities; it does not open a
  listener or authenticate a user;
- `--tls-cert` and `--tls-key` are paired. The certificate file contains the full
  PEM chain and the key file contains an unencrypted PEM private key. A TLS
  startup failure does not fall back to HTTP;
- the native entry point has no ACME, self-signed fallback, certificate watch,
  local CA management, mobile CA distribution, or automatic renewal;
- the Host fence accepts loopback, the listener's address literal, and configured
  trusted hosts. The Origin must match the authority and cross-site requests are
  rejected. Host/Origin failures usually return 403; an authority that reaches
  the auth stage without credentials returns 401;
- APIs and WebSockets require the startup-token exchange or a valid signed
  session cookie. The TLS listener issues session cookies with `Secure`. Short
  request identity checks and long-stream peer lifecycle are separate layers;
  one successful `requestRejection` does not replace retaining and releasing an
  admitted `PeerScope`;
- native HTTP compression supports `none | gzip`; Brotli is not provided;
- in isolated acceptance, the native remote mux negotiated
  `permessage-deflate`; the official WebSocket path also sends Pings and
  terminates inactive sockets. This establishes the protocol negotiation and
  upstream path behavior, but not equivalence with the old package's
  path-specific compression bridge, half-open keep-alive policy, or mobile
  reconnection behavior.

These are long-term capabilities and boundaries. Before exposing LAN access, the
deployment must verify real TLS, CA trust, token/cookie behavior, SSE/WebSocket,
mobile background recovery, and each plugin API.

## Main differences

| Area | Old `dsh-lan-proxy` | Native DSH `0.2.2-rc.1` |
| --- | --- | --- |
| Listener and forwarding | DSH stayed on loopback; the plugin exposed LAN and forwarded upstream over loopback | DSH directly binds one concrete LAN address; there is no plugin proxy layer |
| Address and authority | The proxy rewrote Host/Origin before reaching the loopback upstream | Native Host/Origin fences process LAN authorities directly |
| Authentication | Historical `injectToken` behavior could mint a session for eligible requests | Only the official startup-token exchange and signed-session authentication are accepted |
| Plugin API fence | The loopback upstream made some plugin requests appear local | Loopback keeps a fast path; non-loopback short requests must pass `requestRejection`, and long streams must additionally bind an admitted Peer lifecycle or fail closed |
| TLS certificate | Self-signed or custom certificates with the old package's management surface | User-supplied full certificate chain and unencrypted PEM private key |
| CA lifecycle | The old package provided a local CA, status, and certificate-download surface | No local CA management or client distribution; the deployment owns this lifecycle |
| HTTP compression | Brotli/gzip adaptive negotiation | `none | gzip` |
| WebSocket | Plugin path allowlist, compression bridge, and half-open keep-alive policy | The native remote mux negotiated `permessage-deflate` with Ping/inactive termination; old path-specific policies are not promised as equivalent and must be recorded per path |
| Domain access | Proxy rules handled the request, with IP-literal targets as the main path | A domain authority must be explicitly trusted and must pass the same-origin and authentication checks |
| Diagnostics | Old health, CA, and config routes | Removed with the package; use native startup output and host diagnostics instead of old routes |

## Migration steps

1. Back up plugin configuration, session data, and certificate material managed
   by the old package. Keep private keys and recovery packages out of source
   control, logs, issues, and pull requests. Do not delete old data before the
   backup is complete.
2. Upgrade DSH to the repository baseline `0.2.2-rc.1` and confirm
   `dsh --version`. Install plugin releases that exactly match that baseline;
   do not bypass peer checks to mix runtime versions.
3. Inspect the installed plugins. Remove the old package when it was installed
   independently. Bundle users must update to a bundle release that no longer
   contains the member.

   ```sh
   dsh plugin --profile web list
   dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
   dsh plugin --profile web update @wingsky-1/dsh-plugins-all
   ```

   Only a bundle release that contains the retirement change pulls the four
   remaining members. An ordinary update that still contains the old member has
   not completed the retirement.

4. If native LAN is actually needed, select **one concrete local address**,
   provide the certificate chain and key as a pair, and trust the authority that
   clients will visit. The following only shows the shape; replace every
   placeholder with deployment configuration and keep secrets out of public
   logs and repositories:

   ```sh
   dsh web \
     --host <concrete-local-ip> \
     --tls-cert <full-chain.pem> \
     --tls-key <unencrypted-private-key.pem> \
     --trusted-host <visited-authority> \
     --public-url https://<visited-authority>
   ```

   `--public-url` does not extend trust and wildcard binding is not a supported
   fallback. The certificate SAN must include the visited authority, and the
   client must trust its CA before connecting. Never commit, paste, or log the
   private key or startup token.

5. Restart `dsh web` and the browser. Complete the startup-token exchange from an
   isolated browser context, confirm the signed session, and then verify each
   plugin's API, SSE/WebSocket, Host/Origin, and unauthenticated rejection paths.
6. After migration and a no-credential access review, handle the old settings
   namespace, plugin-owned configuration, and certificate/CA directories
   according to the deployment's data-retention policy. Source retirement does
   not delete these files or automatically clean private material created by the
   old plugin.

## Per-plugin acceptance matrix

These checks define migration completion. Record an item as `NOT-RUN` until it
has a real result. Native TLS support or a loopback-only test cannot substitute
for the plugin-specific LAN check.

| Check | Requirement |
| --- | --- |
| Versions and loading | DSH and the bundle/individual plugins match exactly; the four feature packages load after restart |
| TLS trust | Certificate chain, key, SAN, client CA trust, and `Secure` cookie behavior pass |
| Host/Origin | The correct authority reaches auth; wrong Host, cross-site, and missing-token cases remain rejected |
| Plugin HTTP APIs | `mcp-manager`, `notifier`, and `provider-usage` each have results for representative read and write paths, including the official seam's 401/403/undefined branches |
| Long-stream lifecycle | Non-loopback SSE binds the admitted PeerScope; peer release stops broadcasts, removes the stream and closes it without leaving a writable connection |
| SSE/WebSocket | Long-connection setup, authentication, compression negotiation, Ping/reconnect, and background recovery are recorded per plugin, including acceptance on at least one real mobile device |
| Existing negative cases | The ordinary loopback 403/405 cases and native LAN unauthenticated 401 remain intact |
| Data and certificates | Old settings, configuration, and certificate material have backups; private keys stay out of repositories, logs, and public reports |

## Retention and rollback

- The old settings namespace, plugin configuration, and certificate/CA material
  are retained by default. The deployment decides whether to delete them after
  reviewing backups, private-key exposure, and business requirements.
- Published npm versions of the old package can still be installed explicitly,
  but they no longer follow the current DSH rc. A rollback must restore the DSH
  version and profile declaration that match that old plugin; do not add only the
  plugin back to the new host.
- After rollback, repeat the version, loading, HTTP/WS, Host/Origin, certificate
  trust, and unauthenticated-rejection checks. Rollback is not automatic and is
  not performed by this repository's retirement change.

## Historical evidence

The
[official LAN access overlap assessment](../architecture/dsh-lan-proxy-official-access-assessment.md)
preserved from before retirement records the decision basis for the old
baseline. It is historical material: it does not describe current `0.2.2-rc.1`
capabilities and does not promise native LAN compatibility or security. This
guide and real isolated verification define the current migration boundary.
