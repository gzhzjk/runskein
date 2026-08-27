# 005 — Session lifecycle metadata rides the transcript

Date: 2026-08-05 · Status: accepted · Trigger: M2 implementation — the frozen
`TranscriptStore` interface (api.md §6) must answer `sessions()` returning
`SessionMeta{cwd, status, createdAt, updatedAt}`, but its only write path is
`append(TranscriptEvent)`, and no ACP update carries realm's cwd/status.

## Decision

- Core appends realm-authored envelopes whose `update` is ACP's own
  `session_info_update` variant (a legal `SessionUpdate`; all fields
  optional) carrying the metadata under `_meta["realm.dev/sessionMeta"]`:
  `{ cwd?, status?, nativeSessionId?, resumeTier? }`. `_meta` is ACP's
  official extension point — no second event vocabulary is invented (D1/D2
  hold).
- Persisted lifecycle points: creation (`{cwd, status:'idle',
nativeSessionId}`), terminal close (`{status:'closed'}`), terminal failure
  (`{status:'failed'}`), and — amended for M3 — resume (`{cwd,
status:'idle', nativeSessionId, resumeTier}`). `nativeSessionId` is what
  lets resume tiers 1–2 address the engine-side session; `resumeTier` makes
  restorations auditable and is load-bearing for accounting: a `rebuilt`
  event marks an engine-counter reset, segmenting the stored usage_update
  stream so recovered totals ADD across lives instead of the last life
  clobbering the earlier ones. Costs add only within one currency; decision
  007 defines cross-currency behavior. Transient
  idle/running/awaiting-input flips stay in-memory (`s.status`,
  `s.on('status')`) and are overlaid by
  `hub.sessions()` for live sessions.
- Every store — built-in or custom — derives `SessionMeta` by folding its
  event stream (`createdAt` = first event ts, `updatedAt` = last event ts,
  cwd/status from the latest realm meta entry). Core exports the folding
  helper; the store suite (M5) asserts the behavior.

## Rationale

1. The alternative — widening `TranscriptStore` with a meta-write method —
   changes the frozen §6 interface and burdens every custom store.
2. A sidecar file owned by core breaks P7 ("local transcript store is
   authoritative"): `sessions()` would answer from data the store never saw.
3. Status transitions on the transcript are auditable history, which is the
   transcript's job; per-turn flips would be noise, so they are excluded.

## Consequences

- Transcript consumers see `session_info_update` envelopes realm authored
  (seq 1 is always the creation event). Exporters may filter them.
- `hub.sessions()` = store fold + live-status overlay; stored statuses are
  only ever `idle` (created), `closed`, or `failed`.
- Custom stores need no code to support `sessions()` beyond folding, and
  `readSessionMeta`/`foldSessionMeta` are exported for exactly that.
