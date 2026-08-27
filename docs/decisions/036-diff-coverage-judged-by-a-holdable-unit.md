# 036 - diff coverage is judged by a unit a consumer can hold on its own

Date: 2026-08-25 · Status: **accepted** · Cases: `standalone diff coverage
judge` in `packages/fold/test/contract.test.ts` · Rests on: decision 034 ·
Informs: api §4.2, `docs/transcript-fold.md` §4.2.2

> Accepted in the change that landed the extraction, the parity tests and the
> contract-document update together — the requirement
> `docs/decisions/README.md` sets for flipping a record out of _proposed_.

## Context

Decision 034 gave `ToolRow.diffs` its answer, and made that answer **stateful**:
`created` needs no history, but `chained` is proved by comparing a block's
`oldText` against the text an earlier whole-file diff for that path left behind,
and a block a row was already judged on keeps its verdict so a resend is not
tested against what its own first pass recorded.

All of that state lived inside `TranscriptFolder`: a private `Map<path, text>`
and a `judgedDiffs` list on each open row. The only way in was `createFolder()`
or `collectToolRows()` — a whole folder either way.

A consumer can need coverage on a path that does not fold. realm-plugin's diff
index is one: it is built event by event off the store's append fan-out, records
`{seq, path, adds, dels, …}` per diff, and never renders a message run, a plan
or a usage gauge. Its two options were to re-implement the chain — a second
owner of "what counts as a whole file", where missing one rule (skip a block
whose `path`/`newText` is not a string; reuse a row's prior verdicts; let any
other diff _end_ the chain) surfaces as a confidently wrong line number, which
is the failure 034 exists to prevent — or to run a second folder purely to read
`ToolRow.diffs`, paying for message, plan and usage state it never reads.

## Decision

The chain is its own unit, exported as `createDiffCoverageJudge()` from
`@realm-node/fold`:

```ts
interface DiffCoverageJudge {
  push(update: unknown): readonly Readonly<DiffCoverage>[] | undefined;
}
```

- **The folder is built on it.** `TranscriptFolder` holds a judge like any other
  consumer and no longer holds the chain map or per-row verdicts itself, so
  there is exactly one implementation and `ToolRow.diffs` cannot drift from
  what a standalone judge says.
- **The unit takes updates, not blocks.** Judging a `content` array is only part
  of the rule: a full `tool_call` replaces the row and so discards the verdicts
  of the run before it, and a terminal status ends the row. Those dispatch rules
  are exactly the kind that a consumer re-deriving them would get subtly wrong,
  so they live inside the unit — a consumer pushes every `tool_call` /
  `tool_call_update` of one session in seq order and pushes anything else
  harmlessly.
- **It accepts exactly what the folder accepts.** A malformed row patch — a
  non-string `title`, a `content` that is not an array, a `tool_call` with no
  title — is rejected by a single shared validity rule both go through. A judge
  that read a patch the folder rejects would hand out coverage the rendered row
  disagrees with.
- **`undefined` means "this update judged nothing"** — it carried no content, or
  none of its blocks was a judgeable diff. A patch that does not carry `content`
  therefore leaves a row's existing coverage standing, which is what the folder
  already did.

## Consequences

- Retained state for a bare judge is the file text of each path currently on a
  whole-file chain plus the verdicts of the rows still open. Both shrink as the
  chain breaks and as rows reach a terminal status; nothing else is kept.
- `ToolRow.diffs` is unchanged, field for field. This is a refactor plus a new
  export, not a semantic change, and the parity test pushes one stream through a
  judge and a folder together and compares them after every update.
- The order/replay invariant 034 relies on is now testable without a folder: the
  same stream pushed twice gives the same verdicts, which is what lets a
  consumer's incrementally built index and its rebuild-by-rescan agree.
- A judge started mid-stream still has no chain to build on, exactly as a folder
  started mid-stream does. Coverage is proved by what has been pushed.
- Decision 034 said those per-row verdicts "live on the row". That described
  the mechanism before this record: they now live in the judge, keyed by row,
  and are freed at the same moment as before — the terminal status that evicts
  the row, or a full `tool_call` starting a new run of the id.
- Fold stays outside the frozen contract (it lives on the `realm-node/fold`
  subpath), so this adds a surface without touching the v1 engine-adapter
  surface.
