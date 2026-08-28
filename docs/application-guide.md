# Using runskein in an application

The README's Quickstart creates a hub, runs one turn, and exits. A long-running
program has to decide how hubs and sessions map onto its own work. The short
answer:

> **One `Hub` per application. One `Session` per task, per engine.**

The rest of this page explains why, and what goes wrong otherwise.

## 1. One hub, created at startup

A hub keys engine processes by engine id, so **one hub means one process per
engine**, shared by every session it creates and shut down by reference
counting when the last session lets go.

A second hub does not share those processes. It starts its own, which doubles
cold starts and memory, and it either splits or fights over the transcript
directory that `hub.sessions()`, `attach()`, and resume read from. Create the
hub once and quit it once. Only a truly different setup — another transcript
store, another set of adapters — is worth a second hub. Permission policy is not
a reason: that is a per-session option.

```ts
import { createHub, jsonlStore, policies } from 'runskein';

const hub = createHub({
  store: jsonlStore('.transcripts'),
  defaults: { permissionPolicy: policies.denyAll, idleTimeoutMs: 30_000 },
});
```

## 2. One session per task, per engine

A session is one conversation. If you reuse one session for unrelated tasks,
each task's history leaks into the next, the transcript grows forever, and you
pay for that history in tokens on every turn until the context window — how much
the model can hold at one time — runs out. A session is also the unit of
transcript, resume, and `cancel()`: cancelling one task must not stop another.

A session is tied to one engine, so a task that uses two engines has two
sessions:

```ts
const planner = await hub.session({ engine: 'codex', cwd });
const worker = await hub.session({ engine: 'opencode', cwd });
```

runskein has no idea of a "task", so keep your own map. Resuming later needs
the exact `sessionId`, which runskein minted:

```ts
const task = { id: 'task-42', sessions: { codex: planner.id, opencode: worker.id } };
```

Two sessions share nothing. What one engine did is invisible to the other until
you pass it over; `hub.transcripts.digest(sessionId)` squeezes a transcript into
text a fresh session can read. (`session.fork()` does not help here — a fork
stays on the same engine.)

## 3. Run turns, and handle what comes back

```ts
const result = await session.prompt('Refactor src/parser.ts');
result.stopReason; // 'end_turn' | 'cancelled' | …
result.usage; // tokens for this turn, where the engine reports them
```

Cancelling is not an error. `session.cancel()` makes the running turn _finish_
with `stopReason: 'cancelled'`; only a prompt that never started rejects with
`CancelledError`. That is [decision 001](decisions/001-cancel-semantics.md), and
it exists so a cancelled turn still has a result you can read and record.

Real failures arrive as typed errors that carry what you need to act:

| Error                  | What it carries                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `UnauthenticatedError` | the exact login command for that engine                                                                          |
| `EngineCrashError`     | the last transcript sequence number that reached disk                                                            |
| `ConfigError`          | the values that would have been valid                                                                            |
| `NotSupportedError`    | the engine id and the capability that is missing                                                                 |
| `EngineOperationError` | `kind`, when the adapter could name the failure: `'rate-limit'`, `'context-exceeded'`, `'timeout'`, `'internal'` |

`kind: 'rate-limit'` is the one to branch on: it is a wait-and-retry, and it is
deliberately not an `UnauthenticatedError` — the engine is reachable and the
login is fine. An engine whose throttled wording has not been measured yet
reports no `kind` at all rather than a guess.

## 4. Configuration, and when a setting can be written

Model, mode, and how hard the model should think are written the same way on
every engine. runskein sends each key to whatever the engine actually calls
it:

```ts
const session = await hub.session({
  engine: 'claude-code',
  cwd: process.cwd(),
  config: { model: 'sonnet', reasoning: 'high' },
});
```

What differs between engines is not the call but **when** a key can be written,
and `describe()` says so for each option:

```ts
const { configOptions } = await hub.describe('claude-code');
configOptions.find((o) => o.id === 'reasoning')?.settable; // 'creation'
```

`settable: 'creation'` means the engine only accepts that setting while the
session is being built. `hub.session({ config })` carries it on the creation
request, and a later `setConfig()` refuses it with `NotSupportedError` instead
of sending a write the engine would ignore. No `settable` field means the normal
case: writable at creation and at any time after.

Two things follow. If you want no per-engine branching at all, do all your
configuration at creation — that path works the same on every engine. If you
want live controls in a UI, read `settable` to decide what to draw as a control
and what to draw as a one-time choice, rather than finding out from a failed
write.

## 5. Picking an engine at runtime

