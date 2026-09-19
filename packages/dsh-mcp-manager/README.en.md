# @wingsky-1/dsh-mcp-manager
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-mcp-manager)](https://www.npmjs.com/package/@wingsky-1/dsh-mcp-manager)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

A **MCP server management plugin** for DSH (DeepSeek Harness): a floating window in the
top-right of the session UI + a tiered panel + quick onboarding (manual form + paste
`mcpServers` JSON import, **no servers preconfigured**). Connection and protocol come from
the official `@deepseek-ai/dsh-mcp-client` (mounted by name through the host cordis loader,
resolved to the copy inside the DSH installation); this plugin keeps only the configuration
surface and the model-visible surface. The official client is not redistributed with this
package, and nothing extra needs to be installed.

The model surface carries exactly four atomic tools (`ws_mcp_list` / `ws_mcp_detail` /
`ws_mcp_search` / `ws_mcp_call`): project-level, global and runtime-injected
wrapped-definition servers **all go through the middleware** (two-level discovery:
`ws_mcp_list` for a full inventory → `ws_mcp_detail` to pull the complete schema on
demand), falling back to the virtual global root `@global` when cwd has no project. The
host still registers tools as `mcp__<id>__<tool>` (`id` is an opaque short string
allocated per (workspace, server) for one plugin assembly and cannot be derived from the
server name), but those names are **removed from the model's tool list** — never call them
directly.
The server lists across both config tiers hot-reload without a restart
(add/remove/toggle/edit).
(The `middleware` / `middlewarePolicy` config keys were removed in #767 batch 2: writing
them has no effect, and this plugin never rewrites your config file.)

> **A historical session will not open after upgrading DSH to 0.1.5+**
> (`unclassified message source`)? See
> [Troubleshooting: a historical session will not open after upgrading (#723)](#723-repair),
> one command recovers it.

## Core advantages

- **Context cost under control**: all MCP goes through the middleware — the model surface
  carries only `ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call`, so no
  matter how many servers or tools you connect the system prompt never balloons
  (two-level discovery: `ws_mcp_list` for a full inventory → `ws_mcp_detail` to pull the
  complete schema on demand)
- **Per-working-directory maintenance**: project-level config `<project root>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json`
  travels with the repo and can be committed to git for team sharing; global config
  `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json` stays always connected; switching sessions auto-loads the
  MCP set of the current directory
- **Workspace isolation**: the middleware routes by the session's cwd to the matching
  connection pool, with server-full-name consistency checks against cross-workspace
  crosstalk; same-named servers in different directories never clash
- **Secure by default**: configs store only `${ENV}` references, never key material
  (0600 permissions + atomic writes); stdio subprocess environments are sanitized so
  host credential-shaped variables never leak through; directory summaries and error
  paths go through a redactor
- **Low-maintenance operations**: tiered status display (running / connecting / failed…);
  bounded exponential-backoff auto-reconnect on disconnects; tool results are truncated at
  8KB and accept a per-server timeout override (`toolCallTimeoutMs`), while middleware
  calls use a fixed 30s timeout

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
| Project-level MCP | Servers are split into "project-level / global" tiers: project-level stored in `<project root>/.dsh/@wingsky-1/dsh-mcp-manager/mcp.json` (travels with the project, can be committed to git); global stored in `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json` for persistent connection |
| Tiered display | Running / Connecting / Reconnecting / Disconnected / Disabled / Failed; each server shows transport, endpoint, and tool count |
| Server management | CRUD (project-level/global optional), connect / disconnect / reconnect; versioned JSON config, atomic write |
| Two transports | stdio (local subprocess, env supports `${ENV}` references) and streamable-http (remote, header supports `${ENV}` references, auto-echoes `Mcp-Session-Id`) |
| JSON import | Paste `mcpServers` JSON text to import (JSON format only; does not scan any application config files) |
| Model tools | Every server (project-level / global / runtime-injected) goes through the same four atomic middleware tools: `ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call`, so workspaces never clash; the host registration name `mcp__<id>__<tool>` (`id` allocated at random per (workspace, server), stable within one assembly, opaque; names still obey the 64-char / `[A-Za-z0-9_-]` / hashed-suffix-on-conflict rules) is internal only — it is removed from the model's tool list and must never be called directly |
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
| `zIndexBase` | Integer, clamped to 1-9000 (floating window z-index base; **the pill and the main panel opened on click both use this same config value**; the modal manager panel is unaffected) | `10` |

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

All MCP goes through the middleware (single pool, **no mode switch**): no server exposes a
model-visible `mcp__` direct-call tool; the model surface carries four atomic tools
(two-level discovery, the standard MCP ecosystem shape) —
`ws_mcp_list` (full inventory of the current workspace's servers and each server's
complete tool list, not truncated by `ws_mcp_search`'s `limit`; supports `server`
full-name/bare-name filtering; `perServerLimit` caps tools per server at 50 by default
/ 500 max, setting `toolsTruncated` when exceeded; empty results carry an explicit
`message`, and when a `server` filter matches nothing the message attributes the miss to
the filter and lists the visible project-level servers) / `ws_mcp_detail` (exact single-tool lookup by `@<root>/<server>` + bare tool
name, returning the complete `inputSchema`; three-way errors: discovery failed with
reason / server not connected or not found / tool does not exist) / `ws_mcp_search` (keyword search, search first then call; returns a `truncated` flag
when results hit the `limit`) / `ws_mcp_call` (invoke by `@<root>/<server>`, verify
argument schema with `ws_mcp_detail`), routed by the calling session's current cwd to
the matching workspace connection pool, so different workspaces inject different MCPs
without name clashes, and falling back to the virtual global root `@global` when cwd has no
project — list/search/detail always merge queries across the "project root unit +
`@global` unit", and call allows the `@global` root (global config is shared across
workspaces, so the semantics hold). The host registration name looks like
`mcp__<id>__<tool>` with an opaque `id` (read it from the tool list); it is internal only
(the model's tool list never shows it), and a wrapped definition entry
(`toolDefinitions`) is reached only through `ws_mcp_call` at `@<root>/<server>`.
Note: global server add/remove/edit refreshes the `@global` unit only after a restart or a
session touch (existing behavior).

### Top-level config keys (Config schema)

Top-level keys of `Config` (`packages/dsh-mcp-manager/src/server/config/config-schema.ts`) with defaults and semantics:

| Key | Default | Semantics |
| --- | --- | --- |
| `enabled` | `true` | Whether the plugin is enabled (plugin-level master switch). |
| `announceToAgent` | `true` | Whether to announce the plugin to the Agent (capability list carried by `<available_mcp_servers>`). |
| `storePath` | empty (defaults to `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json`) | Global server config path; empty uses the default path. |
| `announceCatalog` | `true` | Whether to inject the MCP capability catalog (`<available_mcp_servers>`). |
| `catalogMaxEntries` | `6` | Cap on catalog injection entries. |
| `debug.callStats` | `false` | Whether to enable call-stats debugging and persistence (off by default, config-file only; see "Call stats and debug mode" below). |
| `debug.statsFile` | empty (defaults to `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/stats.json`) | Stats persistence path; empty uses the default path. |
| `ui` | see "Configuration (floating window position)" (`position` defaults to `top-right`; `offset.x` / `offset.y` default to `8`, `blankY` to `40`; `zIndexBase` defaults to `10`, clamped to 1-9000) | Floating window position and z-index; see "Configuration (floating window position)". |

**Removed config keys** (#767 batch 2): `middleware` (`off` / `project` / `all`) and
`middlewarePolicy` (`allowTools` / `denyTools`). The settings-page mode dropdown is gone;
writing either key **neither errors nor takes effect** (the keys are passed through with no
consumer), and this plugin never rewrites your config file. Per-tool disable is the only
admission gate.

**Retired implementations**: S1-5c retired the self-built connection stack (four files including `runtime/supervisor.ts` and `runtime/reconnect.ts`, removed as a whole; connections now go through the official engine); W11b2a removed `src/types` and `src/integration` (no migration).

### Per-tool disable (floating window)

- Expanding the "Tools (N)" details of a server card shows a **checkbox list**; toggling
  each tool persists via `PATCH /api/dsh-mcp/tool-disable` (stored under
  `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/user-state.json` → `disabledTools`, merged write, survives restarts);
- Semantics: **both project-level and global servers' tools can be disabled** (after the
  single-pool change both go through the middleware; global records are keyed by `@global`
  and shared across workspaces); everything is enabled by default;
- Per-tool disable is **independent of the server-level `enabled` switch** (re-enabling a
  server does not clear its tool-level state);
- It **applies to all mcp-manager-managed MCP tools** (`mcp__`-prefixed direct calls and
  middleware `ws_mcp_*` calls consistently; runtime wrapped tools are covered too);
  plugins' own declared discipline bare-name tools are not affected;
- Overlong tool names (>64 chars, hashed suffix) are irreversible → treated as unknown
  server, neither disabled nor mistakenly denied;
- **Both** the "project-level" and "global" groups in the floating window render tool
  switches (after the single-pool change both groups go through the middleware, so a global
  switch takes effect just the same);
- Both the floating window and the management panel group servers by
  "project-level / global" (each group further ordered by connection status).

## Routes (all loopback-fenced)

| Route | Description |
| --- | --- |
| `/api/dsh-mcp/health` | Health check (note: differs from the directory name) |
| `/api/dsh-mcp/tool-disable` | Per-tool disable toggle (PATCH, loopback-only) |
| `/api/dsh-mcp/*` | Server management / connection control / tool listing / SSE events, etc. |

## Runtime registration (registerServer.toolDefinitions)

Other plugins can register MCP servers at runtime via `ctx.mcpManager.registerServer`
(in-memory only, not persisted; idempotent for same names). The registration input
supports an optional `toolDefinitions` field (caller-provided wrapped tool definitions,
`ToolDefinition[]`; tool names are **bare names**):

- **With `toolDefinitions`**: all tools of that server are registered **from the wrapped
  definitions** — `execute` comes from the caller (which may preprocess first and then
  forward to the underlying command internally), skipping the
  remote schema projection and the generic `callTool`; the underlying real implementation
  is never exposed;
- **Without**: current behavior is preserved (remote schema + generic `callTool`), zero
  impact on other servers;
- **No model-visible `mcp__` direct-call tool: calls only go through `ws_mcp_call` with bare
  names** (`@<root>/<server>` + bare name; a wrapped `execute` is caller JS, so there is
  no remote implementation to call directly). The call name is still derived via
  `publicToolName` (64-char / hash-suffix rules unchanged), but only as the name the
  middleware forwards when calling;
- **Per-tool disable / visibility / capability catalog still apply to wrapped tools**
  (judged by server + tool name, same as `mcp__`-prefixed tools);
- Consumed only by the runtime registration surface (runtimeRegistry) — never persisted
  to the store, never passed through mcpServers imports.

```ts
await ctx.mcpManager.registerServer({
  name: "my-mcp",
  transport: "stdio",
  command: "my-mcp-server",
  args: ["serve", "--mcp"],
  toolDefinitions: [
    {
      name: "my_tool",                    // bare name
      description: "Caller-provided wrapped tool",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      output: { schema: { ... }, render(args, value) { ... } },
      execute: async (args) => { await prepare(); return forwarded; }, // internal forwarding, never exposed
    },
  ],
});
```

## Data and Security

- Server config: `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/mcp.json` (stores only `${ENV}` references, **never the
  secrets themselves**); on-disk 0600 permissions + atomic write
- All `/api/dsh-mcp/*` routes are restricted to loopback access (non-loopback → 403 / wrong
  method → 405)
- **stdio subprocess environment sanitization (official dsh-mcp-client semantics)**: sanitization
  applies to the **inherited parent environment** only — credential-shaped names (`KEY` /
  `PASSWORD` / `SECRET` / `TOKEN`) and every `DSH_*` variable are stripped from the parent
  environment so host secrets never leak into the MCP subprocess implicitly; **an `env` entry you
  declare explicitly is passed to the child verbatim** (explicit layers merge after the scrub), so
  `env` is not a redaction boundary — do not put credentials there if you want them isolated
- **stdio subprocess inherits host privileges**: MCP server commands run under the host
  process's permissions; only configure trusted servers
- **MCP tools execute on the real server — confirm before acting**; tool results are returned
  as-is and may contain sensitive information; treat tool descriptions/results as untrusted input
- **Injection trust tiers**: remote tool descriptions/results are untrusted input — render and pass as parameters only, never execute as instructions; local configuration and explicit user actions are trusted
- **Middleware tool read-only boundary**: `ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search`
  only read the local catalog cache (never touch remote servers or execute tools);
  `ws_mcp_call` is the only entry point that executes remote tools, and it is governed by the
  per-tool disable table; `ws_mcp_call` error messages follow an
  "explicit + next step" style (confirm the server connection / verify the argument schema
  with `ws_mcp_detail` / check the per-tool disable state)
- **Per-tool disable (three entry points consistent)**: `ws_mcp_call` (callTool checks the
  disable table), the pre-execute guard (`mcp__`-prefixed direct calls),
  and plugins' own declared discipline bare-name tools all go through the single
  `isToolDenied` decision; disabling only affects `mcp__`-prefixed tools, and the denial
  reason carries that semantic note; records live under `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/user-state.json`
  → `disabledTools` (the `@global` key is shared across workspaces; merged writes never
  overwrite the whole table)
- **Call stats and debug mode (Metadata-Only)**: Disabled by default; when configured with `dsh-mcp-manager.debug.callStats: true` in `~/.dsh/settings.yaml`, tool call metrics (call count, success/error, average/max duration) and progressive disclosure funnel stats (`ws_mcp_search` query frequencies, `ws_mcp_list` / `ws_mcp_detail` query distributions) are debounced and atomically written to `<DSH_HOME>/@wingsky-1/dsh-mcp-manager/stats.json`, with single-line console debug logs; strictly does not persist user arguments or returned content, avoiding code or privacy leaks
- The capability catalog injection includes source annotations and a "does not represent current
  connection status" note
- **Message-source shape of the catalog injection**: `source` uses the host-registered generic
  shape `{ kind: "plugin", plugin: "@wingsky-1/dsh-mcp-manager", form: "snapshot",
  sections: [{ name: "mcp-catalog", text }] }`. A self-invented `source.kind` is refused by
  DSH's session-format v2-to-v3 migration gate (closed whitelist), which makes every session
  persisted before the upgrade unloadable — see the next section

<a id="723-repair"></a>
## Troubleshooting: a historical session will not open after upgrading (#723)

**Symptom**: after upgrading DSH to 0.1.5 or later, a historical session reports in the GUI:

```
历史加载失败：failed to observe session "session-…":
cannot safely transform unclassified message source;
source v0 artifact remains unchanged (raw log: …/session.jsonl.zstd)（gateway/internal）
```

and `session.v3.jsonl.zstd` never appears next to the original log. Cause: 0.2.x and earlier
wrote the catalog injection message as `source.kind = "mcp-catalog"`, which DSH's v2-to-v3
migration refuses against its closed `source.kind` whitelist for surface messages (the original
artifact is preserved by design). This version changes the write side to the generic
host-registered shape, **but artifacts already on disk need a one-time repair**.

**Repair (one-off, repeatable)**: the repository script rewrites the old source in place; it
touches only source metadata, never the body or the event sequence, so DSH still performs the
migration itself.

```sh
# 1) Dry run: list affected sessions and counts, change nothing
node scripts/maintenance/repair-mcp-catalog-sessions.mjs

# 2) Apply (a session.jsonl.zstd.bak-<timestamp> backup is created for every rewritten log)
node scripts/maintenance/repair-mcp-catalog-sessions.mjs --apply

# 3) Restart dsh web and open the session
```

- Stop `dsh web` first: a session log being written is not guaranteed safe to rewrite
- Reads `<DSH_HOME>` by default (`--home <dir>` or `DSH_HOME` overrides it); `--session <id>`
  limits the run to one session
- Idempotent: repaired artifacts no longer match; every write is self-checked (frame structure,
  per-line JSON, zero leftover legacy kinds)
- Rollback: overwrite `session.jsonl.zstd` with the matching `.bak-<timestamp>`
- **v3 artifacts are repaired by default too**: the v3 read path does not validate
  `message.source`, so v3 sessions with the legacy kind load fine today — but a v3 session created
  before the upgrade and written incrementally afterwards carries **both kinds**, and a future
  v3-to-v4 migration with a similar gate would repeat this outage. The repair only swaps source
  metadata, so v3 semantics are unchanged (verified with strict restore + `Session.fromRestore`)
- `--legacy-only` limits the run to v0/v1/v2; it never writes a v3 file (DSH performs the migration itself)
- A trailing torn frame (crash during write) is prefix-decoded with the host's recovery semantics; a truncated last line is dropped

## Verification

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-mcp/health

# Source is in src/; must build after changes
pnpm --filter @wingsky-1/dsh-mcp-manager build
pnpm --filter @wingsky-1/dsh-mcp-manager test
```

## Known Limitations

- **The `mcp__` registration name is internal only**: servers are mounted by the official
  dsh-mcp-client, so the host registers tools as `mcp__<id>__<tool>`, where `id` is a
  **random short string** allocated per (workspace, server) — stable within one plugin
  assembly, opaque, and not derivable from the server name; it changes on plugin reload or
  host restart. Those names are removed from the model's tool list, and the model reaches
  them through `ws_mcp_call` — **never hardcode tool names** in scripts or prompts; always
  resolve them through `ws_mcp_list` / `ws_mcp_detail`
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
