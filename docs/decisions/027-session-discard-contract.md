# 027 - `close({ discard })` deletes engine state without deleting transcripts

Date: 2026-08-14 · Status: **accepted** · Cases: ST-DISC-01, ST-DISC-02,
ST-DISC-03, ST-DISC-04

## Decision

`Session.close` accepts `CloseOptions`:

```ts
interface CloseOptions {
  discard?: boolean;
}
```

- `close()` keeps its existing Core local-close behaviour. It may send the
  negotiated `session/close` request when advertised, but missing wire close
  still releases local ownership.
- `close({ discard: true })` is a separate Negotiated request for
  `session/delete`. A missing capability rejects with
  `NotSupportedError { capability: 'session.delete' }` only after the session
  is locally closed. Realm attempts wire close first where advertised and then
  delete even if close failed. A delete failure is
  `EngineOperationError { operation: 'session/delete' }`; when close and
  delete both fail, its cause is an `AggregateError` retaining both failures.
- Discard never deletes the local transcript. Retention remains the host's
  explicit store policy through `TranscriptStore.delete(sessionId)`; there is
  no Hub transcript-delete operation.
- The first close call owns cleanup. Compatible concurrent/repeated calls
  receive that same promise and do not repeat wire work. A later discard after
  a plain close rejects with `EngineOperationError { operation:
'session/delete' }` because reporting the earlier success would falsely
  imply engine-side deletion. A plain call after a discarding close shares the
  discarding result.

## Rationale

Engine history is valuable for normal resume but harmful for short-lived
probes and rejected drafts. Coupling its deletion to local transcripts would
turn an engine-hygiene request into accidental data loss, while accepting a
discard upgrade after a plain close would hide the engine-side residue that the
caller specifically asked to remove. The contract therefore makes both
boundaries explicit and preserves every cleanup failure after local resources
are safely released.

## Consequences

- `CloseOptions` is public from `@realm-node/core` and `realm-node`; changing
  its meaning requires a further API decision.
- Engines without `session/delete` remain usable for ordinary close but cannot
  silently claim discard success.
- Live conformance owns the engine-specific `session/list` proof; hermetic
  tests own ordering, failure, and concurrency semantics.
