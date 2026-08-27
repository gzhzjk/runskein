# 016 — Two timeout knobs; a turn ceiling that defaults to nothing

Date: 2026-08-13 · Status: **accepted** · Trigger:
stabilization requirements AC-3.2 and AC-3.5. Measured while running
the concurrency survey (note 022): **`session/prompt` has no timeout at all.**
`AcpConnection` applies its 30 s default to every request method except
`prompt` and `closeSession`, and the Hub passed none — so a turn was unbounded.
On claude-code, which serializes, a turn queued behind a slow one waits forever
with no typed error. The measurement harness had to impose its own ceiling to
stay bounded, which is the tell.

## Decision

### Two knobs, not one

- `HubOptions.defaults.requestTimeoutMs` — setup-class requests (creation,
  resume, fork, config writes, close). **Default 30 000 ms**, which is what the
  connection layer always applied; nothing changes for existing callers.
- `HubOptions.defaults.turnTimeoutMs` — one turn. **No default. Prompts stay
  unbounded unless a host sets it.**
- `SessionOpts.requestTimeoutMs` / `SessionOpts.turnTimeoutMs` override per
  session.

A timeout rejects as `EngineOperationError` with `operation` set to the wire
method and the new `kind: 'timeout'` discriminant.

### Late settlement

A timed-out prompt sends `session/cancel`, and its **FIFO slot stays occupied
until the original request settles**. A later `prompt()` queues behind it rather
than rejecting. Timed-out creation is **never retried automatically**; if the
original lands anyway it is closed and deleted where the engine advertises it.
Whatever could not be completed is reported through `engine:cleanup-failed`
carrying `{ engineId, sessionId?, operation, nativeId?, error }`.

## Rationale

**Why no default on prompts.** A ceiling is only honest if something measured
supports it. A legitimate turn runs for minutes — a coding agent editing a file
tree does not answer in thirty seconds — so any number invented here would turn
a hang into a _new_ failure: turns killed mid-work, on a schedule nobody chose,
with the damage worst exactly where the tool is most useful. Unbounded is the
status quo and is at least predictable; a host that needs boundedness knows its
own workload and can say so. The bug was never "no ceiling", it was "no way to
have one".

**Why the slot stays occupied.** The caller has been rejected, but the engine is
still working on the request. Releasing the slot then would let the next prompt
reach an engine already mid-turn — which is precisely the overlap the FIFO queue
exists to prevent, reintroduced by the mechanism meant to protect against
hangs. So the caller's promise and the slot's lifetime are decoupled: the
rejection is immediate, the slot frees only on settlement.

**Decision 001 is not contradicted.** 001 governs a turn the _caller_
cancelled, which still resolves with `stopReason: 'cancelled'`. Here the caller
already received a rejection, so there is no turn left to resolve to anything;
the late settlement only frees the slot. An explicit `session.cancel()` arriving
while the slot drains is a no-op on that slot — cancellation was already sent —
and still rejects anything queued behind it, exactly as 001 specifies.

**Why the Hub owns the creation race.** `withTimeout` rejects with a fresh error
and drops the underlying request, so a session arriving after its timeout became
**unobservable** — and an engine-side session nobody can see is one nobody can
clean up. This was found by a test asserting the compensation ran, which failed
because the compensation could never see anything to compensate for. The Hub
therefore issues creation through `rawRequest` and races it itself, keeping a
handle on the original.

**Why `session/new` is never retried.** It is not idempotent. A retry after a
timeout is how one caller ends up owning two engine sessions, one of which it
does not know about — the leak this effort keeps finding in other forms.

**Why cleanup reporting reuses `ProcessManager.emit`.** The manager already owns
the listener registry `hub.on()` delegates to. Adding a second mechanism for one
capability's diagnostics would leave the codebase with two dispatch paths
differing only by which events happen to originate where — a permanent seam
bought for local convenience. `engine:cleanup-failed` is raised by the Hub and
routed through the same registry.

## Consequences

- `EngineOperationError` gains an optional `kind`. Additive: existing `catch`
  sites are unaffected, and absent still means unclassified. §2.4 extends the
  same discriminant to other causes.
- A host that sets `turnTimeoutMs` accepts that a slow-but-working turn can be
  abandoned. The engine may keep running it; realm reports the ambiguity rather
  than pretending the work stopped.
- `hub.quit()` waits for outstanding compensations, bounded by the lesser of a
  30 s internal window and the caller's own quit budget. Anything unsettled at
  the deadline is reported through `engine:cleanup-failed` — **never recorded as
  success**, because the engine may still be working on a request nobody is
  waiting for.
- A timed-out turn leaves the session usable: the next prompt queues normally
  once the slot frees.
