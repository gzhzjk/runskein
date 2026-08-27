# runskein

**One API for five coding agents.**

runskein lets one TypeScript program drive OpenCode, Kimi Code, Claude Code,
Codex, and pi through the same calls. It starts and stops the agent processes,
keeps one conversation per session, and saves everything the agent said to a
transcript you own.

runskein is a **runtime layer, not an orchestrator**. It runs the agents. It
does not decide which agent gets which task, cap what they spend, or keep them
out of each other's files — that is your program's job, or the job of a layer
you build on top.

> **Status: preview.** The current release is `0.1.0-alpha.24`. The API is good
> enough to build against and evaluate, but it is not yet a promise to stay
> compatible. What an engine can do also depends on the version installed on the
> machine — check the [measured matrix](docs/conformance/matrix.public.json) before you
> depend on a feature.

Without runskein:

```ts
if (engine === 'codex') {
  /* spawn it, handshake, its resume, its config keys */
} else if (engine === 'claude-code') {
  /* all of it again, differently */
} else if (engine === 'opencode') {
  /* and again */
}
```

With runskein:

```ts
const session = await hub.session({ engine: 'codex', cwd });
await session.prompt('Fix the failing tests.');
```

## Why runskein?

Each engine runs as a child process. runskein talks to it over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) — four of the
five engines speak it directly, and pi is driven through a small translator
process instead.

ACP defines how one client talks to one agent. runskein handles the parts ACP
leaves to the application:

- starting and stopping agent processes
- one API across engines that differ
- saved transcripts and resume
- permissions and typed errors
- filling some capability gaps, so nothing fails silently

You never see ACP. The public types are runskein's own, so you do not import
the ACP SDK and you do not think about the wire. See
[runskein vs ACP](docs/runskein-vs-acp.md) for the full comparison.

## Quickstart

### Install

**Nothing is on npmjs yet.** The first release has not been promoted, so build
from a clone for now:

```bash
git clone https://github.com/gzhzjk/runskein.git
cd runskein && pnpm install --frozen-lockfile && pnpm build
```

Once the first release lands, the install is:

```bash
npm install runskein@alpha        # or: pnpm add runskein@alpha
```

`runskein` is the package you want: it bundles all five engine adapters, so this
is the only line most applications need.

**`@alpha` will not be optional.** A bare package name resolves the `latest`
tag, and no prerelease will carry it — `latest` currently points at a
name-reservation placeholder with no code in it, so dropping `@alpha` installs
an empty package rather than failing. The same goes for `@runskein/core@alpha`
and the rest, if you reach for one directly.

Node.js 22 or newer, ESM only. Installing this installs no engine — runskein
finds engines already on your `PATH`.

### First run

```ts
import { createHub, policies } from 'runskein';

const hub = createHub();

const session = await hub.session({
  engine: 'opencode',
  cwd: process.cwd(),
  permissionPolicy: policies.allowAll,
});

session.on('update', (event) => {
  const update = event.update;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    process.stdout.write(update.content.text);
  }
});

const result = await session.prompt('Summarize this repository.');
console.log(`\nstop reason: ${result.stopReason}`);

await session.close();
await hub.quit();
```

Transcripts land in `.transcripts/`. The session's `cwd` is also the directory
the engine works in.

## Supported engines

| Engine      | Supported | Resume | Fork | Images |
| ----------- | --------- | ------ | ---- | ------ |
| OpenCode    | ✓         | ✓      | ✓    | ✓      |
| Kimi Code   | ✓         | ✓      | ✓    | ✓      |
| Claude Code | ✓         | ✓      | ✓    | ✓      |
| Codex       | ✓         | ✓      | —    | ✓      |
| pi          | ✓         | ✓      | ✓    | —      |

Session lists, deletion, MCP transports, provider discovery, token usage, and
the engine versions these were measured against are in
[engine support](docs/engine-support.md), with the measured values in
[`docs/conformance/matrix.public.json`](docs/conformance/matrix.public.json).

