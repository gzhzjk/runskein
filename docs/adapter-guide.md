# Writing an engine adapter

A task-oriented companion to the specification. The shape of `EngineAdapter`
is defined in [engine-adapter-api.md §9](engine-adapter-api.md); the discovery
and loading rules are in [Registering it](#registering-it) below. This document
is about how to actually build one, in what order, and which mistakes cost the
most time.

## What an adapter is, and what it is not

An adapter answers exactly one question: **how do I obtain a process that
speaks the protocol?** That is all. Session lifecycle, event mapping, permission
policy, transcript persistence, resume, process supervision and crash restart
are core's, uniformly, for every engine.

So an adapter is data plus at most a `detect()` probe. If you find yourself
writing session logic in one, the design has gone wrong somewhere else — raise
it rather than working around it, because a behaviour implemented in one
adapter is a behaviour the other engines silently lack.

You also do **not** declare what the engine can do. Capabilities are measured
at runtime from the engine's own `initialize` and `session/new` responses. An
adapter that claims a capability would be believed and then fail on the wire.

## Build it in this order

Each step is cheap and rules out a class of failure before the next one gets
expensive.

### 1. Confirm the engine speaks the protocol at all

Before writing anything, run its command by hand and check it answers
`initialize` over stdio. Most engines expose a subcommand for this — `kimi acp`,
`opencode acp` — or ship a wrapper — `npx @zed-industries/claude-code-acp`.

If it does not speak the protocol, you need a shim (`shim.mjs`): a separate
process that speaks ACP on the stdio runskein gives it and the engine's own
protocol to a child it spawns itself. That is a much larger undertaking than an
adapter — the whole of session lifecycle, event translation and permissions has
to be expressed in the engine's own terms — and the rest of this guide is about
the adapter, not the shim.

One bundled engine needs one: `pi`. Read `adapters/pi/` before starting a
second — `src/shim.mjs` is the worked example, and decision 028 is why the
boundary sits where it does. Expect the same shape of work. Three things that
cost time are not obvious in advance: the shim declares capabilities it has
_measured_, not ones it hopes for; a shim entry point is the one place outside
`packages/core/src/acp/` allowed to import the ACP SDK (decision 028), so
implement the `Agent` interface rather than hand-rolling JSON-RPC; and if your
engine holds one session per process, the shim owns one child per session and a
dead child must fail its own turn instead of being reported as an engine
crash.

### 2. Create the directory

```
adapters/<engine-id>/
├── package.json      name runskein-adapter-<engine-id> when published, plus the marker
├── index.mjs         default export: the EngineAdapter
├── index.d.ts        typing for static imports by the meta-package
└── conformance.json  written by the probe (§ below); commit it as evidence
```

Every directory-backed candidate follows one identity rule: its `id` must equal
the directory basename directly (`<engine-id>/`), or equal the basename after
the exact `runskein-adapter-` prefix is stripped
(`runskein-adapter-<engine-id>/`). Any other mismatch is a load error, not a
warning. A discoverable third-party package must use the prefixed form, either
unscoped or as `@scope/runskein-adapter-<engine-id>`.

Shim-style adapters carry additional artifacts beyond this tree: `src/shim.mjs`
(the shim source), a root `shim.mjs` (the committed esbuild bundle), and the
engine's own helpers (e.g. pi's `permission-gate.ts`). The rule that goes with
it: `index.mjs` must stay build-free; `shim.mjs` is the opposite — it is a
build product. This guide only covers the adapter itself; writing a shim is a
project of its own (see decision 028).

`package.json` needs the discovery marker. After a layer selects a directory by
location and, for installed packages, by prefix, the manifest gate checks
`runskein.adapter === true`; `specVersion` is validated by schema after
loading. Without the marker the directory is invisible to discovery:

```json
{
  "name": "runskein-adapter-myengine",
  "private": true,
  "type": "module",
  "main": "index.mjs",
  "types": "index.d.ts",
  "runskein": { "adapter": true, "specVersion": 1 }
}
```

A private, personal adapter keeps `"private": true`. To publish one, drop that
and add `version`, plus the metadata any npm package needs — `license`,
`description`, `files`.

