# 015 — Parent-death supervision for engines that ignore stdin EOF, plus an ownership registry

Date: 2026-08-09 · Status: **accepted** · Trigger:
stabilization requirements AC-1.1 … AC-1.6. Engines are spawned
`detached: true` so lifecycle signals reach a whole process tree, which
deliberately severs the parent-death link. Measured across the live suite: of
the four engines only `@zed-industries/claude-code-acp` fails to exit when its
stdin closes, and it leaks reliably — every live-suite run left exactly one,
and twelve were found accumulated on one dev machine.

## Decision

### 1. `EngineAdapter.supervise?: boolean` — opt-in, zod-validated

An adapter that declares `supervise: true` is launched behind a small watchdog
process (`packages/core/src/process/supervisor.mjs`). The host keeps the write
end of a pipe whose read end the watchdog holds on fd 3; the kernel closes a
dying process's descriptors however it died, SIGKILL included, so EOF on that
fd is a reliable "my host is gone" signal that no in-band protocol message
could provide. The watchdog then stops the engine and exits.

It signals its whole **process group**, not the engine process it spawned. The
engines needing a watchdog are reached through wrappers — `npx -y <pkg>` makes
npx the direct child and the process that actually speaks ACP its grandchild —
so signalling only the direct child would kill the wrapper and leave the engine
running, which is the exact leak being closed. Descendants inherit the group at
any depth, so this reaches codex's deeper chain as well as `npx -> node`.

A descendant can also outlive the watchdog's own child. A wrapper exits on the
polite signal while the process it spawned ignores it, so treating "my child is
gone" as "the tree is gone" leaves the engine running — the leak, intact, from
a watchdog that believes it succeeded. The watchdog therefore sweeps whatever
still shares its process group before reporting its child's exit. Anything left
there is by definition something it spawned and nobody else will clean up.

It also refuses to claim success it did not achieve. The group signal normally
takes the watchdog down with it; reaching the code after it means the kill did
not land, so the watchdog checks whether the engine is really gone and exits
non-zero if it is not. The exit code is the only artifact left once the host is
dead, which is exactly why it must not read as success — the same reason the
sweep never counts a failed reap. For the same reason every diagnostic it writes
is guarded: its stderr reader died with the host, and an unhandled EPIPE would
kill the watchdog in the middle of the escalation it exists to perform.

Only `claude-code` declares it. The other three spawn exactly as before.

### 2. Ownership lives in an on-disk registry, not the child's environment

At spawn realm appends `{ enginePid, engineId, ownerPid, argv0, startedAt }` to
a shared JSONL file under the user state directory, and removes the entry when
the process exits. A sweep kills an entry's process only when **all** of these
hold: the `ownerPid` is dead, the `enginePid` is alive, and that pid is still
identifiably the recorded process — **both** its command line contains the
recorded `argv0` **and** its observed start time matches `startedAt`.

Both halves of the identity check are required. The command line alone is not
an identity: every host running the same engine launches a byte-identical one,
so a recycled pid that now belongs to _another live host's engine_ matches it
perfectly, and killing on that basis would destroy a stranger's in-flight task.
Pid plus start time is the classic process identity, which is what `startedAt`
is recorded for.

A pid that cannot be inspected yields **unknown**, which is deliberately
distinct from mismatch: it is neither killed nor pruned. Conflating the two
would discard the record of a process that is still running, leaving it with
nothing to identify it and permanently untrackable.

The sweep runs before the first engine acquisition and every 5 minutes after,
on an unref'd timer, cleared when the manager quits; concurrent runs coalesce
onto one promise.

### 3. Two internal seams, `@realm-node/core/internal` only

`InternalHubOptions.orphanSweep` accepts `{ ownership, intervalMs, clock,
onSweep }`. The clock has the same shape as the session idle clock (and the
same precedent as `ProcessManagerOptions.sleep`); `onSweep` reports
`{ scanned, reaped, prunedStaleEntries }` per run. Neither appears on the
public surface.

## Rationale

**Why not an environment stamp.** Stamping `REALM_NODE_OWNER=<pid>` into the
child env was the obvious design and is what the chapter originally proposed.
It cannot work: reading another process's environment requires `ps -E` on macOS
(repeatedly tightened by Apple) or `/proc/<pid>/environ` on Linux, both
same-uid-or-root and non-portable — the sweep could not reliably read its own
marker. The registry also makes the _periodic_ sweep meaningful in a
long-running host, which the env stamp never addressed.

