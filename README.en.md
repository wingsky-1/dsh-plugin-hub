# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

[简体中文](README.md) | **English**

A collection of plugins for the **DSH (DeepSeek Harness)** web GUI, distributed via npm:
install them all at once as a single bundle, or pick individual plugins as needed.

- **Bundle package**: `@wingsky-1/dsh-plugins-all` — install everything in one shot
- **Individual plugins**: `@wingsky-1/dsh-*` — install only what you need

## Core advantages

- **Security built into the defaults**: minimal exposure surface and minimal credential
  flow — management surfaces answer only on loopback, keys by default never persist in
  plaintext nor reach the browser; each plugin's threat model and hardening details live
  in its README security section
- **Context-cost-controlled MCP management**: project-level MCP is collapsed into the
  two atomic tools `ws_mcp_search` / `ws_mcp_call` by default, so project-level scale
  never balloons the context (`middleware: all` folds global servers into the middleware
  too); per-working-directory project/global config tiers let each repo carry its own
  MCP servers without cross-project interference
- **Extensible usage-stats framework**: a generic v2 adapter contract with DeepSeek
  official and OpenCode Go built in out of the box; write one mjs file to plug in any
  data source, hot-swappable from the settings page
- **Engineering-quality backing**: every plugin ships smoke assertions (route fences /
  client contracts), plus build contract + pack checks + full gates run in CI

## Plugin list

| Package | What it does | Docs | Status |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | Approval/completion/error event notifications (browser Notification + system toast) | [README](packages/dsh-notifier/README.md) | ✅ Published |
| `@wingsky-1/dsh-provider-usage` | Multi-provider usage float pill (generic adapter framework: DeepSeek official and OpenCode Go built in, plug in any data source with your own mjs) | [README](packages/dsh-provider-usage/README.md) | ✅ Published |
| `@wingsky-1/dsh-lan-proxy` | Access the dsh web UI over LAN (HTTP/HTTPS/WS forwarding + TLS + HTTP response compression, Brotli/gzip) | [README](packages/dsh-lan-proxy/README.md) | ✅ Published |
| `@wingsky-1/dsh-mcp-manager` | MCP server manager (stdio / HTTP; per-working-directory project/global config tiers, project-level MCP collapsed via middleware — no tool flood in the model surface) | [README](packages/dsh-mcp-manager/README.md) | ✅ Published |
| `@wingsky-1/dsh-web-file-preview` | Click conversation file links to preview in the web UI (image / text / Markdown / code / Diff / Mermaid) | [README](packages/dsh-web-file-preview/README.md) | ✅ Published |
| `@wingsky-1/dsh-verify-isolated` | Isolated-environment browser verification skill for DSH plugin development (temp DSH_HOME + independent profile, double isolation) | [README](packages/dsh-verify-isolated/README.md) | ✅ Published |
| `@wingsky-1/dsh-codegraph` | codegraph local code-graph MCP + worktree development discipline (registered at runtime via mcp-manager) | [README](packages/dsh-codegraph/README.md) | ✅ Published (standalone, not in the bundle) |

> **Standalone note**: `@wingsky-1/dsh-codegraph` is published **standalone** and is **not
> included in `dsh-plugins-all`**; install it separately (it registers the codegraph MCP at
> runtime via mcp-manager, so install `dsh-mcp-manager` or the bundle first).

> **No longer maintained**: `@wingsky-1/dsh-skill-explorer` (skill-center / skill management) is
> **discontinued** (deprecated on npm; the plugin package and the bundle package have been removed).
> A better implementation now ships on the web UI side,
> `@linxin666/dsh-client-ui-skill-explorer` (`dsh-web-ui` repository `packages/dsh-skill-explorer`),
> which supports symlink detection, safe handling of linked skills, and more.
> Use the built-in skill center in the web UI instead — please do not install this package.
>
> **No longer maintained**: `@wingsky-1/dsh-idle-archive` (idle-conversation archiving prompt) and
> `@wingsky-1/dsh-subagent-model-inherit` (child agents inherit parent-session model and reasoning
> effort) are both **discontinued**. The former because the community offers more mature session
> lifecycle-management / archiving implementations (e.g.
> [dsh-session-pruner](https://github.com/mrzhangkris/dsh-session-pruner)); the latter because
> official dsh-subagent 0.1.2-alpha.2 natively implements `resolveChildAgentOptions` (child agents
> inherit the parent session's model / reasoning effort / output-token limit). Both packages have
> been removed from this repository and deprecated on npm — please do not install them; uninstall
> if you had installed them before:
>
> ```sh
> dsh plugin --profile web remove @wingsky-1/dsh-idle-archive
> dsh plugin --profile web remove @wingsky-1/dsh-subagent-model-inherit
> ```

> dsh-memory (project long-term memory) is not included yet; it is planned.

<details>
<summary><b>Migrating from legacy packages (upgrade guide)</b> — expand if you installed <code>dsh-gzip</code> / <code>dsh-opencode-usage</code></summary>

Two packages were published historically and are no longer distributed. Uninstall the old
package, install the new one, then restart `dsh web`:

**`@wingsky-1/dsh-gzip` → merged into `@wingsky-1/dsh-lan-proxy`** (since 0.1.9)

HTTP response compression moved wholesale into lan-proxy (on by default, Brotli/gzip
negotiated via Accept-Encoding, SSE streaming exempt, configurable). Uninstall dsh-gzip and install dsh-lan-proxy to get the equivalent:

```sh
dsh plugin --profile web remove @wingsky-1/dsh-gzip
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

**`@wingsky-1/dsh-opencode-usage` → renamed/refactored to `@wingsky-1/dsh-provider-usage`**

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
