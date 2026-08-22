# @wingsky-1/dsh-web-file-preview
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-web-file-preview)](https://www.npmjs.com/package/@wingsky-1/dsh-web-file-preview)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

Click a file link in the conversation to preview file contents right in the **web client** (**image / text / Markdown / code / git Diff**).

DSH's built-in "clickable file reference" uses the desktop native opener when you click a produced-file chip / inline file reference — fine on desktop, but there is **no web-side preview** under a pure web deployment (LAN browser / iPad / iPhone, or `nativeOpen:false`). This plugin fills that gap: clicking a clickable file link in the conversation opens a **preview Modal inside the chat box** instead — images render directly via `<img>`, text via a monospace `<pre>`, and it adapts to light/dark themes.

## Capabilities

- **Image preview**: `png / jpg / jpeg / gif / webp / svg / avif / bmp`; click to enter a lightbox for zoom/pan (scroll-wheel zoom + drag).
- **Markdown preview**: `.md / .markdown` rendered by default (marked + common GFM features), switchable to "Raw".
- **Code syntax highlighting**: 25+ languages (`js/ts/py/java/…`, a highlight.js subset) highlighted, switchable to "Raw".
- **Text preview**: `txt / log / csv / conf …` shown monospace.
- **Diff view (git)**: for `.md/code/text` files inside a git repo with uncommitted changes, a 3rd **Diff** tab appears in the top bar, showing `git diff HEAD -- <file>` in red/green (untracked new files get a hint).
- In-Modal actions: **Preview / Raw / Diff**, **Copy path**, **Open in new tab**, **Close** (Esc / click the overlay).
- **`@`-mention adaptation (dsh rc8)**: conversation-bubble `@` references rendered as `data-ref-chip` (file/folder/session) are uniformly recognized — file references `@path` / `@"…"` click the chip to open the preview Modal with the **clean path** (stripped of leading `@` and quotes); folder references `@path/` show a lightweight notice (no directory browsing, no Modal); session references are explicitly ignored (orthogonal to file preview).
- **Load error state**: fine-grained error breakdown + "Open in new tab" fallback.
- **Caching**: no JS in-memory cache (files change often, permanent caching would show stale content); instead uses browser HTTP caching + host weak ETag (`Cache-Control: no-cache` + `If-None-Match`) for automatic negotiation — unchanged returns 304 instantly, changed fetches the latest automatically.

## Implementation

- **Host side**: `GET /api/dsh-file-preview/file?cwd=&path=` (absolute path may omit cwd; loopback fence — non-loopback → 403 / non-GET method → 405), located via `resolve(cwd, path)` (`~`/`~/` prefix expanded to the user home via `untildify`); suffix grouping: image/text/Markdown/code served directly, others → 415; text larger than `maxTextBytes` returns `413` + `truncated` (stat the size first, never read the whole file). `GET /api/dsh-file-preview/diff?cwd=&path=` (async execFile to compute the git diff) and `GET /api/dsh-file-preview/health` health check. File responses uniformly carry `X-Content-Type-Options: nosniff`; SVG additionally carries `Content-Security-Policy: sandbox`.
- **Client side**: dual interception mechanism (`workspaces.openPath` call-site hook + document-level static interception) + grouped rendering (`renderGroupFor`) + three tabs (Preview / Raw / Diff; Diff shows only when git has changes). Markdown uses `marked`, code uses a `highlight.js` subset, Diff uses `diff2html`.
- **Single source of truth for suffix grouping**: `src/grouping.ts` is shared by the host `mime.ts` and the client `renderer.ts`/`client.ts`, eliminating drift from two independently maintained suffix tables; `cleanRefChipPath` (the `@`-mention chip → clean path pure function) lives in the same file, serving as the inverse of DSH's `formatFileMention`.
- **Cross-package contract assumption (`@`-mention)**: recognition relies on the `data-ref-chip` attribute + `title="@…"` shape as produced by DSH `ui-conversation`. If DSH changes this shape in the future, a failed `data-ref-chip` gate means file chips silently fall back to "no response on click" (not a 404, acceptable degradation). If DSH later provides a clean-path attribute (e.g. `data-ref-path`), it will be adopted with priority.
- **Dependencies**: `marked` / `highlight.js` / `diff2html` / `untildify` are build-time bundled dependencies (inlined into `lib/index.js` and `lib/client.js` on the host/client respectively); Content-Type uses a built-in small mapping (no need for the large mime-db table, avoiding ESM/CJS compatibility issues from inlining host third-party dependencies).
- **Build size**: client esbuild `--minify`, `client.js` ~226KB minified (gzip ~68KB).

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-web-file-preview
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-web-file-preview
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-web-file-preview@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-web-file-preview
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-web-file-preview
```

## Configuration

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | When off, no routes are registered |
| `maxTextBytes` | `524288` (512KB) | Max bytes for text-like (text/markdown/code) previews; exceeding it returns `413` + `truncated` marker (`Cache-Control: no-store`), and the client prompts "file too large" and can open the original in a new tab |

## Verification

```sh
pnpm build && pnpm test                 # repo: build + smoke
curl http://127.0.0.1:3080/api/dsh-file-preview/health
```

## Security Model

- **⚠️ High-risk alert for LAN deployment (must read)**: When this plugin is exposed externally via `dsh-lan-proxy` (or any proxy that forwards external traffic to 127.0.0.1), the **loopback fence can be pierced because the proxy rewrites Host/Origin** — at that point **any device on the LAN** (without any dsh credentials/session) can directly access `/api/dsh-file-preview/file?path=…` to preview any file on this machine whose extension falls within the text/image/Markdown/code whitelist, **including credential/config files such as `~/.dsh/.credentials.yaml`, `~/.dsh/*.json`** (`path` supports `~` expansion and absolute paths, `stat` follows symlinks, and no escape interception is performed). Please deploy on a **trusted LAN** (do not expose to public WiFi/the internet), or configure **session auth / API-prefix allowlist** at the network layer before exposing it. The consequences after being pierced are borne by the deployer — per the "no redundant fallback" clause below, this plugin does not provide plugin-layer access control.
- **Keep the loopback fence**: all `/api` routes strictly verify a loopback source (cross-site / DNS-rebinding protection), consistent with the platform's existing convention; `/file`, `/diff` (other than `health`) also allow GET only (wrong method → 405). This fence is effective for **local/loopback direct connections**; whether it works against proxy-forwarded LAN access depends on whether the proxy rewrites Host/Origin (see the previous point).
- **No redundant fallback**: the semantics of this plugin are "being able to open the dsh web page already means holding high privilege", therefore it does **not** perform arbitrary-file-access strong validation, session auth, or sensitive-name interception — access control is the platform/user's responsibility, and this plugin does not re-implement each of those layers.
- **Path resolution**: `/file` locates directly via `resolve(cwd, path)` without "escape cwd" interception (arbitrary file access is the platform/user's responsibility). `~`/`~/` prefix expands to the user home.
- **Rendering safety**: file responses always carry `X-Content-Type-Options: nosniff`; SVG additionally carries `Content-Security-Policy: sandbox` (no inlined script execution on top-level navigation). Markdown / code rendering output is an HTML presentation layer; `marked` / `highlight.js` escape the body. This plugin does not promise XSS sanitization of rendered output — the previewed content comes from files already seen in the session, and the security boundary is the same as "being able to open dsh web means high privilege".
- **`@`-mention adds no new security surface**: `data-ref-chip`/`title` are read via `getAttribute` only and used as path strings in `URLSearchParams` — never rendered via `innerHTML`. Cleaned paths still go through the `/file` route's existing loopback/cwd fence (relative paths force cwd, absolute paths follow the existing process-readable scope), consistent with the same security model as "deliverable chip preview".

## Known Limitations

- Text-like content exceeding `maxTextBytes` (default 512KB) returns 413 + truncation marker and no longer reads the whole file (streaming/virtual-scroll for large files is not implemented, see the W10 initiative).
- The clickable scope is rather broad (any path title / local href / inline path text may enter preview); the `data-ref-chip` authoritative branch takes priority over generic sniffing to prevent false triggers from `@`-mentions.
- Folder `@`-references do not open a preview (only a notice); directory browsing is outside this plugin's scope.
- The client bundle includes `marked` + a `highlight.js` subset + `diff2html`, ~226KB minified (gzip ~68KB).
- Multi-session switching uses the cwd of the currently active session.
