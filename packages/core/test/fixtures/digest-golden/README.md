# Digest golden corpus — the pre-change oracle for AC-7.4

The stabilization work adds structured, token-bounded and head-keep digests
beside the existing text digest, under one acceptance condition — **AC-7.4: the
default text digest stays byte-identical to today's output for existing
inputs.** That guard only means something if the "today" side was recorded
**before** the new digests existed. This directory is that recording.

Captured from the pristine baseline at commit `3ec4787` (2026-08-08,
node v22.22.1) by running the then-current `buildDigest` — exported from
`@runskein/core/internal` — over each `*.input.json`.

## Frozen

**Never regenerate these files.** A golden refreshed with post-change code
is not an oracle, it is a screenshot of the change agreeing with itself. If
a diff appears, either the change is an unintended regression (fix the code)
or it is a deliberate, documented change to the default digest (which
contradicts AC-7.4 and therefore needs a decision note and a human ruling —
not a refresh). The generator is deliberately not committed for the same
reason.

## Layout

Each fixture is a pair, plus a `manifest.json` index:

- `<name>.input.json` — `{ sessionId, opts?, events }`, the exact
  `buildDigest` arguments. `opts` absent means the default budget.
- `<name>.digest.json` — the exact `TranscriptDigest` returned
  (`{ sessionId, throughSeq, text }`).

## The corpus, and what each fixture is for

| fixture                        | events | maxChars         | out chars | truncated | why it exists                                                                                                                                                |
| ------------------------------ | -----: | ---------------- | --------: | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mixed-roles`                  |     10 | default          |       264 | no        | same-role folding, role alternation, and the role reset a tool entry causes — the core rendering contract.                                                   |
| `tool-calls`                   |     12 | default          |       755 | no        | every tool branch: title/kind fallbacks, whitespace collapse, `rawOutput` fallback, empty output, the 400-char per-result cap, non-terminal updates ignored. |
| `no-digestible-content`        |      5 | default          |         0 | no        | thought/plan/image/pending events advance `throughSeq` but contribute no text — catches stray output or a lost seq watermark.                                |
| `empty`                        |      0 | default          |         0 | no        | the degenerate input a bounding rewrite is most likely to break.                                                                                             |
| `oversized-tail-truncation`    |     82 | 600              |       600 | yes       | the current tail bias at an explicit budget: oldest content dropped, marker prepended, `TAIL-MARKER` survives and `HEAD-MARKER` does not.                    |
| `oversized-default-budget`     |    402 | default (32 000) |    32 000 | yes       | the same policy at the **default** budget — the configuration the resume chain actually uses.                                                                |
| `utf8-multibyte-truncation`    |     62 | 400              |       400 | yes       | CJK, astral-plane emoji, a flag sequence, a skin-tone modifier and an accent, cut under budget pressure.                                                     |
| `utf8-split-surrogate`         |     62 | 357              |       357 | yes       | same corpus at a budget whose cut lands **inside a surrogate pair** (see the defect note below).                                                             |
| `boundary-exact-fit`           |      1 | 100              |       100 | no        | output length exactly `maxChars`: the bound is inclusive, so no truncation.                                                                                  |
| `boundary-one-over`            |      1 | 100              |       100 | yes       | one char past the budget — the smallest input that must truncate; pins the trigger point with the row above.                                                 |
| `boundary-budget-below-marker` |      1 | 10               |        34 | yes       | budget smaller than the truncation marker itself (see the defect note below).                                                                                |

## Two goldens record defects, not expectations

Both were found while capturing the corpus. They are frozen **as the current
behaviour** so the change is visible; neither is an assertion that the
behaviour is correct.

1. `boundary-budget-below-marker` — with `maxChars: 10` the output is 34
   chars: the truncation marker itself overflows the budget it announces.
   The new bounded path is forbidden the analogous behaviour by **AC-7.2: a
   token-budget-bounded digest never exceeds its budget, and a truncated cut is
   always at a valid UTF-8 boundary.**
2. `utf8-split-surrogate` — the current slice is by JS char (UTF-16 code
   unit), so the cut leaves a **lone low surrogate** (`U+DDF5`, half of a
   regional-indicator flag) in the output. AC-7.2 requires truncation to back
   up to a valid UTF-8 boundary.

Where AC-7.4 (freeze the default) and AC-7.2 (never emit an invalid or
over-budget cut) disagree, the conflict is real and belongs to a human, not
to whichever test runs last.
