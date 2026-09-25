# Agent Note: rc2 settings effective-layer merge

Status: implemented

## Problem

In an isolated DSH 0.1.7-rc.2 profile, a LAN settings save updated the canonical
profile patch and emitted the normal settings/config-reload events, but
`settings.describe()` exposed the pre-reload runtime `value` together with the
new `user` override. The shared seam read only `value`, so the running forwarder
kept port 3081 and `listening: false` after the user selected another port.

## Decision

The shared `settings-namespace.js` seam composes the descriptor's `base` and
`user` layers for its effective source. Nested plain objects merge recursively;
arrays and scalar values use the user layer as a whole-value replacement. A
minimal host that exposes only `value` keeps the previous fallback.

The seam subscribes to `settings/document-updated` with Cordis `global: true`
so owner-context events cross the plugin fiber boundary. The injected scoped
context is preferred; the host context is used only when the scoped event surface
is unavailable or throws. The existing namespace filter and detached-value
snapshot remain responsible for change deduplication.

## Alternatives considered

- Keep reading descriptor `value`: rejected because rc2 can expose the old
  runtime value alongside the new user layer.
- Poll `settings.describe()` after each write: rejected because it adds latency
  and still misses changes from another window or migration path.
- Subscribe to both contexts unconditionally: rejected after runtime tracing
  showed duplicate delivery; the scoped global subscription is sufficient and
  fallback is kept only for unavailable surfaces.
- Listen to global `app-boot/config-reload`: rejected because it would refresh
  every settings consumer for any unrelated profile edit and could tear down
  active LAN connections.
- Add a DSH-version conditional: rejected because the event names and argument
  order are unchanged; the mismatch is effective-layer delivery, not a new API.

## Consequences

Settings consumers now observe user edits without waiting for a process restart,
including nested configuration. The shared module remains the single source for
all package copies. The legacy migration receipt and imported-before-live
protocol are unchanged.

This complements the [legacy settings migration note](2026-09-24-rc7-legacy-settings-section-migration.md).

## Testing

- `shared/test/settings-namespace.mutation.test.ts`: 25 tests passed, covering
  global delivery, base+user nested/array merging, scoped fallback, and the
  existing migration/scope lifecycle cases.
- Real isolated DSH 0.1.7-rc.2 LAN run: saving ports 39181/39182 changed
  `/api/dsh-lan-proxy/health` to `listening: true` and the new ports after
  the normal debounce window.
- The final seven-plugin isolated run is recorded in the delivery report.