A new engine is added as an adapter, not as a change to runskein — see
[Adding an engine](#adding-an-engine).

## Core concepts

```text
your application
      ↓
runskein public API
      ↓
core
      ↓
ACP client
      ↓
agent processes
```

**Hub** — the thing you create once, at startup. It finds engines, starts and
stops their processes, and creates sessions. One hub keeps one process per
engine and shuts them down for you, so use one hub for the whole application.

**Session** — one conversation with one engine. You prompt it, cancel it, close
it, and resume it later by its id. Sessions never share context: what one engine
did is invisible to another until you pass it over.

**Transcript** — every event from the agent, saved as it happens. runskein
treats the saved transcript as the source of truth for session history and
resume. It does not rely on the engine to keep that data. Turning a transcript
into something you can draw is
[`runskein/fold`](docs/transcript-fold.md), which is optional and
separate.

**Capabilities** — engines differ, so runskein handles a feature in one of
three ways: required, engine-specific, or emulated. A missing feature never
fails silently; you get a typed error naming the engine and the capability. The
details are in [Architecture](docs/architecture.md).

## Common patterns

**One Hub per application.** A second hub starts its own processes and either
splits or fights over the same transcript directory.

**One Session per task, per engine.** Reusing a session leaks one task's history
into the next and grows the transcript forever. A task that uses two engines has
two sessions.

**Bound your own concurrency.** One engine is one process and one pipe, and
runskein does not queue for you. If you fan out, cap the work per engine.
Different engines run on separate processes and do not compete.

The full path — from creating a hub to shutting it down, with idle gaps,
configuration, and error handling — is in
[the application guide](docs/application-guide.md).

## Adding an engine

An adapter answers one question:

**How do I start a process that speaks ACP?**

A basic adapter is a small directory holding its launch command, its detection
logic, and its metadata:

```text
adapters/<engine-id>/
├── package.json      runskein: { "adapter": true, "specVersion": 1 }
├── index.mjs         default export: the EngineAdapter
├── index.d.ts        types for static imports
└── conformance.json  written by the probe below; committed as evidence
```

Everything else — sessions, events, permissions, resume, process supervision —
is core's, identically for every engine. See
[the adapter guide](docs/adapter-guide.md).

## Packages

| Package             | What it is                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| `runskein`          | what you install; bundles the five engine adapters                              |
| `@runskein/core`    | Hub, Session, transcript stores, permissions, types                             |
| `@runskein/fold`    | turns a transcript into state you can render; also reachable as `runskein/fold` |
| `@runskein/testkit` | a scripted agent, so your tests need no engine                                  |
| `adapters/*`        | per-engine launch and detection details                                         |

`packages/cli` and `packages/conformance` are development tools and are not
published.

## Limitations

- **The public API does not expose ACP directly.** If runskein has not
  modelled an ACP feature, you may need the low-level `_meta` escape hatch.
- **One engine, one process, one pipe.** runskein does not queue.
- **Capability data is a snapshot** of the engine versions it was measured
  against, not every future release.
- **Scheduling, budgets, and workspace isolation are not here** — see the
  runtime-layer boundary above. The rule is about reach: what needs the process
  handle or the ACP connection lives here, what is expressible as `prompt()`
  plus reading its results belongs to the layer above.
  [Architecture](docs/architecture.md) draws the line.
- **No configuration through environment variables.** Everything is passed to
  `createHub()` and `hub.session()`.
- **No batch CLI and no transcript browser.** The CLI is for interactive
  checking during development.
- **The measured tables age.** They record one probe run against one version
  of each engine; `hub.engines()` and `hub.describe()` are what your machine
  actually has.

## Documentation

|                                                 |                                      |
| ----------------------------------------------- | ------------------------------------ |
| [Application guide](docs/application-guide.md)  | using runskein in a real program     |
| [Architecture](docs/architecture.md)            | what runs where, and why             |
| [Adapter guide](docs/adapter-guide.md)          | adding an engine, step by step       |
| [Transcripts and fold](docs/transcript-fold.md) | rendering a session                  |
| [Engine support](docs/engine-support.md)        | what each engine can do              |
| [Capability matrix](docs/capability-matrix.md)  | tier by tier, engine by engine       |
| [CLI](docs/cli.md)                              | driving it from a terminal           |
| [runskein vs ACP](docs/runskein-vs-acp.md)      | the full comparison                  |
| [API specification](docs/engine-adapter-api.md) | the frozen surface                   |
| [Versioning](docs/versioning.md)                | what a version number means          |
| [Contributing](CONTRIBUTING.md)                 | the gates, and what a change carries |

## Contributing

Work inside the package or adapter that owns the change, keep the frozen API
contract intact, and add or update tests for any behaviour change.
[CONTRIBUTING.md](CONTRIBUTING.md) is the full contract: the gates, what is
frozen, and how documentation and licensing travel with a change.

```bash
pnpm install --frozen-lockfile     # Node 22+, pnpm 9.15.9

pnpm quality      # repo invariants: import boundaries, licences, generated files
pnpm typecheck    # tsc --noEmit across packages
pnpm test         # vitest
pnpm build        # required — see below
pnpm conformance  # adapter gate, no engine needed
```

`pnpm build` is not optional, and not only for the output. `tsc --noEmit` never
exercises declaration output, and the build is also what copies path-loaded
assets into `dist` and then checks the built code can still find them. A
watchdog once went missing from a published package precisely because nothing
checked.

If you touched an adapter, also run the gate against the real engine, which
needs that engine installed and logged in:

```bash
pnpm conformance opencode
cd packages/conformance && pnpm probe opencode   # refresh measured capabilities
```

### The CLI, while developing

The fastest way to see real behaviour without writing a program:

```bash
pnpm --filter @runskein/cli dev engines                  # what is installed here
pnpm --filter @runskein/cli dev describe opencode        # what this engine can do
pnpm --filter @runskein/cli dev chat opencode --cwd .    # an interactive session
```

`chat` takes `--permission allow-all|deny-all|ask`, `--resume <sessionId>`, and
repeatable `-c key=value` engine settings. Inside the session, `:cancel`,
`:config key=value`, `:fork`, `:status`, and `:quit` work. The full list is in
[the CLI reference](docs/cli.md).

Engine logins, when you need live runs: `opencode auth login`, `kimi acp
--login`, `claude /login`, and Codex through ChatGPT login or an API key.

[The API specification](docs/engine-adapter-api.md) is the frozen public
contract and the code follows it, not the other way round. Changing that
surface needs a numbered record in [`docs/decisions/`](docs/decisions/),
landing in the same change as the code.