**Why every condition.** Each alone is unsafe. A live owner means someone
else's working engine, which looks identical to an orphan from the outside. An
entry whose process is gone is just litter. A dead owner plus a live pid still
permits pid reuse — and the command line does not rule it out, because engines
of the same kind are launched identically on every host, so the recycled pid may
be another host's live engine matching the recorded `argv0` exactly. Only the
start time distinguishes one process from a later one wearing its pid. When
neither can be read — another user's process, or a platform without `ps` — the
verdict is `unknown` and the sweep neither kills nor forgets.

**Concurrency.** Several hosts share the file, so writes are append-only and
compaction goes through a temporary file plus rename. An append landing between
a compaction's read and its rename is lost. That is the safe direction: a
forgotten engine may leak once and be caught by the next host's sweep, whereas
a phantom entry could get a live process killed.

## The shim-free exemption, explicitly

`CLAUDE.md` requires engines to be driven shim-free. That rule is about **ACP
protocol shims** — processes that sit in the JSON-RPC path, translating,
buffering, or reinterpreting traffic — because those become a second
implementation of the protocol and a place for behaviour to diverge silently.

The supervisor is exempt because it is not in that path at all. It spawns the
engine with `stdio: 'inherit'`, so the engine writes to the very same pipes the
host created and would have used without a watchdog. Nothing in the supervisor
reads, parses, buffers, rewrites, or delays a protocol byte; it watches one
unrelated file descriptor for EOF and, on that signal, sends a signal. AC-1.4
holds it to that claim empirically: identical prompts against a deterministic
mock produce identical transcripts with and without the watchdog, comparing
`seq` and excluding only `ts`, the realm session id, and the engine-native
session id.

Should `@zed-industries/claude-code-acp` gain a stdin-EOF exit, this exemption
retires with it: the adapter drops `supervise` and the process disappears.

## Consequences

- A supervised engine costs one extra process. Only claude-code pays it, and
  only while a fix upstream is outstanding.
- The registry is shared across hosts and versions, so its line format is a
  compatibility surface; unreadable or unrecognised lines are skipped rather
  than treated as records to act on.
- The sweep starts at first acquisition, not at Hub construction: a Hub that is
  only inspected (`engines()`, `describe()`) never adopts another host's
  orphans, and killing processes on behalf of a host that never ran an engine
  would be surprising.
- A registry write failure is logged and ignored. Refusing to start an engine
  because bookkeeping failed would trade a possible future leak for a certain
  present outage.
- Windows has no `ps`, so identity can never be established there: every live
  entry is `unknown`, so the sweep neither kills nor prunes it. That is an
  honest no-op — entries for processes that have actually exited are still
  pruned, because pid liveness does not need `ps`. The watchdog half works; the
  reaping half is POSIX-only until a Windows identity source is added.

## Residual risks, accepted knowingly

- **TOCTOU between the identity check and the kill.** The checks read `ps`, then
  the reap signals; a process could exit and its pid be recycled inside that
  window. It cannot be closed portably without `pidfd` (Linux) or equivalent.
  The window is milliseconds and now requires a recycled pid to also match the
  recorded start time, so the exposure is far smaller than a command-line check alone would give —
  but it is not zero.
- **A racing append can be lost.** Compaction reads, filters, and renames; an
  append landing in between is dropped. Losing a record risks one leaked engine
  that a later host's sweep will not know about. The alternative failure — a
  torn or half-applied file — could authorise killing a live process, so this
  is the direction chosen deliberately.
- **A crash between writing the temporary file and renaming it** leaves a
  `*.tmp` beside the registry. Nothing collects those; they are inert and small,
  but they do accumulate for a host that repeatedly dies mid-compaction.
- **Killing the watchdog alone leaks its engine.** The registry records the
  watchdog's pid, so once it is gone the entry is pruned as stale while the
  engine — now reparented and outside any recorded group — keeps running. Host
  death does not cause this (the watchdog survives and does its job); only a
  signal aimed at the watchdog specifically does.
