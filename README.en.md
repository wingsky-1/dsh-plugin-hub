# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

[简体中文](README.md) | **English**

A collection of plugins for the **DSH (DeepSeek Harness)** web GUI, distributed via npm:
install them all at once as a single bundle, or pick individual plugins as needed.

- **Bundle package**: `@wingsky-1/dsh-plugins-all` — install everything in one shot
  (`dsh-codegraph` is published standalone and not in the bundle; see plugin list below)
- **Individual plugins**: `@wingsky-1/dsh-*` — install only what you need

## Core advantages

- **Security built into the defaults**: minimal exposure surface and minimal credential
  flow — management surfaces answer only on loopback, keys by default never persist in
  plaintext nor reach the browser; each plugin's threat model and hardening details live
  in its README security section
- **Context-cost-controlled MCP management**: project-level MCP is collapsed into the
  four atomic tools `ws_mcp_list` / `ws_mcp_detail` / `ws_mcp_search` / `ws_mcp_call`
  by default, so project-level scale never balloons the context (`middleware: all` folds
  global servers into the middleware too, hot-switchable from the settings page);
  per-working-directory project/global config tiers let each repo carry its own
  MCP servers without cross-project interference
- **Extensible usage-stats framework**: a generic v2 adapter contract with DeepSeek
  official and OpenCode Go built in out of the box; write one mjs file to plug in any
  data source, hot-swappable from the settings page
- **Engineering-quality backing**: every plugin ships smoke assertions (route fences /
  client contracts), plus build contract + pack checks + full gates run in CI

## Version support (rc only)

This plugin set only adapts to **rc (release-candidate) releases of DeepSeek Harness — alpha versions are not supported**.

