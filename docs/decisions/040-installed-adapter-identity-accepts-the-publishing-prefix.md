# 040 - installed adapter identity accepts the publishing prefix

Date: 2026-08-27 · Status: **accepted** · Cases: prefix-aware identity,
installed-package registration, mismatch rejection, and same-layer collision
in `packages/core/test/registry.test.ts` · Informs: api §9

## Context

Dynamic discovery reaches installed third-party adapters by the package-name
prefix `runskein-adapter-`, including the same basename under any npm scope.
The adapter guide gives `runskein-adapter-iota` the id `iota`. The loader,
however, required the id to equal the candidate directory's full basename, so
the scan found that package and then rejected it. Layer 3 had no package name
that could satisfy both rules.

The identity check is narrower than the loading pipeline around it. It runs
after dynamic import and schema validation, does not confine a shim to its
directory, and does not detect id collisions. Its useful property is that a
candidate's directory still tells a reader which adapter it claims to be.

## Decision

- **Every directory-backed discovery layer uses one identity predicate.** A
  candidate id must equal its directory basename, or equal the basename after
  the exact `runskein-adapter-` prefix is stripped. Thus `iota/` with id
  `iota`, `runskein-adapter-iota/` with id `iota`, and
  `@scope/runskein-adapter-iota/` with id `iota` are valid. A directory whose
  basename is neither the id nor `runskein-adapter-<id>` remains invalid.

- **Reach and identity share one prefix constant.** The node_modules scan and
  the identity predicate consume the same module-level value so a future
  publishing-prefix change cannot make the scanner and loader disagree again.

- **Installed discovery still requires both the prefix and the marker.** The
  `runskein.adapter` marker alone does not make an arbitrary dependency a
  layer-3 candidate, and dynamic discovery remains opt-in. This decision
  changes identity validation only after a candidate has been reached and
  imported.

- **Bundled package names remain asymmetric.** RunSkein's bundled adapters use
  `@runskein/adapter-*`, but the meta-package statically imports them through
  layer 1. Layer 3 scans third-party packages named
  `runskein-adapter-<id>` or `@scope/runskein-adapter-<id>`; it does not scan
  the bundled coordinate and no package is renamed here.

## Consequences

- Conforming scoped and unscoped installed packages can register through
  layer 3 for the first time.

- Workspace and explicit-path directories named `runskein-adapter-<id>` gain
  the same valid identity shape. There is no layer-specific identity branch to
  drift from the scanner.

- The check remains failure-isolated after import and validation. A mismatched
  directory still produces an invalid candidate; shim containment and
  same-layer id collision checks remain independent and unchanged.
