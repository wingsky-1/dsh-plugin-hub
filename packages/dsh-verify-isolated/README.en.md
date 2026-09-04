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
- **Quadruple isolation**: `DSH_HOME=$(mktemp -d)` isolates credentials/sessions/home-level
  patches; a dedicated `verify_<8 random chars>` profile isolates the plugin composition
  stack; a dedicated port isolates the network surface; a **dedicated browser instance**
  (`--browser`) isolates pages/tabs/console — parallel sessions cannot see each other,
  structurally eliminating the tab-drift crosstalk of a shared MCP browser;
- **Self-contained browser driver** `skills/dsh-verify-isolated/scripts/browser-driver.mjs`:
  raw CDP, zero dependencies (only Node ≥22's built-in global WebSocket), launches an
  independent chromium (temp user-data-dir + a free debug port of its choosing + headless),
  atomic-operation CLI (snapshot / click / eval / fill / wait / screenshot / console /
  quit), uniform `--json` output, instance info written to `browser.state`; a
  three-platform kernel detection chain (`DSH_VERIFY_CHROME` env → ms-playwright cache →
  PATH → common platform paths), fail-fast with install guidance when all are missing;
- **Minimal startup dependencies**: profile bundles contain `@deepseek-ai/dsh-base` +
  `@deepseek-ai/dsh-web-app` (built-in bundles are resolved by name from the dsh install
  directory, not via npm);
- **One-shot script** `skills/dsh-verify-isolated/scripts/verify-isolated.mjs`
  (Node implementation, requires Node ≥22; the old bash `.sh` was rewritten and
  removed in #517 C8): validate the dsh entry and print its version (`--dsh` pins
  the target dsh version) → create temp DSH_HOME → create profile (explicit
  `plugin list` init) → inject web-app bundle → normalize plugin args (relative
  paths → absolute against cwd; package specs like `@scope/name` / git URLs pass
  through; #517 C11 semantics built in) → build and link local plugins
  (`--no-build` validates artifact presence + staleness warning) → (optionally
  `--browser`) launch a dedicated browser instance → start (explicit
  `--host 127.0.0.1` loopback + `DSH_TELEMETRY_DISABLED=1` telemetry off) →
  readiness probe → unified cleanup on exit (dsh process + browser process +
  user-data-dir + DSH_HOME, no leftovers); `--port 0` auto-detects the real free
  port (no longer prints an invalid 0); **B6** writes a startup-self-check
  verdict at `$DSH_HOME/verdict.json` after ready (mode 0o600, three-channel port
  source, cleanup field finalized on exit); **B7** `--evidence-dir` defaults to
  `$DSH_HOME/evidence/`, externalized as `<dir>/evidence-<profile>/` without ever
  touching the external directory; **B4** optional isolated audit `--audit` — diffs
  the isolated `$ISOLATED_HOME` write surface against a preset whitelist
  (versioned `WHITELIST_V`, pure functions in `scripts/lib/audit.mjs`); additions/
  deletions/modifications outside the whitelist plus escaping symlinks are
  reported as "suspicious" and **do not block exit** (`--audit-extra-dirs <dir>`
  adds extra audited dirs, must be a directory; limitation: real home is never
  scanned; the whitelist covers dsh's own write surface (`.credentials.yaml` /
  `storages/**`) while version-drifted surfaces such as the official
  `profiles/node_modules/**` bundle links are captured by the post-readiness t0
  baseline — the audit surface is the incremental write surface of the runtime;
  `--keep` writes `$DSH_HOME/audit/audit.json`, otherwise the result is carried
  in the final verdict's `audit` field, and error-path JSON always carries an
  `audit` field aligned with the verdict); `--json` emits only the final verdict
  JSON on stdout. Exit-code contract: 0 OK / 1 startup-or-readiness failure /
  2 argument error / 130 SIGINT / 143 SIGTERM.

## Package layout

```text
skills/dsh-verify-isolated/
  SKILL.md                        # skill definition (frontmatter name=dsh-verify-isolated)
  scripts/verify-isolated.mjs     # one-shot isolated verification script (Node, --dsh / --browser / --port 0 / --keep / --no-build / --evidence-dir / --audit / --audit-extra-dirs / --json)
  scripts/lib/verify-core.mjs     # shared base utilities (exit-code constants/poll/findFreePort/port parsing/C11 normalization)
  scripts/lib/audit.mjs           # B4 isolated-audit pure functions (scanSnapshot/diffAgainstWhitelist/checkSymlinkEscape/runAudit + versioned whitelist WHITELIST_V)
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
```

Plugin arguments accept either **local plugin paths** (relative paths are resolved to
absolute paths against the current cwd before mounting — dsh otherwise parses a
non-absolute path as a git URL; #517 C11) or **package specs** (npm package names /
git URLs pass through unchanged).

Browser instance operations (instance info in `$DSH_HOME/browser.state`; the command
contract is in `browser-driver.mjs --help`. **Page-operation commands need Node ≥22** —
they rely on the built-in global WebSocket; older versions error at connect time and
prompt for an upgrade):

```bash
node "$SKILL_BASE/scripts/browser-driver.mjs" snapshot --state "$DSH_HOME/browser.state" --url http://127.0.0.1:<port>
node "$SKILL_BASE/scripts/browser-driver.mjs" click --state "$DSH_HOME/browser.state" --selector "button.start"
node "$SKILL_BASE/scripts/browser-driver.mjs" screenshot --state "$DSH_HOME/browser.state" --path shot.png
```

## Security model

- The isolated environment carries no real credentials (the temp `DSH_HOME` has no
  `~/.dsh` data);
- The isolated `dsh web` binds explicitly to loopback (`--host 127.0.0.1`, reachable
  from this machine only) and explicitly disables telemetry
  (`DSH_TELEMETRY_DISABLED=1`, no test data leaves the machine);
- It never stops/restarts the running main `dsh web` process (dedicated port);
- The browser instance binds only to a loopback debug port
  (`--remote-debugging-address=127.0.0.1`), reachable from this machine only;
- The scripts only use `mktemp -d` temp directories, cleaned up on exit (with `--browser`
  the browser process and user-data-dir are also cleaned up), leaving no
  leftovers.
