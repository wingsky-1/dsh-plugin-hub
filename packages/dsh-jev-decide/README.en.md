# dsh-jev-decide

JEV decision gateway: frozen preset templates + dual-track keys + local secret-shape precheck + official SystemOne calls.

One-click install (restart `dsh web` afterwards to activate):

```sh
dsh plugin --profile web add @wingsky-1/dsh-jev-decide
```

- Model tools: `ws_jev_decide` (decide), `ws_jev_list_presets` (read-only).
- Loopback routes: `/api/dsh-jev-decide/health|config|presets|history|test-connection`.
- 5 frozen presets (templateVersion always 1): general / secret-leak (disabled by default) / plan-review / risk-check / custom.

## Configuration

Three files under `~/.dsh/@wingsky-1/dsh-jev-decide/` (`DSH_HOME`-aware, dirs 0700 / files 0600 / atomic writes):

- `config.json`: `{version:1, connection:{apiKeyRef?,hasPlaintextKey,timeoutMs:8000,maxConcurrency:4,truncBudget:32000}, presets:[5 ids+enabled+automationCap(0|1|2)], history:{perSession:200,totalSessions:50}}`;
- `presets.json`: switch overlay; `secrets.json`: the only plaintext location; `VERSION`: storage version tick.

PUT `/config`: `apiKeyRef` must match `^[A-Z][A-Z0-9_]{1,63}$`; mutually exclusive with `apiKeyPlaintext`; plaintext needs `confirm:true`; shape rejections are 400 with category only; retired keys like `baseUrl` are 400.

## Security model

- **Off-device data**: truncated text + questions leave the device only when the local secret-shape precheck misses and a key is available; on hit (e.g. `sk-…`, `AKIA…`, `ghp_…`, private-key blocks, `password=`) nothing leaves and the decision routes to human (`appliedSource: local-precheck`).
- **Dual-track keys**: ENV reference (`apiKeyRef`) wins over plaintext; switching to ENV folds (clears) `secrets.json`; plaintext writes need double confirmation, enforced server-side with mutual exclusion.
- **0600/0700**: namespace dir 0700, files 0600, temp-file + rename atomic writes.
- **Masked surface**: GET `/config` returns only the `apiKeyRef` name and `hasPlaintextKey`; key material is never echoed; shape rejections return only an `empty|too-short|charset` category.
- **secret preset warning**: `secret-leak` is disabled by default (local precheck still runs first when enabled); history `snippetRedacted` is redacted-then-truncated to ≤200 chars; raw keys are never stored.
- **Pinned BaseURL**: `https://api.typesafe.ai/v1/systemone` is a load-asserted constant, never configurable; PUT with `baseUrl`-like keys is 400.

## History

One jsonl file per (workdir rootHash, sessionId): 200 entries per session rotation, 50 sessions total (count semantics only; no pinning on mtime ties). Query `root` accepts a full path, a `rootHash`, or a bare basename (matched against `rootDisplay`); deletion is single-session only (`root` + `sessionId` both required, ambiguous basenames are 400).

## Follow-ups (deferred, not in this version)

- **Startup self-check migration**: the assembly-time chain currently only anchors versions (seed when missing / no-op when anchored / refuse future versions); config self-checks and legacy migrations arrive with future steps. Client double confirmation (plaintext writes need `confirm:true`) stays, enforced server-side too.
- **Non-grouped three-file writes**: config/presets/secrets are three independent atomic writes, not one transaction; a crash between writes may leave mixed old/new state (read side converges with fill-defaults). That crash window is tolerated, no WAL.
