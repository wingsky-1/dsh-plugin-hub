# dsh-plugin-hub

[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![CI](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/wingsky-1/dsh-plugin-hub/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/wingsky-1/dsh-plugin-hub)](LICENSE)

[简体中文](README.md) | **English**

A collection of plugins for the **DSH (DeepSeek Harness)** web GUI, distributed via **npm**:
install them all at once as a single bundle, or pick individual plugins as needed.

- **Bundle package**: `@wingsky-1/dsh-plugins-all` — install everything in one shot
- **Individual plugins**: `@wingsky-1/dsh-*` — install only what you need
- All plugins mount through DSH's official profile mechanism (`dsh.bundle.patch`) — **no DSH source changes**
- Published to npm under the `@wingsky-1` scope, **zero runtime dependencies**

## Plugin list

| Package | What it does | Docs | Status |
|---|---|---|---|
| `@wingsky-1/dsh-notifier` | Approval/completion/error event notifications (browser Notification + system toast) | [README](packages/dsh-notifier/README.md) | ✅ Published |
| `@wingsky-1/dsh-provider-usage` | Multi-provider usage float pill (per-provider adapter framework, built-in OpenCode Go) | [README](packages/dsh-provider-usage/README.md) | ✅ Published |
| `@wingsky-1/dsh-lan-proxy` | Access the dsh web UI over LAN (HTTP/HTTPS/WS forwarding + TLS) | [README](packages/dsh-lan-proxy/README.md) | ✅ Published |
| `@wingsky-1/dsh-mcp-manager` | MCP server manager (stdio / HTTP, registers tools for the model) | [README](packages/dsh-mcp-manager/README.md) | ✅ Published |
| `@wingsky-1/dsh-idle-archive` | Prompt to archive idle conversations | [README](packages/dsh-idle-archive/README.md) | ✅ Published |
| `@wingsky-1/dsh-gzip` | gzip compression for `/api` responses | [README](packages/dsh-gzip/README.md) | ✅ Published |
| `@wingsky-1/dsh-web-file-preview` | Click conversation file links to preview in the web UI (image / text / Markdown / code / Diff) | [README](packages/dsh-web-file-preview/README.md) | ✅ Published |

> **No longer maintained**: `@wingsky-1/dsh-skill-explorer` (skill-center / skill management) is
> **discontinued** (deprecated on npm; the plugin package and the bundle package have been removed).
> A better implementation now ships on the web UI side,
> `@linxin666/dsh-client-ui-skill-explorer` (`dsh-web-ui` repository `packages/dsh-skill-explorer`),
> which supports symlink detection, safe handling of linked skills, and more.
> Use the built-in skill center in the web UI instead — please do not install this package.

> dsh-memory (project long-term memory) is not included yet; it is planned.

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

### Upgrading from 0.1.x (patch id migration)

Since 0.1.5, individual package patch `id`s changed from the old short names (e.g. `notifier`,
`lan-proxy`, `dsh-gzip`) to `ui-<name>` (e.g. `ui-dsh-notifier`). If you previously installed
individual packages, your profile may still contain old `id` lines — detect and reinstall the
affected packages to pull the new patch:

```sh
# Detect whether old ids are still referenced in the profile (home-level and profile-level)
grep -rnE '^\s*id:\s*(dsh-gzip|dsh-idle-archive|lan-proxy|mcp-manager|notifier|opencode-usage|ui-dsh-opencode-usage)\s*$' \
  "$DSH_HOME/cordis.patch.yml" ~/.dsh/profiles/*/cordis.patch.yml 2>/dev/null
# If output exists → reinstall to overwrite and pull the new config (default = latest)
dsh plugin --profile web remove @wingsky-1/<package>
dsh plugin --profile web add @wingsky-1/<package>@latest
```

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

```sh
pnpm install
pnpm build        # build all plugins (host-side tsc + esbuild inlines shared; client build: clean module → contract shell)
pnpm contract     # client contract checks (node scripts/contract-check.ts: load id/apply/inject/arrive)
pnpm test         # full smoke (test/*.ts run directly)
pnpm pack:check   # pack smoke: pnpm pack then verify tarball contents
```

Directory layout:

```
packages/dsh-*/            # each plugin = an independent npm package (@wingsky-1/dsh-*)
  src/index.ts             # host-side entry (cordis service; exports ROUTES as single source for client routes)
  src/client/index.ts      # client clean-module entry (exports apply/inject only, no load/IIFE shell)
  src/client/style.css     # client styles (separate file; inlined into client.js by text-loader at build time)
  src/client/*.ts          # client helper modules (not for host; browser-side only)
  src/*.ts                 # remaining host modules; profile deps exported by the host — see cordis.patch.yml
packages/dsh-plugins-all/  # bundle package (dependencies reference all subpackages; published via pnpm publish with version replacement)
shared/                    # host-side shared layer (loopback/host-utils/frontmatter), inlined into each package at build time, not published
types/dsh.d.ts             # self-built DSH plugin type layer
scripts/                   # build/contract/pack-check scripts (*.ts, run directly with Node)
```

Client development (clean-module convention): source does **not** write `window.__ModuleLoader__` /
IIFE — only `export function apply(ctx)` + `export const inject`; the contract shell
(load/IIFE/Symbol.toStringTag assembly + load id = package name) is generated uniformly by
`scripts/build-client.ts` at build time. Styles live in a separate `style.css` (inlined from
`.css` by the text-loader). Pure browser third-party libs (e.g. web-file-preview's
dompurify/diff2html) are inlined into the output via `dsh.client.inlineBareImports: true` and
live under `src/client/`. See [DEVELOPMENT.md](docs/DEVELOPMENT.md).

Plugins were reviewed before being moved into this repository (self-contained build, privacy
cleanup, security hardening, complete metadata).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): Conventional Commits, feature branch + PR workflow,
pre-commit checks (sensitive info / artifact boundaries).

## License

[MIT](LICENSE)
