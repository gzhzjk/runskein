# Architecture

This page explains what runs where, and why. For the frozen type surface see
[the API specification](engine-adapter-api.md); for what each engine was
measured to support, [the capability matrix](capability-matrix.md).

## The layers

<p align="center">
  <img src="assets/runskein-layers.svg" width="900"
       alt="Your application calls the runskein public API (Hub, Session, typed errors, optional runskein/fold). Beneath it, engine-agnostic core holds sessions, permissions, resume, the transcript store and the process manager. Beneath that, an internal-only ACP client speaks JSON-RPC over stdio to opencode, kimi, claude-code and codex directly, and to pi through a shim translating ACP to pi's JSONL.">
</p>

The same shape in text, which is what a diff and a screen reader can follow:

```text
        your application
               │
               ▼
┌──────────────────────────────────┐
│  runskein public API             │  Hub, Session, typed errors
│  (runskein's own types)          │  runskein/fold (optional)
├──────────────────────────────────┤
│  core                            │  sessions, permissions, resume,
│  engine-agnostic                 │  transcript store, process manager
├──────────────────────────────────┤
│  ACP client (internal only)      │  JSON-RPC over stdio
└──────────────────────────────────┘
        │        │        │        │
        ▼        ▼        ▼        ▼
   opencode    kimi   claude-code  codex      ← speak ACP directly
                                     pi       ← shim translates to pi's JSONL
```

Two rules hold this shape together:

- **Core never imports from `adapters/*`.** An adapter is data core reads, not
  code core calls into.
- **Only `packages/core/src/acp/` and the shim entry points may import the ACP
  SDK.** Nothing a consumer can reach does, which is what lets the public types
  stay runskein's own.

## One turn, end to end

```text
session.prompt("…")
      │
      ▼
  core sends the prompt over ACP
      │
      ├──► engine asks to run a command
      │        │
      │        ▼
      │    permission policy decides → allow / deny / ask you
      │
      ├──► engine streams text and tool updates
      │        │
      │        ├──► transcript store  {seq, ts, sessionId, engineId, update, usage?}
      │        └──► session.on('update')  → your code, or fold → your UI
      │
      ▼
  turn ends → TurnResult { stopReason, usage }
```

Every event is saved before you see it.

## The transcript is runskein's, the vocabulary is ACP's

Each event is wrapped in runskein's own envelope:

```text
{ seq, ts, sessionId, engineId, update, usage? }
```

`update` is the ACP `SessionUpdate` shape, unchanged. There is deliberately no
second event vocabulary to learn or to keep in sync. `usage` is runskein's own
type, because ACP's is unstable.

**The local store is the authority.** Session lists and resume answer from your
own transcript store, and the engine's own state is only a cross-check. Engines
forget, delete, and run on other machines; your disk does not.

## Three kinds of capability

Every feature sits in one of three tiers, and nothing ever fails silently:

```text
Core       must work on every engine      → call it; the registration gate
                                            blocks any adapter that fails it
Negotiated works only if the engine says   → check hub.describe() first, or
           it can                            catch NotSupportedError
Emulated   runskein fills the gap        → call it; the result tells you
                                             which path was taken
```

A missing capability is a branch your code can take, not a call that quietly did
nothing. Which engine advertises what is measured, not declared —
[engine support](engine-support.md) has the table, and
[`conformance/matrix.public.json`](conformance/matrix.public.json) has the
measured values it is drawn from.

### Resume, the clearest emulated capability

runskein tries three things in order and reports the winner in
`session.resumeTier`:

```text
native session/resume  ──absent──►  session/load  ──absent──►  rebuild from
                                                               transcript digest
```

The runskein `sessionId` stays the same across all three, so a caller that stored
an id can always resume with it, whatever the engine can do.

## Processes

One hub keys engine processes by engine id: **one hub, one process per engine**,
shared by every session and released by reference counting. `idleTimeoutMs`
starts counting only once no session holds the engine.

