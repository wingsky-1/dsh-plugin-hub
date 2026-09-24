# Agent Note: RC7 legacy settings section migration

Status: implemented

## Problem

DSH 0.1.7-rc.1 renames the old host settings document to
`settings.yaml.imported`, but its importer does not map plugin aliases
`dsh-lan-proxy` and `dsh-mcp-manager` to the canonical
`ui-dsh-lan-proxy` and `ui-dsh-mcp-manager` entries. Without a narrow
migration, editable plugin fields can disappear from the active profile after
the host upgrade, while copying the whole imported document would incorrectly
reintroduce unrelated host state.

## Decision

The shared `legacy-settings-migration.js` module owns the format-independent
protocol: it reads `settings.yaml.imported` and `settings.yaml`, merges them
in imported-before-live order, rejects non-JSON/cyclic values, and overlays only
paths missing from the raw canonical user layer. Before the first canonical
write it creates a versioned pending receipt; after `scope.update` succeeds it
promotes the receipt to the completion marker. A pending receipt is finalized
without replay on the next start for unknown write/marker failures, because an
unset field is indistinguishable from a never-written field. Only an explicit
DSH `SETTINGS_CONFLICT` (known to be rejected before commit) clears the receipt
for a later retry. Consumers provide the legacy namespace, sanitizer,
paths, scope, expected revision, logger, and label.

LAN keeps its public migration facade and its Config-specific sanitizer,
including the existing `wsDeflatePolicy` plain-record check. MCP uses the same protocol from the config domain and runs it from the
canonical settings `onScope` callback, after the owning fiber is ACTIVE. Its sanitizer projects only the supported `ui`
fields; retired `middleware`/`middlewarePolicy`, unknown keys, and other
non-volatile top-level fields never enter the canonical patch. The MCP marker
is the version-1 `settings.migrated` file in the DSH_HOME-aware private
plugin directory; the receipt is created before the canonical write and
retained until completion.

## Alternatives considered

- Copy `settings.yaml.imported` into the active profile: rejected because it
  would copy unrelated host state and bypass canonical entry filtering.
- Keep separate LAN/MCP migration loops: rejected because it duplicates the
  merge, clone, failure, and marker protocol and allows the priority rules to
  drift.
- Normalize every old UI document with the full Config schema before merging:
  rejected because defaults would erase the distinction between an absent
  field and an explicitly stored value, weakening imported-before-live
  field-level precedence.
- Run MCP migration before the canonical namespace is served: rejected
  because the raw user layer is unavailable and the migration could overwrite
  a value the user has already set. The shared seam waits for the owning fiber
  and rechecks the descriptor instead of using a sleep or root-loader barrier.
- Retry a pending receipt whenever the old key is missing: rejected because
  DSH `unset` also removes the user key, so this would resurrect a value the
  user deliberately cleared. This implementation chooses at-most-once
  migration after the receipt is created; a crash may require manual re-entry
  of a cosmetic preference, but it cannot silently undo a later clear.

## Consequences

The migration is bounded to editable plugin settings and leaves the imported
file as an audit copy. Read, sanitization, and receipt-directory failures happen
before the receipt and remain retryable. Once the pending receipt exists, any
an unknown canonical-update or completion-marker failure is fail-closed: the
next start promotes the receipt to complete without replaying the old section.
An explicit `SETTINGS_CONFLICT` is the only retryable post-receipt failure. This
is an explicit at-most-once tradeoff for unknown outcomes and prevents a later
DSH `unset` from being mistaken for a missing migration. A complete marker is an explicit no-op, and
pending receipts are retained for audit/recovery. The shared module has a
small protocol surface and an independent test; package facades retain their
existing exports and runtime boundaries.
