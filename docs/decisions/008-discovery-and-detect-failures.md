# 008 — Executable discovery and detect failures

Date: 2026-08-06 · Status: accepted · Trigger: the M1–M5 quality review found
that dynamic adapter imports were enabled by default and that `detect()` errors
were misreported as a definitive `installed: false` result.

## Decision

- Workspace and installed-package discovery is disabled by default. Hosts opt
  in with `discovery: true`, acknowledging that adapter imports execute trusted
  code with the host process's privileges.
- Statically imported built-ins and explicit adapter registrations remain
  available when discovery is disabled. `adapterPaths` are also explicit trust.
- A rejected `detect()` surfaces as `EngineOperationError` with operation
  `adapter/detect`. `hub.engines()` preserves inventory failure isolation by
  representing that adapter as `InvalidEngineInfo`; APIs targeting that engine
  reject with the typed error rather than claiming the binary is absent.

## Rationale

Schema validation occurs after JavaScript module evaluation and cannot sandbox
top-level code. Opt-in is the only honest default trust boundary. A failed
probe is likewise an unknown state, not evidence that an engine is absent;
preserving the cause prevents automation from silently skipping usable engines.

## Consequences

- api.md §§2 and 9 change as described above; this note authorizes the frozen
  default and inventory-semantics corrections.
- Hosts that relied on implicit workspace discovery must pass
  `discovery: true` or an explicit trusted path.
- Discovery and detect contract tests cover both the safe default and typed
  failure behavior.
