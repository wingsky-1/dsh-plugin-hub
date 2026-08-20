# @wingsky-1/dsh-idle-archive
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-idle-archive)](https://www.npmjs.com/package/@wingsky-1/dsh-idle-archive)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

Idle-session archive reminder: automatically scans sessions that have had no conversation for
over X hours and pops up a dialog asking whether to archive them; after choosing "Snooze", the
session won't be prompted again for Y hours.

> Positioning: a session-hygiene assistant. It only **reminds + one-click runs the official
> archive** — it never archives automatically and never deletes any session records.

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-idle-archive
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-idle-archive
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-idle-archive
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-idle-archive@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-idle-archive
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-idle-archive
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-idle-archive
```

## Behavior

1. Periodically scans the session list (every 60 minutes by default; also re-scans on mount
   and on list changes);
2. When a candidate is hit (see filter rules) and the page is visible with no other dialog
   open, shows the archive confirmation dialog;
3. Each candidate session can be acted on individually:
    - **Archive** — calls the official `workspace.archiveSession` (the session is hidden from
      the group list, while the session records and workspace ledger are retained);
    - **Snooze** — the session enters a silence period and won't be reminded again for Y hours;
4. Dialog actions (× / Esc = close and brief 1-hour silence; "Snooze all" = silence all for
   Y hours).

## Filter rules (non-intrusive principle)

The following sessions do not enter the reminder: sessions never spoken to (blank), running
sessions, subagent sessions, already-archived sessions, the currently open session, sessions
within their silence period, and sessions without a valid timestamp.

## Configuration

| Key | Default | Meaning | Range |
|---|---|---|---|
| `enabled` | `true` | Master switch | boolean |
| `idleHours` | `72` | Idle threshold: only remind after this many hours without a conversation | 1 ~ 8760 |
| `snoozeHours` | `24` | Silence duration after rejection | 1 ~ 720 |
| `scanMinutes` | `60` | Auto-scan interval | 5 ~ 1440 |
| `maxRows` | `50` | Max candidate rows listed in a single dialog | 1 ~ 200 |

GUI edit entry: Settings → Plugins → the "Idle Session Reminder" card (takes effect after
saving; persisted by the host).

Config file: `~/.dsh/dsh-idle-archive.json` (contains settings and the snoozed silence table).

## Security and boundaries

- The host only provides config / silence-period persistence + an RPC channel (authority
  loopback fence, non-loopback returns 403) + a health route; **the archive action is executed
  by the client calling the official `workspace.archiveSession`**, so the host does not
  re-implement domain logic.
- Archiving is one-way: the official `dsh-workspace` has no unarchive API yet — the dialog only
  reminds and never archives automatically.
- The dialog is a browser-side DOM implementation: it only reminds when the Web GUI page is open.
- The silence table accumulates a few entries as sessions grow; expired entries are cleaned up
  automatically when read.

## Verification

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-idle-archive/health

# Source is in src/; must build after changes (dsh imports lib artifacts directly)
pnpm --filter @wingsky-1/dsh-idle-archive build
node test/smoke.mjs && node test/client-shim.mjs
```

## License

MIT
