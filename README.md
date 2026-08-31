# runskein

[![CI](https://github.com/gzhzjk/runskein/actions/workflows/ci.yml/badge.svg)](https://github.com/gzhzjk/runskein/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/runskein)](https://www.npmjs.com/package/runskein)
[![License](https://img.shields.io/npm/l/runskein)](LICENSE)

<p align="center">
  <b>English</b> | <a href="README.zh-CN.md">简体中文</a>
</p>

**One API for five coding agents.**

<p align="center">
  <img src="docs/assets/runskein-overview.svg" width="960"
       alt="Your TypeScript program calls one runskein API; runskein handles session lifecycle, typed errors, the transcript store and permission control, and drives OpenCode, Kimi Code, Claude Code, Codex and pi as child processes.">
</p>

Build a CLI, a developer tool, or a multi-agent application that switches between OpenCode,
Kimi Code, Claude Code, Codex and pi — without maintaining five separate integrations for
process lifecycle, sessions, and transcripts.

runskein runs the agents. It does not decide which agent gets which task, cap what they spend,
or keep them out of each other's files: it is a **runtime layer, not an orchestrator**.

`0.1.1` · Node.js 22+ · ESM only · still `0.x`, so behaviour can change — [what a version means](docs/versioning.md)

## Quickstart

### What you need

- **Node.js 22 or newer.**
- **One coding agent, installed and logged in.** runskein installs no engine; it finds what is
  already on your `PATH`:

| Agent       | Log in with                                                            |
| ----------- | ---------------------------------------------------------------------- |
| OpenCode    | `opencode auth login`                                                  |
| Kimi Code   | `kimi acp --login`                                                     |
| Claude Code | `claude auth login`                                                    |
| Codex       | `codex login` — ChatGPT or an API key                                  |
| pi          | configure a provider, then check it: `pi auth check --provider <name>` |

### Three minutes

```bash
mkdir runskein-demo && cd runskein-demo
npm init -y
npm install runskein
# save the code below as demo.mjs
node demo.mjs
```

```js
import { createHub, policies, UnauthenticatedError } from 'runskein';

const hub = createHub();

// Which agents are on this machine? Cheap — it never starts one.
const engines = await hub.engines();
const usable = engines.filter((e) => e.installed && e.health !== 'invalid' && e.authenticated !== false);
// Some agents cannot report their login state, so `authenticated` is undefined
// for them. Take one that says it is logged in before one that cannot say.
const engine = usable.find((e) => e.authenticated === true)?.id ?? usable[0]?.id;
if (!engine) {
  console.error('No coding agent found. Install one and log in, then run this again.');
  process.exit(1);
}
console.log(`using ${engine}`);

const session = await hub.session({
  engine,
  cwd: process.cwd(),
  // Demo only: approves every permission request. cwd is not a sandbox.
  permissionPolicy: policies.allowAll,
});

// The agent's reply arrives as it is written.
session.on('update', (event) => {
  const update = event.update;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    process.stdout.write(update.content.text);
  }
});

try {
  const result = await session.prompt('Read package.json here and tell me the package name.');
  console.log(`\n\nstop reason: ${result.stopReason}`);
} catch (error) {
  // The one failure a first run really hits: installed, but not logged in.
  if (!(error instanceof UnauthenticatedError)) throw error;
  console.error(`\n${engine} is not logged in — try: ${error.loginHint ?? 'its login command'}`);
} finally {
  await session.close();
  await hub.quit();
}
```

On a machine that is already set up, the output should look roughly like this — whichever
agent you have will word the answer differently:

```text
using codex
I’ll inspect the local `package.json` and report its package name.The package name is `runskein-demo`.

stop reason: end_turn
```

The turn is now on disk in `.transcripts/`, a JSONL file per session, yours to read, render or
resume from. The same script is [`examples/hello-world.mjs`](examples/hello-world.mjs).

> **Run your first experiment in a directory you can throw away, or in a sandbox.**
> `policies.allowAll` is runskein's default, and it approves every permission request the agent
> makes. `cwd` sets where the agent works; it does not confine what it can reach on disk, and
> runskein provides no workspace isolation. `policies.denyAll` denies every permission request
> and `policies.rules([...])` decides per tool — their full shape is in
> [the API specification](docs/engine-adapter-api.md).

## What you can build

- **A switchable agent backend inside your own tool.** One code path drives all five engines,
  so the engine becomes a setting rather than a branch.
- **Sessions you can save, resume and show.** The transcript is a file you own, and
  [`runskein/fold`](docs/transcript-fold.md) turns it into state a user interface can draw.
- **Several agents over one repository.** One designs, one codes, one reviews — separate
  sessions, separate processes, one transcript format — under an orchestrator you write.

## Why runskein?

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

Each engine runs as a child process. runskein talks to it over the
[Agent Client Protocol (ACP)](https://agentclientprotocol.com) — four of the five engines speak
it directly, and pi is driven through a small translator process instead.

ACP defines how one client talks to one agent. runskein handles the parts ACP leaves to the
application:

- starting and stopping agent processes
- one API across engines that differ
- saved transcripts and resume
- permissions and typed errors
- filling some capability gaps, so nothing fails silently

You never see ACP. The public types are runskein's own, so you do not import the ACP SDK and you
do not think about the wire. See [runskein vs ACP](docs/runskein-vs-acp.md) for the full
comparison.

## Supported engines

| Engine      | Supported | Resume | Fork | Images |
| ----------- | --------- | ------ | ---- | ------ |
| OpenCode    | ✓         | ✓      | ✓    | ✓      |
| Kimi Code   | ✓         | ✓      | ✓    | ✓      |
| Claude Code | ✓         | ✓      | ✓    | ✓      |
| Codex       | ✓         | ✓      | —    | ✓      |
| pi          | ✓         | ✓      | ✓    | —      |

Session lists, deletion, MCP transports, provider discovery, token usage, and the engine
versions these were measured against are in [engine support](docs/engine-support.md), with the
measured values in
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

**Hub** — the thing you create once, at startup. It finds engines, starts and stops their
processes, and creates sessions. One hub keeps one process per engine and shuts them down for
you, so use one hub for the whole application.

**Session** — one conversation with one engine. You prompt it, cancel it, close it, and resume
it later by its id. Sessions never share context: what one engine did is invisible to another
until you pass it over.

**Transcript** — every event from the agent, saved as it happens. runskein treats the saved
transcript as the source of truth for session history and resume. It does not rely on the
engine to keep that data. Turning a transcript into something you can draw is
[`runskein/fold`](docs/transcript-fold.md), which is optional and separate.

**Capabilities** — engines differ, so runskein handles a feature in one of three ways:
required, engine-specific, or emulated. A missing feature never fails silently; you get a typed
error naming the engine and the capability. The details are in
[Architecture](docs/architecture.md).

## Common patterns

**One Hub per application.** A second hub starts its own processes and either splits or fights
over the same transcript directory.

**One Session per task, per engine.** Reusing a session leaks one task's history into the next
and grows the transcript forever. A task that uses two engines has two sessions.

**Bound your own concurrency.** One engine is one process and one pipe, and runskein does not
queue for you. If you fan out, cap the work per engine. Different engines run in separate
processes over separate pipes, but they still share the machine, and the workspace whenever you
point them at one directory.

The full path — from creating a hub to shutting it down, with idle gaps, configuration, and
error handling — is in [the application guide](docs/application-guide.md).

## Adding an engine

An adapter answers one question:

**How do I start a process that speaks ACP?**

A basic adapter is a small directory holding its launch command, its detection logic, and its
metadata:

```text
adapters/<engine-id>/
├── package.json      runskein: { "adapter": true, "specVersion": 1 }
├── index.mjs         default export: the EngineAdapter
├── index.d.ts        types for static imports
└── conformance.json  written by the probe below; committed as evidence
```

Everything else — sessions, events, permissions, resume, process supervision — is core's,
identically for every engine. See [the adapter guide](docs/adapter-guide.md).

## Packages

| Package             | What it is                                                                      |
| ------------------- | ------------------------------------------------------------------------------- |
| `runskein`          | what you install; bundles the five engine adapters                              |
| `@runskein/core`    | Hub, Session, transcript stores, permissions, types                             |
| `@runskein/fold`    | turns a transcript into state you can render; also reachable as `runskein/fold` |
| `@runskein/testkit` | a scripted agent, so your tests need no engine                                  |
| `adapters/*`        | per-engine launch and detection details                                         |

`packages/cli` and `packages/conformance` are development tools and are not published.

## Limitations

- **The public API does not expose ACP directly.** If runskein has not modelled an ACP feature,
  you may need the low-level `_meta` escape hatch.
- **One engine, one process, one pipe.** runskein does not queue.
- **Capability data is a snapshot** of the engine versions it was measured against, not every
  future release.
- **Scheduling, budgets, and workspace isolation are not here** — see the runtime-layer
  boundary above. The rule is about reach: what needs the process handle or the ACP connection
  lives here, what is expressible as `prompt()` plus reading its results belongs to the layer
  above. [Architecture](docs/architecture.md) draws the line.
- **No configuration through environment variables.** Everything is passed to `createHub()` and
  `hub.session()`.
- **No batch CLI and no transcript browser.** The CLI is for interactive checking during
  development.
- **The measured tables age.** They record one probe run against one version of each engine;
  `hub.engines()` and `hub.describe()` are what your machine actually has.

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

## Feedback

Trying runskein for the first time? Tell the maintainers how it went —
[open an issue](https://github.com/gzhzjk/runskein/issues):

- **It would not start.** Paste the error, plus your Node and runskein versions.
- **An engine behaved differently from the table above.** Name the engine and its version.
  Capabilities are measured per engine version, so a report without one cannot be reproduced.
- **You built something with it.** What you are making is the most useful thing to hear.

A security problem goes privately instead: [SECURITY.md](SECURITY.md) says how.

## Contributing

Work inside the package or adapter that owns the change, keep the frozen API contract intact,
and add or update tests for any behaviour change. [CONTRIBUTING.md](CONTRIBUTING.md) is the full
contract: the gates, what is frozen, and how documentation and licensing travel with a change.

```bash
pnpm install --frozen-lockfile     # Node 22+, pnpm 9.15.9

pnpm quality      # repo invariants: import boundaries, licences, generated files
pnpm typecheck    # tsc --noEmit across packages
pnpm test         # vitest
pnpm build        # required — see below
pnpm conformance  # adapter gate, no engine needed
```

`pnpm build` is not optional, and not only for the output. `tsc --noEmit` never exercises
declaration output, and the build is also what copies path-loaded assets into `dist` and then
checks the built code can still find them. A watchdog once went missing from a published
package precisely because nothing checked.

If you touched an adapter, also run the gate against the real engine, which needs that engine
installed and logged in:

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

`chat` takes `--permission allow-all|deny-all|ask`, `--resume <sessionId>`, and repeatable
`-c key=value` engine settings. Inside the session, `:cancel`, `:config key=value`, `:fork`,
`:status`, and `:quit` work. The full list is in [the CLI reference](docs/cli.md).

[The API specification](docs/engine-adapter-api.md) is the frozen public contract and the code
follows it, not the other way round. Changing that surface needs a numbered record in
[`docs/decisions/`](docs/decisions/), landing in the same change as the code.
