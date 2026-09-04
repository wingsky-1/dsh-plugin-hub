# @wingsky-1/dsh-plugins-all
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-plugins-all)](https://www.npmjs.com/package/@wingsky-1/dsh-plugins-all)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

The all-in-one **aggregate package** of DSH plugins: installing this package installs every
functional plugin in one shot.

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-plugins-all
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-plugins-all
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-plugins-all
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has
not synced the latest yet, or the latest has issues in your environment, append `@version`
to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-plugins-all@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly
(under the hood it calls `pnpm`, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-plugins-all
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-plugins-all
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-plugins-all
```

## Included plugins

| Package | Function |
|---|---|
| `@wingsky-1/dsh-notifier` | Approval / completion / error event notifications (browser Notification + system toast) |
| `@wingsky-1/dsh-provider-usage` | Multi-provider usage floating panel (adapter framework, ships with OpenCode Go) |
| `@wingsky-1/dsh-lan-proxy` | Access dsh web UI over the LAN (HTTP/HTTPS/WS + TLS + HTTP response gzip) |
| `@wingsky-1/dsh-mcp-manager` | MCP server manager (stdio/HTTP, tools registered for the model) |
| `@wingsky-1/dsh-web-file-preview` | Preview conversation file links in the web UI (image/text/Markdown/code/Diff) |
| `@wingsky-1/dsh-verify-isolated` | Isolated-verification skill for plugin development (temp DSH_HOME + dedicated profile double isolation) |

> `@wingsky-1/dsh-gzip` is retired: HTTP response compression has been merged into
> dsh-lan-proxy and no longer ships with the bundle. Users who installed dsh-gzip
> separately should run
> `dsh plugin --profile web remove @wingsky-1/dsh-gzip` to uninstall after upgrading.
>
> `@wingsky-1/dsh-idle-archive` (idle session reminder & archiving) and
> `@wingsky-1/dsh-subagent-model-inherit` (subagent model inheritance) have both been
> **retired** and no longer ship with the bundle: the former because the community already
> has more mature session lifecycle management/archiving implementations, the latter
> because the official dsh-subagent 0.1.2-alpha.2 natively implements
> `resolveChildAgentOptions`. Users who installed them should run
> `dsh plugin --profile web remove <package>` to uninstall.
>
> dsh-memory (project long-term memory) is not included in this aggregate package.
>
> `@wingsky-1/dsh-codegraph` (codegraph MCP + worktree development discipline) is
> **packaged separately** and is not included in this aggregate package for now; to use
> it, install this aggregate package or `dsh-mcp-manager` first, then install
> `dsh-codegraph` on its own.

## Install individually

When you only want one plugin, install it alone (see each plugin's README):

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

## Security notes

- `lan-proxy` listens on `0.0.0.0:<port>` and serves HTTPS; read its README security
  notes before use.
- `mcp-manager` spawns MCP server subprocesses (stdio) and executes their commands;
  only configure trusted servers.
- `notifier` pops system notifications on Windows via PowerShell WinRT.
