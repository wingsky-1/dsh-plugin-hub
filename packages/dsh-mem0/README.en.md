# @wingsky-1/dsh-mem0

DeepSeek Harness (DSH) persistent long-term associative memory system plugin based on mem0.

## Features

- **Local stdio runtime**: Launches a lightweight Python subprocess over OS standard I/O (stdio) pipes, bound to the Node parent process lifecycle with zero orphan process risk and zero port conflicts.
- **Git workspace awareness**: Automatically reads session `cwd` and unifies the memory namespace across git worktrees and main checkouts via Git Canonical identity (`git-common-dir` & `remote.origin.url`).
- **All-English tool contracts**: Provides 4 core tools (`memory_search`, `memory_add`, `memory_list`, `memory_delete`) with all-English descriptions and offline graceful degradation fallback.
- **Chinese memory retention**: Embeds Chinese constraint instructions to filter out trivial chit-chat and record concise, factual memories.
- **Memory Center settings tab**: Mounts a dedicated "Memory Center" tab in the DSH settings panel via the official `settings.section` slot.
- **dsh-mcp-manager integration**: Server registration, health lifecycle, and tool audit are completely managed by `dsh-mcp-manager`.

## Security Model

- **Process isolation**: Local stdio communication is strictly confined to standard I/O pipes, listening on no external network ports.
- **Loopback fence**: All `/api/dsh-mem0/*` REST routes enforce a strict loopback fence, rejecting cross-site and non-loopback requests with 403 Forbidden.
- **Credential protection**: Inherits model provider credentials from DSH settingsScope, passing API keys securely through environment variables without storing plaintext to disk.
- **Safe deletion**: No bulk wipe tools are exposed to the agent; deletions require confirmation.

## License

MIT
