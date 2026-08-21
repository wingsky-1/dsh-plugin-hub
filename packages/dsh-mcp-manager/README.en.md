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
