# 014 — Session lifetime: one reactivation mechanism, two triggers, no new verbs

Date: 2026-08-08 · Status: **accepted** · Trigger:
stabilization requirements AC-2.1 … AC-2.7. A `Session` pinned its
engine reference for its whole life, so an orchestrator holding sessions open
across a 1–24 h task kept every engine resident for the duration, and every
consumer had to hand-write the same crash-recovery loop.

## Decision

### Configuration (additive, v1 behaviour preserved by default)

- `HubOptions.defaults.sessionIdleTimeoutMs?: number` — how long a session may
  sit idle before releasing its engine reference. **Absent disables it**, which
  is exactly today's behaviour.
- `HubOptions.defaults.reactivationAttempts?: number` — positive integer,
  default 3. A non-integer or non-positive value is rejected at Hub
  construction with `ConfigError`, rather than being silently coerced.
- `SessionOpts.sessionIdleTimeoutMs` / `SessionOpts.reactivationAttempts`
  override the corresponding default for one session.

### One mechanism, two triggers

Idle expiry and engine crash both end with the session holding no engine
reference and no routing, and both are revived by the same path on next use
(`prompt()`, `setConfig()`, `fork()`): acquire an engine, walk the existing
tiered resume chain, re-register routing, re-apply config, emit the event.
There is deliberately no second code path for crashes.

### No new public verbs

`close()` plus `hub.session({ resume })` already spell suspend and resume; a
second spelling would add surface without adding capability. Reactivation is
therefore invisible except through one new event:

```ts
s.on('reactivated', ({ tier }: { tier: 'native' | 'load' | 'rebuilt' }) => …);
```

The caller keeps the same `Session` object, realm id, and transcript.

### Mid-turn crash semantics (the decision-001 treatment)

The interrupted `prompt()` **rejects with `EngineCrashError`** and is **never
replayed automatically**. The partial turn's output is already in the
transcript but it has no `stopReason`; re-sending it spends tokens again, and
whether that is worth it depends on budget and idempotence — policy, which
lives above this layer. The rejection is the signal; the next `prompt()` the
host sends is the host's decision.

### Exhaustion error

```ts
EngineOperationError {
  operation: 'session/reactivate',
  cause: { attempts, cap, lastError },
}
```

The cap is counted **within one reactivation episode**. A caller that catches
this and prompts again starts a fresh bounded episode — an explicit choice
rather than a silent retry loop.

### The two budgets stay separate

`restartAttempts` counts _process_ respawns and belongs to `ProcessManager`;
`reactivationAttempts` counts _session_ rebuilds and belongs to the Hub. One
reactivation attempt performs at most one `acquire()`, which may reuse a
healthy process and spawn nothing at all — a reactivation that fails before
acquiring (an unreadable transcript, say) spawns nothing. The two are never
multiplied, and a test asserting spawn counts must assert against
`restartAttempts`.

## Rationale

The alternative — close after every step and resume on the next — was rejected
in the design because it puts the tiered resume chain on every step's critical
path while resume fidelity is only half measured. Idle release gets the same
resource benefit while paying that cost only on a session that has genuinely
gone quiet.

**Serialized transitions.** Idle release, reactivation, `prompt()`, and
`close()` share one per-session transition lock. Without it the natural race —
a prompt arriving while a release is in flight — ends with either two engine
references or none. Enqueueing a prompt marks the queue non-empty
_synchronously_, so a countdown that reaches the lock afterwards sees the
prompt and stands down; a prompt that arrives after the release instead waits
for the lock and reactivates. `close()` sets its flag before awaiting the lock,
so a revival already in flight sees the session closed, gives back the engine
reference immediately, and drops the routing entry it had re-registered rather
than leaving that to the closing step that runs next. That routing cleanup is
not what prevents a leak — `closeLocked()`'s own detach compares against the
current routing key regardless of which path set it, and would remove the same
entry a moment later even if the revival did nothing here. Doing it immediately
only narrows the window, between the revival losing the race and `closeLocked`
running, during which an inbound update for the new engine-side id could still
reach a session that is about to close.

**Config is re-applied by realm, not trusted to the engine.** Whether a resumed
session keeps its model or mode is unproven (the resume-fidelity experiment
found no evidence either way), and a session silently running on a different
model than the host asked for is exactly the kind of quiet wrongness this layer
exists to prevent. Re-application reads §2.8's `desired` — the writes an engine
acknowledged — so it re-asserts only what was actually established. A refusal
during re-application fails that attempt rather than being swallowed: it means
the engine has drifted from what it accepted before.

## Consequences

- **`prompt()` after a crash no longer throws.** It previously rejected with
  `EngineCrashError` and a message pointing at `hub.session({ resume: id })`;
  it now revives the session in place. This is a deliberate behaviour change —
  it is the whole point of AC-2.3 — and the old escape hatch is no longer
  needed. It is also no longer _available_: a crashed session stays registered
  with the hub so it can revive itself, so an external
  `hub.session({ resume: id })` for it is refused as already live, and
  `hub.attach(id)` returns the same object.
- **`status` stays `'failed'` between a crash and the next use.** It describes
  the session accurately right now — it has no engine — rather than passing a
  verdict that it can never run again, and it keeps `hub.sessions({ status:
'failed' })` meaningful. A successful revival records a fresh `idle` meta
  event, so the store shows the recovery too.
- **A suspended session is still the hub's.** It stays in the live registry so
  `attach()` finds it and a concurrent resume of the same id is still refused;
  only the native-id routing entry is dropped, because there is no engine-side
  session left to route to.
- **`cancel()` on a session that is waiting to be revived** rejects that turn
  with `CancelledError` instead of reaching through a released connection. The
  turn never reached the engine, so this matches decision 001's rule that only
  never-ran prompts reject.
- **Recovery re-establishes an engine in exactly one place** (`SessionInternals.reactivate`,
  implemented by `Hub.reactivateSession`). Whether recovery can reuse a live
  process or must force a fresh one is an open measurement; confining it to one
  seam means answering that question later is a local change, not a redesign.
- **`reactivated` fires when the resume chain lands, not when the whole episode
  succeeds.** By then the `rebuilt` tier has already spent tokens, so an attempt
  that afterwards fails on config re-application still reports the rebuild that
  really happened. A host retrying past a failed attempt can therefore see more
  than one event; that is the honest count of rebuilds, not a duplicate.
- After an exhausted episode the session still holds its (dead) engine
  reference until it is closed or successfully revived, so the manager will not
  idle-reap that handle in the meantime. Handing the reference back earlier
  would let the reference count reach zero at exactly the moment the manager is
  deciding whether a crash deserves a restart.
- A reactivation that fails for a permanent reason (an unreadable transcript)
  still consumes the whole attempt budget before reporting. The attempts are
  cheap — they fail before acquiring an engine — and classifying which failures
  are retryable would mean guessing about store and engine errors, which this
  layer avoids elsewhere too.