Three things can be true or false on a machine, and they are not the same thing:
the engine is installed, the user is logged in, and the engine supports the
feature you want. Check them separately.

```ts
const inventory = await hub.engines(); // cheap; starts no process
const usable = inventory.filter((e) => e.health !== 'invalid' && e.installed && e.authenticated !== false);

const descriptor = await hub.describe('codex'); // starts the engine and asks it
if (!descriptor.capabilities.session.fork) {
  // Pick another flow, or handle NotSupportedError from session.fork().
}
```

`describe()` starts a process, so cache the descriptor if a UI renders it
repeatedly. Capability discovery is a preflight, not a replacement for error
handling: an engine update can still make a call fail, so handle
`NotSupportedError` at the call site too.

## 6. Long gaps between calls

An open session pins its engine process. `idleTimeoutMs` only starts counting
once no session holds the engine, so a session left open across a long pause
keeps every engine it touched alive for the whole pause, and the idle cleanup
never runs.

For bursty work — short bursts, long waits — close the session at the end of a
burst and resume it by id in the next one:

```ts
await session.close();
// ... long gap; engine processes can now be cleaned up ...
const resumed = await hub.session({ engine: 'codex', cwd, resume: task.sessions.codex });
```

All bundled engines resume natively today, so this is a quick round trip, not a
replay of the whole history. `session.resumeTier` tells you which path was
actually used.

Set `idleTimeoutMs` against your own gap pattern: well below the gap to let
processes actually be reclaimed, or above it to keep them warm for reuse.

## 7. Concurrency is per engine, and nothing queues

Every session on one engine shares that engine's single process and single stdio
pipe, and one hub cannot hold two processes for the same engine. Setup-class
requests — creating, resuming, forking, closing a session, writing config —
time out after 30 seconds, which heavy parallel load can genuinely exceed: the
live test suite hits it when several engines start at once. A turn is not
bounded by that, or by anything, unless you set `defaults.turnTimeoutMs`; a
legitimate turn can run for many minutes, so runskein does not invent a ceiling
for it.

runskein does not queue for you, so if you fan out, cap your own concurrency
per engine. Work spread across _different_ engines runs on separate processes
and does not compete.

pi is the one exception on the model side: its shim runs one `pi` child per
session, because a pi process holds exactly one session. The ACP pipe is still
single.

## 8. Shutdown

```ts
await hub.quit();
```

`quit()` walks a bounded chain per engine — close stdin, `SIGTERM`, wait,
`SIGKILL` — and signals the whole process group, so wrapper scripts and their
children go too. Call it on every exit path.

A host killed with `SIGKILL` cannot run it at all. Engines that do not exit when
their pipe closes are left behind — and runskein reclaims them itself: the next
run's first engine acquisition sweeps the ownership registry for processes its
own hosts left behind, and a periodic sweep follows. The sweep is tied to
acquisition rather than to startup on purpose, so a program that only inspects
(`engines()`, `describe()`) never reaps anything. Of the bundled engines only
claude-code survives its host's `SIGKILL`, which is why only it is launched
behind a watchdog.

## Testing your application without an engine

Depending on runskein should not mean your CI needs engine binaries, logins,
and paid model tokens. `@runskein/testkit` ships a scripted agent that speaks
the protocol and replies with whatever your test asks for, so the code path
under test is the real one.

```ts
import { createHub, jsonlStore } from 'runskein';
import { scriptedAdapter } from '@runskein/testkit';

const hub = createHub({
  // The five built-ins stay registered — `adapters` adds to them rather than
  // replacing them, and `discovery: false` (the default) governs only dynamic
  // scanning. Selecting `engine: 'scripted'` below is what keeps this hermetic.
  discovery: false,
  adapters: [scriptedAdapter({ env: { RUNSKEIN_TESTKIT_ASK_PERMISSION: '1' } })],
  store: jsonlStore('.transcripts'),
});

const session = await hub.session({ engine: 'scripted', cwd: process.cwd() });
await session.prompt('hello'); // asks for permission, then ends the turn
```

The `RUNSKEIN_TESTKIT_*` switches are documented in
[that package's README](../packages/testkit/README.md), along with what it does
_not_ promise — reply strings and ids may change between versions. Keep real
engines for the tests that truly need them.

## See also

- [Architecture](architecture.md) — what runs where, and why
- [Engine support](engine-support.md) — what each engine can do
- [Transcript folding](transcript-fold.md) — turning a transcript into UI state
- [API specification](engine-adapter-api.md) — the frozen surface
