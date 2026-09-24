# @wingsky-1/dsh-worktree-sidebar
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-worktree-sidebar)](https://www.npmjs.com/package/@wingsky-1/dsh-worktree-sidebar)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

Three tools that let the agent bind a **git worktree** to the current session, so that session's right-sidebar file tree is rooted at that worktree — **without changing the session cwd**.

This is a **transitional adapter**: if the official product ships native worktree sessions, this plugin retires.
How it works (five host domains, host/client chains, self-healing rules, the six things to remember) is documented in [docs/architecture/dsh-worktree-sidebar.md](../../docs/architecture/dsh-worktree-sidebar.md).

## Quick install

```sh
dsh plugin --profile web add @wingsky-1/dsh-worktree-sidebar
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only composed at startup) for changes to take effect.

## What it does

The right sidebar's file tree is always rooted at `session.header.cwd`, and that field is immutable once the session is created (adopting a session with a different cwd throws `ApiSessionCwdConflict`). So when a session runs in the main checkout while the actual work happens in a worktree, the tree shows the wrong place.

The plugin exposes three tools to the agent:

| Tool | Effect |
|---|---|
| `ws_worktree_register` | Bind an **existing** worktree to the current session |
| `ws_worktree_create` | Run `git worktree add` first, then bind (path and branch come from the caller; the plugin imposes no layout convention); an optional `base` picks the start point, defaulting to the current HEAD of the repository the session working directory is in |
| `ws_worktree_remove` | Drop the binding; only removes the directory via `git worktree remove` when explicitly asked |

Once bound, **open or refresh** the Files tab and it lists the worktree; opening a file previews the worktree's copy.
The tab does **not** follow automatically: the plugin does not poll the host, and re-reads the binding only when you open the tab, hit the built-in refresh, or the window becomes visible/focused again.

Subagent sessions **and user-forked sessions** inherit their parent's binding: a session without a binding of its own roots its Files tab at the worktree of the **first session up the parent chain that holds a registration** (the walk stops at the top, and falls back to the session's own cwd once that registration is dropped). The criterion is the header's `parentSession`, and the plugin deliberately does not tell the two shapes apart — a fork copies the parent's cwd, so inheriting the view root keeps it consistent with "the file root is a rewrite of the session cwd".

Tools are exposed to **every agent inside a git repository, subagents included**, decided per agent when it is created; a second check at execution time covers environments that changed in between. Each tool's result text states which worktree is bound and on which branch, so the model need not call another tool to confirm.

`ws_worktree_create`'s `base` is a commit-ish (branch, tag, SHA — e.g. `origin/main`). Its shape is checked first (a value starting with `-` is rejected), then it is normalized to a SHA before git sees it: after `<path>`, git **restarts option parsing** (measured: `base: "-f"` / `"--force"` reports success yet checks out HEAD), and a normalized SHA gives that parsing nothing to latch onto.

## Explicit non-goals (known inconsistencies)

These are deliberate trade-offs of "change only the view root", not a backlog:

- `@` file references, `present` targets and the skill catalog **still anchor `session.header.cwd`**. The tree points at the worktree while `@` lists the main checkout — the most easily misunderstood part of this plugin.
- **Under the `workspace-write` file policy the agent cannot write into the worktree**: the write fence's `sandboxPolicy.workspaceRoot` also derives from `header.cwd`, and that service cannot be replaced by a third-party plugin. Use `danger-full-access`, or open the session inside the worktree.
- **No diff marker** for same-named files between the main checkout and the worktree.
- "Tree root = worktree, execution cwd = original directory" is this design's premise. The agent's commands still run in the original cwd.
- The rewritten session view **affects only the single entry this plugin registers**: the client attaches the rewrite to `hooks.sessions` of the official entry inject face, so only that one entry's inject face is affected; every other `useSessions` consumer (preview, command palette, `@`, ...) still sees the session's real cwd. That is a direct consequence of "change only the view root", not a backlog item.

## Install

Requires DeepSeek Harness with a working `dsh web` (see "dsh not installed globally" otherwise).

### Install the plugin (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-worktree-sidebar
```

### Remove the plugin (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-worktree-sidebar
```

After removal the binding table remains at `<DSH_HOME>/@wingsky-1/dsh-worktree-sidebar/bindings.json` but has no effect. Worktrees you created are **not** deleted; clean up yourself if needed:

```sh
git worktree list          # see what is left
git worktree prune         # drop registrations whose directory was deleted by hand
```

### Update the plugin (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-worktree-sidebar
```

> Install / remove / update each require **one restart** of `dsh web` (bundles are composed at startup only).

### Pin a version (@version)

Omit `@version` to install latest (recommended). Append it only when the registry lags or a specific release misbehaves in your environment:

```sh
dsh plugin --profile web add @wingsky-1/dsh-worktree-sidebar@<version>
```

### dsh not installed globally

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-worktree-sidebar
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-worktree-sidebar
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-worktree-sidebar
```

## Configuration

- A single master switch `enabled` comes in via the plugin config (`WorktreeSidebarConfig`, `src/index.ts:41-45`): with `enabled === false` nothing is taken over, no tools are registered, no routes are mounted (`src/index.ts:98`); omitting it enables the plugin.
- The plugin never reads a user config file from disk; it owns its binding table at `<DSH_HOME>/@wingsky-1/dsh-worktree-sidebar/bindings.json`, derived from the single variable `DSH_HOME` (`src/server/shared/paths.ts:9-17`).
- `ws_worktree_create`'s `base` defaults to the current HEAD of the repository the session working directory is in; an explicit `base` is shape-checked (a leading `-` is rejected) and normalized to a SHA before reaching git, so the start point cannot be silently dropped.
- `base` is a commit-ish (branch, tag, SHA, e.g. `origin/main`); an omitted branch adds an explicit `--detach`, checking out the start point detached without creating a branch.
- With `enabled === false` the binding table is not even read; existing registrations stay on disk with no effect.

## Contract

- Only two things must agree on both ends, defined once in `src/shared/contract.ts:12-28`: route paths (`ROUTES`) and the binding-query response shape (`BindingResponse`); routes are additionally injected into the client at build time via `__DSH_ROUTES__`, keeping both ends consistent. See §2.4 of the architecture doc.
- Both routes are GET and read-only: `GET /api/dsh-worktree-sidebar/bindings?session=<id>` answers `{ revision, worktreePath | null }`; `GET /api/dsh-worktree-sidebar/health` answers `{ ok, revision, scopeTakeover, scopeChain }` (`src/server/api/impl/handlers/index.ts:24-67`).
- Minimal exposure: the binding query never returns `repoRoot` — the client only needs the directory root; a missing `session` parameter is a 400, never an empty answer that could be misread as "unbound" (`handlers/index.ts:1-8`, `30-34`).
- `revision` is a content version, not a write counter: an empty table starts at 0, storing one binding bumps it by one; dropping a nonexistent target returns the table unchanged without bumping (`src/server/binding/impl/model/index.ts:10-13`, `67-86`).
- The client only compares for equality and guards monotonicity: no notification when revision and path are unchanged, and a smaller revision arriving out of order is discarded (`src/client/bindings.ts:40-48`).
- The query endpoint carries a self-healing side effect: it resolves the effective root first and reads the revision second, dropping registrations positively confirmed as stale; merely ignoring them would leave the revision unchanged and the tree pointing at a dead root (`handlers/index.ts:35-37`).

## Verification

```sh
pnpm build && pnpm test      # unit + integration, including real git repos and real worktree add/remove
pnpm gate:pr                 # before opening a PR; a new package and catalog entry also need pnpm gate:full
```

Four **UI semantics** cannot be covered by any automated gate (there is no browser in `gate:*`) and are pre-release manual evidence, verified in an isolated live environment:

1. the file tree lists the worktree's contents;
2. opening a file previews the worktree's copy;
3. an unbound session — and an install without this plugin — behaves identically (no regression);
4. a subagent or forked session's tree follows the binding held by the session that owns it up the parent chain, and the three tools report the same root.

## Test strategy

- Two layers: `test/unit` drives `src` modules directly (pure logic, domain assembly, client contract assertions); `test/integration` goes through the composition root with real git repositories and real temp directories; all on-disk output goes to `mkdtempSync` isolation directories (see §12 of the proposal).
- Zero file exclusions in the mutation surface: `mutate` covers `src/**/*.ts`, the package config revokes the four shared-default literal exclusions, leaving the effective operator exclusion set empty (`scripts/data/gauntlet.config.json:51`, #847).
- Inheritance criterion: forked and subagent sessions resolve bindings up the parent chain; in the inherited state the tool surface never drops the parent record and never calls git, reporting only the owning session and the three ways out (`test/unit/tools.test.ts:587`, "tool surface in the inherited state (#847)").
- Routes always carry 403/405 fence cases plus a two-end route-consistency assertion (proposal §12; `src/server/api/impl/route/index.ts:41`, 403 before 405).
- This section is read-only description: commands and gate wording follow the "Verification" section and the repository-root AGENTS.md; no commands are promised here.

## Troubleshooting

- Tools say bound while the sidebar still follows the cwd: check `scopeTakeover` in `/health` first — the two readings differ deliberately: the tool surface reports the registration fact (no takeover gate), and only `live` means the file root really switched (`src/server/scope/interface.ts:31-40`).
- Liveness and state queries (use the port your local `dsh web` actually listens on; the example uses the default 3080):

  ```sh
  curl 'http://127.0.0.1:3080/api/dsh-worktree-sidebar/health'
  curl 'http://127.0.0.1:3080/api/dsh-worktree-sidebar/bindings?session=session-1'
  ```

- Two common causes for a non-`live` `scopeTakeover`: `waiting` (provider not registered yet; startup order is not stable) and `abandoned` (the lookup table is held by a third party); `scopeChain` records the one silent degradation where the persistence read failed (`src/server/api/impl/handlers/index.ts:44-53`).
- A failed client fetch keeps the last good state (G6): every failure yields undefined, never null, so a first-ever failure falls back to the real cwd (`src/client/index.ts:37-56`, `src/client/bindings.ts:30-39`); both ends read the revision from the same in-memory snapshot, and the client never moves the root on mismatch (G7, see "Contract").
- Mount or takeover entry failures only speak through `console.warn`: nothing is registered and the right column keeps official behaviour (`src/client/index.ts:121-124`, `src/client/takeover.ts:226-233`).

## Compatibility (read-only coupling)

The plugin does not modify official sources, but it **reads** these contracts from the sole
supported target runtime, dsh `0.1.7-rc.1`. No compatibility promise is made for any other
runtime version:

- the host's `typert` `workspaceFileScope` lookup: the plugin registers its resolver via `lookups.configure` and delegates to the **official resolve captured before configuring** on a miss;
- the client `sidebarRightTabs` type registry and the keyed seat `sidebar.right.pane.tab` (including the `StoredEntry` shape: `component/inject/store/locale`);
- the session hook source contract `{ getSnapshot(), subscribe(fn) }`, where `getSnapshot` must return a **reference-stable** snapshot;
- the official client package `@deepseek-ai/dsh-client-ui-sidebar-right` must be present.

On any of these failing the behaviour is **zero registration / fall back to official**: if the official tab implementation cannot be captured, no tab is registered at all and the tree shows the cwd exactly as before. **Visibly doing nothing beats silently showing the wrong place.**

## Security model

- **Loopback-only routes**: non-loopback requests to `/api/dsh-worktree-sidebar/*` get 403; unknown methods get 405 (403 before 405). No file-reading surface is exposed to the browser.
- **The query endpoint has a self-healing side effect**: `GET /api/dsh-worktree-sidebar/bindings` may drop a binding it has positively confirmed as stale while resolving the effective root (rewriting `bindings.json` and bumping the revision). That is deliberate: the client uses the revision as its cache key, so merely ignoring a stale binding would leave the revision unchanged and the tree pointing at a root that no longer holds.
- **The main repository path is never returned**: the binding query answers only `{ revision, worktreePath | null }`.
- **git runs via `execFile` with argv only**, never a shell.
- **Branch names are validated by git itself** (`git check-ref-format --branch`); every positional argument follows `--`, so a path that looks like `--force` is never read as a flag.
- **An omitted branch adds an explicit `--detach`**: plain `git worktree add <path>` creates a **new branch named after the directory basename**, so a basename with a space (common in macOS home directories) is rejected as an invalid branch name and one starting with `-` is re-parsed as a flag — `--` only guards `worktree add`'s own option parsing. With `--detach`, "omit the branch" really means "check out the start point, detached" — the repository HEAD by default, or the `base` you passed.
- **Removal is explicit**: `ws_worktree_remove` only drops the binding unless explicitly told otherwise, and `--force` must be asked for separately. The plugin only ever runs `git worktree remove` — never `rm -rf`.
- **State lives under `DSH_HOME`**: `bindings.json` is written atomically (temp file + `rename`); a corrupt or future-versioned file is treated as empty rather than guessed at.
- **No credentials, no network**: tools only write the plugin's own binding table and invoke git.

## Known limitations

- **Session ids are reused by new sessions after a restart, and the binding does not follow**: the official session id is an **in-process counter** (`session-1`, `session-2`, ...), so a restarted `dsh web` hands `session-1` to a brand-new session. Each binding therefore also stores the session header's `createdAt` as its identity: a mismatch (a different session) drops that binding and the tree falls back to cwd, while a genuinely restored session matches and keeps it (when the check cannot be read at all, the binding is conservatively kept — one IO hiccup must not permanently drop a user's binding).
- **Worktree directory deleted from outside**: treated as unbound and the tree returns to the real cwd (visible, never pointing at a missing directory). But when the **ownership reading is unavailable** (permissions, failing git) the binding is kept and a warning is emitted: only two positively-read, differing common git directories count as "no longer a worktree of this repository".
- **One worktree per session**: a second binding overwrites the first.
- **No system-prompt injection**: the model is not told the tool exists beyond the tool list and result text. This is deliberate (no always-on prompt cost); discovery depends on the model inspecting its tools.
- **Cannot write into the worktree under `workspace-write`** (see non-goals).
- **One `dsh web` restart is needed after install or upgrade.**
- **Per-session state is released with the plugin itself**: the client no longer infers liveness (per-session pruning was removed together with the polling), and uses the snapshot only to rewrite the single field `byId[sessionId].cwd`; views and subscriptions are released when the plugin unmounts (`releaseAllSeedings()` + `views.clear()` inside `ctx.effect`), and the view cache is capped at 128 entries, evicting the coldest sessions (each view is an independent reader of the same host fact, so an eviction never makes a tree read a different place).
- **A second assembly in the same process throws**: all five domains are in-process singletons (`install` / `release` pairs with an `installed` guard), so a second instance cannot mount and the second `install` throws instead of silently sharing state. If a profile mounts this package twice you get one explicit startup error; the old "two instances do not interfere" semantics is gone.
- **Inheritance is re-resolved along the parent chain every time**: the Files tab root comes from the first session up the chain that holds a registration; once that registration is dropped, or found invalid during resolution, descendants fall back to their own cwd (never silently pointing at a root that no longer holds).
- **When the takeover is not in effect, tools and the Files tab disagree (deliberately)**: the `workspaceFileScope` takeover has a waiting state (provider not registered yet) and an abandoned state (taken by a third party); in both, the plugin leaves the file root alone and the Files tab still follows the cwd, while the three tools report the **registration fact**. `scopeTakeover` in `/health` is the authority (nothing but `live` switches the root).
- **`ws_worktree_remove` in the inherited state drops nothing**: it never unbinds the parent session's registration and never removes the directory; it reports which session owns the root plus the ways out (unbind there / bind another worktree here / register this session to its own cwd).

## Retirement criteria

Any one of these makes the plugin unnecessary:

- the official product ships native worktree sessions (a session carries its own working-area switch);
- the official product ships a supported way to switch the file root per session;
- `SessionHeader.cwd` becomes mutable, or `workspaceFileScope` gains a supported third-party extension point.

After retiring, clean up worktrees left behind: `git worktree list` to inspect, `git worktree prune` to drop stale registrations.
