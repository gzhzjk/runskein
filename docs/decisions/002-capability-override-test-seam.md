# 002 — `capabilityOverride`: a test-only seam to force resume tiers 2–3

Date: 2026-08-05 · Status: accepted · Trigger: test-plan review — RS-02/03
("force tier by masking resume capability") referenced a mechanism that did
not exist anywhere in the spec or design.

## Problem

The measured matrix shows all four v1 engines advertise native
`session/resume` and `loadSession`. The resume chain's tier 2 (`load`) and
tier 3 (digest rebuild) — the Emulated capability the library most depends on
for future engines — can therefore never execute against real engines. Code
that can't run is code that rots.

## Decision

Core accepts a hidden hub option:

```ts
capabilityOverride?: { [engineId: string]: Partial<CapabilityMatrix> }
```

- Applied after `initialize`, before any capability-dependent branch.
- **Mask-only**: it may force a capability bit off, never on. A widening
  entry is a `ConfigError`.
- Not part of the public API surface (api.md unchanged); the type and the
  option are re-exported **only** by `@realm-node/conformance`. Consumers
  reaching for it are off the supported path by construction.

## Consequences

- Test plan RS-02/03/04 use the seam against real engines (real transcripts,
  real digest injection — only the capability bits are faked).
- The seam is documented next to the conformance gates.
- CI mock-agent fixtures may also simply not advertise the capability —
  the seam is for live-engine runs where we don't control the agent.