RunSkein's bundled adapters use the package names `@runskein/adapter-*`, but
that is a layer-1 convention: the meta-package statically imports them before
dynamic discovery. Layer 3 does not scan that form. A third-party publisher
must use `runskein-adapter-<id>` (optionally under their own scope), rather than
copying the bundled package name. `adapters/kimi/package.json` is a complete
in-repo example of the bundled layer-1 form.

`index.mjs` must be plain, runtime-importable ESM with no build step. Discovery
imports it directly under bare node.

### 3. Write the launch block

```js
export default {
  specVersion: 1,
  id: 'kimi',
  launch: { command: 'kimi', args: ['acp'], startTimeoutMs: 30_000 },
};
```

**Choose `startTimeoutMs` from how the command resolves, not from how fast the
engine is.** A native binary on `PATH` starts in well under a second; the
bundled native-binary engines use 20–30 s (opencode and kimi 30 s, pi 20 s),
which is almost entirely headroom. An `npx` wrapper may download the package
on first run, so the bundled npx-based engines use 120 s. Measured on a warm
cache, spawn plus `initialize` was ~0.6 s for a native binary and ~1.6 s for
an npx wrapper — the budget exists for the cold case, not the normal one.

`launch.env` is applied **after** core's environment scrub, so it wins. Use it
for settings the engine reads at startup, not for per-session configuration:
one process serves many sessions, and its environment is fixed when it starts.

### 3a. `supervise` — only if your engine ignores stdin EOF

```js
supervise: true, // default false
```

Engines run in their own process group so runskein can signal a whole tree, which
also means nothing kills them when the host dies. Most engines notice their
stdin closing and exit; one of the bundled engines did not, and leaked a process
on every uncleanly-terminated host.

Set `supervise: true` only after checking yours: start it, kill the host with
`SIGKILL`, and see whether the engine is still running a few seconds later. If
it exits on its own, leave this off — it costs an extra process per engine.

The watchdog is **not** a protocol shim. Your engine inherits the host's stdio,
so its JSON-RPC stream is untouched; the extra process only watches a pipe for
the EOF that means the host is gone. See `docs/decisions/015`.

### 3b. `creationConfig` — settings that can only be set at creation

Some engines carry settings that never reach the ACP config surface: they are
read once from `session/new`'s `_meta` during session construction, and nothing
afterwards can change what was read. Declare them as data instead of stuffing
them into `launch.env` (which is fixed per process, not per session):

```js
creationConfig: {
  reasoning: {
    meta: ['claudeCode', 'options', 'maxThinkingTokens'],
    values: { low: 4000, medium: 10000, high: 32000 },
    description: 'Thinking budget, applied when the session is created',
  },
},
```

(from the bundled claude-code adapter). The keys are **runskein config keys**
(`reasoning`, `model`, …), never engine-native names; `meta` is the path inside
the creation request's `_meta` object; `values` maps runskein's levels onto
whatever the engine expects, because "what high means" is your adapter's
knowledge, not core's. RunSkein delivers the value on the creation request and
reports the key through `describe()` as `settable: 'creation'`, refusing
runtime writes rather than sending one that would be accepted and ignored.

Do **not** use `creationConfig` for a setting the engine already reports in
`configOptions` — shadowing a real, writable surface produces a value that
validates and then cannot be applied, the same worst outcome as a stale
`configHints` entry (see "The mistakes that cost the most" below).

### 3c. `errorPatterns` — what the engine's failures mean

Engine error wording belongs to the engine, so core classifies a post-ready
failure only through patterns you declare:

```js
errorPatterns: [
  { cause: 'rate-limit', match: 'reached your usage limit|quota will be refreshed' },
  { cause: 'auth', match: 'Authentication required' },
],
```

Two rules, both learned the hard way:

- **Declare `rate-limit` before `auth`.** First match wins, and an engine is
  free to word a throttled request as an authentication problem — kimi prefixes
  an upstream refusal with `Authentication required:` whatever its cause. Order
  matters more than it looks: `auth` is a teardown, not a label. It invalidates
  the cached login until `hub.rescan()`, marks every live session on the engine
  crashed, and retires the engine process. A spent quota classified as `auth`
  tears the engine down for a failure that clears itself.
