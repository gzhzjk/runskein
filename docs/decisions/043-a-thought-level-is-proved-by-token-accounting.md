# 043 - a thought level is proved by token accounting, not by streamed text

Date: 2026-08-31 · Status: **accepted** · Cases: CF-06, CF-10, PV-02 live ·
Evidence: live run 2026-08-31 across all five bundled engines ·
Rests on: decisions 032, 033 · Informs: the conversation capability table

## Context

Decision 032 gave claude-code a thought level through the wrapper's private
`_meta.claudeCode.options`, and CF-10 was written to prove it arrived: ask the
engine to think, count `agent_thought_chunk`. That oracle worked once and then
stopped, without anything failing.

Two things broke it. Decision 032's route disappeared when the adapter moved to
Anthropic's own ACP wrapper and the level began riding the engine's published
`effort` option instead. And the counting itself stopped discriminating:
recent Claude models default `thinking.display` to `"omitted"`, so the wrapper —
which emits a chunk only when the thinking text is non-empty — emits none, at
every level.

One probe, 2026-08-31, each engine at the strongest level it advertises. The
second row is why counting chunks was not merely dead but misleading:

| engine      | chunks | `usage.thought` |
| ----------- | ------ | --------------- |
| claude-code | 0      | absent          |
| codex       | 0      | 31              |

An oracle that reports zero for an engine that just accounted for 31 tokens of
thinking is not a weak oracle. It is a wrong one, and it had been reporting
`warn` — "we looked and it was probably fine" — in exactly the state it was
written to catch. codex is not consistently silent, which is worse than
consistently: a CF-10 run hours later on the same machine streamed 552
characters of thought text alongside 2070 thought tokens. An oracle that works
on some runs of the same engine cannot be the one a gate rests on.

## Decision

**1. The thought level stays Negotiated.** Every bundled engine except pi
publishes one and accepts writes to it. Nothing here removes a capability.

**2. Its evidence is usage, not streamed text.** CF-10 takes the strongest
level the engine advertises and looks for evidence the model did more work, in
this order, naming in its log which tier answered:

1. `TurnResult.usage.thought` — the engine broke thinking tokens out.
2. streamed `agent_thought_chunk` text.
3. output tokens at the strongest level against the weakest, one control turn.

**3. Tier 3 exists because thinking can be real and invisible.** Anthropic
bills thinking inside `output_tokens` and does not break it out. On claude-code
that is the only signal there is, and it is emphatic. Four runs on the same
prompt, `effort=low` against `effort=max`:

| `low` | `max` | separation |
| ----- | ----- | ---------- |
| 3     | 4915  | 1638x      |
| 86    | 6378  | 74x        |
| 3     | 1806  | 602x       |
| 3     | 9276  | 3092x      |
| 3     | 7039  | 2346x      |
| 86    | 1600  | 18.6x      |

**The margin is 8x, and it is set from both sides.** A bare inequality would
call noise a working setting. Two negative controls — the case run with _both_
arms writing the same level, so nothing changes — came out 8268 against 4229
and 3614 against 9369: spreads of 1.95x and 2.59x with the settings identical,
and on the second the nominally stronger arm spent less. So the threshold has
to clear about 2.6x of run-to-run noise. 8x sits about three times above it,
and rather more than twice below the tightest real separation measured — 18.6x,
which is not the comfortable order of magnitude the first four runs suggested.
The weak arm is what closes the gap: its output varies between 3 and 86 tokens
depending on how terse the answer happens to be, while the strong arm stays in
the thousands. A single sample each way is thin, which is why this case warns
rather than fails, and why a run landing between 2.6x and 8x should widen the
sample before it moves the number.

The second control was run against this case exactly as it ships, and it
warned. That is what makes the passing runs mean anything: the oracle has been
watched failing, not only succeeding.

**4. When no tier applies, the case skips saying so** — `no observable oracle
on this engine` — rather than warning. A `warn` reads as a soft pass; a skip
with that reason reads as an untested contract, which is what it is.

**5. Levels are ranked, not positional.** The engine publishes the option now
and its declaration order is arbitrary: opencode lists `none` last and
claude-code lists `default` first. A rank table over the known names decides
the weakest and strongest pair, and `default` is deliberately unranked — it
means "whatever this model does unasked", which is not a point on the scale.

## Rationale

The alternative was to accept that claude-code's thought level is unverifiable
and say so. That would have been honest about the streamed text and wrong about
the engine: the level works, and a measurement nobody had taken shows it works
by a factor of 74 to 1638. Retiring a capability, or marking it unverified, on
the strength of an oracle that had gone blind would have been the expensive
kind of mistake — everything downstream would have treated the gap as settled.

Reading output tokens off the wire is engine-level evidence a consumer cannot
reproduce through the public surface, because claude-code's adapter declares no
usage mapping. That limit is named here rather than hidden: CF-10 asserts what
the _engine_ does, and the capability table tells a consumer separately what
they can observe themselves.

## Consequences

- Decision 032's consequence "`reasoning=high` accepted at creation and four
  `agent_thought_chunk` observed on the turn" no longer describes claude-code.
  The route is the engine's own `effort` option, written at runtime, and no
  thought chunk is observed at any level. 032's decision — one config interface,
  uniform at creation, described at runtime — is untouched.
- `settable: 'creation'` has no bundled user. CF-10 still routes on it, so an
  adapter that declares one gets the creation path and the runtime-refusal
  assertion 032 requires.
- PV-02's absence waiver stops implying the model did not think. What it
  observes is whether the stream carries thinking — which is what a host
  rendering a thought pane needs — and it points at CF-10 for the effect.
- `usage.thought` can never reach a claude-code consumer. The Claude Agent
  SDK's usage carries five token counts — input, output, cached read, cached
  write and total — and nothing else, so a usage mapping for this engine would
  surface tokens and cost but no thought count.
