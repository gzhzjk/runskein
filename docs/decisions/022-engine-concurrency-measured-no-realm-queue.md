# 022 — Measured engine concurrency: no realm-side queue; the gap is the missing prompt timeout

Date: 2026-08-08 · Status: **accepted** · Case: ST-CONC-01 (AC-3.1) ·
Evidence: `docs/conformance/st-conc-01.json` (two independent samples)

## What was measured

Per engine: three sessions on **one** shared process (`processCount: 1`
confirmed by scanning this process's children), then three `prompt()` calls
fired at the same instant, each carrying its own codeword. Engines were run
strictly serially so machine contention stayed outside the measured intervals.

Classification uses **completion stagger**, not interval overlap. Because all
three prompts are fired together their `[start, end]` intervals are nested and
cannot discriminate, and "time to first update" turned out to be unreliable —
opencode buffers a turn's updates and flushes them late, which made a genuinely
parallel engine look partly serialized in the first sample. Completion times
cannot be disguised that way: an engine that runs turns one at a time staggers
completions by roughly one turn each (spread → (N-1)× the first completion,
i.e. 2.0 for N=3), one that runs them together lands them all within about one
turn (spread → 0).

| engine      | stagger (run 1 / run 2) | verdict        | wall vs sum of turns | routing |
| ----------- | ----------------------- | -------------- | -------------------- | ------- |
| opencode    | 0.22 / 0.19             | **parallel**   | 2.6 s vs 7.2 s       | clean   |
| kimi        | 0.61 / 0.31             | **parallel**   | 6.2 s vs 15.7 s      | clean   |
| codex       | 0.20 / 0.47             | **parallel**   | 8.3 s vs 19.7 s      | clean   |
| claude-code | 2.41 / 3.26             | **serialized** | 12.4 s vs 21.1 s     | clean   |

claude-code's per-turn completions (2.9 s → 5.8 s → 12.4 s, each turn starting
only after the previous one finished) are the signature of an internal queue;
the other three overlap almost completely. No engine errored, corrupted a turn,
or refused concurrent work.

**Routing was clean in every run**: 24/24 sessions across both samples contained
their own codeword and none of their siblings'. Interleaved traffic on a shared
process routes correctly (`liveByNative` holds under real concurrency).

**No request timed out** — and could not have. See the finding below.

## Decision

1. **No realm-side queue ships (§2.3.3 resolved: timeout-only).** The
   measurement's own precondition for a queue was "engines reject or corrupt
   under concurrency". None do. Three engines already run turns in parallel, so
   a realm queue would _remove_ working throughput; the fourth already
   serializes internally, so a realm queue in front of it would be a second
   queue whose only effect is to move the wait somewhere less observable. The
   hard session cap stays rejected for the reason already established: the
   contended resource is in-flight requests, not sessions.
   Consequently **ST-CONC-04 does not apply** and is withdrawn from the
   inventory rather than left as a permanently skipped case.
2. **§2.3.2's request timeout ships unchanged and becomes the whole of §2.3's
   load story.** It was already specified as unconditional; this measurement
   makes it the _only_ load control, which raises its priority rather than
   lowering it.
3. **Per-engine concurrency is recorded as engine behaviour, not as a realm
   capability.** claude-code being serialized is not a defect and gets no
   `NotSupportedError`: the turn still completes correctly, only later. It is
   documented so a host sizing fan-out knows that N concurrent turns on one
   claude-code process cost N× latency, and that spreading them across
   processes (separate cwds) is the way to parallelize that engine.

## The finding that matters more than the ruling

**`session/prompt` has no timeout at all today.** `AcpConnection` applies
`DEFAULT_REQUEST_TIMEOUT_MS` (30 s) to every request method _except_ `prompt`
(no default) and `closeSession` (10 s), and the Hub passes none. So the "does
the default 30 s timeout trip under concurrency?" half of ST-CONC-01 is
vacuous: a prompt cannot time out, however long an engine makes it wait. A
turn queued behind a slow one on claude-code waits indefinitely, and a wedged
engine hangs the caller forever with no typed error — exactly the unreadable
failure §2.4 exists to prevent.

The measurement harness had to impose its own ceiling to stay bounded, which is
the tell: if the test harness needs a timeout that the library does not offer,
consumers need it too. This makes `HubOptions.defaults.requestTimeoutMs` (and
its per-session override) the load-bearing deliverable of §2.3, and it must
cover `prompt`, not only session setup.

## Evidence handling

The per-run data lives in `docs/conformance/st-conc-01.json`, not in
`matrix.json`: the matrix is regenerated wholesale by `pnpm probe`, so a
hand-written concurrency row would be silently overwritten on the next probe
run. Folding concurrency into the probe is the correct home if this becomes a
recurring measurement; until then the dedicated artifact is the record.

## Re-run

`pnpm --filter @runskein/conformance st:conc [engineId ...]` — rerun when an
engine's version changes, since the verdict is a property of the engine build,
not of realm.
