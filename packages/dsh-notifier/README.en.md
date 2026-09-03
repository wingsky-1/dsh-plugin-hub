# @wingsky-1/dsh-notifier
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-notifier)](https://www.npmjs.com/package/@wingsky-1/dsh-notifier)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

Notifications for approval / completion / error events: get alerted even when you are away from the browser.

## Installation

Prerequisite: DeepSeek Harness installed and `dsh web` running normally (for running dsh
without a global install, see "Without a global dsh install" below).

### Install plugins (add)

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier
```

### Uninstall plugins (remove)

```sh
dsh plugin --profile web remove @wingsky-1/dsh-notifier
```

### Update plugins (update)

```sh
dsh plugin --profile web update @wingsky-1/dsh-notifier
```

> After install / uninstall / update, **restart `dsh web` once** (bundle layers are only
> composed at startup) for changes to take effect.

### Pin a version (@version)

Omitting `@version` installs the default latest (recommended). Only when the registry has not synced the latest yet, or the latest has issues in your environment, append `@version` to the package name:

```sh
dsh plugin --profile web add @wingsky-1/dsh-notifier@<version>
```

### Without a global dsh install

If there is no global `dsh` command on the machine, use `npx` to run it on the fly (`dsh plugin`
calls `pnpm` under the hood, so `pnpm` and `Node.js` must still be installed locally):

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-notifier
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-notifier
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-notifier
```

## Deployment & how to access (important)

All plugin endpoints are protected by a **loopback fence**: only calls originating from the local
loopback interface (`127.0.0.1` / `localhost`) are accepted. Therefore, when you access
`http://<server IP>:3080` directly from a LAN browser, `/api/dsh-notifier/*` always returns
403 and the notification channels do not work — this is the expected behavior of the security
guardrail, not a plugin fault; the page will show a guidance hint.

Pick one of the following access forms (both the settings card and the README surface a hint for each):

| Form | How to access | Notes |
|---|---|---|
| Local desktop | `http://127.0.0.1:3080` | Secure context: both browser notifications and system notifications work |
| LAN HTTPS (recommended) | `https://<server IP>:3443` (dsh-lan-proxy) | Satisfies loopback check via proxy + secure context; on mobile, "Add to Home Screen" enables PWA-grade notifications |
| Tunnel | After `ssh -L 3080:127.0.0.1:3080 <server>`, visit the local address | Loopback + secure context, same effect as local |

> Verified (2026-08): `https://<IP>:3443/api/dsh-notifier/health` returns 200,
> SSE long connection (`/api/dsh-notifier/events`) delivers its first frame normally via 3443.

## Features

- **Ask you a question** (on by default): notifies when `ask_user_question` / the GUI question popup is triggered
- **Approval reminder**: notifies when the real approval path `approval/request` is triggered, including task title, tool display name (Chinese), request reason, and an action hint
- **Completion reminder**: notifies when a task transitions from running to idle (`agent/status` running → idle), including task title and elapsed time; completion detection is dual-source — on idle, the latest `turn/end` read back from the session event snapshot is merged with the latest `turn/end` remembered from the `session/event` push stream, taking the newer as this turn's closure evidence (issue #272: a one-off snapshot read lag no longer solidifies into permanent silence; both sources for the same turn notify only once, and skipped decisions emit an observable warn log); subagent completion uses a separate toggle `notifySubagentDone` (off by default; subagents include spawned ones with `origin: subagent` and fork-delegated workers whose runtime ownership holds — fork mainline sessions without ownership are unaffected and still report as main-task completion); no completion notification is sent when the user stops generation / interrupts / the task fails / the task is blocked (when this turn's `turn/end` reason is `aborted`/`interrupted`/`error`/`blocked` it is always silent — failed tasks are handled separately by the error reminder's "task errored" so the same turn never both errors and falsely reports completion)
- **Error reminder**: notifies when a task errors (`agent/error`), including task title, the errored turn/step, and the error message (first 300 chars); identical errors within a 60-second window are auto-merged
- **Turn completion** (off by default): notifies on `agent/turn-stopping`
- **Dual channels**:
  - System notifications: native Windows toast (embedded PowerShell WinRT script, zero dependencies); macOS uses `osascript` (display notification, zero dependencies); Linux uses `notify-send` (only when available)
  - Browser notifications: SSE frame push + Notification API (only pops when the page is hidden)
- **Insecure-context fallback**: on LAN HTTP access the browser blocks system-level popups — automatically falls back to "in-page banner + sound + title reminder"
- **Do-not-disturb window**: supports crossing midnight (e.g. 22:00 → 08:00); an **urgent exception** can be set (`quietHours.allowKinds`: events still reminded during DND). The default candidates are the high-frequency blocking kinds (approval / question / error); the settings page lets you check **all 6 built-in events** (including task-done / subagent-done / turn-end) with one-click "Follow enabled events" or "Reset default". Exemption is orthogonal to the event toggles — a disabled event never produces notifications anyway, and the exemption entry stays intact
- **Approval timeout re-reminder**: when an approval waits longer than `askRemindMin` minutes (default 5, 0 disables) without being handled, remind again
- **Completion-storm aggregation**: when multiple tasks / subagents finish at once, auto-aggregate into "N other tasks have completed" to avoid notification spam
- **Settings-card diagnostics**: the plugin card under Settings → Plugins → dsh-notifier shows the browser notification permission status and a secure-context hint, plus the 10 most recent notification records, a "Send test notification" button, and a "Clear history" entry

## Configuration (official settings storage, editable via Settings → Plugins → dsh-notifier)

Configuration is stored in the **official settings store** (`<DSH_HOME>/settings.yaml`,
namespace `dsh-notifier`), read/written through the plugin card under
Settings → Plugins → dsh-notifier (issue #76). The legacy self-maintained
`~/.dsh/dsh-notifier.json` is **migrated once at startup** into the official store;
the original file is renamed `dsh-notifier.json.migrated.bak` (corrupt files are
renamed `.corrupted.bak` without being written). The self-maintained read/write path
is retired.

**Unknown-key semantics (forward compatibility, issue #470)**: dsh-notifier applies a
**"pass-through and preserve"** policy to configuration keys it does **not recognize** —
read and write behave consistently; unknown keys are never dropped, validated or
rewritten (except for composition-layer assembly keys, see boundaries below):

- **Reading**: `GET /api/dsh-notifier/config` returns unknown keys verbatim in both
  `user` (the raw settings user layer) and `effective` (the resolved config), keeping
  future-version / third-party keys visible.
- **Writing**: `PUT /api/dsh-notifier/config` is an incremental patch — it merges the
  submitted known keys only; unknown keys already in the user layer are **not affected
  by saving known keys**, and unknown keys carried in the current patch are **preserved
  verbatim** (never silently dropped). A patch with only unknown keys (e.g.
  `{"futureKey":1}`) returns **200** and is written; only an empty patch `{}` (or a
  patch with nothing writable after filtering, e.g. only assembly keys) returns **400**
  "need at least one config key".
- **Upgrade path**: when a key is unknown in version vN (already passed through into the
  user layer) and becomes a known key in vN+1 — stale dirty values in the user layer are
  **not auto-cleaned** (an upgrade never overwrites fields the user has already set);
  on read, normalize falls back to defaults for invalid known-key values (dirty values
  do not affect the effective config or other keys); a **400 + hint** is only raised when
  you **actively submit** that key with an invalid value. To clear a leftover dirty key,
  delete it manually in `settings.yaml`.
- **Legacy migration**: unknown keys in the old `dsh-notifier.json` are **preserved
  through migration** — written when missing from the user layer, never overwriting
  existing ones; a legacy file containing only unknown keys is no longer treated as
  "no valid keys".
- **Boundary exceptions**:
  - Composition-layer assembly keys (`configFile` / `toastScript` / `historyFile` /
    `statusFile` / `enabled`) are cordis composition/startup parameters and **never
    enter the settings user layer** — PUT and migration drop same-named keys; entry
    composition goes through the whitelist filter.
  - Reserved Bark channel keys (`device_key` / `device_keys` / `ciphertext`) are still
    always stripped / rejected; unknown channel params only pass through as
    string/number values.
  - Unknown keys take no part in validation (invalid known keys still return
    400 + hint).

Consequence: after an upgrade, if the settings page does not show a field that still
exists in `settings.yaml`, that is the intended preserve behavior — saving other known
settings will not lose it.

Example values (defaults):

```json
{
  "notifyAsk": true,
  "notifyQuestion": true,
  "notifyTaskDone": true,
  "notifySubagentDone": false,
  "notifyTaskError": true,
  "notifyTurnEnd": false,
  "systemNotify": true,
  "browserNotify": true,
  "notifyWhenVisible": false,
  "notifySound": true,
  "quietHours": { "enabled": false, "start": "22:00", "end": "08:00", "allowKinds": [] },
  "errorMergeWindowMs": 60000,
  "askRemindMin": 5,
  "doneMergeWindowMs": 3000,
  "historyMaxAgeDays": 0,
  "maxConnections": 16
}
```

> `maxConnections`: SSE connection-table cap (default 16, range 1–1024). It counts
> **server-side unreleased handles**, not "online devices" — half-open connections
> (device screen off / network switch / silent NAT cut) linger briefly until the
> transport layer reaps them; the cap keeps the connection table bounded, evicting
> the oldest connection beyond the limit (clients auto-reconnect with `since`
> replay, transparent). If more devices×tabs are concurrently online, raise it in
> the card.

## Routes (all behind the loopback fence)

| Route | Method | Notes |
|---|---|---|
| `/api/dsh-notifier/config` | GET/PUT | **GET** returns `{ok, user, revision, effective, writable}` (`user` = official settings user layer, `revision` for optimistic concurrency, `effective` = resolved config); **PUT** accepts `{patch, expectedRevision?}` (incremental patch, optional `expectedRevision`), returns `{ok, user, revision}` |
| `/api/dsh-notifier/events` | GET | SSE notification frames (browser EventSource subscription; `?since=<seq>` replays missed frames after reconnect) |
| `/api/dsh-notifier/test` | POST | Test notification (bypasses Do-Not-Disturb) |
| `/api/dsh-notifier/history` | GET / **DELETE** | GET recent notification records (up to 200, filtered by `historyMaxAgeDays`; entries suppressed by DND are flagged `suppressed`); **DELETE clears** |
| `/api/dsh-notifier/health` | GET | Health check |

Error mapping (PUT /config): invalid config key → 400 (`{ok:false, error:{error:"配置校验失败: <key>", hint}}`); stale `expectedRevision` conflict → 409 (`code:"SETTINGS_CONFLICT"`); settings service unavailable → 503 (`code:"settings-unavailable"`); write failure → 500 (root cause only in server logs).

## Type dependencies

Host-side types come from the official `@deepseek-ai/*` packages (`dsh-agent`,
`dsh-session`, `dsh-host-webserver`, ...; versions are pinned in the repository's
`pnpm-workspace.yaml` catalog and upgraded with DSH releases): **`import type` only,
compile-time usage** — build artifacts contain zero official runtime imports; all
runtime objects are injected by the dsh host. The package declares this host coupling
as optional peerDependencies; consumers running type checks against the plugin must
be able to resolve these official packages (skipping type checking is unaffected).

## Security & boundaries

- Notification text only contains metadata such as task title / tool name / request reason — **never tool parameters** (prevents sensitive info leakage)
- **Error notification text is redacted**: masked via an ordered rule table and truncated to 300 chars before entering notifications and history, reducing the exposure surface of embedded command echo, paths, and credential fragments. Covered categories and placeholders:
  - User paths (`/home` `/Users` `/root` `/etc` `C:\Users`) → `<path>`
  - PEM private key blocks (including truncated forms with only the BEGIN header) → `<private-key>`
  - Database / message-queue connection-string credentials (postgres/mysql/mongodb/redis/amqps etc., scheme preserved; not redacted when the password contains URL-reserved chars like `<>`/quotes — known limitation) → `scheme://<redacted>@host`
  - Tokens: JWT, AWS AKIA, GitHub PAT (classic and fine-grained), ≥24-char hex / ≥32-char base64 runs → `<token>`
  - Secret field assignments (`password=`/`token=`/`api_key=`…; an explicit `=`/`:` separator is required) → `key=<redacted>`
  - Email addresses → `<email>`
  - **Approval reasons and question texts** are redacted too (truncated to 120 chars) — these most often embed command echo and credential fragments
  - **Known trade-off (rule intentionally unchanged)**: 40-char git commit SHAs are indistinguishable from "≥24-char hex secrets" and get masked to `<token>` by the generic long-run rule (e.g. `HEAD detached at abc0123…` → `HEAD detached at <token>`), losing the lookup value of error messages. The false positive is accepted in exchange for secret coverage: a SHA-scenario whitelist would be unreliable (40-hex cannot be told apart from real secrets by shape), so this is documented as known behavior only
  - Proven false-positive-prone, deliberately not covered: IPv4 (same shape as UA version numbers), phone numbers (same shape as order IDs), credit cards (13-digit millisecond timestamps match at 100%)
- System notification failures are silent (logs only), and do not affect the main flow; a missing / non-executable native binary (ENOENT etc.) is caught by the `error` event and **never bubbles up as an unhandled error that crashes the host process** (see issue #1)
- **The two channels are delivered to different machines (don't confuse them)**:
  - **Browser notifications** are pushed to **the browser client you are actually using** (your Mac / phone both count), and pop a native notification via the browser's Notification API; they require permission and by default only pop when the page is hidden (the settings card can enable "also when visible"). No matter which machine dsh web runs on, as long as browser notifications are allowed you receive them on your own Mac.
  - **System notifications (host toast)** are popped on the desktop of **the machine dsh web runs on**: if dsh web runs on a Linux server (headless, no desktop session) or some other machine, the toast appears on **that server**, not your Mac — the settings card / health reflects whether the channel is available. To also get the system toast on your Mac, run dsh web directly on your Mac (it then uses macOS `osascript`); macOS has no `notify-send`, and the system notification is already implemented via `osascript` (zero dependencies, nothing to install)
- **iOS difference**: Safari's normal tabs have no Web Notifications API (only the "Add to Home Screen" PWA does); on iOS the available channels are "in-page banner + sound when the page is visible" and system notifications after HTTPS + A2HS
- Browser notifications require a **secure context** (HTTPS or localhost); LAN HTTP access automatically routes through the fallback channel (banner / sound / title reminder)
- Browser notification permission is requested within a gesture (via the "Request notification permission" button on the Settings → Plugins → dsh-notifier card)
- Windows system notifications are implemented via a PowerShell WinRT script, with the command passed as a parameter array and title/body packed into a single base64 (UTF-8 JSON) payload argument (no shell concatenation surface, and immune to PS 5.1 command-line argument parsing ambiguities, see issue #238); the script idempotently registers the AppUserModelId `DSH.dsh-notifier` on startup (HKCU, no admin required) — an unregistered AUMID gets toasts silently dropped by Windows 10/11. The AUMID follows the `Company.Product` convention to avoid collisions in the public namespace (`HKCU\SOFTWARE\Classes\AppUserModelId`) where same-named apps overwrite each other's display names; a legacy `DSH` key registered by older versions is harmless leftover (just an empty registry entry, does not affect new toasts) and can be removed manually with `Remove-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\DSH"` if desired

## Verification

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-notifier/health

# Source is in src/, must build after changes
pnpm --filter @wingsky-1/dsh-notifier build
node test/smoke.ts
```

## License

MIT
