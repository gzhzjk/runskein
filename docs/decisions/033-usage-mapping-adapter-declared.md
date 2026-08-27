# 033 - usage accounting through adapter-declared `_meta` mapping

Date: 2026-08-23 · Status: **accepted** · Cases: `UA-*` (see
the usage-enhancement test plan), live `UA-LIVE-01`, matrix row `usage` ·
Evidence: `docs/conformance/codex.raw.json` (`_meta.quota.token_count`),
`docs/conformance/pi.raw.json` (nested `usage_update.usage`) · Rests on:
decisions 007, 013, 024, 028 · Informs: api §8, §9; the transcript and
accounting capability table

> Accepted in the change that landed the declaration schema, the interpreter,
> the session semantics, the codex declaration, the UA-* suites and the
> contract-document updates together — the requirement
> `docs/decisions/README.md` sets for flipping a record out of _proposed_.
>
> Amendment (2026-08-23, same day): a multi-turn live measurement found that
> opencode also reports per-turn tokens on its prompt response (top-level
> `usage`, alias `cachedReadTokens`) — a carrier this record's context survey
> missed. It declared under point 2 of this decision; no contract surface
> moved. kimi and claude-code were re-measured and still have nothing to
> declare: their wires carry only `{used, size}` gauges or nothing, which
> point 1's absent-stays-absent rule keeps out of `Usage`.

## Context

Realm's usage accounting is pass-through (api §8, Emulated): the three public
surfaces — `TurnResult.usage`, `s.usage()`, `TranscriptEvent.usage` — are
populated only from what the engine puts on the wire, and absent fields stay
absent. Measured consequence: only `pi` returns real token accounting today.
codex, opencode and kimi send either nothing or bare `{used, size}` window
gauges; claude-code sends no `usage_update` at all.

But codex's numbers **are** on the wire, in the protocol's official extension
point — the prompt response's `_meta.quota.token_count`. Two per-engine facts
keep them out of `Usage`: the report is not a `usage_update` notification, and
codex's field names (`cachedInputTokens`, `reasoningOutputTokens`) are not in
the built-in alias table `foldUsage` walks. Per-engine facts are adapter data,
not core code.

Decision 013/024 deliberately made `_meta.quota` an opaque
`TurnResult.quota.payload` — "one reporter out of four is nowhere near enough
to generalize from". That was about baking codex's shape into a realm
vocabulary. It does not forbid reading codex's fields into realm's **existing**
`Usage` vocabulary through a per-engine declaration, which is exactly how realm
already absorbs `errorPatterns`.

## Decision

**1. `Usage` stays the single target, and the public surface does not change.**
Every engine normalizes into the one existing shape, so a session on codex and
a session on pi read identically to a consumer. Absent fields stay absent:
codex reports no cost, so codex usage has no cost.

