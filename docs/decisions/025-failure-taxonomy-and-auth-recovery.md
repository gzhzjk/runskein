# 025 - Failure taxonomy and conservative auth recovery

Date: 2026-08-14 · Status: **accepted** · Cases: ST-ERR-01, ST-ERR-02,
ST-ERR-03, ST-AUTH-03

## Decision

1. Adapter packages may declare `errorPatterns` entries with `{ cause, match,
flags? }`. `cause` is exactly one of `auth`, `rate-limit`, `context`, or
   `internal`; `match` is non-empty regular-expression source; omitted flags
   mean case-insensitive matching. Registry validation compiles every entry at
   load time. A malformed pattern invalidates that adapter rather than being
   skipped.
2. Patterns are evaluated in adapter order against the engine error message
   and its `cause` chain. An absent match is the required plain
   `EngineOperationError` fallback. `auth` maps to the existing
   `UnauthenticatedError`; the other three map to `EngineOperationError.kind`
   as `rate-limit`, `context-exceeded`, and `internal`. `timeout` remains a
   realm-owned kind and is never inferred from adapter text.
3. A recognised mid-run auth failure emits `engine:unauthenticated` once per
   cached-auth episode, marks the registry result unauthenticated immediately,
   and retires the engine process. All live sessions on that engine enter the
   existing recovery path, so a future request cannot reuse a process that may
   have cached the rejected credential.
4. `hub.rescan()` is the explicit recovery boundary. It clears the forced auth
   state and reruns `detect()`; it does not assert that login succeeded. Until
   an adapter reports authentication again, new sessions and reactivations
   remain blocked with `UnauthenticatedError`.
5. `UnauthenticatedError.cause` preserves the matched raw engine failure. If
   transcript persistence or cleanup also fails in the same public operation,
   core keeps `UnauthenticatedError` as the public type and exposes an
   `AggregateError` cause rather than relabelling the auth failure as a store
   or generic operation error.

## Evidence and limitation

The hermetic fixture covers all four causes, unrecognised fallback, malformed
patterns, cause-chain matching, cached auth invalidation, and a fresh process
after rescan. Codex additionally runs `codex login status` during `detect()`.
The exact runtime auth wording for the other bundled engines remains subject to
the deferred scratch-home measurement in ST-AUTH-01; their current tables use
the ACP wrapper's `Authentication required` wording and must be revised only
with recorded live evidence.

The decision intentionally chooses respawn over an in-process retry. Whether
each engine observes a repaired credential in an already-running process is
unmeasured; paying one extra process start is safer than preserving a process
that can retry a dead token indefinitely.
