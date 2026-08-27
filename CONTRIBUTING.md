# Contributing

Thanks for looking. This document is the contract for changes to RunSkein —
what the gates check, which parts of the surface are frozen, and what a change
has to carry with it.

## Getting set up

Node 22 or newer (the transcript store uses `node:sqlite`) and pnpm 9.15.9.
The workspace is ESM only.

```bash
pnpm install --frozen-lockfile
```

## The gates

Run all five before opening a pull request. The CI here runs four of them —
everything but `pnpm conformance`, whose cases reach it through `pnpm test` —
plus `trunk check` and a coverage report.

**This CI is feedback, not the release gate.** RunSkein is developed in a
private repository and exported here; the gate that decides a release runs
there, over the same code plus live-engine checks that need real engines and
authentication. Where the two disagree, that one is right. A green run here is
not a promise that a change will land, and a red one on something you did not
touch is worth reporting rather than working around.

```bash
pnpm quality      # import boundaries, licence files, translations, generated tables
pnpm typecheck    # tsc --noEmit across every package
pnpm test         # vitest, plus the CLI's own end-to-end suite
pnpm build        # required — see below
pnpm conformance  # the adapter registration gate, against a hermetic mock agent
```

**`pnpm build` is not optional, and not only for its output.** `tsc --noEmit`
never exercises declaration emit, and the build is also what copies
path-loaded assets into `dist` and then checks the built code can still find
them. A watchdog once went missing from a published package precisely because
nothing checked.

If you touched an adapter, also run the gate against the real engine. That
needs the engine installed and logged in:

```bash
pnpm conformance opencode
cd packages/conformance && pnpm probe opencode   # refresh measured capabilities
```

The probe writes `docs/conformance/matrix.json`, which holds the provider
configuration of the machine that ran it, and per-engine `*.raw.json` dumps full
of that machine's temporary paths. The stability runs (`st:conc`, `st:cwd`,
`st:quota`, …) write `docs/conformance/st-*.json` the same way. Commit
`adapters/<id>/conformance.json` and leave all of those out of the pull request
— they describe your machine, not the engine.

Found a security problem? Do not open an issue — see
[SECURITY.md](SECURITY.md).

The fastest way to see real behaviour without writing a program is the CLI —
see [`docs/cli.md`](docs/cli.md):

```bash
pnpm --filter @runskein/cli dev engines
pnpm --filter @runskein/cli dev chat opencode --cwd .
```

## What is frozen, and what that means for you

[`docs/engine-adapter-api.md`](docs/engine-adapter-api.md) is the **frozen v1
surface**. Changing it is allowed; changing it silently is not. A surface
change needs a numbered record in [`docs/decisions/`](docs/decisions/) — next
number, same shape as the ones already there — landing in the same change as
the code. The records are append-only: correct one by writing the next, never
by editing history.

Three rules follow from that and are worth stating on their own:

- **A capability's tier is not code's to change.** Core, Negotiated and
  Emulated are promises, and moving something between them changes what every
  consumer can rely on. If measured behaviour shifted, re-run the probe and say
  what it measured, in the same change. Refreshing
  [`docs/conformance/matrix.public.json`](docs/conformance/matrix.public.json)
  and the generated
  [`docs/capability-matrix.md`](docs/capability-matrix.md) is the maintainers'
  step, not yours: the projection is made from a probe of all five engines, and
  one made from a single engine would drop the other four.
- **ACP does not leak.** Core never imports from `adapters/*`, and nothing a
  consumer can reach imports `@agentclientprotocol/sdk` — only core's `acp/`
  module and shim entry points may. The public types are RunSkein's own
  structural mirrors. `pnpm quality` enforces this, and
  [decision 028](docs/decisions/028-non-acp-engines-via-shim.md) explains why.
- **No failure resolves silently.** Every error path surfaces as one of the
  typed errors in api §10. An empty `catch` fails the quality gate.

## Documentation is part of the change

Treat [`README.md`](README.md) and
[`docs/engine-support.md`](docs/engine-support.md) as consumer contracts. When
a change affects observable API behaviour, typed errors, installation, bundled
engines, detection or authentication results, capability tiers, or negotiated
capability support, update the consumer documentation in the same commit.

Keep the static tables and the runtime guidance distinct. A measured table
records what one engine version advertised on one probe run; consumers use
`hub.engines()` and `hub.describe()` for what their own machine has. Neither
should be written as if it were the other.

**Published documents are bilingual.**
[`docs/published-documents.json`](docs/published-documents.json) lists them,
and each English source has a Chinese `*.zh-CN.md` peer whose frontmatter
records the source's hash. When the English changes, translate it and then
refresh the hash — never the hash alone. Both sides land in the same commit;
`pnpm quality` fails a commit that moves only one, by design.

If you would rather not write the Chinese side, say so in the pull request and
open it against the English document anyway — it is better reviewed and
translated than not written.

## Commits and pull requests

- Work inside the package or adapter that owns the change.
- Add or update tests for any behaviour change. A test that cannot fail is not
  a test; make sure yours goes red before it goes green.
- Commit messages say **what and why**, and reference a decision number or a
  test-plan case ID when one applies.
- Before a large edit, read `git log --oneline -5`. Someone may have moved the
  same files.

## Licensing

RunSkein is Apache-2.0. By contributing you agree that your contribution is
licensed under the same terms — inbound equals outbound. There is no separate
contributor licence agreement, and copyright stays with you: the notices say
"RunSkein contributors" precisely so that no assignment is needed.

If your change adds a runtime dependency, check its licence first, and say
what it is in the pull request. A dependency that gets **bundled** rather than
installed — as `adapters/pi/shim.mjs` bundles its own — also has to have its
notice added to [`NOTICE`](NOTICE), which `pnpm quality` checks is carried by
every published package.
