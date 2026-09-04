# dsh-codegraph

codegraph MCP + worktree development discipline — packages [codegraph](https://github.com/colbymchenry/codegraph)
(a local code-graph MCP, `@colbymchenry/codegraph`) together with its companion worktree
development discipline into a one-shot dsh plugin.

## Features

- **Detect + guided install**: automatically detects the codegraph CLI; when missing, injects
  guidance (prints the install command, does not execute it by default).
- **Runtime registration**: registers the codegraph MCP server (`codegraph serve --mcp`,
  in-memory only, nothing persisted) through the dsh-mcp-manager core service
  (`ctx.mcpManager`); MCP registration/management/usage is based on the mcp-manager
  integration (inject strong dependency, see "Dependencies").
- **Wrapper definitions registered via mcp-manager (architecture convergence, #363 addendum 3)**:
  dsh-codegraph **no longer registers any bare-name tools itself** — the 8 wrapper tools
  (`codegraph_explore` / `codegraph_impact` / `codegraph_node` / `codegraph_callers` /
  `codegraph_callees` / `codegraph_search` / `codegraph_files` / `codegraph_status`) go
  through the `registerServer.toolDefinitions` channel (#362 addendum 4) and are handed to
  mcp-manager for unified registration and management. Every wrapper `execute` first runs
  `codegraph sync` (hard freshness guarantee: worktree indexes never go stale; a TTL cache
  skips re-syncing the same projectPath within 30s; query results are never cached) and then
  validates/completes `projectPath` (defaults to the current session worktree; refused with
  a hint when auto-completion is impossible) before internally forwarding to the real
  codegraph CLI (the underlying implementation is fully internalized; the model only sees
  the wrapper tools). This eliminates "worktree index silently going stale" and "missing
  projectPath querying the wrong object".
- **Agent discipline hook**: `agent/pre-step` + session cwd detection — only git-repo
  sessions (main checkout / worktree) get the worktree development discipline injected,
  delivered as a pre-step user message (the official dsh-tool-skill carrier, visible in the
  GUI "Context injection" panel, idempotent via session-history lookup); non-git-repo
  sessions (day-to-day maintenance / discussion spaces) get nothing — multiple workspaces
  are naturally distinguished (by session cwd, no configuration needed). The discipline is
  orthogonal to the MCP capability catalog (the discipline teaches tool usage; the catalog
  lists servers), with no ordering dependency. The discipline is a **scenario decision
  table** (#417 item A): structure-type queries (who calls X / who is affected by changing
  X / symbol definitions and call chains) prefer codegraph, picking
  `codegraph_impact` / `node` / `callers` / `callees` / `search` / `files` / `status` by
  scenario; grep only for full-text word search; files being edited are always Read from
  the original text.
- **Capability catalog description (A2, #417)**: registration carries a server-level
  `description` — the `available_mcp_servers` entry prefers it (falling back to a summary
  of tool descriptions when absent, which happened to be `codegraph_files`'s "list file
  structure", burying the core explore/impact/callers capabilities); with it added, the
  catalog faithfully presents the structure-type query capabilities.

## Installation

```bash
# 1. Install the codegraph CLI (this plugin never executes third-party commands
#    automatically; the user/agent must install explicitly)
npm install -g @colbymchenry/codegraph
# or the official install.sh (installs the binary into ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | bash

# 2. Create the project index (independent per worktree)
cd your-project && codegraph init

# 3. Mount the plugin into dsh (install @wingsky-1/dsh-codegraph via profile;
#    dsh-mcp-manager must be enabled)
```

## Configuration

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `autoInstall` | `false` | Auto-install the codegraph CLI when missing (guidance only by default; enabling it requires acknowledging the supply-chain risk) |
| `installCommand` | `npm install -g @colbymchenry/codegraph` | Custom install command |
| `injectDiscipline` | `true` | Inject the discipline into git-repo sessions |

> The tool-layer discipline (mandatory pre-query sync + projectPath validation/completion)
> is the core value and is hard-coded as default behavior with no off switch — so that
> "worktree indexes never go stale" and "projectPath is never omitted" cannot be bypassed
> via configuration.

## Worktree development workflow

```
git worktree add ../dsh-hub-task-<n> -b task/<n>   # create the worktree
codegraph init ../dsh-hub-task-<n>                 # create that worktree's index (independent per worktree)
# while developing, query tools auto-sync first (no manual step needed)
# when the worktree is cleaned up at task end, .codegraph/ is deleted with the directory
```

- `.codegraph/` is a local runtime artifact (gitignore recommended), never committed;
- queries against non-init directories return guidance instead of errors; the index only
  covers files as of init/sync time.

## Security model

- **Never auto-executes third-party install commands** (`autoInstall: false` by default):
  the install command comes from `@colbymchenry/codegraph` (third-party); the supply-chain
  risk is borne by the user who explicitly runs the installation; enabling `autoInstall`
  requires acknowledging that the plugin will execute that command.
- **stdio subprocesses inherit host permissions**: the codegraph MCP server runs with the
  host process's permissions (same as other stdio MCP servers).
- **The index is unencrypted local SQLite**: `.codegraph/` contains the structure of all
  source code; watch directory permissions on multi-user machines.
- **External binary, not self-contained**: codegraph is an independently installed binary
  not shipped with this plugin; the plugin only detects + guides installation (the
  published artifact is self-contained, with no runtime npm dependencies).
- **Tools execute on real servers**: codegraph wrapper tools really query local indexes;
  confirm before operating.

## Wrapper tools (registered via mcp-manager)

| Tool | Purpose | Parameters (aligned with CLI 1.6.0 field tests) |
|---|---|---|
| `codegraph_explore` | Structure-type query (related symbol sources + call paths) | `query` (required), `projectPath`? |
| `codegraph_impact` | Impact scope of modifying/deleting a symbol | `symbol` (required), `depth`? (1-5, default 2), `projectPath`? |
| `codegraph_node` | Single symbol source + trail (symbol mode) / read file + symbol table (file mode) | `symbol`? and `file`? choose one, `offset`?, `limit`?, `symbolsOnly`?, `projectPath`? |
| `codegraph_callers` | Who calls X | `symbol` (required), `limit`? (1-100, default 20), `projectPath`? |
| `codegraph_callees` | What X calls | `symbol` (required), `limit`? (1-100, default 20), `projectPath`? |
| `codegraph_search` | Search symbols by keyword (maps CLI `query` subcommand) | `query` (required), `kind`?, `limit`? (default 10), `projectPath`? |
| `codegraph_files` | List project file structure from the index | `filter`?, `pattern`?, `format`? (tree/flat/grouped), `maxDepth`?, `projectPath`? |
| `codegraph_status` | Show index status and statistics | `path`? (positional, defaults to the current worktree) |

> Parameter schemas are aligned with CLI field tests: impact/callers/callees have no
> `file`, node has no `line`, files uses `filter` (the CLI's `--filter`) rather than
> `path`, and status's path is a positional argument.

> **Registration shape**: the 8 wrapper definitions are handed to mcp-manager for
> registration via `registerServer.toolDefinitions` (#362 addendum 4). In project mode
> tools register with the `mcp__codegraph__<tool>` prefix and project-level servers are
> called by bare name through the middleware `ws_mcp_call`; in all mode everything goes
> through `ws_mcp_call` bare-name calls. This plugin never registers tools directly and
> only provides wrappers (pre-sync + worktree discipline); per-tool disabling takes
> effect on the wrapper tools via mcp-manager.

## Dependencies

- **dsh-mcp-manager** (provides the `ctx.mcpManager` service): **strong dependency**
  (declared via inject). MCP registration/management/usage is based on the mcp-manager
  integration; when mcp-manager is not enabled this plugin is automatically deactivated
  by the cordis kernel (and reactivated once enabled) — no separate degradation.
- codegraph CLI (`@colbymchenry/codegraph`, detection + guided install)
