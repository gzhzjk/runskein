# 001 — Cancel semantics: active turn resolves, queued prompts reject

Date: 2026-08-05 · Status: accepted · Trigger: test-plan review found
SL-05/06 asserting `prompt()` _rejects_ on cancel while the plan's own log
example asserted `stopReason:'cancelled'` on _resolve_.

## Decision

- `s.cancel()` → the **active** turn's `prompt()` promise **resolves** with
  `TurnResult{ stopReason: 'cancelled' }`.
- Prompts that never started — queued behind the active turn, or all pending
  when `close()` is called mid-turn — **reject** with `CancelledError`.

## Rationale

1. ACP's own shape: `session/cancel` is a notification; the outstanding
   `session/prompt` request then completes **normally** with stop reason
   `cancelled`. Resolving mirrors the wire truth; rejecting would fabricate
   an error where the protocol reports an orderly stop.
2. A cancelled turn still produced transcript events and possibly usage —
   a `TurnResult` is the natural carrier; an exception discards it.
3. Rule of thumb: **resolve if the turn ran at all, reject only if it never
   ran.** One rule, no per-engine ambiguity.

## Consequences

- api.md §3.2 clarified (no signature change — `stopReason` already included
  `'cancelled'`; the frozen surface is unchanged).
- Test plan SL-05/SL-06/ER-05 assert the split accordingly.
