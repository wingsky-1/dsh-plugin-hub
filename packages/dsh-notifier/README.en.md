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
- **Completion reminder**: notifies when a task transitions from running to idle (`agent/status` running → idle), including task title and elapsed time; completion detection is **push-first with a snapshot fallback** — the latest `turn/end` remembered from the `session/event` push stream is the primary evidence (dispatched synchronously post-commit, always fresh), and the snapshot read-back (`lastTurnEndOf`) only serves as a fallback when the push is missing (the plugin was mounted mid-turn, or the event was dispatched inside a reload window before the new fiber remembered it) (issue #290 phase two: a one-off snapshot read lag no longer solidifies into permanent silence; the same turn notifies only once, and a skipped decision emits an observable warn log that names the evidence source); subagent completion uses a separate toggle `notifySubagentDone` (off by default; subagents include spawned ones with `origin: subagent` and fork-delegated workers whose runtime ownership holds — fork mainline sessions without ownership are unaffected and still report as main-task completion); no completion notification is sent when the user stops generation / interrupts / the task fails / the task is blocked (when this turn's `turn/end` reason is `aborted`/`interrupted`/`error`/`blocked` it is always silent — failed tasks are handled separately by the error reminder's "task errored" so the same turn never both errors and falsely reports completion)
- **Error reminder**: notifies when a task errors (`agent/error`), including task title, the errored turn/step, and the error message (first 300 chars)
- **Turn completion** (off by default): notifies on `agent/turn-stopping`
- **Dual channels**:
  - System notifications: native Windows toast (embedded PowerShell WinRT script, zero dependencies); macOS uses `osascript` (display notification, zero dependencies); Linux uses `notify-send` (only when available)
  - Browser notifications: SSE frame push + Notification API (only pops when the page is hidden)
- **Three switches per channel: enabled / popup / sound**: the browser and system channels are
  each a **built-in channel entry** in `channels`, carrying "Enabled" (send or not), "Popup"
  (pop or not) and "Sound" (sound or not, which tone). **Turning the channel switch off means
  no delivery at all** — not even sound. That is the dividing line from the old behavior: a
  single key used to act as both popup toggle and channel switch, so "popup off + sound on"
  still made noise. Sound values: muted / follow the system default / built-in tones
  `ding`·`bell`·`chime`·`pop` with ▶ Preview; Linux system notification sound is fixed by host
  self-play of freedesktop event sounds (notify-send used to carry no sound hint and DE support
  varies); see "Configuration → Per-channel three switches".
- **Insecure-context fallback**: on LAN HTTP access the browser blocks system-level popups — automatically falls back to "in-page banner + sound + title reminder"
- **Do-not-disturb window**: supports crossing midnight (e.g. 22:00 → 08:00); an **urgent exception** can be set (`quietHours.allowKinds`: events still reminded during DND). The default candidates are the high-frequency blocking kinds (approval / question / error); the settings page lets you check **all 6 built-in events** (including task-done / subagent-done / turn-end) with one-click "Follow enabled events" or "Reset default". Exemption is orthogonal to the event toggles — a disabled event never produces notifications anyway, and the exemption entry stays intact; disabled events are shown dimmed (reduced opacity) on the settings page and can still be exempted. **Upgrade note**: now that the allow-list is open, kinds that older configurations used to filter out (e.g. hand-edited `done`/`turn-end`) will be reminded again during DND — a behavior change; adjust the exemptions on the settings page if you do not want that
- **Settings-card diagnostics**: the plugin card under Settings → Plugins → dsh-notifier shows the browser notification permission status and a secure-context hint, plus the 10 most recent notification records, a "Send test notification" button, and a "Clear history" entry

## Event subscription and scope semantics ({global:true} trade-off)

When subscribing to host events (`approval/request`, `internal/service`, `session/event`,
`agent/status`, `agent/disposed`, `agent/error`, `agent/turn-stopping`), the plugin always
registers `{ global: true }` (cordis `EventOptions`, "Receive the event regardless of
context filter checks"). The trade-off (issue #290):

- **Events arrive anyway under an untagged flat mount**: a plugin ctx inserted flat via
  `cordis.patch.yml` carries no scope tag, and the host dsh-scope event dispatch lets
  listener contexts without a scope tag through — agent-scoped events arrive even without
  `{ global: true }`;
- **`{ global: true }` is consumer-side defense**: it decouples event arrival from the host's
  scope-dispatch semantics — if the plugin ever runs in a private-scoped mount form (listener
  ctx carrying a scope tag that does not match the event carrier's scope), `hook.global`
  passes unconditionally in the dispatch filter, so notifications never go mute on scope
  filtering (every `ctx.on` registration in this plugin carries the option);
- **The cost (the trade-off)**: `global` also receives **cross-scope** events — under an
  extreme deployment of many plugins and many scopes it may receive events outside the
  current ctx scope. Every listener in this plugin consumes with "payload self-validation +
  per-agent / event-content filtering" (event payloads are untrusted across the host
  boundary, validated field by field at runtime, and a non-finite turn is skipped outright),
  so a cross-scope arrival is only filtered out silently and never produces a wrong
  notification; this stage **adds no configuration key** to control that behavior.

## Outward contract (surface visible to other plugins, #733 convergence)

The service surface is exposed on the host context as `ctx["wingsky.notifier"]`, and its `apiVersion` is **2**. What this domain-by-domain rewrite converges on the outside:

- **The `wingsky-notify/sent` event is retired**: delivery terminal states are now carried by two query surfaces — `GET /api/dsh-notifier/status` (per-channel latest state + consecutive failure count) and `GET /api/dsh-notifier/history` (recent records, including per-channel delivery details);
- **`registerChannel` is retired**: it promised a channel-contribution model that never landed; channel types are built-in only (system / browser / bark / webhook);
- **`send` no longer returns an accepted array**: it returns `Promise<void>` — the `ok` in that array meant "accepted", not "delivered", and misreading the direction is more expensive than having no return value at all;
- **`registerKind` and `send` themselves are unchanged**: consumers using only those two are unaffected.

## Configuration (editable via Settings → Plugins → dsh-notifier)

Configuration is owned by the plugin itself and lives in `config.json` inside its **package-private
storage directory** (`<DSH_HOME>/@wingsky-1/dsh-notifier/config.json`, `~/.dsh` by default), read and
written through the plugin card under Settings → Plugins → dsh-notifier or via
`GET/PUT /api/dsh-notifier/config`. On upgrade the **legacy locations are read once during
assembly, and the shape is migrated along the way**: the 0.2.3 official settings namespace
`dsh-notifier` takes precedence, read **straight from the host settings document file** (the
`documentPath` the provider reports, falling back to `<DSH_HOME>/settings.yaml` and
`settings.json`; `.yaml`/`.yml` are parsed as YAML) because `describe()` only lists **registered**
namespaces and the plugin stops registering this one in 0.2.4; falling back to
the older self-maintained `dsh-notifier.json` (DSH_HOME root, including the `.migrated.bak` left
by an earlier migration); what is read is merged into the current `config.json` (legacy values
override the file, the same precedence the old write path used), and the 8 top-level channel keys
are then moved into the two built-in entries of `channels` and **deleted** (see "Per-channel three
switches"). After that `config.json` is the only read/write path.

**Unknown-key semantics (forward compatibility, issue #470)**: dsh-notifier applies a
**"pass-through and preserve"** policy to configuration keys it does **not recognize** —
read and write behave consistently; unknown keys are never dropped, validated or
rewritten (except for composition-layer assembly keys, see boundaries below):

- **Reading**: `GET /api/dsh-notifier/config` returns unknown keys verbatim in `user`
  (the raw user layer), keeping future-version / third-party keys visible. `effective`
  (the resolved config) has a **fixed shape** and therefore never contains unknown keys
  — they live in the file and in the `user` view only.
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
  delete it manually in `config.json`.
- **Legacy migration**: unknown keys in the old configuration (the 0.2.3 settings
  namespace and the older self-maintained json) are **preserved** when read — written
  when missing from the user layer, never overwriting existing ones; a legacy file
  containing only unknown keys is no longer treated as "no valid keys".
- **Boundary exceptions**:
  - `patch` **must be an object**: non-object shapes (arrays, `null`, numbers, etc.)
    always return 400 — arrays are never passed through as numeric-index dirty keys.
  - Prototype-chain / special member keys (`__proto__`, `constructor`, `prototype`,
    `toString`, `hasOwnProperty`, `valueOf`, etc., which JSON text can inject as own
    keys) are always stripped from both the read pass-through and the write channels —
    never validated and never written.
  - Composition-layer assembly keys (`configFile` / `toastScript` / `historyFile` /
    `statusFile` / `enabled`) are cordis composition/startup parameters and **never
    enter the user layer** — PUT and migration drop same-named keys; entry
    composition goes through the whitelist filter.
  - Reserved keys are still always stripped / rejected — `device_key` / `device_keys` /
    `ciphertext` inside a Bark channel instance, and `WEBHOOK_RESERVED_KEYS`
    (`auth_token` / `access_token` / `bearer_token` / `api_key` / `apikey` /
    `client_secret` / `secret` / `password_hash`) inside a webhook channel instance;
    unknown channel params only pass through as string/number values.
  - Unknown keys take no part in validation (invalid known keys still return
    400 + hint).

Consequence: after an upgrade, if the settings page does not show a field that still
exists in `config.json`, that is the intended preserve behavior — saving other known
settings will not lose it.

Example values (defaults; `channels` / `kindRoutes` / `allowKinds` are new M2 keys):

```json
{
  "notifyAsk": true,
  "notifyQuestion": true,
  "notifyTaskDone": true,
  "notifySubagentDone": false,
  "notifyTaskError": true,
  "notifyTurnEnd": false,
  "quietHours": { "enabled": false, "start": "22:00", "end": "08:00", "allowKinds": [] },
  "historyMaxAgeDays": 0,
  "maxConnections": 16,
  "channels": [
    { "type": "browser", "id": "browser", "enabled": true, "popup": true, "sound": true, "whenVisible": false },
    { "type": "system", "id": "system", "enabled": true, "popup": true, "sound": true }
  ],
  "kindRoutes": {},
  "allowKinds": []
}
```

> The browser and system notifications are the two **built-in entries** in `channels`: they live in
> the same array as bark / webhook instances and share the same rendering and decision logic; the
> only thing special about them is that they **cannot be deleted** (a write whose `channels` lacks
> a built-in entry returns 400). The 8 top-level channel keys of 0.2.3 (`systemEnabled` /
> `browserEnabled` / `systemNotify` / `browserNotify` / `notifyWhenVisible` / `notifySound` /
> `browserSound` / `systemSound`) are **moved into these two entries and deleted** during the
> upgrade — the migration is done in one version, with no second place where the old keys still
> read. Submitting them after the upgrade returns 400 (refresh the page if it was open before the
> upgrade).

> `maxConnections`: SSE connection-table cap (default 16, range 1–1024). It counts
> **server-side unreleased handles**, not "online devices" — half-open connections
> (device screen off / network switch / silent NAT cut) send no FIN, so close/error
> never fires. Since #515 the connection table is managed by shared/sse-hub with three
> complementary reclamation paths: **stalled reclamation** (writes rejected for over
> 90 s → disconnect), **maxAge rotation** (alive for over 120 min with no business
> frames → actively disconnected; clients auto-reconnect and replay with `since`, so it
> is transparent), and **cap eviction** (oldest evicted beyond the limit). The cap keeps
> the table bounded; if it is **persistently exceeded** (clients reconnect after eviction
> and are evicted again, a churn loop), the value is below peak concurrent connections —
> raise it to at least the peak and observe again. Reclamation-path counters are exposed
> as `sseEvicts` on `/api/dsh-notifier/health`.

### Per-channel three switches (#640 / #641; folded into channel entries as of 0.2.4)

The browser and system notifications are two **built-in channel entries** in the `channels`
array, with the same shape, rendering and decision logic as bark / webhook instances:

```json
{ "type": "browser", "id": "browser", "enabled": true, "popup": true, "sound": true, "whenVisible": false }
{ "type": "system",  "id": "system",  "enabled": true, "popup": true, "sound": true }
```

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean | **channel switch (send or not)**: the only delivery gate per channel; off = no delivery at all |
| `popup` | boolean | **popup switch (pop or not)**: off with sound on = sound only |
| `sound` | `boolean \| tone id` | sound (whether / which tone) |
| `whenVisible` | boolean | whether to also pop while the page is visible (browser channel only; sent with the frame and executed by the page) |

**What gets sent is up to the channel**: the decision pipeline judges `enabled` only, per
channel; popup and sound are handed to the channel as-is, and it decides whether this one pops,
sounds, sounds without popping, or sends nothing at all. So a channel with "popup off + sound
off" **still receives the delivery** — the outlet determines there is nothing to send this time,
and history records a `skipped` entry (neither disguising it as a successful delivery, nor
judging the shape inside the pipeline on the outlet's behalf).

**The old top-level keys are moved away and deleted during the upgrade**: the 0.2.3 keys
`systemEnabled` / `browserEnabled` / `systemNotify` / `browserNotify` / `notifyWhenVisible` /
`notifySound` / `browserSound` / `systemSound` are moved into the two built-in entries by the 0.2.4
upgrade chain and then **deleted** from the configuration file — the channel shape is expressed in
the entries alone. Submitting those keys after the upgrade returns 400 (with a hint to refresh)
instead of silently doing nothing.

Values: `false` = muted (a popup may still show, without sound); `true` = **follow the
system default**; a tone id = an explicit built-in tone (`ding` / `bell` / `chime` /
`pop` — the 4 tones have consistent meaning across platforms; pick one in the "Tone"
dropdown of each channel card and hit ▶ Preview: the preview is synthesized locally
with Web Audio as a listening reference — **the real system sound follows the platform
and system settings**).

Delivery matrix (**with the channel switch off nothing is delivered, regardless of popup
and sound**; with it on, popup × sound decide the shape):

| Enabled | Popup | Sound | Behavior |
|---|---|---|---|
| Off | any | any | **no delivery at all** (sending depends on the channel switch only) |
| On | On | `false` | Show notification, silent |
| On | On | `true` | Show notification, OS-default sound |
| On | On | tone id | Show notification; the app self-plays the tone (system notification silenced to avoid double sound) |
| On | Off | `true`/tone id | **Sound only**: no popup, self-play only (page alive / host self-play) |
| On | Off | `false` | Enters the pool but **sends nothing**: history records `skipped`, and the settings card says so |

- **`notifySound` (old global key) is migrated by the upgrade**: its value is spread onto the two
  built-in entries' `sound` by the 0.2.4 upgrade (an outlet key — `browserSound` / `systemSound` —
  wins when present), and the old key is then deleted. Users who had muted the old sound therefore
  **stay muted** after upgrade — no surprise sound. From 0.2.4 the settings UI only writes the
  entries; there is no global sound switch any more.
- **Browser sound unlock prerequisite**: browser `true`/tone self-play needs an
  unlocked page audio context — browser autoplay policy requires one user gesture
  (opening the notification center / any sound-row interaction unlocks the
  AudioContext). A purely background page that was never interacted with may stay
  silent (notifications still pop, just no sound) — a browser policy constraint,
  not a plugin defect.
- **Linux `true` special case (#640 fix)**: Linux desktop daemons differ widely in
  sound-hint support (GNOME silent by default / KDE only since 2025 / Xfce needs
  libcanberra), so the system channel's `sound: true` means "**self-play the default event
  sound**": the host plays the `message-new-instant` event sound (freedesktop sound theme)
  via `pw-play` (PipeWire) or `paplay` (PulseAudio) instead of relying on the daemon.
  Headless servers (no desktop/audio session) stay silent. **Behavior change for
  existing Linux installs**: system notifications used to be silent (notify-send had
  no sound hint); after this upgrade, sound-on self-plays the event sound (requires an
  audio session and `pw-play`/`paplay`; silently skipped when the player/event file is
  missing — notifications are unaffected).
- **Tone × platform mapping (approximate, best-effort)**:

| Tone | Browser (Web Audio) | macOS | Linux (freedesktop event) | Windows |
|---|---|---|---|---|
| `ding` | double short high | Glass (NSSound) | `message-new-instant.oga` | `C:\Windows\Media\Windows Ding.wav` |
| `bell` | single mid-high | Tink | `bell.oga` | `Windows Chimes.wav` |
| `chime` | three-note ascent | Sosumi | `complete.oga` | `Windows Chord.wav` |
| `pop` | short low | Pop | `message.oga` | `Windows Balloon.wav` |
| `true` (system) | OS default (not silent) | Glass (kept) | default event self-play | toast default system sound; near-default wav for sound-only |

  macOS playback is subject to the system "Allow notification sounds" setting; Windows
  tones are played by the host `SoundPlayer` from built-in wav files (allow-listed
  paths, silent when missing); Linux event files are the oga files guaranteed to exist
  in the sound-theme-freedesktop base package under
  `/usr/share/sounds/freedesktop/stereo/` (multi-path probing, silent when missing).
  Self-play always uses argument-array spawning (no shell concatenation) and
  allow-listed file paths.
- The host platform is exposed via the `platform` field of `/api/dsh-notifier/health`
  (the system card shows a platform hint from it — the browser OS and the host OS can
  differ; don't confuse them).

### Bark push channel (M2, issue #366)

Configure via the "Notification center → Delivery channels → Add Bark push" tab (or edit the
configuration JSON above directly). Per-instance fields: `id` (auto-generated then locked),
`name` (display name), `baseUrl` (Bark server address, http/https), `deviceKey` (found in the
Bark app; always masked as `********` in responses, submitting the mask = keep the original
value), `enabled` (default **false** — outbound authorization must be granted explicitly).

Optional parameters (all omitted = not sent; unknown string/number keys pass through verbatim
for forward compatibility with future Bark parameters; `device_key` / `device_keys` /
`ciphertext` are reserved keys and never pass through):

| Field | Notes |
|---|---|
| `sound` | Ringtone name (Bark Sounds list) |
| `group` | Group (notifications in the same group collapse on the phone) |
| `icon` | Icon URL (**must be reachable from the phone's network**, not from the server; SVG needs iOS 17+; empty uses the Bark default) |
| `url` | URL opened when the notification is tapped |
| `badge` | App badge number |
| `level` | Instance-level urgency override; when omitted, mapped automatically from event severity: `failure→timeSensitive`, `warning/success→active`, `info→passive` |
| `levels` | Per-event (kind) urgency sparse mapping (below) |

`levels` (kind→level sparse mapping matrix): sets Bark urgency for a concrete event type,
**taking precedence over the instance-level `level` and the severity auto-mapping**; unconfigured
types use the default. Suited to per-event differentiation such as "questions must ring,
subagent completions stay quiet":

```json
{ "id": "phone", "type": "bark", "baseUrl": "https://api.day.app", "deviceKey": "…",
  "enabled": true, "levels": { "question": "timeSensitive", "subagent-done": "passive" } }
```

- Keys are event kinds (the built-ins `ask/question/done/subagent-done/error/turn-end/test` or
  dynamic kinds; any string); values are limited to `active` / `timeSensitive` / `passive` /
  `critical`; at most 64 entries, each key at most 64 chars.
- Full precedence: `levels[kind]` > `level` > severity mapping > not carried.
- Note: `critical` requires special Apple authorization (regular apps cannot request it);
  without it Bark may downgrade or reject the request.
- Orthogonal to `kindRoutes` (kind→channelId[] routing): routing decides "which channels receive
  it", `levels` decides "how loudly this instance rings".

Delivery reliability: 10 s hard timeout, network errors / 5xx retried ×2 (4xx not retried), at
most 2 in-flight deliveries per instance (built-in channels are unlimited); success requires
both HTTP 2xx and a response body with `code===200`. Terminal delivery states
are persisted to this plugin's status file (see "Storage layout" below), and
the settings-page channel-card status row is refreshed on card load and after sending a test
via `GET /api/dsh-notifier/status` (no polling, the D20 stance).

**Three terminal states with different meanings (0.2.4)**: `ok` = a channel really executed an
action and it succeeded; `failed` = an action was executed and it failed (there is failure
evidence, so the status row is written); `skipped` = there was **no executable action at all**
(popup and sound are both off, or this host cannot produce the command). The system channel treats popup
and sound as two independent actions: **once the popup has gone out, a sound failure is best-effort and
does not change the terminal state** (sound is no longer the only action); a popup failure still flips it. `skipped` **does not
write the status row** — the channel did nothing, so there is no "latest delivery outcome" to
speak of, and writing success would claim success on its behalf. A green status row therefore does
not mean this particular notification arrived: every entry in the **History tab** carries its
per-channel delivery detail (which channel, which outcome, which reason), and that is the only
per-notification visible surface.

**Delivery reasons are structured (0.2.4)**: `{ code, params?, detail? }` — `code` is rendered into
the current language by the client dictionary, and `detail` holds raw host output (HTTP response
body, stderr tail, JSON.parse error) and is **never the primary text**; the UI folds it away behind
a "Raw host output" label. The upgrade folds pre-0.2.4 prose reasons in `status.json` /
`history.jsonl` into `code: "reasonLegacy"` with the original sentence in `detail` (idempotent; the
read side is tolerant as well, so a hand-edited file cannot make the UI show `undefined`).

> **Storage layout (#733 convergence)**: configuration, notification history, channel status, the SSE
> seq counter and the storage version marker all live under `DSH_HOME/@wingsky-1/dsh-notifier/` —
> `config.json` / `history.jsonl` / `status.json` / `seq.json` / `version` (`version` is the upgrade
> chain's scale). Legacy locations are **read once at startup**: the DSH_HOME-root
> `dsh-notifier-history.jsonl` / `dsh-notifier-status.json` / `notifier-seq.json` are renamed to
> `.migrated.bak` after being moved; the two generations of configuration (the 0.2.3 settings
> namespace and the older `dsh-notifier.json`) are read without being renamed.
> All paths respect `DSH_HOME` (#510): they resolve to `~/.dsh` when the variable is unset and
> follow the isolated home when set — isolated environments (multi-instance / test sandboxes /
> dsh-verify-isolated) never touch the real `~/.dsh`.

`kindRoutes`: a sparse kind → channelId[] routing map (e.g.
`{ "error": ["browser", "system", "bark:phone"] }`); kinds without an entry broadcast to every
enabled channel; the events area of the settings page edits it both ways (sharing one copy of
the configuration with the channel cards).
`allowKinds`: the list of confirmed dynamic kinds (notification types registered by other
plugins are persisted here once you confirm them).

### Webhook push channel (#508)

Configure via the "Notification center → Delivery channels → Add Webhook push" tab (or edit
the configuration JSON directly). Purpose: receive notifications on Android via ntfy /
Gotify / a self-hosted push gateway, complementing Bark (iOS); each delivery POSTs a JSON
body to `url`.

Per-instance fields (`type` fixed to `"webhook"`):

| Field | Notes |
|---|---|
| `id` | Instance id (2-32 chars, lowercase letters/digits/hyphens; locked after creation; the alignment key for `kindRoutes` and mask backfill) |
| `name` | Display name (falls back to the id) |
| `url` | Target URL (http/https; normalized to origin+path — query/hash stripped, credential URLs rejected) |
| `enabled` | Whether enabled (default **false** — outbound authorization must be granted explicitly) |
| `auth` | Authentication: `none` (default) / `bearer` / `basic` / `header` |
| `token` | Bearer token (secret: always masked `********` in responses) |
| `username` | Basic auth username (not a secret) |
| `password` | Basic auth password (secret: always masked) |
| `headerName` / `headerValue` | Custom-header auth (`headerValue` is a secret: masked); header names are limited to letters/digits/hyphens (≤64 chars) and forbid `content-type` / `content-length` / `host` / `cookie` / `authorization` |
| `preset` | Preset: `ntfy` (default) / `gotify` / `custom` (self-hosted gateway); selects the `{{priority}}` mapping and the default template |
| `template` | JSON body template (≤8192 chars; empty = preset default template) |
| `timeoutSec` | Delivery timeout in seconds (1-60, default 10; authoritatively clamped server-side) |

Presets and the channel-aware `{{priority}}` mapping (selected by `preset`; `{{severity}}`
is always the raw severity):

| preset | info | success | warning | failure |
|---|---|---|---|---|
| `ntfy` | `default` | `low` | `high` | `urgent` |
| `gotify` | 3 | 3 | 7 | 9 |

`custom` does no mapping — `{{priority}}` passes the severity through verbatim for the
gateway to handle.

Template placeholder list: `{{title}}`, `{{message}}`, `{{kind}}`, `{{severity}}`,
`{{priority}}` (mapping above), `{{source}}` (renders as an empty string, reserved), and
`{{ts}}` (rounded epoch milliseconds, emitted as a bare number — the only placeholder
allowed unquoted in the template).

Rendering semantics (JSON-aware, two steps): `{{ts}}` is substituted as a numeric literal
first → the template is parsed with `JSON.parse` → placeholders are replaced in string
values only while walking the parsed tree → re-serialized with `JSON.stringify`.
Substitution happens inside already-parsed strings and is uniformly escaped on
re-serialization, so notification content containing quotes or `"}}` cannot break out of a
string to inject extra fields. A template that is not valid JSON fails that channel's
delivery and is recorded (never silently downgraded to plain text; other channels are
unaffected). The `ntfy` preset default template contains `"topic": "<topic>"` — replace it
with your topic name before delivering.

Delivery reliability: timeout 1-60 s (default 10); **failures are never retried
automatically** — 4xx / 5xx / network errors / render failures all end as a terminal
failure recorded in the status file and the notification history (the raw host text is
truncated as-is into the reason's `detail`, see "Security & boundaries");
re-send via "Send test notification" to verify. Reference channels in `kindRoutes` as
`webhook:<id>` (same `type:id` shape as `bark:<id>`).

Example instance (stored alongside Bark instances in the `channels` array, ids unique
across types):

```json
{ "id": "droid", "type": "webhook", "url": "https://ntfy.sh/mytopic",
  "enabled": true, "auth": "bearer", "token": "…", "preset": "ntfy", "timeoutSec": 10 }
```

## Routes (all behind the loopback fence)

| Route | Method | Notes |
|---|---|---|
| `/api/dsh-notifier/config` | GET/PUT | **GET** returns `{ok, user, revision, effective, writable}` (`user` = official settings user layer, `revision` for optimistic concurrency, `effective` = resolved config; **credential fields (bark `deviceKey` / webhook `token`·`password`·`headerValue`) are always masked**); **PUT** accepts `{patch, expectedRevision?}` (incremental patch, optional `expectedRevision` for optimistic concurrency), returns `{ok, user, revision}` (also masked) |
| `/api/dsh-notifier/events` | GET | SSE notification frames (browser EventSource subscription; `?since=<seq>` replays missed frames after reconnect) |
| `/api/dsh-notifier/test` | POST | Test notification (funnels through the service pipeline, bypasses Do-Not-Disturb; optional body `{channelId}` to test a single channel) |
| `/api/dsh-notifier/history` | GET / **DELETE** | GET recent notification records (up to 200, filtered by `historyMaxAgeDays`; entries suppressed by DND are flagged `suppressed`; every record carries per-channel delivery detail `channels[]` whose `reason` is a structured reason); **DELETE clears** |
| `/api/dsh-notifier/status` | GET | Channel delivery status (per-channel latest delivery terminal state + consecutive failure count; the failure reason is a structured object `{code, params?, detail?}` whose `detail` is truncated as-is to 300 chars, with no credential replacement) |
| `/api/dsh-notifier/kinds` | GET / POST | GET the dynamic kind list (including confirmation state); POST `{kind, confirmed}` writes a confirmation (persisted to `allowKinds`); the 200 response carries `revision` (for the client to sync its optimistic-concurrency version) |
| `/api/dsh-notifier/health` | GET | Health check |

Error mapping (PUT /config): invalid config key → 400 (`{ok:false, error:{error:"配置校验失败: <key>", hint}}`); stale `expectedRevision` conflict → 409 (`code:"SETTINGS_CONFLICT"`); settings service unavailable → 503 (`code:"settings-unavailable"`); write failure → 500 (root cause only in server logs).

Error mapping (POST /kinds): kind-confirmation CAS retries (≤2) exhausted → 409 (`code:"SETTINGS_CONFLICT"`, rare: sustained concurrent writes during confirmation); settings service unavailable → 503 (`code:"settings-unavailable"`, same semantics as PUT /config); write failure → 500 (fixed `error` text, root cause only in server logs).

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
- **Notification body and title are no longer masked (#733 convergence)**: the old `sanitizeContent` rule table (paths / PEM private keys / connection-string credentials / tokens / emails …) has been deleted — notifications, history writes (including suppressed entries) and delivery all carry the original text; the body is not truncated here, and length is capped by each delivery channel's display limit. Deployments that need "a given kind of text never appears in logs" must handle it at the event source
- **The only remaining credential masking is in the settings view**: channel credentials in `GET /config`'s `user` + `effective` and in `PUT` success responses (bark `deviceKey`, webhook `token` / `password` / `headerValue`) are always masked as `********`; submitting the full mask = keep the original value (backfilled aligned by instance id so a reordering never swaps credentials between instances); a mask submitted for a new instance returns 400 (`CHANNEL_SECRET_FIELDS` is the per-channel-type single source of truth)
- **Outbound error reasons no longer replace credential literals (measured risk, documented as-is)**: Bark 4xx response bodies echo the device key, and webhook non-2xx response bodies echo the credentials they received — failure reasons are only truncated (webhook response body 200 chars; status entry 300 chars), with **no guarantee that credentials stay out of the error text**. Those texts live in the reason's `detail` field (reasons are structured as of 0.2.4, see "Delivery reliability"), and go to server logs, the status file (`status.json`) and the notification history (`history.jsonl`), reaching the settings page via `GET /status` and `GET /history`; deployments sensitive to error-text exposure should act on the bullet above
- Server-side internal errors still return fixed wording (root causes only go to server logs)
- System notification failures are no longer silent: when a channel **executed an action and it failed**, the status row is written as `failed` and the per-channel detail appears in the notification history; when **no command can be constructed at all**, the outcome is `skipped` plus exactly one warn (as of 0.2.4 linux / darwin emit that log too — previously only the win32 branch did). A missing / non-executable native binary (ENOENT etc.) is caught by the `error` event and **never bubbles up as an unhandled error that crashes the host process** (see issue #1)
- **The two channels are delivered to different machines (don't confuse them)**:
  - **Browser notifications** are pushed to **the browser client you are actually using** (your Mac / phone both count), and pop a native notification via the browser's Notification API; they require permission and by default only pop when the page is hidden (the settings card can enable "also when visible"). No matter which machine dsh web runs on, as long as browser notifications are allowed you receive them on your own Mac.
  - **System notifications (host toast)** are popped on the desktop of **the machine dsh web runs on**: if dsh web runs on a Linux server (headless, no desktop session) or some other machine, the toast appears on **that server**, not your Mac — the settings card / health reflects whether the channel is available. To also get the system toast on your Mac, run dsh web directly on your Mac (it then uses macOS `osascript`); macOS has no `notify-send`, and the system notification is already implemented via `osascript` (zero dependencies, nothing to install)
- **iOS difference**: Safari's normal tabs have no Web Notifications API (only the "Add to Home Screen" PWA does); on iOS the available channels are "in-page banner + sound when the page is visible" and system notifications after HTTPS + A2HS
- Browser notifications require a **secure context** (HTTPS or localhost); LAN HTTP access automatically routes through the fallback channel (banner / sound / title reminder)
- Browser notification permission is requested within a gesture (via the "Request notification permission" button on the Settings → Plugins → dsh-notifier card)
- Windows system notifications are implemented via a PowerShell WinRT script, with the command passed as a parameter array and title/body packed into a single base64 (UTF-8 JSON) payload argument (no shell concatenation surface, and immune to PS 5.1 command-line argument parsing ambiguities, see issue #238); the script idempotently registers the AppUserModelId `DSH.dsh-notifier` on startup (HKCU, no admin required) — an unregistered AUMID gets toasts silently dropped by Windows 10/11. The AUMID follows the `Company.Product` convention to avoid collisions in the public namespace (`HKCU\SOFTWARE\Classes\AppUserModelId`) where same-named apps overwrite each other's display names; a legacy `DSH` key registered by older versions is harmless leftover (just an empty registry entry, does not affect new toasts) and can be removed manually with `Remove-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\DSH"` if desired
- **Bark channel credentials & outbound security (M2)**:
  - **The device key never lands in the URL**: pushes go to `POST {baseUrl}/push` with a JSON body (the `device_key` field) — reverse-proxy access logs record URLs and headers by default, never bodies
  - **A single masking exit**: `deviceKey` in `GET /config`'s user+effective and in `PUT` success responses is always masked as `********`; submitting the full mask = keep the original value (backfilled aligned by instance id so a reordering never swaps credentials between instances)
  - **No credential replacement at the error exit (measured)**: Bark 4xx response bodies echo the key verbatim — failure reasons are truncated as-is and go to the logger and to `status.json`; the literal device-key replacement is gone, and so is the `sent` event as an exit (see "Security & boundaries")
  - **SSRF posture**: `baseUrl` is limited to the http/https scheme, credential URLs (`user:pass@host`) are rejected, and query/hash are dropped. **No domain allowlist** — pointing baseUrl at an intranet self-hosted bark-server is a legitimate case; known residual risk: a caller able to reach dsh web from the LAN (through a lan-proxy reverse proxy it can cross the loopback fence, see the deployment doc) can use `/test` to trigger one outbound POST to `baseUrl` (semi-blind: the response error summary echoes only a truncated raw excerpt). Deployments sensitive to that risk can turn the plugin's `enabled` off or adopt a dedicated-port setup (a later version)
- **Webhook channel credentials & outbound security (#508)**:
  - **Disabled by default**: `enabled` defaults to false — outbound authorization must be granted explicitly (same posture as Bark)
  - **Credentials never land in the URL**: credentials travel only in request headers (bearer → `Authorization: Bearer`, basic → `Authorization: Basic` (base64), header → custom header name + value); reverse-proxy access logs (URL + header names) never see them
  - **Credential masking funneled via `CHANNEL_SECRET_FIELDS`**: the masked-field list is a per-channel-type single source of truth (bark → `deviceKey`, webhook → `token`/`password`/`headerValue`); GET /config (user + effective) and PUT success responses always mask `********`, submitting the full mask = keep the original value (backfilled aligned by instance id so a reordering never swaps credentials between instances); a mask submitted for a new instance returns 400
  - **Reserved keys block config bypass (`WEBHOOK_RESERVED_KEYS`)**: credential alias keys such as `auth_token` / `access_token` / `bearer_token` / `api_key` / `apikey` / `client_secret` / `secret` / `password_hash` are always stripped / rejected on write — legitimate credentials can only enter via the known secret fields (masked end to end)
  - **JSON injection protection**: the template renders JSON-aware in two steps (value-level substitution + uniform re-serialization escaping); notification content cannot break out of a string to inject extra JSON fields
  - **Outbound errors do not replace credentials**: same as Bark — non-2xx response bodies are truncated to 200 chars and enter the reason's `detail` as-is, with no credential-literal replacement and no rule table (see "Security & boundaries")
  - **URL SSRF posture (same normalize as Bark)**: http/https schemes only, credential URLs (`user:pass@host`) rejected, query/hash stripped; no domain allowlist — an intranet self-hosted gateway is a legitimate use case; custom header names forbid end-to-end headers (`content-type`/`content-length`/`host`/`cookie`/`authorization`) against request smuggling / JSON body corruption
  - **No retry on failure**: a failed delivery is terminal (4xx/5xx/network/render) — no retry-driven outbound amplification
  - Webhook is an **additive channel type**: the semantics and compatibility commitments of existing channels and notification outputs (SSE frames / system notifications / history jsonl) are unchanged

## Verification

Tests are maintained in a single copy, with mutation coverage automatic: unit tests only live in
`test/*.test.ts` (`import "../lib/index.js"` exercises the built artifact); stryker reuses the
same assertions through the lib→src hook, so no hand-synced copy is needed.

```sh
# Health check (loopback)
curl -s http://127.0.0.1:3080/api/dsh-notifier/health

# Source is in src/, must build after changes
pnpm --filter @wingsky-1/dsh-notifier build
pnpm --filter @wingsky-1/dsh-notifier test
```

## License

MIT