- **Write the pattern from a payload you measured**, not from what the engine
  probably says. Match the fragment that names the condition and keep it long
  enough to exclude a sentence that merely mentions a limit or a number. An
  unmatched failure is an honest `EngineOperationError` with no `kind`; a
  pattern that fires on the wrong message is a wrong answer stated
  confidently.

### 4. Write `detect()`

```js
async detect() {
  const version = await tryVersion('kimi', ['--version']);
  if (version === undefined) {
    return { installed: false, loginHint: 'install kimi, then: kimi acp --login' };
  }
  return { installed: true, version, loginHint: 'kimi acp --login' };
}
```

`detect()` is cheap, must never spawn the engine proper, and feeds
`hub.engines()`. Three rules:

- **Report facts, never guesses.** `installed: false` means you checked and it
  is absent. If you cannot determine authentication, leave `authenticated`
  undefined — that reads as "unknown", and `false` would make the hub refuse to
  start a session that would have worked.
- **Let failures throw.** A `detect()` that throws surfaces as a typed
  `EngineOperationError` and the engine appears as `health: 'invalid'`.
  Swallowing the error and returning `installed: false` turns a broken probe
  into a false environment fact, which is much harder to debug.
- **Probe the thing that matters.** For a wrapper, probe the underlying engine,
  not the wrapper. `npx` is almost always present; that tells you nothing.

`loginHint` is shown to users on `UnauthenticatedError`, so make it the exact
command to run.

### 5. Run the gate

```sh
pnpm conformance <engine-id>
```

This is not a formality — it is the registration mechanism. **An adapter is
registrable if and only if it passes**, and the same cases that run hermetically
against the mock agent run against your real engine.

Three gates, and it is worth knowing which one is complaining:

| Gate                 | What it runs                                                                                                                                                                            | What failing means                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Core gate**        | spawn → `initialize` → `session/new` → `prompt` → streamed updates → stop reason → cleanup, plus env-hygiene spawn, cancel mid-turn, and a permission round-trip under `policies.rules` | not registrable                                                                                     |
| **Capability truth** | the probe's measured matrix against what the adapter claims                                                                                                                             | drift between `configHints` and probe output is a **warning**; drift in a Core row is a **failure** |
| **Store gate**       | any `TranscriptStore` implementation: append/read ordering, seq monotonicity, digest determinism, filtering                                                                             | only relevant if you ship a store                                                                   |

CI runs the Core gate against the mock agent on every push. The live probe runs
on demand, from a machine with the engine installed and logged in.

Then record the measured capabilities:

```sh
cd packages/conformance && pnpm probe <engine-id>
```

That writes `adapters/<id>/conformance.json` and refreshes the engine's row in
`docs/conformance/matrix.json`.

**Commit `conformance.json` only, and neither of the other two files.**
`matrix.json` carries the provider configuration of whichever machine ran the
probe, so it is not in this repository and yours should not be added to it. The
published capability tables come from a projection of it, `matrix.public.json`,
which the maintainers refresh from a full five-engine probe — projecting from a
one-engine `matrix.json` would drop the other four, and
`project-conformance-matrix.mjs --write` refuses rather than let that happen.

Say in your pull request what the probe measured. `conformance.json` is the
baseline later drift is compared against, so refresh it in the same change as
anything that moves it.

## The mistakes that cost the most

**Assuming a wrapper forwards what you give it.** An engine reached through a
wrapper is two processes, and the wrapper decides what reaches the inner one.
Setting an environment variable on the adapter's launch puts it in the
wrapper's environment, which is not the same as the engine's: one bundled
wrapper rebuilds a clean environment for the process it spawns, so variables set
this way are silently dropped. Command-line arguments can be swallowed the same
way. Verify by reading the inner process's actual environment and argv, or by
asking the engine to report the setting back — never by observing that no error
was raised.