**2. Engines declare where their accounting lives; core interprets
generically.** `EngineAdapter` gains one optional field, `usage` — pure data
beside `errorPatterns` and `configHints` — naming the source (a `usage_update`
notification, or a path on the prompt response's `_meta`), any engine field
names the built-in alias table does not already know, and the report's
semantics. Core runs one interpreter over it and never branches on an engine
id. Declaring nothing is today's behaviour, so pi, opencode, kimi and
claude-code are untouched.

**3. `semantics: 'cumulative' | 'per-turn'` is part of the contract, not an
implementation detail.** The two known reporters disagree on meaning: pi
reports session totals, codex reports per-turn counts. Folding per-turn counts
through the replace path yields "the last turn" as the session total; reading a
cumulative total as a turn result yields "everything so far" as one turn — two
opposite wrong numbers from the same missing fact.

**3a. `per-turn` is refused for the `usage_update` source.** An engine-sent
update is stored verbatim, and replay has no semantics to consult, so per-turn
numbers in that carrier would resume as the last turn alone. No engine
exhibits the combination, and one that appears can be adapted by a shim, so
the schema refuses it rather than paying for a second stored event or a
semantics-aware replay.

**4. A turn value means _this turn_ on every engine.** On a cumulative
reporter it is the per-field delta against the turn-start snapshot, clamped at
zero — `total` included, because pi reports a total that is not `input +
output` and re-deriving it would replace the engine's number with a fabricated
one. This corrects a pre-existing bug: `TurnResult.usage` on pi is today the
running session total, because the turn counter is folded through the same
replace path as the session counter.

**5. A declared non-default source is exclusive.** An engine reporting through
both carriers would otherwise be counted twice, and both numbers would look
plausible. Cost is out of that scope and is still read from every
`usage_update`.

**6. A `_meta`-sourced report is persisted as a synthesized `usage_update`
transcript event, carrying the session-cumulative value in realm's own field
names, marked as realm-synthesized.** Engine-sent `usage_update` events are
already persisted verbatim and stay that way; synthesis fills in only the
carrier that produces no event of its own. Resume recovers its accounting only
from stored
`usage_update` events, replacing within a segment and adding across segments,
and without the adapter — so a report that is not written back gives codex real
numbers in-life and `{}` after resume, the asymmetry decision 1 forbids; a
turn-delta event would recover the last turn instead of the sum; an engine's
own field names would make a transcript depend on the declaration that produced
it. The marker keeps the
envelope's "protocol shape, verbatim" contract honest about what the engine
actually sent.

**7. Both failure modes are loud.** A malformed declaration fails zod at
adapter load (`health: 'invalid'`). A well-formed declaration that is wrong
about the wire cannot be caught at load — it is a claim about an engine — so
the live suite and the matrix measure it. Neither failure is a silent empty
`s.usage()`.

## What does not change

- **`TurnResult.quota` stays opaque** (013). `_meta.quota` is read for
  _accounting_ and still passed through verbatim as _quota_. Two surfaces, two
  concerns.
- **`used`/`size` are never folded into `Usage`** (024). They are window
  gauges; back-filling tokens from them is fabrication.
- **No per-model breakdown, no engine-private file reading, no estimation.**
- **013's "Usage is untouched" is amended** for the population path only: the
  shape and all three surfaces are unchanged; this decision adds where values
  may come from, and corrects what a turn value means.

## Rationale

**Why not a core-side engine lookup.** An `if (engineId === 'codex')` in core
is the coupling the adapter layer exists to prevent: a new engine must be a
directory, not a code change. The same argument made `errorPatterns` data
rather than a per-engine error decoder.

**Why declared aliases extend the built-in table instead of replacing it.** Two
tables that both claim authority drift: an engine whose declaration omits
`input` would silently lose a field core already knew how to read. Additive
means declaring nothing is exactly today's behaviour.

**Why now, when 024 said one reporter was not enough.** 024 rejected a
codex-shaped field on the API. Nothing here is generalized from codex: the
vocabulary is realm's own and the engine-shaped part lives in the engine's own
directory. Two working precedents now exist — pi's shim translation and codex's
`_meta` — that a uniform mechanism can be built around.

**Why declaring beats detecting.** A mapping is a falsifiable claim about an
engine's wire, so it can be gated. Sniffing `_meta` heuristically would produce
the same numbers with no place to notice when they stop arriving.

## Consequences

- codex gains real `s.usage()`/`TurnResult.usage` in pi's shape; cost stays
  absent where the engine reports none. opencode, kimi and claude-code keep
  absent-field behaviour until they report or declare.
- **Breaking:** `TurnResult.usage` on a cumulative reporter changes from
  "session total so far" to "this turn". `s.usage()` is unaffected.
- Transcripts on `_meta`-sourced engines gain one synthesized `usage_update`
  per turn, marked as realm-synthesized.
- Adapter writers get a documented third declarative surface (`usage`).
- api §9's `EngineAdapter` and §8's accounting row gain it; the accounting
  capability table is
  updated; `docs/conformance/matrix.json` gains a measured `usage` row,
  refreshed when measured behaviour shifts — the mapping is trustable only
  while the gate proves it.

## Re-run

`pnpm --filter @runskein/conformance test:live codex pi LIVE_INCLUDE=...` —
engines are positional arguments of `test:live` (`RUNSKEIN_GATE_ENGINES` selects
the Core gate, not this runner). `UA-LIVE-01` shares `ST-QUOTA-02`'s
default waiver, so opt in per run: `LIVE_INCLUDE="ST-QUOTA-02,UA-LIVE-01"`.
Zero additional turns (UA-LIVE-01 is judged on the turn ST-QUOTA-02 already
runs); rerun on engine version bumps.
