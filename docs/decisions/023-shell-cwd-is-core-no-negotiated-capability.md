# 023 — Per-session shell cwd holds on all four engines: stays Core, no `workspace.shellCwd`

Date: 2026-08-08 · Status: **accepted** · Case: ST-CWD-02 (AC-6.2) ·
Evidence: `docs/conformance/st-cwd-02.json`

## What was measured

An earlier survey established that all four engines resolve **file** operations from
the per-session `cwd`. The shell/terminal path was never probed, and it is a
separate implementation per engine: a build or test run in the wrong tree
damages exactly like a misplaced write.

Protocol per engine: two sessions on **one** process with two different seeded
cwds, each asked to run `pwd` through the engine's own terminal /
command-execution tool and report the exact output line. Session **B** is the
load-bearing one — the process is launched with session A's cwd (first acquire
wins, A.3), so B reporting its own directory proves the engine resolves the
subprocess cwd per session rather than per process. Replies were matched
against both the literal and the `realpath` form of the directory (macOS
`/var` → `/private/var`; kimi in fact answered in the unresolved form). An
execute-kind tool call was recorded separately so "the model answered from
memory" stays distinguishable from "a shell really ran there".

| engine      | session A | session B | shell tool observed | reported sibling's cwd |
| ----------- | --------- | --------- | ------------------- | ---------------------- |
| opencode    | correct   | correct   | yes                 | no                     |
| kimi        | correct   | correct   | yes                 | no                     |
| claude-code | correct   | correct   | yes                 | no                     |
| codex       | correct   | correct   | yes                 | no                     |

8/8 correct, including all four second sessions whose cwd differs from the
process cwd. No engine leaked its sibling's directory. codex's sandbox was not
a barrier, matching A.3's file-tool result.

## Decision

1. **Shell cwd stays Core.** The conditional branch that was drafted for it
   is **not**
   selected: `workspace.shellCwd`, `SessionOpts.require?: { shellCwd?: true }`,
   and the `NotSupportedError { capability: 'workspace:shell-cwd' }`
   pre-session rejection **do not ship**. Adding a Negotiated surface no engine
   fails would be unused API — and AC-6.3 is conditional precisely so this
   ruling can decline it. AC-6.3 is therefore satisfied as "branch not
   selected"; ST-CWD-02's promoted form asserts the guarantee instead.
2. **The guarantee becomes guarded, not assumed.** This is the point of the
   chapter: the result is a property of four engine builds, not of realm, and a
   version bump can silently regress it. ST-CWD-02 is promoted to a recurring
   live case beside ST-CWD-01 (file tools), so a regression turns a row red
   instead of being discovered by a build running in the wrong worktree.
3. **The pass oracle stays two-sided.** A recurring case asserts both that each
   session reports _its own_ cwd and that it never reports its _sibling's_ —
   an engine that answered from the model's memory rather than the shell would
   satisfy a one-sided check on the first session and fail the second.

## Caveat worth keeping visible

This measures where the engine's shell _starts_, not where it can _reach_.
Nothing prevents an engine-run command from touching an absolute path outside
its cwd, and realm cannot predict whether a prompt will invoke an engine-owned
shell at all. Per-session cwd isolation therefore remains a cooperative
guarantee that L2 depends on; container isolation stays the only enforceable
answer and stays out of scope until chosen (and would be an L1 launcher hook,
not an L2 feature).

## Re-run

`pnpm --filter @runskein/conformance st:cwd [engineId ...]` — rerun on engine
version changes; the promoted live case covers the recurring signal.

## Amendment (2026-08-21) — the guard is still there, no longer on by default

The live runner's default case set was cut to the classic path a host takes,
and ST-CWD-02 is now opt-in (`LIVE_INCLUDE=ST-CWD-02`, or `all`). Consequence
2 above said "recurring", and by default it no longer is.

What still runs every time is ST-CWD-01, the file-tool half. The shell half —
the one this ruling actually rests on, because it is a separate implementation
in each engine — now only runs when asked for. A shell-cwd regression in an
engine build will therefore be found by whoever next opts in, not by the next
scheduled run.

That is a real reduction in cover, accepted deliberately: a live run costs
tokens on every engine, and the case was not paying for itself on every one.
Reversing it is one line — remove 'ST-CWD-02' from DEFAULT_WAIVED in
`packages/conformance/src/live.ts`.