Two details are here because they were measured, not imagined:

- **Environment scrubbing.** Child processes are spawned with the host's
  session markers removed. Launching an engine from inside a Claude Code
  session otherwise leaks markers that make the Claude Code ACP wrapper refuse
  to start with "active session". Which markers go is each adapter's own
  declaration — `CLAUDE*` by claude-code, `CODEX_SANDBOX*` by codex,
  `OPENCODE_SESSION*`/`OPENCODE_CALLER*` by opencode, its own by pi — so the
  scrub applies to the engine whose marker it is and not to the others
  (decision 045).
- **Orphan reaping.** No bundled engine currently outlives its host's
  `SIGKILL` — claude-code did until its wrapper was replaced, which is why the
  parent-death watchdog exists at all. The mechanism stays, declared per adapter
  with `supervise`, because whether an engine cleans itself up is a property of
  that engine's current release and not a permanent fact about it.

None of this is reachable from above: a host has no pids, no reference counts,
and no backoff timers.

## Adapters are data

An adapter answers one question — how do I start a process that speaks the
protocol? — and is declarative data plus at most a `detect()` probe. Session
lifecycle, event mapping, permissions, resume, and process supervision belong to
core, identically for every engine. Adapters do not declare capabilities either:
those are measured from the engine's own answers at runtime.

Adapters reach the hub three ways: the bundled ones are imported by the
`runskein` meta-package, directory discovery finds the rest by the
`runskein.adapter` marker in their `package.json`, and a host may pass adapter
objects itself. However one arrives, it is checked against a schema and
isolated on failure: a broken adapter is reported as `health: 'invalid'` and
does not take the hub down.

The walk-through is [the adapter guide](adapter-guide.md).

## Engines that do not speak ACP

pi speaks no ACP. It is driven through an out-of-process shim
(`adapters/pi/shim.mjs`) that translates ACP to pi's own JSONL RPC. The shim
sits on the far side of the wire, so it may import the ACP SDK where consumer
code may not, and in your code `engine: 'pi'` reads exactly like
`engine: 'codex'`. See
[decision 028](decisions/028-non-acp-engines-via-shim.md).

## Packages

```text
packages/runskein   what consumers install; bundles the built-in adapters
packages/core         Hub, Session, transcript stores, permissions, types
adapters/*            per-engine detection and launch details (data)
packages/fold         turns transcripts into UI state (consumer-side)
packages/testkit      scripted agent for consumers' own tests
packages/conformance  the adapter and transcript test suites
packages/cli          terminal tool for development and checking
```

`cli` and `conformance` are development tools and are not published. The other
four plus the five adapters release together, on one version line: a given
release is the same version across every package, so there is no compatibility
matrix between them to reason about.

## Where the line is drawn

Scheduling, budgets, arbitration between agents, and workspace isolation are the
job of the layer above runskein, by design. The rule that decides which side a
feature falls on is about **reach**, not importance:

- **Inside runskein: anything that needs the process handle or the ACP
  connection.** Orphan reaping, in-flight request control, idle release of
  engine references, re-applying configuration on resume, crash recovery,
  error classification, and passing quota and authentication signals through.
  A host above cannot see pids, refcounts, backoff timers or wire errors, so
  none of this can live there.
- **Outside: anything expressible as `prompt()` plus reading its results.**
  Worktree isolation — measured, every bundled engine honours a per-session
  cwd — task and DAG state, retry and arbitration policy, budget gates fed by
  the signals runskein passes through, approval policy, and cross-task
  scheduling.

Two exceptions are worth naming because they are not symmetric. Container
isolation cannot be done above runskein: the spawn belongs to this layer, so
it would need a launcher hook here. And when policy moves out, this layer's
remaining duty is **signal quality** — which is why `EngineOperationError`
splits by cause rather than reporting one opaque failure.
