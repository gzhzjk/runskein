# 004 — Typed errors for local state and engine startup

Date: 2026-08-05 · Status: accepted · Trigger: test-plan review found that
unknown resume ids, transcript backend failures, reads after deletion, and
engine start timeouts had no representable error in the frozen v1 contract.

## Decision

- `NotFoundError` represents a requested local session or transcript that does
  not exist. It carries `{ resource: 'session' | 'transcript', resourceId }`
  plus `engineId` / `sessionId` only where those values are known. Store-only
  lookups are not required to invent engine provenance.
- `EngineStartError` represents failure before an engine reaches `ready`. It
  carries `{ stage: 'spawn' | 'initialize' | 'timeout' }` and preserves the
  original failure as `cause` where one exists.
- `StoreError` represents a transcript backend failure other than absence. It
  carries `{ operation: 'append' | 'read' | 'sessions' | 'digest' | 'delete'
| 'export' }` and preserves the backend failure as `cause`.
- An unknown engine id remains `NotInstalledError`; it is not local session or
  transcript state.

## Rationale

1. Mapping a missing transcript to `ConfigError` or `NotInstalledError` would
   be misleading, while returning a generic `Error` would violate the v1 rule
   that failures surface through documented typed errors.
2. `EngineCrashError` describes a process that died after starting, including
   mid-turn state such as `lastSeq`. Reusing it for a process that never became
   ready would make recovery and diagnostics ambiguous.
3. These errors close existing failure-path holes; they do not change any
   capability tier or success-path behavior.

## Consequences

- api.md §10 adds `NotFoundError`, `EngineStartError`, and `StoreError` to the
  frozen v1 error surface.
- Resume, transcript export/read, and adapter start-timeout tests assert the
  concrete new types rather than an unspecified "typed error".
- Implementations must preserve original startup/store causes and may not
  silently fall through after the digest rebuild tier fails.
