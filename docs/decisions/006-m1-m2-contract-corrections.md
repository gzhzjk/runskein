# 006 — M1/M2 error and usage contract corrections

Date: 2026-08-05 · Status: accepted · Trigger: post-M2 review found that the
frozen v1 surface could not represent post-start engine-operation failures and
that `Usage` required token fields while simultaneously requiring unreported
fields to remain absent.

## Decision

- `EngineOperationError` represents an ACP operation that fails after an
  engine has initialized. It carries `{ engineId, sessionId?, operation,
cause? }`. Startup failures remain `EngineStartError`; negotiated capability
  absence remains `NotSupportedError`; invalid configuration remains
  `ConfigError`.
- `Usage.input`, `Usage.output`, and `Usage.total` are optional. An engine that
  reports no token breakdown produces an empty token summary (possibly with
  reported cost), never fabricated zeroes.
- `systemInstructions` is transported in
  `session/new._meta["realm.dev/systemInstructions"]`. It is not rewritten as
  user content because that changes role and transcript semantics.

## Rationale

1. Returning raw SDK/JSON-RPC errors violates api.md §10, while mapping a
   post-ready request failure to a startup, configuration, or capability error
   would be misleading.
2. Zero tokens means a measured zero; it cannot also mean "the engine did not
   report this field". Optional fields make D7 implementable.
3. ACP v1 has no first-class system-instruction field. Its `_meta` extension
   point preserves role identity and gives adapters/engines an explicit hook
   without corrupting the user transcript.

## Consequences

- api.md §4.1 and §10 change as described above; this note authorizes those
  frozen-surface corrections.
- All public ACP calls wrap unknown post-ready failures in
  `EngineOperationError`; cleanup still runs before the error is returned.
- SL-12 asserts the exact instruction value in the raw `session/new` request.