- All plugins are currently pinned to `dsh 0.1.2-rc.1` (the official type-layer catalog and
  every package's peerDependencies are locked in lockstep)
- npm/pnpm will surface a peer mismatch if your dsh version does not match — upgrade the
  dsh CLI to the corresponding rc release first
- Per-release adaptation baselines, breaking changes and upgrade guides live in
  [Release Notes](docs/release-notes/)
- The plugin set follows official rc releases; **alpha versions are unsupported** — do not
  install on an alpha dsh (or accept the compatibility risk yourself)

## Plugin list

| Package | What it does | Docs | Status |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | Task-event notification center: 6 event kinds (ask / approval / completion / subagent completion / error / turn end), dual channels (browser Notification + host system toast) plus Bark/Webhook push channels (ntfy, Gotify, self-hosted gateways); quiet hours with urgent exceptions, approval-timeout re-reminders, completion-storm aggregation, notification text redaction | [README](packages/dsh-notifier/README.md) · [Architecture](docs/architecture/dsh-notifier.md) | Published |
| `@wingsky-1/dsh-provider-usage` | Multi-provider usage stats framework (v2 adapter contract): persistent capsule + detail panel; DeepSeek official (interval-bookkeeping daily usage derivation + peak/valley countdown badge — works even without an official usage endpoint) and OpenCode Go built in; plug in any data source with a single mjs file, hot-swappable from the settings page; daily/weekly/monthly usage reports (generated via the host llm); API keys stay on the host, never reach the browser | [README](packages/dsh-provider-usage/README.md) · [Adapter guide](packages/dsh-provider-usage/docs/adapter-guide.md) · [Architecture](docs/architecture/dsh-provider-usage.md) | Published |
| `@wingsky-1/dsh-lan-proxy` | Access the dsh web UI over LAN: HTTP/HTTPS/WS forwarding + TLS (self-signed / custom certs); dual compression for HTTP (Brotli/gzip adaptive) and WebSocket (permessage-deflate); WS half-open probing keeps mobile backgrounding from going stale; launch-token auto-injection lets LAN devices connect without fetching the token; DNS-rebinding protection + loopback target allowlist | [README](packages/dsh-lan-proxy/README.md) · [Architecture](docs/architecture/dsh-lan-proxy.md) | Published |
| `@wingsky-1/dsh-mcp-manager` | MCP server manager (stdio / streamable-http): per-working-directory project/global config tiers; project-level MCP collapsed into 4 atomic tools via middleware by default (`middleware: all` folds in global servers, hot-switchable in the settings page); workspace isolation prevents cross-project interference; configs store `${ENV}` references only — no plaintext secrets on disk; runtime registration API for other plugins to inject MCP servers | [README](packages/dsh-mcp-manager/README.md) · [Architecture](docs/architecture/dsh-mcp-manager.md) | Published |
| `@wingsky-1/dsh-web-file-preview` | Web-side preview for conversation file links: images (lightbox zoom) / Markdown (with Mermaid diagram rendering) / code (25+ languages highlighted) / text / git Diff / sandboxed HTML preview (iframe sandbox, no script execution); @-mention recognition + path fallback search (unique basename match inside the workspace when the referenced path is wrong) | [README](packages/dsh-web-file-preview/README.md) · [Architecture](docs/architecture/dsh-web-file-preview.md) | Published |
| `@wingsky-1/dsh-verify-isolated` | Isolated-environment browser verification skill for DSH plugin development: temp DSH_HOME + independent profile + independent port + independent browser instance (four-way isolation), one-command launch with automatic cleanup; bundled zero-dependency raw-CDP browser driver (snapshot / click / screenshot / eval), optional isolation audit | [README](packages/dsh-verify-isolated/README.md) · [Architecture](docs/architecture/dsh-verify-isolated.md) | Published |
| `@wingsky-1/dsh-codegraph` | codegraph local code-graph MCP + worktree development discipline: 8 wrapper tools (impact / call chains / symbol search / file structure, etc.); queries force a sync first to guarantee index freshness and auto-complete projectPath; registered at runtime via mcp-manager | [README](packages/dsh-codegraph/README.md) · [Architecture](docs/architecture/dsh-codegraph.md) | Published (standalone, not in the bundle) |

> **Standalone note**: `@wingsky-1/dsh-codegraph` is published **standalone** and is **not
> included in `dsh-plugins-all`**; install it separately (it registers the codegraph MCP at
> runtime via mcp-manager, so install `dsh-mcp-manager` or the bundle first).

<details>
<summary><b>Historical maintenance & migration</b> — discontinued packages and legacy-package migration (expand if you installed the old/retired packages)</summary>

**Discontinued (do not install; deprecated on npm)**:

- `@wingsky-1/dsh-skill-explorer` (skill-center / skill management) is discontinued; both the
  plugin package and the bundle package have been removed. A better implementation now ships
  on the web UI side, `@linxin666/dsh-client-ui-skill-explorer` (`dsh-web-ui` repository
  `packages/dsh-skill-explorer`), which supports symlink detection, safe handling of linked
  skills, and more. Use the built-in skill center in the web UI instead.
- `@wingsky-1/dsh-idle-archive` (idle-conversation archiving prompt) is discontinued because
  the community offers more mature session lifecycle-management / archiving implementations
  (e.g. [dsh-session-pruner](https://github.com/mrzhangkris/dsh-session-pruner)).
- `@wingsky-1/dsh-subagent-model-inherit` (child agents inherit parent-session model and
  reasoning effort) is discontinued because official dsh-subagent 0.1.2-alpha.2 natively
  implements `resolveChildAgentOptions` (child agents inherit the parent session's model /
  reasoning effort / output-token limit).

Uninstall these packages if you installed them before:

```sh
dsh plugin --profile web remove @wingsky-1/dsh-skill-explorer
dsh plugin --profile web remove @wingsky-1/dsh-idle-archive
dsh plugin --profile web remove @wingsky-1/dsh-subagent-model-inherit
```

> dsh-memory (project long-term memory) is not included yet; it is planned.

**Legacy packages (published historically, no longer distributed)**:

`@wingsky-1/dsh-gzip` → merged into `@wingsky-1/dsh-lan-proxy` (since 0.1.9)

HTTP response compression moved wholesale into lan-proxy (on by default, Brotli/gzip
negotiated via Accept-Encoding, SSE streaming exempt, configurable). Uninstall dsh-gzip and install dsh-lan-proxy to get the equivalent:

```sh
dsh plugin --profile web remove @wingsky-1/dsh-gzip
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

`@wingsky-1/dsh-opencode-usage` → renamed/refactored to `@wingsky-1/dsh-provider-usage`

Refactored into a multi-provider adapter framework (built-in OpenCode Go, custom data-source
adapters supported). The patch `id` changed from `ui-dsh-opencode-usage` to
`ui-dsh-provider-usage` and config keys were adjusted — nothing migrates automatically.
Reinstall, then re-check your settings in the settings panel (e.g. `apiKey`, `baseUrl`):

```sh
dsh plugin --profile web remove @wingsky-1/dsh-opencode-usage
dsh plugin --profile web add @wingsky-1/dsh-provider-usage
```

> Both legacy packages are marked deprecated on npm (installing them prints a migration hint).

</details>

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
# Install everything (recommended)
dsh plugin --profile web add @wingsky-1/dsh-plugins-all

# Or install individual plugins (as needed)
dsh plugin --profile web add @wingsky-1/dsh-notifier
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-notifier
```

### Update plugins (update)

```sh
# Update a single plugin to latest
dsh plugin --profile web update @wingsky-1/dsh-notifier

# Update the bundle (aggregate + the sub-packages it pulls in) to latest
dsh plugin --profile web update @wingsky-1/dsh-plugins-all

# Update all plugins under the current profile
dsh plugin --profile web update
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for the sidebar / settings page to reflect the change.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name — works for both `add` and `update`:

```sh
# Install a specific version (instead of latest)
dsh plugin --profile web add @wingsky-1/dsh-notifier@<version>

# Update to a specific version
dsh plugin --profile web update @wingsky-1/dsh-notifier@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
# Install the bundle
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-plugins-all

# Install an individual plugin (with a version pin)
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-notifier@<version>

# Uninstall / update (same shape — swap add for remove / update)
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-notifier
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-plugins-all
```

> `npx` fetches `@deepseek-ai/dsh` on each run. To pin it, run `pnpm add -g @deepseek-ai/dsh`
> (or `npm i -g @deepseek-ai/dsh`) and then use `dsh` directly.

### Individual install vs. bundle: pick ONE (since 0.1.5)

Each individual package and the bundle share the same patch `id` (`ui-*`). **Install only one way**
— installing both `dsh-plugins-all` and any individual package such as `@wingsky-1/dsh-lan-proxy`
results in duplicate same-name entries, and `dsh web` fails to start with a *duplicate* error
(detectable, not corrupting). To adjust: uninstall the bundle, or uninstall the corresponding
individual package, then restart.

## Related projects

- [dsh-web-mobile](https://github.com/mexiaosqwq/dsh-web-mobile) (npm: `@dsh-external/dsh-mobile-nav`) — DSH web mobile adaptation: auto-collapses the sidebar on narrow screens, opens TOC as a drawer. A lot of this project's development and debugging was done by using it remotely from a phone / tablet.
- [dsh-web-ui](https://github.com/zhu1090093659/dsh-web-ui) — A collection of DSH web UI skins. Learned many good practices from it; it is also the inspiration for DSH plugin development.
- [dsh-routing-suite / dsh-router-standard](https://github.com/yjh051108/dsh-routing-suite) — Provides the Router Standard agent preset (task-aware reasoning-mode routing: spec / mixed / react) for selecting presets in a session.

## Security notes

- After installing `dsh-lan-proxy`, HTTP/HTTPS ports are opened on `0.0.0.0` — **every device on your LAN can access your dsh**. Uninstall it when not needed.
- The launch-token auto-injection of `dsh-lan-proxy` (`injectToken`) is **on by default**: any device on the LAN that can reach the port gets full dsh control without a token (equivalent to trusting the entire LAN — bash passthrough to the host). Enable it only on a trusted intranet; turn it off in the settings card on untrusted segments.
- When `dsh-web-file-preview` is exposed through `dsh-lan-proxy` or any proxy that forwards external traffic, the loopback fence is bypassed: **LAN devices can preview local files without any credentials (including credential/config files under `~/.dsh`)** — use it only on a trusted LAN, never expose it to public networks.
- The stdio subprocesses of `dsh-mcp-manager` inherit host privileges; only configure MCP servers you trust.
- All plugin routes are loopback-fenced (non-loopback → 403, wrong method → 405).

## Development

Requirements: Node ≥ 23.6 (tests run TS directly with native type stripping), pnpm ≥ 11.

Build / contract / test / pack commands, directory layout, and host- & client-side coding
conventions all live in [DEVELOPMENT.md](docs/DEVELOPMENT.md) (start at §0); contributing
workflow in [CONTRIBUTING.md](CONTRIBUTING.md); issue workflow in
[ISSUE-WORKFLOW.md](docs/ISSUE-WORKFLOW.md).

Plugins were reviewed before being moved into this repository (self-contained build, privacy
cleanup, security hardening, complete metadata).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): Conventional Commits, feature branch + PR workflow,
pre-commit checks (sensitive info / artifact boundaries).

## License

[MIT](LICENSE)