**Adding `configHints` for something the engine actually reports.** Hints are a
fallback for engines that report _no_ configuration at all, and they are static,
so they go stale. Before adding one, check the full `session/new` response:
configuration lives in `configOptions`, but model choice may be published
separately in `models`, and modes in `modes`. A hint that shadows a real,
writable surface produces the worst outcome available — a value that validates
and then cannot be applied.

**Trying to make configuration per-session through the environment.** One
process serves every session on that engine and its environment is fixed at
spawn. Per-session settings must go over the wire.

**Adding an engine-specific quirk to core.** If your engine needs special
handling, that is a capability-negotiation gap. Fix it as a negotiated
capability so every engine benefits, or file it — do not special-case an id in
core, which is the one thing the adapter layer exists to prevent.

## Environment hygiene

Core scrubs host-agent session markers (`CLAUDE*`, `CLAUDECODE`,
`CODEX_SANDBOX*`, `OPENCODE_SESSION*`, `OPENCODE_CALLER*`) before spawning any
engine. This is load-bearing, not tidiness: running runskein from inside a coding
agent leaks that agent's session variables into the child, and at least one
engine refuses to start with "active session" as a result.

If your engine has its own markers with the same problem, add them:

```js
envScrubExtra: [/^MYENGINE_(SESSION|CALLER)/],
```

Scrub what identifies a _session_, not what configures the engine — over-scrubbing
strips the user's own configuration.

## Registering it

`createHub()` resolves adapters in four layers. **A later layer wins an id
collision; two adapters claiming the same id within one layer is an error** —
so an explicit object can deliberately stand in for a bundled engine, but two
scanned directories fighting over `kimi` is a mistake, not a precedence puzzle.

|     | Layer              | Needs `discovery`                          | Where                                                                                   |
| --- | ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1   | Built-ins          | no — the application already imported them | the `adapters/*` packages inside `runskein`                                             |
| 2   | Workspace          | yes                                        | `<cwd>/adapters/*` and `<cwd>/.runskein/adapters/*` with the `runskein.adapter` marker  |
| 3   | Installed packages | yes                                        | `node_modules/runskein-adapter-*` and `node_modules/@*/runskein-adapter-*`, same marker |
| 4   | Explicit           | no                                         | `adapterPaths` first, then `adapters`                                                   |

Each directory-backed candidate goes through the same pipeline: find the
`runskein.adapter` marker, check `specVersion`, dynamically import the main
entry, validate the default export against the schema, require its id to match
the directory basename directly or after stripping `runskein-adapter-`, check
for an id collision, register. Nothing runs `detect()` at this point — it is
awaited lazily, on the first `engines()` or `session()` that needs it.

**One bad directory never takes the hub down.** A failed import, a default
export that does not validate, an unsupported `specVersion`, or a `detect()`
that rejects all produce the same outcome: that engine is reported by
`await hub.engines()` as `{ id?, health: 'invalid', error }` and skipped, and
every other engine keeps working. When you are iterating on an adapter, note
that discovery results and `detect()` results are both cached per process —
`hub.rescan()` invalidates them and forces a re-walk.

**Discovery is off by default, and that is a security boundary, not a
default-value preference.** `import()` executes the adapter's top-level code
with the host process's full privileges, and the schema validates the export
_after_ that code has already run. It is a compatibility gate, not a sandbox.
Enable discovery only for a workspace whose contents you trust; otherwise pass
the adapters you mean, as objects or as explicit paths.

## Checklist

- [ ] Directory basename is `<id>` or `runskein-adapter-<id>`; installed packages use the prefixed form
- [ ] `runskein.adapter` marker present in `package.json`
- [ ] `index.mjs` is runtime-importable ESM with no build step
- [ ] `startTimeoutMs` reflects how the command resolves, not engine speed
- [ ] Creation-only settings declared via `creationConfig`, not stuffed into `launch.env`
- [ ] `detect()` reports facts, throws on failure, and probes the real engine
- [ ] `loginHint` is the exact command a user should run
- [ ] No session logic, event mapping or capability declarations
- [ ] `pnpm conformance <id>` passes
- [ ] `conformance.json` and the matrix row committed
