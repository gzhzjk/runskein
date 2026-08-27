# 003 — Async engine inventory and explicit non-running health

Date: 2026-08-05 · Status: accepted · Trigger: second API/design review found
that synchronous inventory could not await adapter detection and that process
absence had no valid health state.

## Decision

- `hub.engines()` returns `Promise<EngineInfo[]>` and `hub.health()` returns
  `Promise<Record<string, Health>>`; both lazily await adapter `detect()` hooks
  without spawning an engine process.
- `Health` includes `stopped`, meaning a registered, usable adapter currently
  has no child process. It is the initial state and the state after idle reap.
- `EngineInfo` is a discriminated union. Registered engines require `id` and
  `installed`; malformed discovery candidates use `InvalidEngineInfo`, where
  `health` is `invalid`, `error` is required, and `id` may be unavailable.
- Discovery and detection results remain cached until `hub.rescan()`.

## Rationale

1. `EngineAdapter.detect()` is asynchronous and intentionally lazy, so a
   synchronous inventory either lies about detection data or blocks through
   an unsupported mechanism.
2. A process that has not started, or was reaped normally, is neither ready
   nor dead. `stopped` preserves that distinction and prevents normal idle
   reaping from looking like a failure.
3. A candidate that fails import or schema validation cannot satisfy the
   fields guaranteed for a registered engine. The union makes that state
   explicit without weakening the normal variant.

## Consequences

- Consumers must `await hub.engines()` and `await hub.health()`.
- Initial and post-idle health assertions expect `stopped`.
- `health: 'invalid'` narrows inventory entries to a required diagnostic
  `error`; consumers must not pass an optional `id` to session APIs.
