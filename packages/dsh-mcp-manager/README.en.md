# @wingsky-1/dsh-mcp-manager
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-mcp-manager)](https://www.npmjs.com/package/@wingsky-1/dsh-mcp-manager)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

A **MCP server management plugin** for DSH (DeepSeek Harness): a floating window in the
top-right of the session UI + a tiered panel + quick onboarding (manual form + paste
`mcpServers` JSON import, **no servers preconfigured**), supporting **project-level MCP
that follows session switches**. Tools from connected servers are registered for the model
to call directly as `mcp__<serverName>__<rawName>`. The MCP protocol client is
implemented directly on top of `node:child_process` and the global `fetch` —
nothing extra to install.

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
| Model tools | Tools from connected servers registered as `mcp__<server>__<tool>` (64 chars, `[A-Za-z0-9_-]`, hashed suffix on conflict) |
| Reconnection | Exponential backoff (starts at 500ms, caps at 30s, gives up after 10 attempts and deregisters the tools) |
| Result truncation | Tool results truncated at 8KB and marked (prevents oversized JSON from entering context in full) |
| Timeout fallback | Tool call timeout defaults to 60s → 15s (overridable per server via `toolCallTimeoutMs`) |

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
