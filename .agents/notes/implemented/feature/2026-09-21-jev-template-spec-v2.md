# Agent Note: JEV template library as English asking guides (no frozen exam papers)

Status: implemented

## Problem

`packages/dsh-jev-decide` shipped five frozen presets whose templates embedded fixed exam
questions (e.g. general hardcoded "Which option is better?" with options A/B). Five fixed
questions cannot cover real usage, and they mislead callers into thinking only those exact
questions may be asked. The locked direction is: presets teach HOW to ask (a writing
convention), callers supply WHAT to ask per call via `state.text` + `questions_override`.

## Decision

Preset templates hold **one free-form English `description`** and no questions at all.
`PresetTemplate` is `{ id, label, description, defaultEnabled, automationCap }`;
`TEMPLATE_VERSION` stays 1 and the plugin is unpublished, so there is no deprecation shim,
no VERSION bump and no migration: `PresetTemplate.questions`, the `fromTemplate` fallback,
the `PARTIAL_OVERRIDE` length/id rule and `listPresets.questionCount` are deleted outright.

The six points (goal / dimensions / mutual exclusion / good-vs-bad asking examples /
prohibitions / how-to-call) are a **writing convention**, not a schema. Each frozen
`description` follows it in English prose; `validate.ts` only length-checks the string.
Every call must bring explicit questions: `questions_override` is required for all presets
(1-20 questions), and `appliedSource` is `custom` (built-in `custom` or a self-built id)
or `override` (any other preset).

Self-built presets reuse the same shape and stay decoupled from frozen:

- Storage is a fourth file `custom-presets.json` (`{version: 1, customPresets: [...]}`).
  Absent means empty; there is no seeding step and no VERSION-migration step.
- Writes go through the **incremental** `PUT /config` key `customPresets` (full replace of
  that key only, other keys untouched). Ids must match preset shape, must not collide with
  frozen (`RESERVED_PRESET`), labels/descriptions are length-checked, cap is 0|1|2.
  `createdAt` is preserved by id across rewrites; `updatedAt` is restamped.
- Self-built ids are directly decidable: validation resolves frozen-then-custom
  (`UNKNOWN_PRESET` only when both miss), switches and caps reuse frozen semantics
  (`enabledOf`/`capOfState` consult custom entries), and `listPresets`/`GET /presets`
  merge frozen + customs with a `custom` flag.
- History carries a redacted snapshot of the called questions (`questions`, text/options
  through the same redaction patterns as snippets; per-option probabilities are not
  fabricated because the upstream wire protocol does not return them), and `GET /history`
  enriches `presetTitle` at read time — records still store ids only, and a missing title
  falls back to the short id.

The settings UI is a **React** module registered through the host `settings.section` slot
(`order: 80`, React externals, no global React), replacing the earlier vanilla
`settings.plugin.item` card. Copy-as-custom prefills a real add form (id/label/guide/cap,
drafts start disabled), custom rows carry a two-step delete, and history renders titles plus
read-only question snapshots.

## Alternatives considered

- Six-field schema (goal/dims/mutex/good/bad/bans as separate fields): strongest case is
  structured rendering and per-field validation. Rejected: schema rigidity costs four-place
  edits (contract + PUT validation + UI + tests) per criterion change; prose examples do not
  decompose cleanly; empty-string/format disputes follow. Convention over schema at this stage.
- Empty-but-deprecated shim (keep `questions: []` + `@deprecated`, delete at v2): strongest
  case is shape compatibility for published consumers. Rejected: nothing is published, so the
  shim only prolongs the fork between "template has questions" and "templates hold no papers".
  Delete directly; stale branches fail fast and get fixed.
- Keep example questions as documentation samples: strongest case is onboarding clarity.
  Rejected: examples stored in the frozen record are read as normative papers by callers and
  by future agents. Examples live in this note and in UI copy, not in the template record.
- Reuse `presets.json` for customs instead of a fourth file: strongest case is one less file
  and one less path helper. Rejected: `presets.json` is a switch overlay for frozen ids and
  merging two object shapes into it would couple the frozen switch merge to custom CRUD.
- Defer the storage change to a follow-up PR: strongest case is a smaller red-line surface per
  PR. Rejected by direct user direction ("do not open a new PR, solve P1 here"); the storage
  change is therefore in this PR and still requires maintainer `approved` before merge.

## Consequences

- Cost: in-flight worktrees or branches reading `.questions` break immediately (accepted —
  fail fast, no shim). English-only guidance may confuse Chinese-only operators, mitigated by
  keeping settings chrome/buttons/empty-states in Chinese while guidance prose stays English.
- Cost: self-built presets are recoverable-but-plaintext config on disk (0600 inside the
  0700 namespace dir), like every other plugin config file; they hold no secrets and no
  questions, so the blast radius of a leak is naming/guidance text only.
- Benefit: callers can ask anything the model can judge, in any language for `state.text`
  (only ids are ASCII-restricted), while templates stay a small, stable, English guidance
  layer that never needs a release to cover a new question shape.
- Verification: package suite 226/226 with real assertions (reserved-id rejection, disk
  round-trip with `createdAt` preservation, custom-id decide incl. switch-off and cap
  clamping, question-snapshot redaction, `presetTitle` enrich, add-form and two-step delete),
  `typecheck`/`build` clean, `pnpm gate:pr` PASS, and isolated-browser verification of the
  React tab (mount, three tabs, keycard mutual exclusion, single-open detail, create then
  two-step delete with `custom-presets.json` on disk, zero console errors).

## Deferred

- Host locale-service subscription (notifier-style `locale.subscribe` rebind): DONE in PR #963
  (`bindTranslate`/`unbindTranslate` in `src/client/locale.ts`, `jev-decide` dict register +
  subscribe rebind in `src/client/index.tsx`, 12 wired tests). Local-dict fallback kept
  (unlike notifier's key fallback) so legacy runtimes still render Chinese copy.
- Per-option probabilities in history: the official SystemOne response carries a single
  `choice`/`score` + `confidence`, so the UI renders one bar per decision instead of one bar
  per candidate until the upstream wire protocol returns per-option values.
- Storage/interface change (new file + `customPresets` PUT key + history fields) needs
  maintainer `approved` on the PR; it is not self-stamped.
