# 045 - a session marker belongs to the engine that leaves it

Date: 2026-08-31 · Status: **accepted** · Cases: core scrubs nothing of its own
(`packages/core/test/unit.test.ts`), each bundled adapter scrubs its own marker
(`packages/runskein/test/meta.test.ts`), a declared marker is removed at spawn
and an undeclared one is not (`packages/core/test/functional.test.ts`), and a
terminal reserves only what the session's adapter declared
(`packages/core/test/terminal.test.ts`) · Informs: design §3.2 (env hygiene),
api §9, adapter guide §3

## Context

Child agents refuse to start when a host agent's session markers reach them: a
parent Claude Code session's `CLAUDE*` variables make the Claude Code ACP
wrapper refuse with "active session". Core has scrubbed them since the finding
was measured, from one list in `spawn.ts`:

```ts
export const ENV_SCRUB_PATTERNS: readonly RegExp[] = [
  /^(CLAUDE|CLAUDECODE|CODEX_SANDBOX|OPENCODE_(SESSION|CALLER))/,
];
```

Three engines named inside core, in a library whose whole point is that core
knows about engines only through what an adapter declares. And the fourth
engine's markers were never there: pi has declared its own since it was
written, through the `envScrubExtra` hook core already merges at both scrub
sites — the engine process and an agent-requested terminal.

So the same kind of fact had two homes, and which home it got was decided by
when the engine was added rather than by anything about the fact.

## Decision

- **Each adapter declares the markers its own engine leaves.** `claude-code`
  declares `/^CLAUDE/`, `codex` `/^CODEX_SANDBOX/`, `opencode`
  `/^OPENCODE_(SESSION|CALLER)/`, and pi keeps what it had. Core's
  `ENV_SCRUB_PATTERNS` becomes empty.

- **kimi declares nothing.** No kimi session marker has been measured. An
  absent declaration is honest; a guessed pattern would scrub a variable no one
  has seen, and would read to the next person as evidence.

- **The list stays, empty.** It is the place a marker belonging to no single
  engine would go, and keeping it keeps the merge order — core first, then the
  adapter — where every reader already expects it. It is also the undo: an
  engine found refusing on another engine's marker gets that pattern written
  back here, one line, with the measurement beside it.

## Consequences

**The scrub narrows from every child to the child that cares.** Spawning kimi
from inside a Claude Code session no longer removes `CLAUDE*` from kimi's
environment. That is the intent, not a cost: a session marker is a statement an
agent makes to itself, and `CLAUDECODE=1` means nothing to kimi.

Measured rather than argued, because it is the one thing that could have made
this decision wrong. From a live Claude Code session carrying ten `CLAUDE*`
variables — `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` and the rest —
with the new adapters in place, `describe` spawned and probed opencode, codex,
kimi and pi. All four returned a full capability set and none refused. What was
not done is a side-by-side run against the old blanket scrub, so the claim is
that the markers do not stop these engines, not that nothing anywhere differs.
claude-code is the engine that does refuse, and its own adapter now declares the
pattern.

So core's list was broader than any measurement supported, and narrowing it
costs nothing that has been observed.

**What an agent may set on a terminal becomes per-engine too.** A terminal
refuses the variables the host scrubs, so an opencode session may now set
`CLAUDE_FOO` where before it could not. The separate list that decides _which
program a command becomes_ — `PATH`, `LD_*`/`DYLD_*`, `NODE_OPTIONS`,
`GIT_SSH_COMMAND` and the rest — is untouched, so no boundary moves.

**A nested agent started by an agent's own command sees the host's markers.**
If opencode's terminal runs `claude`, that process now receives `CLAUDE*`.
runskein does not model what an agent's commands spawn; the environment a
terminal runs with reaches the permission policy as data, and a consumer that
cares can deny it. Nothing that was guaranteed is withdrawn.

**No frozen surface moves.** `ENV_SCRUB_PATTERNS` is exported from
`@runskein/core/internal`, which states that it is off the supported path and
may change. `envScrubExtra` is unchanged in shape, meaning and validation.

**Where a lost marker now shows up.** Core's own tests were the only thing
holding the engine list, so emptying it would have left the adapters' patterns
untested. `packages/runskein/test/meta.test.ts` now asserts, per engine, that
each marker core used to hold is still scrubbed — and that four
deliberately-set variables close in name to a marker are not
(`MY_CLAUDE_KEY`, `CODEX_HOME`, `OPENCODE_CONFIG_CONTENT`, `PI_CODING_AGENT_DIR`).
Core's own cases moved to an invented engine's markers, because what they prove
is the mechanism, which must behave the same for an engine this repository has
never seen.

## Alternatives

**Leave it.** It works, and the over-scrub is harmless. Rejected because the
inconsistency is the kind that decides the next adapter's shape: an author
reading core would put their engine's markers there, and an author reading pi
would not.

**Apply every registered adapter's `envScrubExtra` to every spawn.** Keeps
today's behaviour exactly while still moving the data out of core. Rejected
because it changes what `envScrubExtra` means — from "extra for this engine" to
"extra for all engines" — for a breadth no measurement asks for, and it would
make one adapter's pattern able to strip a variable another engine needs.
