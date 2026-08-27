# 029 - realm runs terminals for engines that delegate command execution

Date: 2026-08-20 · Status: **accepted** · Cases: terminal.test.ts (10 cases),
probe `commandExecution` · Informs: the conversation-features and
out-of-scope capability tables; api §5

## Context

ACP lets an agent execute commands **through its client**: `terminal/create`,
`terminal/output`, `terminal/wait_for_exit`, `terminal/kill`,
`terminal/release`, gated on a `terminal` client capability. realm declined
that capability and never implemented the methods, on the recorded grounds that
"codex runs terminals agent-side; others degrade gracefully".

That premise expired. kimi 0.37.2 moved command execution onto the client, and
under realm every command tool fails with

```
ACP terminal capability is unavailable
```

before any decision is made — no permission request, no tool output, nothing a
consumer can act on. Reported by realm-plugin with a reproduction, repeated
here against kimi 0.37.2 and confirmed at the byte level: the engine's binary
contains that string and gates on `terminalEnabled`.

Two things made this worse than a missing feature. It is a **silent**
degradation, which contradicts the one thing realm claims about itself. And it
was **invisible to our own gate**: the Core gate and the probe ask for a reply
with no tools, so kimi passed everything while being unable to run a command.

## Decision

**1. realm implements the five client terminal methods and declares the
capability.** The declaration follows the wiring — `terminal` is `true` exactly
when a handler set is installed — so an engine is never told the client can run
commands it cannot.

**2. Every terminal goes through the session's PermissionPolicy.** Running a
command for the agent is realm executing what a model asked for, which is what
the permission mechanism exists to govern. The request arrives as
`tool: 'terminal'`, `kind: 'execute'`, with `{command, args, cwd}` as input and
the resolved cwd as its location, so existing rule tables match it without
learning a new vocabulary. A refusal means the process is never spawned.

**3. The session's cwd is a ceiling, not a default.** A relative cwd resolves
inside it; an absolute one must be within it; anything else is refused with a
reason the agent can report. The host set that boundary and the agent may
narrow it, never move it.

**4. Terminals die with their session.** `close()` releases every terminal it
opened, killing the process group — a command started for an agent has no other
owner.

**5. Failures reach the agent with their reason.** A refused permission and an
escaping cwd come back as invalid-params errors carrying the message, not as a
generic internal error.

**6. The probe measures command execution.** Every probe run now asks the
engine to read a marker file through its own tools and records
`commandExecution: { ok, usedClientTerminal, detail }` in the matrix. This is
the check that would have caught the regression: no engine advertises whether
it delegates, so the only way to know is to make it run something.

## Rationale

Declining a client capability is not neutral. It reads like a scope decision
and behaves like a compatibility decision: it silently partitions engines into
ones that work and ones that do not, and the partition moves when an engine
ships a release. realm exists to be honest about engine difference; a substrate
that cannot run kimi's commands, and does not say so, fails at exactly that.

The alternative considered was to keep terminals out of scope and surface the
gap in the descriptor. It is strictly better than the status quo, and still
leaves the engine unable to work. Since the capability is squarely realm's kind
of duty — it needs the process handle, which is L1 by the boundary rule in
`docs/vision.md` — implementing it is the answer, and the visibility work is
worth doing anyway for whatever the next unadvertised divergence turns out to
be.

## Consequences

- Engines that delegate execution work under realm; verified live: kimi runs
  `cat marker.txt` and answers from its output.
- The measurement immediately paid for itself, and then corrected itself. The
  probe shows **claude-code also uses client terminals** when they are offered
  (`usedClientTerminal: true`), while opencode, codex and pi run commands in
  their own process. But _using_ is not _requiring_: driven with the terminal
  capability declined — the old behaviour, measured deliberately — claude-code
  falls back to executing in its own process and answers correctly. kimi is
  still the only engine that breaks without this. So: two of five delegate, one
  of five depends on it, and `usedClientTerminal` in the matrix means the first
  of those, not the second.
- **Behaviour change for existing consumers.** For an engine that delegates,
  command execution moves out of the engine's process and into realm's, which
  means it now passes through the permission policy. A host running
  `policies.denyAll` will see claude-code commands refused that previously ran
  unseen. That is the mechanism working — the policy is supposed to govern what
  the model executes — but it is a change, and a host that wants the old
  behaviour for a specific engine has to allow `tool: 'terminal'` explicitly.
- realm now spawns processes it did not previously spawn. Env scrubbing, cwd
  containment, process-group kills and session-scoped cleanup all apply, and
  the permission policy is on the path — a host that wants none of it can deny
  `tool: 'terminal'` and be back to the previous behaviour, explicitly.
- A `SessionTerminals` instance exists per session with terminals; it is
  internal, and only `@realm-node/core/internal` exposes it (the probe uses it
  without a Session).
- The capability tables no longer claim other engines degrade
  gracefully, because they do not.

## Amendment (2026-08-21) — what the policy sees, and what the boundary means

A review of the shipped path found both guards decided less than they read as
deciding. Two corrections, neither changing the public surface:

**The environment is part of the authorisation.** The request presented to the
policy carried `{command, args, cwd}` while `env` was copied into the child
after the decision, over the scrubbed environment. A host allowing `git status`
was therefore allowing a name: the same request could supply `PATH`,
`NODE_OPTIONS`, `LD_PRELOAD` or `GIT_SSH_COMMAND` and decide which program that
name ran, or what it loaded. `env` is now validated first and included in
`PermissionRequest.input`, and the variables that select or inject a program are
refused outright — before the policy is asked, since "may I run git under a PATH
I chose" is not a question a rule table can answer usefully. The host's own
scrub list is refused too: an agent may not restore the session markers that
scrubbing exists to remove. Everything else passes through and is visible to
the policy. Rule tables match a glob over the stringified input, so env values
now join args as text a rule can match on; what keeps that from becoming an
execution decision is the deny list, not the rule.

**Containment is decided on resolved paths.** The cwd check compared spellings,
which a symlink inside the session defeats: `escape -> /somewhere/else` reads as
a session-relative path and runs outside the boundary. The check now also
compares the real paths of the session cwd and the target, and a cwd that does
not exist is refused with that reason rather than passed to spawn — there is
nothing for containment to be true about. The path the command runs in is still
the one the agent named, so policy rules and locations are unchanged.
