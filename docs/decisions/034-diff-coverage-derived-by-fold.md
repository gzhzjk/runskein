# 034 - diff coverage is derived by fold, proved or `unknown`

Date: 2026-08-24 · Status: **accepted** · Cases: `packages/fold/test/contract.test.ts`
(`diff coverage`) · Rests on: decisions 028 · Informs: api §4.2;
`docs/transcript-fold.md` §4.2

> Accepted in the change that landed `DiffCoverage`, the derivation, the
> contract tests and the document updates together — the requirement
> `docs/decisions/README.md` sets for flipping a record out of _proposed_.

## Context

A consumer rendering a `diff` content block wants to say which line of the file
each rendered line is. The wire does not carry that.

ACP's diff is `{path, oldText?, newText}` — no position field. `ToolCallLocation`
does have `line?: number | null`, but a downstream survey of 556 diff blocks
across four engines found it filled zero times out of the 545 blocks that
carried `locations` at all. `rawInput.edits[]` holds search/replace pairs, and
apply_patch's `patchText` hunks carry context text rather than line numbers.

Worse than the missing number: nothing on the wire says whether a block's text
is the **whole file** or a **fragment** of it, and the answer varies per tool
inside one engine — claude-code's `Write` sends whole files while its `Edit`
sends fragments. So a renderer cannot even tell when numbering a block from 1
happens to coincide with the file's own numbering, and cannot recover the
distinction by branching on the engine id.

Reconstructing the answer from the file on disk was considered and rejected.
Engines write before they notify, so at the moment a diff arrives the file is
already the _new_ text and the block's `oldText` is gone; a second edit to the
same file inside one turn moves it again. Replay is worse still: a transcript
opened later describes files that have since changed — the same survey found 16
whole-file blocks that no longer match their file. A rule that reads disk
produces a plausible line number that is sometimes wrong, and a wrong line
number is worse than none.

## Decision

Fold derives coverage for each diff block and reports it on `ToolRow.diffs` as
`DiffCoverage { index, path, scope, startLine?, from? }`. It answers only where
the transcript itself proves the answer:

1. **`created`** — the block has no `oldText`, so it wrote the file into
   existence and its `newText` is the whole file. `scope: 'wholeFile'`,
   `startLine: 1`.
2. **`chained`** — the block's `oldText` is exactly the `newText` of an earlier
   whole-file block for the same path, so the text being replaced is the whole
   file. `scope: 'wholeFile'`, `startLine: 1`. Any other diff for a path ends
   its chain: what the file holds afterwards is no longer known.
3. Everything else is `scope: 'unknown'` with no `startLine`.

The derivation stays inside fold, reads nothing but the transcript, and adds no
IO, no clock and no engine branch — the properties `docs/transcript-fold.md`
§3 requires of the folder. Core is not involved: the transcript stays verbatim
(api §4.2), so realm never edits what an engine said, and this inference lives
in realm's own layer where a consumer can see where it came from.

Consumer contract: `wholeFile` licenses claiming file line numbers, because the
block starts at line 1. `unknown` does not — number the block from 1 and say so.

## Consequences

- A fragment edit is `unknown`, which is most edits on most engines. That is the
  honest answer at this tier, not a gap to be filled by guessing.
- An engine that resends whole files gets `chained` from its second edit of a
  file onward; the first stays `unknown`, since nothing yet proves what the file
  contained.
- Coverage is derived live, so a folder started mid-transcript has no chain to
  build on and reports `unknown` until a diff proves otherwise. Replaying a
  transcript from its first event is what makes the chain available.
- The chain compares file text verbatim rather than by hash, so `chained` is a
  proof rather than a likelihood; a hash small enough to be worth keeping would
  turn a collision into a confidently wrong line number. The folder therefore
  retains one copy of the text of each file an engine last rewrote whole, and
  drops a path as soon as some other diff ends its chain.
- A block already judged on a row keeps its verdict, so an engine resending its
  `content` array does not have that block re-judged against what its own first
  pass recorded. Those verdicts live on the row and are freed with it; the reuse
  is deliberately not folder-wide, because the same edit can happen twice in a
  session with other edits in between, and the later one must be judged against
  the chain as it stands then. Inside a row the verdicts are handed back one for
  one for the same reason at smaller scale: a row can carry the same edit twice,
  and the second copy was judged against what the first one left behind.
- Two better sources stay open and are not blocked by this record: an engine
  filling `locations[].line` (fold must then prefer the engine's number), and
  realm serving `fs/read_text_file` so it holds the file's content _before_ the
  edit and can locate a fragment exactly. The second reverses "fs client methods
  stay out of scope" and needs its own record.
