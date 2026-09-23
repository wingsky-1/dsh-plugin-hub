# dsh-decision-gateway

General-purpose assistant decision gateway (JEV is the first provider): frozen asking guides (English) + dual-track keys + local secret-shape precheck + official SystemOne calls (transport via the official `@typesafe-ai/sdk`, inlined at build time; base URL and model are both pinned, zero runtime dependencies).

Scope: suited for agent decisions needing calibrated binary / score / risk verdicts, secret-shaped text prechecked locally before egress, and auditable switches/history; not suited for auto-execution (advisory levels only, no executors), open-ended reasoning (frozen templates only), or reliable queues/transactional writes.

One-click install (restart `dsh web` afterwards to activate):

```sh
dsh plugin --profile web add @wingsky-1/dsh-decision-gateway
```

- Model tools: `ws_request_verdict` (decide), `ws_list_verdict_guides` (read-only).
- Loopback routes: `/api/dsh-decision-gateway/health|config|presets|history|test-connection`.
- 5 frozen asking guides (templateVersion always 1, English prose, zero preset questions): general / secret-leak (disabled by default) / plan-review / risk-check / custom. Callers bring the full question set per call via `questions_override` (1-20 questions, required; the first question drives the verdict, extra questions travel as context). Wording note: general changed from binary/two to a 2-10-candidate choice, custom changed from three to first-question-driven; templateVersion stays 1; stored history templateVersion remains observably 1. Tool params: `preset_id` is one of the 5 frozen ids or a custom id (custom:true entries from `ws_list_verdict_guides`); `state.lang` is en/zh/unknown and defaults to unknown when omitted; score questions carry no options but may carry 2-10 levels (default 1-5 when omitted, e.g. five levels 1-5 or two levels low-high rescaled to 1-5).
- Custom presets (`custom-presets.json`, absent means empty): incremental `PUT /config` key `customPresets` (full replace; ids must not collide with frozen, cap 0|1|2); custom ids are directly decidable (same switch/cap semantics); history stores a redacted snapshot of the called questions, and `GET /history` enriches display titles (only ids are stored).

## Quick start

1. Install and restart `dsh web` (command at the top); the dsh-decision-gateway card appears in settings, and service-available on the connection tab means the host side is mounted.
2. Set the key (either): put an exported ENV name in `apiKeyRef` (recommended, the value never lands on disk); or unfold the plaintext section and paste the key (no double confirmation).
3. Hit test-connection (`POST /test-connection`, empty body is legal): `ok` + `latencyMs` means end-to-end works; on `NO_KEY`, check the ENV export or whether the plaintext was saved.

## Configuration

Three files under `~/.dsh/@wingsky-1/dsh-decision-gateway/` (`DSH_HOME`-aware, dirs 0700 / files 0600 / atomic writes):

- `config.json`: `{version:1, connection:{apiKeyRef?,hasPlaintextKey,timeoutMs:8000,maxConcurrency:4,truncBudget:32000}, presets:[5 ids+enabled+automationCap(0|1|2)], history:{perSession:200,totalSessions:50}}`;
- `presets.json`: switch overlay; `secrets.json`: the only plaintext location; `VERSION`: storage version tick.

PUT `/config`: `apiKeyRef` must match `^[A-Z][A-Z0-9_]{1,63}$`; mutually exclusive with `apiKeyPlaintext`; plaintext needs no confirmation (a `confirm` field is ignored when present); shape rejections are 400 with category only; retired keys like `baseUrl` are 400.

## Security model

- **Off-device data**: truncated text + questions leave the device only when the local secret-shape precheck misses and a key is available; on hit (e.g. `sk-…`, `AKIA…`, `ghp_…`, private-key blocks, `password=`) nothing leaves and the decision routes to human (`appliedSource: local-precheck`, `choice: human`); a first-answer Noul (abstention) likewise forces tier none and routes to human.
- **Dual-track keys**: ENV reference (`apiKeyRef`) wins over plaintext; switching to ENV folds (clears) `secrets.json`; plaintext writes need no confirmation; mutual exclusion is still enforced server-side.
- **0600/0700**: namespace dir 0700, files 0600, temp-file + rename atomic writes.
- **Masked surface**: GET `/config` returns only the `apiKeyRef` name and `hasPlaintextKey`; key material is never echoed; shape rejections return only an `empty|too-short|charset` category.
- **secret preset warning**: `secret-leak` is disabled by default, enable it only when you must check untrusted text for real secrets (local precheck still runs first when enabled); history `snippetRedacted` is redacted-then-truncated to ≤200 chars; raw keys are never stored.
- **Pinned BaseURL**: `https://api.typesafe.ai/v1/systemone` is a load-asserted constant, never configurable; PUT with `baseUrl`-like keys is 400. The model is pinned to `jev-latest` under the same treatment; score floats rescale to 1..5 by sent level count (default five levels behave as round+1, all clamped; custom 2-10 levels travel in `levels`, e.g. five levels 1-5 or two levels low-high), tiers derive from confidence at ≥0.8 high/≥0.5 low (else none).

## History

One jsonl file per (workdir rootHash, sessionId) (workdir comes from the session store, falling back to the caller directory): 200 entries per session rotation, 50 sessions total (count semantics only; no pinning on mtime ties). Stored entries carry templateVersion (always 1, observable; wording revisions do not bump the version). Query `root` accepts a full path, a `rootHash`, or a bare basename (matched against `rootDisplay`); deletion is single-session only (`root` + `sessionId` both required, ambiguous basenames are 400). Session titles enrich at read time for live sessions only (`sessionTitle`, falling back to the short id, never persisted).

## Verification and troubleshooting

- Liveness: `GET /api/dsh-decision-gateway/health` returns `ok` / `version` / `templateVersion`.
- Fence: non-loopback callers always get 403, off-table methods get 405 (403 is checked first).
- Common failures: `NO_KEY` (no usable key), `PRESET_DISABLED` (preset switched off), `MUTUALLY_EXCLUSIVE` (`apiKeyRef` sent together with plaintext), key-shape 400s return only an `empty|too-short|charset` category.
- Missing history: prefer a full path or `rootHash` for `root` (basenames match against `rootDisplay`, ambiguous delete is 400); `GET /history` defaults to 100 entries, max 500.

## Follow-ups (deferred, not in this version)

- **Startup self-check migration**: the assembly-time chain currently only anchors versions (seed when missing / no-op when anchored / refuse future versions); config self-checks and legacy migrations arrive with future steps. Plaintext double confirmation was removed with explicit user approval.
- **Non-grouped three-file writes**: config/presets/secrets are three independent atomic writes, not one transaction; a crash between writes may leave mixed old/new state (read side converges with fill-defaults). That crash window is tolerated, no WAL.
