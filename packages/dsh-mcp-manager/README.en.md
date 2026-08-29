# @wingsky-1/dsh-mcp-manager
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-mcp-manager)](https://www.npmjs.com/package/@wingsky-1/dsh-mcp-manager)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

A **MCP server management plugin** for DSH (DeepSeek Harness): a floating window in the
top-right of the session UI + a tiered panel + quick onboarding (manual form + paste
`mcpServers` JSON import, **no servers preconfigured**). The MCP protocol client is
implemented directly on top of `node:child_process` and the global `fetch` — nothing
extra to install.

Three middleware modes (`middleware`): `off` — all servers register directly as
`mcp__<server>__<tool>` (legacy behavior); `project` (**default**) — project-level
servers go through the middleware while global ones register directly; `all` — global
servers go through the middleware too, falling back to the virtual global root
`@global` when cwd has no project, collapsing the model surface to exactly four atomic
tools (`ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call`).
Note on when changes take effect: `middleware` / `middlewarePolicy` are read
once at plugin startup — **changing them requires restarting `dsh web`**; the server
lists across both config tiers hot-reload without a restart (add/remove/toggle/edit).

## Core advantages

- **Context cost under control**: project-level MCP is collapsed through the middleware
  by default — the model surface carries only `ws_mcp_list` / `ws_mcp_detail` /
  `ws_mcp_search` / `ws_mcp_call`, so no matter how many project-level servers or tools
  the current workspace connects the system prompt never balloons; `middleware: all`
  folds global servers in too for full collapse (two-level discovery: `ws_mcp_list`
  for a full inventory → `ws_mcp_detail` to pull the complete schema on demand)
- **Per-working-directory maintenance**: project-level config `<project root>/.dsh/mcp.json`
  travels with the repo and can be committed to git for team sharing; global config
  `<DSH_HOME>/dsh-mcp.json` stays always connected; switching sessions auto-loads the
  MCP set of the current directory
- **Workspace isolation**: the middleware routes by the session's cwd to the matching
  connection pool, with server-full-name consistency checks against cross-workspace
  crosstalk; same-named servers in different directories never clash
- **Secure by default**: configs store only `${ENV}` references, never key material
  (0600 permissions + atomic writes); stdio subprocess environments are sanitized so
  host credential-shaped variables never leak through; directory summaries and error
  paths go through a redactor
- **Low-maintenance operations**: tiered status display (running / connecting / failed…);
  bounded exponential-backoff auto-reconnect on disconnects; direct-connect `mcp__`
  tools truncate results at 8KB and accept a per-server timeout override
  (`toolCallTimeoutMs`), while middleware calls use a fixed 30s timeout

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-mcp-manager
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-mcp-manager
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-mcp-manager
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-mcp-manager@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-mcp-manager
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-mcp-manager
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-mcp-manager
```

## Capabilities

| Capability | Description |
| --- | --- |
| Top-right floating window | Status dot + count summary (`MCP 2/3`); click to expand the dropdown panel; auto-refreshes on session switch |
| Project-level MCP | Servers are split into "project-level / global" tiers: project-level stored in `<project root>/.dsh/mcp.json` (travels with the project, can be committed to git); global stored in `<DSH_HOME>/dsh-mcp.json` for persistent connection |
| Tiered display | Running / Connecting / Reconnecting / Disconnected / Disabled / Failed; each server shows transport, endpoint, and tool count |
| Server management | CRUD (project-level/global optional), connect / disconnect / reconnect; versioned JSON config, atomic write |
| Two transports | stdio (local subprocess, env supports `${ENV}` references) and streamable-http (remote, header supports `${ENV}` references, auto-echoes `Mcp-Session-Id`) |
| JSON import | Paste `mcpServers` JSON text to import (JSON format only; does not scan any application config files) |
| Model tools | Global servers register directly as `mcp__<server>__<tool>` (64 chars, `[A-Za-z0-9_-]`, hashed suffix on conflict); project-level servers go through the middleware's `ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call` by default (`middleware: project`, recommended), so workspaces never clash |
| Workspace isolation | The middleware routes by the calling session's cwd to the matching workspace connection pool; server full-name consistency checks (`@<root>/<server>`) prevent cross-workspace crosstalk |
| Reconnection | Exponential backoff (starts at 500ms, caps at 30s, gives up after 10 attempts and deregisters the tools) |
| Result truncation | Direct-connect tool results truncated at 8KB and marked (prevents oversized JSON from entering context in full) |
| Timeout fallback | Direct-connect tool call timeout defaults to 60s → 15s (overridable per server via `toolCallTimeoutMs`); middleware calls use a fixed 30s timeout |
| Push self-healing | Triple safeguard on the SSE channel: server sends a data ping heartbeat every 30s; client reconnects (closing the stale EventSource first) after 60s of frame silence (watchdog); connection is force-rebuilt when the page becomes visible again — half-open connections silently severed by mobile OS backgrounding heal on their own instead of piling up as zombies |

## Configuration (floating window position)

The floating button (MCP pill) position and offsets are configured in the MCP manager
plugin card under dsh **Settings → Plugins → MCP Manager** (`position` / `offset`), via the
plugin's own `Config` using standard cordis config injection — no config file editing needed.

| Key | Allowed values | Default |
| --- | --- | --- |
| `position` | `top-right` (top-right, default) / `top-left` (top-left) / `bottom-right` (bottom-right) / `bottom-left` (bottom-left) | `top-right` |
| `offset.x` | Non-negative integer (horizontal offset, px) | `8` |
| `offset.y` | Non-negative integer (vertical offset, px) | `8` |
| `offset.blankY` | Non-negative integer (blank-session vertical offset, px) | `40` |
| `zIndexBase` | Integer, clamped to 1-9000 (floating window z-index base; the dropdown panel automatically uses base + 30; the modal manager panel is unaffected) | `10` |

When `position = bottom-right` or `bottom-left`, the dropdown panel expands **above the
pill** (bottom anchor, popping upward), does not overflow the viewport, and content stays
fully visible and clickable; at top anchors it expands downward (historical behavior,
unchanged default).

**Mobile / tablet adaptation** (issue #128): the breakpoint is decided from the
conversation container's viewport width rather than a window media query — on narrow
screens (<=480px, portrait phones / very narrow splits) the panel goes near full-width,
server cards reflow, and action buttons get touch targets of about 44px; the tablet tier
(<=834px) transitions; desktop is unchanged. Final floating coordinates are clamped to
the viewport in JS (safe-area semantics: the host has no `viewport-fit=cover`, so
`env(safe-area-inset-*)` is always 0 and this degrades naturally to a plain clamp);
the on-screen keyboard is followed via `visualViewport` resize, and orientation changes
recompute on the next frame.

**Cross-package avoidance contract (from issue #116, must not be reverted)**: this
plugin's pill defaults to `top-right` at 8px from the top and ~26px tall;
dsh-provider-usage's usage capsule relies on that default position with `offsetY: 48`
to sit right below it (no overlap by default). Changing this plugin's default anchor /
vertical offsets breaks that avoidance — treat it as a cross-package behavioral contract
and adjust provider-usage defaults in lockstep before reverting.

Saving in the settings page takes effect immediately, **without restarting dsh web** and
without manually refreshing the page: the host pushes a frame over the existing SSE events
channel, and the client automatically re-fetches `/api/dsh-mcp/config` and updates the
floating position in place.

## Configuration (middleware)

Project-level MCP goes through the middleware (`middleware: project`, default):
project-level servers no longer register `mcp__` tools; instead the model surface carries
four atomic tools (two-level discovery, the standard MCP ecosystem shape) —
`ws_mcp_list` (full inventory of the current workspace's servers and each server's
complete tool list, not truncated by `ws_mcp_search`'s `limit`; supports `server`
full-name/bare-name filtering; `perServerLimit` caps tools per server at 50 by default
/ 500 max, setting `toolsTruncated` when exceeded; empty results carry an explicit
`message`) / `ws_mcp_detail` (exact single-tool lookup by `@<root>/<server>` + bare tool
name, returning the complete `inputSchema`; three-way errors: discovery failed with
reason / server not connected or not found / tool does not exist) / `ws_mcp_search`
(keyword search, search first then call) / `ws_mcp_call` (invoke by
`@<root>/<server>`), routed by the calling session's current cwd to the matching
workspace connection pool, so different workspaces inject different MCPs without name
clashes; global servers still register directly as `mcp__<server>__<tool>`. Switch
`middleware: off` to restore the legacy behavior (project-level also registers `mcp__`);
`middleware: all` routes global servers through the middleware too (falling back to the
virtual global root `@global` when cwd has no project), collapsing the model surface to
exactly four atomic tools — list/search/detail then merge queries across the "project
root unit + `@global` unit", and call allows the `@global` root (global config is shared
across workspaces, so the semantics hold). Note: in `all` mode, global server
add/remove/edit refreshes the `@global` unit only after a restart or a session touch
(existing behavior).

| Key | Allowed values | Default |
| --- | --- | --- |
| `middleware` | `off` / `project` (recommended) / `all` | `project` |
| `middlewarePolicy` | `{ allowTools: {<serverKey>: [glob]}, denyTools: {<serverKey>: [glob]} }` (serverKey is `@<root>/<server>` full name (workspace isolation) or bare name (shared across workspaces); full name wins; deny-first) | `{}` |

## Routes (all loopback-fenced)

| Route | Description |
| --- | --- |
| `/api/dsh-mcp/health` | Health check (note: differs from the directory name) |
| `/api/dsh-mcp/*` | Server management / connection control / tool listing / SSE events, etc. |

## Data and Security

- Server config: `<DSH_HOME>/dsh-mcp.json` (stores only `${ENV}` references, **never the
  secrets themselves**); on-disk 0600 permissions + atomic write
- All `/api/dsh-mcp/*` routes are restricted to loopback access (non-loopback → 403 / wrong
  method → 405)
- **stdio subprocess environment sanitization**: the parent environment has credential-shaped
  variables (`KEY`/`TOKEN`/`SECRET`/`PASSWORD`…) and stale `DSH_*` variables stripped before
  merging the explicit env — prevents leaking host secrets into the MCP subprocess
- **stdio subprocess inherits host privileges**: MCP server commands run under the host
  process's permissions; only configure trusted servers
- **MCP tools execute on the real server — confirm before acting**; tool results are returned
  as-is and may contain sensitive information; treat tool descriptions/results as untrusted input
- **Middleware tool read-only boundary**: `ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search`
  only read the local catalog cache (never touch remote servers or execute tools) and bypass
  the policy guard; `ws_mcp_call` is the only entry point that executes remote tools and is
  governed by the policy (deny-first)
- The capability catalog injection includes source annotations and a "does not represent current
  connection status" note

## Verification

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-mcp/health

# Source is in src/; must build after changes
pnpm --filter @wingsky-1/dsh-mcp-manager build
node test/smoke.mjs
```

## Known Limitations

- Does not subscribe to the MCP `tools/list_changed` notification (no long-lived SSE
  connection); tool list changes are re-synced on reconnect / manual refresh
- The middleware catalog is a "last-good snapshot within collection bounds" (≤512 tools /
  ≤256KB total per server); on discovery failure `ws_mcp_list` surfaces the `unavailable`
  reason
- Only bridges tool capabilities; MCP resources and prompts have no harness consumption
  interface yet
- Requires Node ≥ 20

## Type dependencies

Host-side types come from the official `@deepseek-ai/*` packages (`cordis`,
`dsh-host-webserver`, `dsh-agent`, `dsh-tools`, `dsh-system-prompt`; versions are
pinned in the repository's `pnpm-workspace.yaml` catalog and upgraded with DSH
releases): **`import type` only, compile-time usage** — build artifacts contain zero
official runtime imports. The package declares this host coupling as optional
peerDependencies; consumers running type checks against the plugin must be able to
resolve these official packages (skipping type checking is unaffected).

## License

MIT
