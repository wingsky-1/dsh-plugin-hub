# dsh-verify-isolated

An **isolated-environment browser verification** skill plugin for DSH plugin development:
quadruple isolation — temp `DSH_HOME` + dedicated `verify_<random>` profile + dedicated
port + **dedicated browser instance** — one command spins up an isolated `dsh web`, and it
cleans up on exit without polluting the `web` profile you are actually using.

## Installation

```bash
dsh plugin --profile web add @wingsky-1/dsh-verify-isolated
```

After installation, the `dsh-verify-isolated` skill is automatically registered as a
built-in skill and becomes available to all sessions in the profile (check with
`/skill dsh-verify-isolated`).

## How it works

- **Built-in skill registration**: `cordis.patch.yml` reuses the official
  `@deepseek-ai/dsh-skill-filesystem` `bundledSkillDir` configuration and resolves this
  package's `skills/` directory from the package manifest (following the
  [archify-dsh](https://github.com/tt-a1i/archify) pattern) — the official provider
  discovers and registers `skills/dsh-verify-isolated/SKILL.md`; no hand-written
  registration code needed;
- **Main line plus branches**: `SKILL.md` carries only what every run needs (when to
  use, quick path, the two hard preconditions, isolation self-check, verification and
  the done checklist); branch material (script contracts, manual setup, kernel
  troubleshooting, viewport-geometry methodology) lives in `references/`, each file
  self-contained and pointed at by the main line with the condition for reading it —
  a routine verification never loads the branches;
- **Quadruple isolation**: `DSH_HOME=$(mktemp -d)` isolates credentials/sessions/home-level
  patches; a dedicated `verify_<8 random chars>` profile isolates the plugin composition
  stack; a dedicated port isolates the network surface; a **dedicated browser instance**
  (`--browser`) isolates pages/tabs/console — parallel sessions cannot see each other,
  structurally eliminating the tab-drift crosstalk of a shared MCP browser;
- **Self-contained browser driver** `skills/dsh-verify-isolated/scripts/browser-driver.mjs`:
  raw CDP, zero dependencies (only Node ≥22's built-in global WebSocket), launches an
  independent chromium (temp user-data-dir + a free debug port of its choosing + headless),
  atomic-operation CLI (snapshot / click / eval / fill / wait / screenshot / console /
  quit), uniform `--json` output, instance info written to `browser.state`; **device
  emulation**: page commands accept `--width / --height / --dpr / --mobile` to verify
  responsive layouts viewport by viewport — applied within the command and cleared before
  it exits, so commands never affect each other (why it is not sticky state, see
  `scripts/lib/emulation.mjs`: CDP's Emulation state is per session, so clearing across
  connections silently fails and leaks the size); a three-platform kernel detection chain
  (`DSH_VERIFY_CHROME` env → ms-playwright cache → PATH → common platform paths), fail-fast
  with install guidance when all are missing;
- **Minimal startup dependencies**: profile bundles contain `@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-web-app` (built-in bundles are resolved by name from the dsh install
  directory, not via npm);
- **One-shot script** `skills/dsh-verify-isolated/scripts/verify-isolated.mjs`
  (Node implementation, requires Node ≥22; the historical bash `.sh` was removed
  with no shim left behind): validate the dsh entry and print its version (`--dsh` pins
  the target dsh version) → create temp DSH_HOME → **preset the first-run popup
  skip** (writes the internal-testing notice version into the isolated
  `settings.yaml`, see below) → create profile (explicit
  `plugin list` init) → inject web-app bundle → normalize plugin args (relative
  paths → absolute against cwd; package specs like `@scope/name` / git URLs pass
  through) → build and link local plugins
  (`--no-build` validates artifact presence + staleness warning) → (optionally
  `--browser`) launch a dedicated browser instance → start (explicit
  `--host 127.0.0.1` loopback + `DSH_TELEMETRY_DISABLED=1` telemetry off) →
  readiness probe → **parse and print the token-bearing access URL** (also
  written to `browser.state.dshWebUrl`) → unified cleanup on exit (dsh process +
  browser process + user-data-dir + DSH_HOME, no leftovers); `--port 0`
  auto-detects the real free port (no longer prints an invalid 0); **B6** writes
  a startup-self-check verdict at `$DSH_HOME/verdict.json` after ready (mode
  0o600, three-channel port source, cleanup field finalized on exit); **B7**
  `--evidence-dir` defaults to `$DSH_HOME/evidence/`, externalized as
  `<dir>/evidence-<profile>/` without ever touching the external directory;
  **B4** optional isolated audit `--audit` — diffs the isolated `$ISOLATED_HOME`
  write surface against a preset whitelist (versioned `WHITELIST_V`, pure
  functions in `scripts/lib/audit.mjs`); additions/deletions/modifications
  outside the whitelist plus escaping symlinks are reported as "suspicious" and
  **do not block exit** (`--audit-extra-dirs <dir>` adds extra audited dirs,
  must be a directory; limitation: real home is never scanned; the whitelist
  covers dsh's own write surface (`.credentials.yaml` / `settings.yaml` /
  `storages/**`) while version-drifted surfaces such as the official
  `profiles/node_modules/**` bundle links are captured by the post-readiness t0
  baseline — the audit surface is the incremental write surface of the runtime;
  `--keep` writes `$DSH_HOME/audit/audit.json`, otherwise the result is carried
  in the final verdict's `audit` field, and error-path JSON always carries an
  `audit` field aligned with the verdict); `--json` emits only the final verdict
  JSON on stdout. Exit-code contract: 0 OK / 1 startup-or-readiness failure /
  2 argument error / 130 SIGINT / 143 SIGTERM.
- **First-run popups are skipped by default**: a brand-new DSH_HOME opens on two
  **blocking** dialogs ("Internal Testing Notice" → "Add an API key to get
  started"); both set `#root` to `inert`, so every click on the page silently
  fails. Before startup the script presets `ui-onboarding.welcomeNoticeVersion`
  in `settings.yaml` (the value is read from the dsh client artifact's
  `WELCOME_NOTICE_VERSION` at run time rather than hardcoded — a stale value
  after a dsh upgrade silently brings the dialog back) to remove the first one;
  the API-key dialog cannot be preset away (its "Configure later" only holds for
  the current page lifetime and reappears on every reload), so browser-driver
  clicks through it after navigation. When no skip button is recognized it does
  **not guess** (the dialog may also offer a side-effecting "Save and continue"),
  reporting `onboardingBlocked` with a warning instead. `--no-skip-onboarding`
  keeps the native first-run state for verifying onboarding itself, and
  `--no-auto-dismiss` makes the browser side probe without clicking. The pure
  functions and probe live in `scripts/lib/onboarding.mjs`.
- **Access authentication (the token is mandatory)**: the dsh web GUI is
  authenticated, and a bare port returns a 401 text page
  (`dsh web authentication required`); since the readiness probe treats any
  2xx-4xx as ready, a missing token lets verification keep running against that
  401 page. The token exists only in the line dsh prints at startup; the script
  parses it, prints it, and writes it to `browser.state.dshWebUrl` (0o600) for
  browser-driver's reserved `--url state` value; the verdict records only the
  token-free `web.url`, and every echoed URL is redacted (`token=***`), so the
  token never reaches CI logs or evidence files.

## Package layout

```text
skills/dsh-verify-isolated/
  SKILL.md                        # skill definition (frontmatter name=dsh-verify-isolated; main line: when to use / quick path / hard preconditions / self-check / verification / done checklist)
  references/script-contracts.md  # branch: verdict fields, isolated-audit whitelist and timing, exit codes, Windows promise
  references/manual-setup.md      # branch: manual isolated-environment setup (the script's steps, expanded)
  references/browser-kernel.md    # branch: Chromium kernel detection chain, per-platform self-check and install
  references/viewport-geometry.md # branch: per-viewport device emulation and geometry-assertion methodology
  scripts/verify-isolated.mjs     # one-shot isolated verification script (Node, --dsh / --browser / --port 0 / --keep / --no-build / --evidence-dir / --audit / --audit-extra-dirs / --no-skip-onboarding / --json)
  scripts/lib/verify-core.mjs     # shared base utilities (exit-code constants/poll/findFreePort/port and token-URL parsing/C11 normalization)
  scripts/lib/audit.mjs           # B4 isolated-audit pure functions (scanSnapshot/diffAgainstWhitelist/checkSymlinkEscape/runAudit + versioned whitelist WHITELIST_V)
  scripts/lib/emulation.mjs       # device-emulation pure functions (parseEmulationFlags / buildDeviceMetrics; CDP session semantics)
  scripts/lib/onboarding.mjs      # first-run popup skip pure functions (version constant lookup / settings doc / overlay probe expression / token redaction)
  scripts/browser-driver.mjs      # self-contained browser driver (raw CDP, zero deps, --json atomic CLI)
cordis.patch.yml                  # reuses official dsh-skill-filesystem + bundledSkillDir
lib/index.js                      # host gate export (name + empty apply)
```

## Usage

Once the skill is loaded, follow its checklist; you can also call the package's one-shot
script directly. The script's resource base directory relative to the skill (the
`Base directory for this skill:` absolute path injected when the skill loads) is always
`scripts/verify-isolated.mjs` (Node implementation, requires Node ≥22; upgrade path from
the old bash version: `bash .../verify-isolated.sh ...` → `node .../verify-isolated.mjs ...`),
adaptive to the install shape (npm copy / `link:` dev mode / in-repo browsing all work);
see SKILL.md §2:

```bash
# SKILL_BASE = the "Base directory for this skill:" absolute path injected when the skill loads
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 3456 <plugin-package-path>
# parallel sessions / browser verification: --port 0 auto-detects the port,
# --browser launches a dedicated browser instance
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --browser <plugin-package-path>
# pin the dsh version (required when verifying a specific dsh release's ecosystem,
# prevents PATH drift)
node "$SKILL_BASE/scripts/verify-isolated.mjs" --dsh /opt/dsh-0.1.2-alpha.2/bin/dsh --port 0 <plugin-package-path>
# externalize the evidence dir + emit only the final verdict JSON on stdout (human text on stderr)
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --evidence-dir /tmp/my-evidence --json <plugin-package-path>
# isolated audit (B4): changes outside the whitelist are reported as suspicious and do not block exit;
# --keep writes $DSH_HOME/audit/audit.json
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --audit --keep <plugin-package-path>
# keep the native first-run state (to verify the onboarding popups themselves;
# the skip is preset by default, see SKILL.md §4.1)
node "$SKILL_BASE/scripts/verify-isolated.mjs" --port 0 --no-skip-onboarding <plugin-package-path>
```

Plugin arguments accept either **local plugin paths** (relative paths are resolved to
absolute paths against the current cwd before mounting — dsh otherwise parses a
non-absolute path as a git URL) or **package specs** (npm package names /
git URLs pass through unchanged).

Browser instance operations (instance info in `$DSH_HOME/browser.state`; the command
contract is in `browser-driver.mjs --help`. **Page-operation commands need Node ≥22** —
they rely on the built-in global WebSocket; older versions error at connect time and
prompt for an upgrade):

```bash
# --url state: use the token-bearing URL from state (the GUI is authenticated;
# a bare port only yields a 401 text page)
node "$SKILL_BASE/scripts/browser-driver.mjs" snapshot --state "$DSH_HOME/browser.state" --url state
node "$SKILL_BASE/scripts/browser-driver.mjs" click --state "$DSH_HOME/browser.state" --selector "button.start"
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$DSH_HOME/browser.state" --url state --path shot.png
# device emulation (available on every page command): verify responsive layouts
# viewport by viewport; applied within the command and cleared when it exits
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$DSH_HOME/browser.state" --url state --width 375 --height 667 --path phone.png
node "$SKILL_BASE/scripts/browser-driver.mjs" eval --state "$DSH_HOME/browser.state" --width 375 --height 667 --expression "innerWidth+'x'+innerHeight"
```

Navigating commands automatically skip the first-run popups after navigation (the output
records the clicked buttons under `dismissed`; when no skip button is recognized it
reports `onboardingBlocked` with a warning). `--no-auto-dismiss` probes without clicking
and `--overlay-wait <ms>` tunes the popup wait window (default 1500). `eval` / `fill` do
not navigate and therefore do not trigger this logic.

## Security model

- The isolated environment carries no real credentials (the temp `DSH_HOME` has no
  `~/.dsh` data); the first-run popup skip only writes the isolated
  `$DSH_HOME/settings.yaml` (0o600) and clicks the dialog's own "Configure later"
  button — it injects and copies **no API key**. The script inherits the launching
  environment (`{...process.env}`, unchanged semantics), so provider credential
  variables already present there take effect per dsh's official precedence; launch
  from a shell without them if you need a fully clean credential surface;
- **Minimal token exposure**: the token-bearing GUI URL is written only to the 0o600
  `$DSH_HOME/browser.state` (`dshWebUrl`) and `$DSH_HOME/dsh.log`; every URL echoed by
  the script and browser-driver is redacted (`token=***`), and the verdict records only
  the token-free `web.url` — the token never reaches `--json` output, CI logs, or
  evidence archives;
- The isolated `dsh web` binds explicitly to loopback (`--host 127.0.0.1`, reachable
  from this machine only) and explicitly disables telemetry
  (`DSH_TELEMETRY_DISABLED=1`, no test data leaves the machine);
- Isolated verification covers the **loopback access shape** only (the script pins
  `--host 127.0.0.1`). To verify LAN/mobile access, start it yourself with the official
  `--trusted-host <authority>` and confirm the plugin under test authenticates as expected
  in that shape;
- It never stops/restarts the running main `dsh web` process (dedicated port);
- The browser instance binds only to a loopback debug port
  (`--remote-debugging-address=127.0.0.1`), reachable from this machine only;
- The scripts only use `mktemp -d` temp directories, cleaned up on exit (with `--browser`
  the browser process and user-data-dir are also cleaned up), leaving no
  leftovers.
