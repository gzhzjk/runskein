# 013 — `TurnResult.quota` is an opaque engine passthrough; an internal wire trace makes it checkable

Date: 2026-08-08 · Status: **accepted** · Trigger:
stabilization requirements AC-5.1 … AC-5.3 ·
Rests on: decision 024 (ST-QUOTA-01, evidence
`docs/conformance/st-quota-01.json`), the four-engine survey that fixed the
shape of this field. Engines put operational
signals on the prompt response's `_meta` and realm dropped them; separately,
several of realm's contracts are claims about the wire that no test could
check except against realm's own bookkeeping.

## Decision

### 1. `TurnResult.quota?: { engineId: string; payload: unknown }`

Additive and optional. Populated from the prompt response's `_meta.quota`,
verbatim, when the engine reported one; **absent** otherwise. Presence of the
key is the whole test — an engine sending `_meta: {}` has reported nothing and
must not acquire the field. A reported nullish value is passed through as
reported, because the engine did report.

`payload` stays `unknown` and is scoped by `engineId`. realm does **not**
back-fill it from `usage_update`, and `Usage` is untouched.

### 2. An internal wire-trace seam

`AcpConnectionOptions.onWireFrame` accepts an observer receiving every JSON-RPC
frame in both directions:

```ts
interface WireFrame {
  direction: 'in' | 'out'; // out = realm → engine
  method?: string; // requests and notifications
  id?: string | number; // requests and responses
  params?: unknown;
  result?: unknown;
  error?: unknown;
}
```

Installed through a per-engine factory (`ProcessManagerOptions.wireObserver`,
`InternalHubOptions.wireObserver`), exported **only** from
`@realm-node/core/internal`, and never on the public surface. Absent means no
tracing and no behaviour change. A throwing observer is logged and ignored.

## Rationale

**Why the passthrough is opaque.** The chapter's original premise — that this
feeds L2 budget gating — did not survive measurement. Only codex reports
anything, and what it labels `quota` is a per-turn token count with no ceiling,
no reset, and no balance; no engine reports the number a budget gate would
throttle on. One reporter out of four cannot justify a cross-engine vocabulary,
and inventing one from a single visibly codex-flavoured shape would be
guessing. What the field honestly buys is that codex's per-model breakdown is
richer than realm's own `Usage`, and that the plumbing is already in place the
day an engine emits a real allowance.

The back-fill prohibition is the sharp edge. `usage_update` data is _available_
and superficially quota-shaped, so filling the field from it is the obvious
convenience — and it would be the worst possible outcome: an unattended host
throttling against a number that is not headroom, believing it is. Absent is
the honest answer, and a host that sees the field missing knows it must not
gate on quota for that engine.

**Why the trace seam.** "Verbatim" and "was re-applied and acknowledged" are
claims about bytes that crossed stdio. Asserting them through the state the
implementation maintains tests the implementation against itself: a passthrough
that quietly reshaped a payload would still equal its own stored copy. The live
harness drives only the public API, so no independent oracle existed at any
tier. The seam supplies one for the hermetic suite and the live harness alike,
which is why it lives in core rather than in test code.

It is deliberately a _seam_, not a feature: the same family as the capability
override and the manager's injectable sleep. It carries no policy, no
buffering, and no filtering — a consumer wanting an event stream should not
find one here.

## Consequences

- `TurnResult.quota` is public and additive; existing readers are unaffected.
  Giving it a type firmer than `unknown` requires a new note and more than one
  reporting engine.
- The trace observes frames **before** routing, so it sees `session/update`
  notifications that the inbound transform consumes and the SDK never sees.
  Without that a trace would be blind to most of a turn.
- `wireObserver` is a factory taking an engine id, never a bare observer,
  because an observer and a factory are both one-argument functions and could
  not be distinguished at runtime.
- The factory runs once per **connection**, not once per engine, so a crash
  restart invokes it again for the same engine id. A factory that allocates a
  fresh collector each call therefore drops the frames of the connection that
  just died — precisely the traffic worth keeping. Harnesses should own the
  collector outside the factory unless per-connection scoping is deliberate.
  This matches the existing `handlers` factory, which is also per connection.
- `WireFrame` reports `error` as well as `result`, which the design chapter's
  sketch (`params|result`) did not list. A refusal is a frame too, and an
  observer blind to error responses would be blind exactly where a failure
  needs explaining.
- Tracing costs one observer call per frame and nothing at all when unset. It
  is not a supported production monitoring hook and may change without a note,
  as `@realm-node/core/internal` states.
- **The survey this rests on is decision 024** (case ST-QUOTA-01, evidence
  `docs/conformance/st-quota-01.json`), which measured all four engines at the
  connection level rather than through the Hub — necessarily, since the public
  surface had no field to show. It found codex the only reporter, with
  `_meta.quota` holding `{ token_count, model_usage[] }`; opencode sending
  `_meta: {}`; kimi and claude-code sending no `_meta` at all. Both codex and
  opencode separately emit `usage_update`, which is exactly the signal this
  note forbids back-filling from. Rerun that case on engine version bumps: if a
  second engine starts reporting, or codex reports headroom rather than
  consumption, the opaque-passthrough decision should be revisited before any
  firmer type ships.
