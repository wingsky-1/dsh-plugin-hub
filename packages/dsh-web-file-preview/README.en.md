# @wingsky-1/dsh-web-file-preview
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-web-file-preview)](https://www.npmjs.com/package/@wingsky-1/dsh-web-file-preview)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

Turns "open with the default application" file requests inside the conversation into the **built-in right-Sidebar preview**, so file viewing finishes inside dsh.

## What it does

Since dsh 0.1.5, almost every file click in a conversation already opens the built-in right-Sidebar preview; only one path still hands a file to an **external application**: `POST /api/present.open` (the Host's `sessionController.openWorkspacePath`). It has two browser-side entry points:

- the `present` deliverable card menu item "open with the default application";
- clicking a **mention** of a presented file in the assistant's final response (inline-code reference).

This plugin takes over that request in the browser: when it matches an "open with the default application" call it sends nothing over the network, asks `ctx.sidebarRight.openResource` to open the right-Sidebar preview using the official address grammar (`dsh-resource://file/session/<id>/<path>`), and synthesizes the success response the official caller understands.

Paths that are deliberately **not** taken over (maintainer decision: shrink the feature surface):

- `reveal` ("show in file manager") passes through untouched — it does not open file contents, and dsh has no equivalent;
- `open-in-app` in the session header (open the workspace directory in an external editor);
- every other file click inside the conversation (the official client already opens the right-Sidebar preview for those).

The plugin does **not** register the official `documentPreviews` / `sidebarRightTabs` extension points, and does not modify official DOM or styles.

## Capability change (repositioning)

Earlier versions shipped their own previewer (Modal + image lightbox + Markdown/Mermaid + code highlighting + git Diff + virtual HTML serving + binary download card + path fallback search + self-hosted Host routes) plus a conversation click interceptor. Since dsh 0.1.5 the built-in preview covers the main capabilities, so the plugin shrank to the single forwarding duty described above; that code, its dependencies and the Host routes have all been removed.

**Upgrade note**: after upgrading, clicking a `present` card or a mention opens the right-Sidebar preview instead of launching a desktop application; the previous Modal-only capabilities (Diff, Mermaid, multi-file HTML assets) are no longer provided — the built-in preview renderers own them. The plugin has no user-facing options any more; uninstalling is the off switch.

## Install

Prerequisite: DeepSeek Harness is installed and `dsh web` starts (see "dsh not installed globally" below otherwise).

### Install the plugin (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-web-file-preview
```

### Remove the plugin (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
```

### Update the plugin (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-web-file-preview
```

> Installing / removing / updating all require **one restart** of `dsh web` (the bundle layer is composed at startup only).

### Pin a version (@version)

Omitting `@version` installs the latest release (recommended). Append `@version` only when the registry has not caught up or the latest release misbehaves in your environment:

```sh
dsh plugin --profile web add @wingsky-1/dsh-web-file-preview@<version>
```

### dsh not installed globally

If there is no global `dsh` command, use `npx` (it still calls `pnpm`, so `pnpm` and `Node.js` must be present):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-web-file-preview
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-web-file-preview
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-web-file-preview
```

## Verification

Unit tests live only in `test/*.test.ts` (`import "../lib/index.js"` tests the artifact); stryker reuses the same assertions through the lib-to-src hook.

```sh
pnpm build && pnpm test                 # in the repo: build + smoke (address golden table + fetch interlock fixture)
```

The address builder is kept in lockstep with the official `fileAddressFor` from `@deepseek-ai/dsh-util-workspace-path`: the right Sidebar keys tabs by the address itself, so any drift would open the same file as two tabs.

## Compatibility (read-only coupling)

The plugin does not modify official sources and does not register official extension points, but it **reads** the following official contracts; they are the only failure surface when dsh changes:

- the `/api/present.open` path, its `POST` method and its `action` query parameter (`reveal` relies on `action=reveal` to stay distinguishable);
- the `[data-presented-file]` marker with its inner `button[title]` (card path source), and `code > button[title]` mentions in the assistant response; official CSS Modules class names are build-time hashes and must not be relied on (the official `fileMention` class name is such a hash);
- the `dsh-resource://file/session/<id>/<path>` address grammar and `fileAddressFor`'s cwd-folding semantics.

When any of them changes the behavior is a **graceful pass-through**: the takeover stops applying and the click falls back to the official native open (observable, never silent data corruption).

## Security model

- **No self-hosted routes any more**: the earlier `/api/dsh-file-preview/*` surface (raw file serving, virtual HTML serving, token store) was removed with the repositioning. The plugin no longer exposes any file-reading surface to the browser and no longer needs loopback fences, serve tokens or CSP fallbacks — **the earlier LAN warning ("exposed through a proxy, local files become previewable") is gone with it**.
- **Read-only coupling**: the plugin only reads (never writes) request URLs and the `title` attribute of official card DOM; the collected path is used solely to build an official address string.
- **No network egress**: on a match the plugin sends no request at all and calls the official Sidebar navigation directly; on a miss or any failure it replays the official request unchanged.
- **Least privilege**: the browser half injects only `sessions` (session cwd, for address folding) and `sidebarRight` (official Sidebar navigation); the Host half no longer needs `webServer`, the filesystem or any official service.

## Known limitations

- **Depends on official DOM markers**: path collection relies on `[data-presented-file]` and `title`. If a future dsh release changes those markers, the takeover degrades to a pass-through (see "Compatibility").
- **Pending window**: the path is collected when the card or mention is clicked and consumed by the following "open with the default application". Rare flows (keyboard-invoked menu, or clicking long after the menu opened) may collect nothing, which also degrades to a pass-through.
- **Path-shape filter**: collection accepts only "contains a separator" or "bare filename with an extension"; a bare extension-less name (such as a repository-root `Makefile`) is not collected, and that click degrades to a pass-through.
- **One restart per install/upgrade**: the artifact is composed when `dsh web` starts; every runtime "open" click takes effect immediately, with no restart needed.

## Retirement criteria

The plugin can be retired as soon as either holds:

- the official client also opens presented card menus and mentions through the right-Sidebar preview (or offers a web fallback branch for `openWorkspacePath`);
- an equivalent "open-behavior redirection" extension point becomes available.

Tracking issue: [#698](https://github.com/wingsky-1/dsh-plugin-hub/issues/698).
