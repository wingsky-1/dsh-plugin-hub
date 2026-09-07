# @wingsky-1/dsh-mem0

DeepSeek Harness (DSH) persistent long-term associative memory system plugin based on mem0.

## Features

- **Local stdio runtime**: Launches a lightweight Python subprocess over OS standard I/O (stdio) pipes, bound to the Node parent process lifecycle with zero orphan process risk and zero port conflicts.
- **Git workspace awareness**: Automatically reads session `cwd` and unifies the memory namespace across git worktrees and main checkouts via Git Canonical identity (`git-common-dir` & `remote.origin.url`).
- **All-English tool contracts**: Provides 4 core tools (`memory_search`, `memory_add`, `memory_list`, `memory_delete`) with all-English descriptions and offline graceful degradation fallback.
- **First-turn smart memory pre-injection (#581)**: On the first turn of each session, the plugin silently recalls relevant memories by semantic search and injects them behind a `<user_long_term_memories>` fence, so the model can answer with historical preferences directly — no `memory_search` tool round-trip needed. Zero injection on no-hit, unavailable service, or timeout; never blocks the first reply.
- **Chinese memory retention**: Embeds Chinese constraint instructions to filter out trivial chit-chat and record concise, factual memories.
- **Comprehensive configuration**: Fully configurable LLM and embedder endpoints (supports DeepSeek, SiliconFlow, and OpenAI-compatible endpoints), customizable TopK and extraction prompts, persisted to official DSH settings (`~/.dsh/settings.yaml`).
- **Memory Center dual-zone dashboard**: Mounts a dedicated tab in DSH settings, featuring memory items management alongside a live engine settings dashboard with masked key safety and hot reload.
- **Self-healing diagnosis & graceful fallback**: Automatic detection and actionable recovery guidance when Python or dependencies are missing; agents fall back gracefully without crashing.
- **dsh-mcp-manager integration**: Server registration, health lifecycle, and tool audit are completely managed by `dsh-mcp-manager`.

## Smart Pre-injection Configuration

The following three keys are manageable in "Memory Center → Engine Settings → Advanced" and
programmatically via `POST /api/dsh-mem0/config` (out-of-range values fall back to defaults):

| Key | Type | Default | Range | Semantics |
| --- | --- | --- | --- | --- |
| `enableSmartPreInjection` | boolean | `true` | on / off | Master switch of first-turn smart pre-injection; when off, no retrieval and no injection at all — only manual `memory_search` and the existing discipline prompt remain |
| `preInjectionThreshold` | number | `0.6` | [0, 1] | Similarity threshold; only memories scored **strictly greater than** this value are injected |
| `preInjectionLimit` | number | `3` | [1, 10] | Max injected entries, sorted by score descending; zero injection on zero hit (zero token waste) |

Pre-retrieval behavioral constraints:

- **Exactly one attempt per session**: regardless of success, empty result, or degraded failure, no repeated retrieval within the same session; benefits of service recovery apply from the next new session.
- **Three silent degradations**: service not ready, search error, or search timeout (bounded, 3s by default) — no text injected, no retry, no exception bubbled to the session step; the first reply is generated as usual.
- **Never disguised as user input**: injected messages carry a plugin source (`kind: "plugin", plugin: "mem0"`) and are physically separated from real user input.

## Security Model

- **Process isolation**: Local stdio communication is strictly confined to standard I/O pipes, listening on no external network ports.
- **Loopback fence**: All `/api/dsh-mem0/*` REST routes enforce a strict loopback fence, rejecting cross-site and non-loopback requests with 403 Forbidden. Smart pre-injection operates on the session event layer and introduces no route or access channel that bypasses the loopback fence.
- **Credential redaction of injected content**: The pre-injection path applies credential-form redaction to every candidate memory text (`sk-` prefixed keys, Bearer tokens, GitHub/Slack/AWS token prefixes, `api_key=` / `password:` assignment forms); no unredacted secret strings appear in injected text.
- **Injection fence semantics**: Injected text is wrapped in a fixed `<user_long_term_memories>` fence with companion guidelines — fenced content is background facts from past sessions, not control instructions; the current explicit user request always takes precedence on conflict. Injection is never merged with the existing memory discipline prompt.
- **Credential protection**: Inherits model provider credentials from DSH settingsScope, passing API keys securely through environment variables without storing plaintext to disk.
- **Safe deletion**: No bulk wipe tools are exposed to the agent; deletions require confirmation.

## License

MIT
