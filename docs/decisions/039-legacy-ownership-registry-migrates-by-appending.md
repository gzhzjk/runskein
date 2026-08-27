# 039 - the pre-rename ownership registry is carried over by appending

Date: 2026-08-26 · Status: **accepted** · Cases: the three migration cases in
`packages/core/test/orphanSweep.test.ts` · Rests on: decision 015 (the
ownership registry)

> Written after decision 038, which decided the rename in full. This record
> covers one of its consequences — the state file that had to move — because
> that is the part the shipped code cites, and a citation has to lead somewhere
> the reader can go. Nothing here revises 038.

## Context

Decision 015 put the ownership registry outside any working tree —
`<state>/<product>/engines.jsonl` — so that a repository checkout never carries
another machine's pids. The orphan sweep reads it to know which engine
processes a previous host left behind.

The product was renamed from realm-node to RunSkein. The registry's parent
directory names the product, so the path moved with it: entries written before
the upgrade sit in `<state>/realm-node/`, where the sweep no longer looks.

That is a leak, not a hypothetical one. An engine process that survived a host
before the upgrade is recorded only in the old file, so after the upgrade
nothing will ever reap it — the sweep is not blind to it, it does not know it
exists. On the machine the rename landed on, the legacy file held 1304 bytes of
live state on the day the work started.

## Decision

- **The migration appends; it does not move.** "Move only if the target is
  absent" was the first design and it is wrong: by the time a host upgrades,
  both files can already exist — the new one written by a run of the new
  version, the old one left by a run of the previous — and a
  move-if-absent guard then does nothing in exactly the case the migration
  exists for. On the machine this landed on, both did exist. So the migration
  reads the legacy file, appends its entries to the current one, and unlinks
  the legacy file. The unlink is what makes a second call a no-op; without it
  every start would re-append the same entries.

- **Failure is silent, and that is not the usual rule.** RunSkein surfaces
  failures as typed errors rather than swallowing them. Here the alternative is
  worse: a registry that could not be migrated leaves the sweep exactly as blind
  as it was before this function existed, while throwing would take down every
  hub on the machine over a stale file it does not need. The cost is bounded and
  the failure is the status quo ante.

- **It has an expiry and a mechanism, not a promise.** The migration is deleted
  before 1.0. What makes that credible is that it is written to be deletable —
  one call site, no other reader of the legacy path — and that a `TODO` naming
  this record sits on the function, with three cases that go red if the
  behaviour changes. Prose alone would not survive the year.

- **`.realm/adapters/` gets no migration, and the difference is stated rather
  than assumed.** A developer's adapter directory is re-created by re-running
  the tool that wrote it. A lost pid registry is not re-creatable: the processes
  it names are already running and nothing else records them.

## Consequences

- A host upgrading across the rename keeps its sweep coverage. A host that never
  ran a pre-rename version pays one `existsSync` on a path that is not there.

- The deletion before 1.0 is a real piece of work with a known shape: remove
  `migrateLegacyRegistry`, its single call site, its three cases, and the `TODO`
  that names this record. Anything that adds a second reader of the legacy path
  makes that deletion harder and should be refused on those grounds.

- Entries carried over keep their original contents, including pids recorded
  under the old product name. Nothing in an entry names the product — the sweep
  works from pid liveness, the owning host's pid, and the `argv0` recorded at
  spawn, which guards against pid reuse — so a carried entry is reaped by
  exactly the same rules as one this version wrote.
