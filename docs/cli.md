# `runskein` — the interactive CLI

A terminal client for the public API: list the engines on this machine, show
what one can be configured with, and hold a conversation with it while every
update type streams past. It is a **verification tool, not a product surface** —
it consumes only `createHub` and `Session`, so anything it cannot do is
something the public API is missing.

It is the reference answer to "what does this library actually look like when
something drives it", and the first consumer of
[`@runskein/fold`](transcript-fold.md).

**Not** in scope: scripting or batch mode, a transcript browsing UI, engine
routing, or anything beyond the public API.

---

## 1. Running it

`packages/cli` is a workspace package, `@runskein/cli`, whose bin is
`runskein`. In this repository:

```sh
pnpm --filter @runskein/cli dev -- <args>
```

It registers the five bundled adapters explicitly and leaves core's
directory discovery switched off, so it never imports adapter code from
whatever directory you happen to run it in.

For discovery testing there is the repeatable global flag `--adapter-path
<dir>`, which opts one directory into scanning. **It imports code from that
directory**, so the CLI prints a warning and you have to pass it deliberately.

## 2. Commands

### Command reference

| Command                           | What it does                                                     | Backing API                |
| --------------------------------- | ---------------------------------------------------------------- | -------------------------- |
| `runskein engines`                | List all discovered engines: installed / version / auth / health | `hub.engines()`            |
| `runskein describe <engineId>`    | List one engine's configurable options, modes, capabilities      | `hub.describe()`           |
| `runskein chat <engineId> [opts]` | Start the engine and chat in a REPL, streaming every update type | `hub.session()`, `Session` |

Global options, accepted before the command:

| Flag                   | Effect                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `--adapter-path <dir>` | Opt an adapter directory into discovery; repeatable and intended only for trusted discovery fixtures |

`--help` / `-h` as the first argument prints USAGE and exits 0 before any
parsing or adapter loading — distinct from a `UsageError`, which prints USAGE
to stderr and exits 2.

`runskein engines` takes no command-specific flags.

`runskein describe <engineId>`:

| Flag        | Effect                                                           |
| ----------- | ---------------------------------------------------------------- |
| `--refresh` | Ignore the cached descriptor and re-probe (`hub.rescan()` first) |

`runskein chat <engineId>` options:

| Flag                    | Effect                                                                                                                                       | Example                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `--cwd <dir>`           | Working directory for the session (default: current dir)                                                                                     | `--cwd /tmp/demo`              |
| `-c key=value`          | Engine config; repeatable. Keys map to `ConfigOption`s (`model`, `reasoning`, `mode`, or any option id); boolean options take `true`/`false` | `-c model=k3 -c reasoning=max` |
| `--resume <sessionId>`  | Resume a previous session (3-tier degradation applies)                                                                                       | `--resume 01J8K…`              |
| `--permission <policy>` | `allow-all` (default) · `deny-all` · `ask` (interactive)                                                                                     | `--permission ask`             |

Inside `chat`, lines starting with `:` are CLI-local commands (never sent to
the engine); anything else is sent as a prompt:

| REPL command              | Effect                                                         | Backing API                |
| ------------------------- | -------------------------------------------------------------- | -------------------------- |
| `:cancel`                 | Interrupt the active turn (resolves `stopReason: 'cancelled'`) | `s.cancel()`               |
| `:config key=value`       | Change config at runtime                                       | `s.setConfig()`            |
| `:fork`                   | Fork the session; later prompts go to the fork                 | `s.fork()`                 |
| `:status`                 | Show session status + engine health                            | `s.status`, `hub.health()` |
| `:quit` (or EOF / Ctrl-D) | Close session and quit the engine                              | `s.close()`, `hub.quit()`  |

### Usage examples

```bash
# 1. See what engines are available
runskein engines

# Exercise failure-isolated discovery with an explicitly trusted fixture dir
runskein --adapter-path /tmp/runskein-adapter-fixtures engines

# 2. See what kimi can be configured with
runskein describe kimi

# 3. Chat with kimi, picking a model and thought level
runskein chat kimi -c model=k3 -c reasoning=max

# 4. Chat with codex, approving every tool call by hand
runskein chat codex --permission ask

# 5. Resume yesterday's session
runskein chat opencode --resume 01J8K…

# 6. Bad config fails fast with the list of valid values
runskein chat kimi -c model=nope
# [error] ConfigError { engineId: 'kimi', key: 'model', validValues: ['kimi-for-coding','k3','k3-256k'] }
```

### 2.1 `runskein engines`

Renders `await hub.engines()` as a table:

```
ID           INSTALLED  VERSION   AUTH   HEALTH
opencode     yes        1.2.3     yes    stopped
kimi         yes        0.9.0     yes    stopped
claude-code  no         -         -      not-installed
codex        yes        0.4.1     no     unauthenticated
<broken>     -          -         -      invalid: <error>
```

Invalid candidates are shown too (they are the point of a test CLI).

### 2.2 `runskein describe <engineId>`

Renders `await hub.describe(engineId)`:

- `source: probe | hints` — printed first. `hints` means the engine reported
  **no `configOptions`**, so the _config-options list_ comes from the
  adapter's static `configHints`; `capabilities` and `modes` are still
  whatever the live probe returned. Do not read `hints` as "everything below
  is unverified".
- **Config options** — one row per `ConfigOption`: `id`, `category`,
  `type`, `currentValue`, and allowed values (`select` options flattened from
  `SelectOption[] | SelectGroup[]`; group names shown as prefixes).
- **Models** — `SessionModel[]` if present, with `describe().currentModel`
  marked `(current)`. Engines that expose the model as a config option
  instead show it above and have no models section.
- **Modes** — `SessionMode[]` if present.
- **Capabilities** — the `CapabilityMatrix` booleans (compact key list).

Example:

```
engine: kimi   source: probe
config options:
  model        (model, select)        current=kimi-for-coding
                values: kimi-for-coding, k3, k3-256k
  reasoning    (thought_level, select) current=high
                values: low, high, max
  mode         (mode, select)         current=default
                values: default, plan, auto, yolo
capabilities: loadSession fork resume ...
```

### 2.3 `runskein chat <engineId>`

Starts a session and enters a readline REPL:

```
$ runskein chat kimi -c model=k3 -c reasoning=max
[hub] spawning kimi ...
[hub] ready
[session] id=01J... engine=kimi status=idle
kimi> 帮我看一下这个仓库的结构
⟪thought⟫ ...
⟪agent⟫ 好的，我先列出目录……
⟪tool⟫ execute  ls -la            (running)
⟪tool⟫ execute  ls -la            (completed)
⟪plan⟫ 3 entries, 1 in_progress
⟪usage⟫ in=1234 out=567
[turn] stopReason=end_turn  durationMs=8200
kimi>
```

`spawning …` and `ready` are two separate lines with the engine-start window
between them — tens of seconds on an `npx` cold start.

Behaviour:

- **Config** — each `-c key=value` lands in `SessionOpts.config`
  (`model`, `reasoning`, `mode`, or any `ConfigOption.id`; boolean options
  take `true`/`false`). Invalid keys/values fail fast with the engine's
  `ConfigError` listing valid options — printed verbatim.
- **Streaming** — `s.on('update')` renders each `TranscriptEvent` by
  `update.sessionUpdate` discriminant (§3). One renderer per type; unknown
  types print the raw update JSON so nothing is ever dropped.
- **Permissions** — `--permission` picks a policy:
  `allow-all` (default, `policies.allowAll`), `deny-all`
  (`policies.denyAll`), or `ask` — an interactive policy that prints the
  `PermissionRequest` (tool, kind, options) and resolves once the input state
  machine (§2.4) collects the user's option pick. This exercises the
  single-policy mechanism end to end.
- **Questions** — `s.on('question')` prints the `QuestionRequest` and parks
  the REPL in `awaiting-question`; the next input line is sent back via
  `s.respond(requestId, answer)` instead of being treated as a new prompt.
- **Turn end** — after `prompt()` resolves, print `TurnResult`
  (`stopReason`, `usage`, `durationMs`) and cumulative `s.usage()`.
- **Errors** — any rejection goes through the §4 formatter:
  `[error] NotSupportedError { engineId, capability }` style.

### 2.4 Input state machine — the single owner of readline

One stdin, several consumers (prompts, `:cancel`, permission picks, question
answers). To prevent them racing for the next line, **the REPL loop is the
only code that ever calls `readline`**; event handlers never read input
directly — they request state transitions and await a promise the REPL
resolves.

```
                 prompt line        permission req      question req
                ┌──────────┐       ┌──────────────┐    ┌─────────────┐
                ▼          │       ▼              │    ▼             │
┌──────┐  line  ┌─────────┐│  ┌────────────┐      │ ┌───────────────┐│
│ idle │───────▶│ running │├─▶│ awaiting-  │──────┘ │ awaiting-     ││
│      │◀───────│         │◀──│ permission │◀───────┼─│ question    ││
└──────┘ turn   └─────────┘│  └────────────┘ answer └───────────────┘│
   ▲    end                │        ▲                       ▲        │
   │                       └────────┴───────────────────────┴────────┘
   │                          (both only reachable while running)
   └────────────── :quit / EOF / SIGINT-at-idle ──▶ shutting-down
```

The shutdown transition is drawn from `idle` only to keep the diagram
readable; `:quit`, EOF, and SIGTERM enter `shutting-down` from every
non-terminal state.

States and rules:

| State                 | Entered when                                                                                                           | What an input line means                                                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`                | no turn active                                                                                                         | `:`-command or new prompt (→ `running`)                                                                                                                                                                                         |
| `running`             | `prompt()`, `:config`, or `:fork` in flight                                                                            | `:status` and `:quit` run immediately; `:cancel` cancels an active turn when present; `:config` and `:fork` are queued until idle; a plain line is **queued** and echoed as `[queued]`, submitted FIFO after the current action |
| `awaiting-permission` | policy invoked during a turn                                                                                           | line selects an offered `optionId` (by number or id); the pending policy promise resolves; invalid picks reprint the options                                                                                                    |
| `awaiting-question`   | `question` event during a turn                                                                                         | line becomes the `Answer` (`{text}`, or `{optionId}` if it matches a listed option); resolves via `s.respond()`                                                                                                                 |
| `shutting-down`       | `:quit` / EOF / SIGTERM from any state, or SIGINT at `idle` (and in an active state with nothing cancellable — see §5) | no further input accepted; local queues are cleared and pending interactions are settled before cleanup                                                                                                                         |

Priority and contention:

- `awaiting-permission` / `awaiting-question` take precedence over plain
  prompt interpretation — while either is pending, non-`:` lines answer the
  pending request, never start a prompt.
- If a permission request and a question are both pending (possible across
  turns or a racing engine), they are answered **in arrival order**: the REPL
  keeps a FIFO of pending requests; the head of the queue owns the next line.
- A second permission/question arriving while one is pending is appended to
  that queue and printed immediately with its position, so nothing is lost
  silently.
- `:cancel` or SIGINT at `running`/`awaiting-*` first clears the CLI-local
  prompt/command queue. It then settles every pending permission policy with
  an offered reject `optionId`, or `{ outcome: 'deny' }` when no reject option
  exists, removes pending question entries that core cancels, and finally
  awaits `s.cancel()`. The active turn resolves with
  `stopReason: 'cancelled'`; cancelled interactions are not promised to be
  re-issued by the engine. This ordering ensures an interactive policy
  promise cannot keep the ACP request or turn alive forever.
- `:quit`, EOF, and SIGTERM from `running`/`awaiting-*` atomically stop input,
  clear the local queues, settle pending permission policies as above, and
  enter `shutting-down`; `s.close()` cancels pending questions and the active
  prompt. SIGINT at `idle`, or in an active state while a cancel is already
  hanging or there is nothing cancellable (no active turn and no pending
  interaction), also enters `shutting-down`.
- In `shutting-down` the cleanup path (§5) runs exactly once.
- A **blank line** only re-shows the prompt (on a TTY) and never consumes an
  engine turn — it is a REPL habit, not input.
- In every permission mode except `ask`, each permission request prints one
  observation line, `[permission] tool=… kind=… → <policy>` — the policy has
  already answered; in `ask` mode the policy prints the full request itself,
  so no observation line is emitted. This keeps output under
  `--permission allow-all` stable and greppable.

## 3. Update rendering map

The verbatim `TranscriptEvent` stream is folded into presentation events by
[`@runskein/fold`](transcript-fold.md); the CLI is its first
presenter, consuming the package's `FoldedEvent` stream. Rendering,
coalescing policy, terminal safety, and IO stay CLI-owned — fold carries
data, never markup.

Renderers are keyed by **two** discriminants where the type nests:
`update.sessionUpdate` first, then the inner `content.type` / `plan.type` /
tool-call delta shape. Every level has a raw-JSON fallback.

| Folded input                                                                                                    | Rendering                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| message stream (`agent`)                                                                                        | **one shared line**: `⟪agent⟫ ` printed at `messageStart`, each `messageAppend` written inline (no newline, no repeated prefix), the line terminated at `messageEnd`                                                                                                                                                                                                                                  |
| message stream (`thought`)                                                                                      | same, dimmed                                                                                                                                                                                                                                                                                                                                                                                          |
| message stream (`user`)                                                                                         | same, echo (rare headless)                                                                                                                                                                                                                                                                                                                                                                            |
| non-text `content` event                                                                                        | closes the shared line, prints its placeholder on its own line (content-block table below)                                                                                                                                                                                                                                                                                                            |
| `toolRow` (creation)                                                                                            | new row: `kind? title status?` + locations, `rawInput`/`rawOutput` when present; content items rendered per tool-call-content table                                                                                                                                                                                                                                                                   |
| `toolRow` (delta)                                                                                               | the merged row is re-rendered **only when the change is visible**: status transitions, title/kind changes, and terminal states always repaint; pure content/rawInput growth deltas are coalesced — the row repaints at most once per status, with the final state complete at `completed`/`failed`. Changed fields are marked (e.g. `status → completed`). Missing fields never render as `undefined` |
| `planState`                                                                                                     | current entries with status icons (`items`), `plan file: <uri>`, markdown body dimmed, `plan <planId> removed` for removals                                                                                                                                                                                                                                                                           |
| `usageState`                                                                                                    | token line; `cost` shown only when present                                                                                                                                                                                                                                                                                                                                                            |
| `notice` (`available_commands_update` / `current_mode_update` / `config_option_update` / `session_info_update`) | one line each: command list, mode notice, option id + currentValue, present info fields                                                                                                                                                                                                                                                                                                               |
| `raw` (unknown)                                                                                                 | raw JSON — never silently dropped                                                                                                                                                                                                                                                                                                                                                                     |

Stream rules: a non-chunk update or the end of the turn flushes any open
shared line before the next output; a chunk whose `(kind, messageId)`
differs from the open stream ends it and starts a new one ([fold](transcript-fold.md) §4.1).

Content blocks (`content` events, and inside tool rows' `content[]`):

| `content.type`  | Rendering                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `text`          | streamed text                                                                                   |
| `image`         | `[image <mimeType> <uri-or-base64-bytes>B]` — data never dumped                                 |
| `audio`         | `[audio <mimeType> <bytes>B]`                                                                   |
| `resource_link` | `[link <name> <uri>]` (+ title/size when present)                                               |
| `resource`      | `[resource <uri> <mimeType?>]`; text resources show the first ~200 chars, blobs show byte count |
| _(unknown)_     | raw JSON                                                                                        |

Tool-call content (`tool_call` / merged `tool_call_update` `content[]`):

| `type`      | Rendering                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------ |
| `content`   | nested content block, per the table above                                                  |
| `diff`      | `diff <path>` + `newText` preview (+ `oldText` when present)                               |
| `terminal`  | `[terminal <terminalId>]` (client-side terminal methods are v1 out-of-scope; display only) |
| _(unknown)_ | raw JSON                                                                                   |

How a row reaches the state being rendered — full `tool_call` replacement,
sparse `tool_call_update` patching, which fields treat `null` as "no change",
and when a terminal row is evicted — is
[fold's contract](transcript-fold.md), not the CLI's. Rendering always shows
merged state, so incremental updates from any engine display correctly.

### 3.1 Terminal-safe output

Every string originating outside the CLI — agent text/thought, tool titles
and content, paths, URIs, config labels, adapter errors, and nested causes —
passes through one terminal sanitizer before being written. It removes ESC,
CSI/OSC sequences and C0/C1 control characters except newline and tab, so an
engine or repository cannot manipulate terminal state, set terminal metadata,
or write the clipboard through OSC 52. ANSI sequences generated by the CLI
itself for labels and dimming are applied only after sanitization.

Raw-JSON fallbacks are serialized first and then sanitized as defence in
depth. Printable Unicode is preserved. This is implemented locally with
Node/string primitives; it does not add a runtime dependency.

## 4. Error formatter and exit codes

One formatter for everything the CLI prints as an error. Rules:

- **RunSkein typed errors** ([api §10](engine-adapter-api.md) — all of them): print class name, then
  every own enumerable field (`engineId`, `sessionId`, `capability`, `stage`,
  `operation`, `resource`, `resourceId`, `validValues`, `lastSeq`,
  `loginHint`…).
  The formatter is field-driven, so each class is covered without
  per-class code:
  - `NotSupportedError`, `NotInstalledError`, `UnauthenticatedError`,
    `NotFoundError`, `EngineStartError`, `StoreError`, `EngineCrashError`,
    `CancelledError`, `ConfigError`, `EngineOperationError`
- **Serialization**: never bare `JSON.stringify(err)` — `name`/`message` are
  non-enumerable and would be lost. Format as
  `[error] <ClassName>: <message> { ...structured fields }`.
- **`cause` chains**: recursed and printed indented (`caused by: …`) until
  the chain ends; cycles guarded.
- **`AggregateError`**: each inner error formatted on its own line. Exit-code
  classification recursively inspects its leaf errors: an aggregate whose
  leaves are all runskein typed errors is code 1; any unknown leaf makes it code 3. Empty aggregates are unexpected and therefore code 3. A runskein typed
  error is a classification boundary: its displayed `cause` may be an
  ordinary engine/store error, but the public wrapper still classifies as
  code 1. Only top-level failures and `AggregateError.errors` determine the
  code.
- **Unknown throwable** (not a runskein error class): printed as
  `[error] unexpected: <name>: <message>` plus stack — these indicate a CLI
  bug or a core contract leak and must be distinguishable from typed errors.
- **Exit codes**:

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | success (including clean `:quit` / EOF)                 |
| `1`  | runskein typed error (any §10 class)                    |
| `2`  | CLI usage error (unknown flag/command, bad `key=value`) |
| `3`  | unexpected/unknown throwable                            |

When more than one failure is printed, the final process exit code is the
highest-severity classification: `3` if any unexpected throwable occurred,
otherwise `2` for a CLI usage error, otherwise `1` for runskein typed errors.
Cleanup failures participate in this calculation, so they are visible
without masking the original command failure.

## 5. Process cleanup — every command, every exit path

`hub.describe()` spawns the engine to probe it, and sessions hold the process
alive; the default idle reap is 5 minutes — far too long for a CLI that
should exit promptly. Therefore:

- **Every command** (`engines` included — cheap but consistent) runs cleanup
  after command dispatch and calls
  `await hub.quit(undefined, { timeoutMs: 3_000 })`. The top-level dispatcher
  catches the command error and cleanup errors separately; it never throws
  directly from `finally`, which would mask the original error. A command is
  not considered successful until this cleanup completes; cleanup failure is
  reported and makes the exit non-zero.
- **Shutdown is idempotent**: the cleanup routine tracks whether it has run
  and no-ops on re-entry (normal exit, idle-state SIGINT, SIGTERM, and error
  paths all converge on it).
- **Error aggregation in cleanup** (`chat`): `s.close()` and `hub.quit()` are
  both attempted regardless of the other's failure, and both failures are
  reported — two of them as one `AggregateError`. The top-level dispatcher
  prints the captured command error first, then each cleanup error, and
  computes one exit code per §4. Cleanup never masks the original failure.

- **SIGTERM and idle-state SIGINT handlers** route into the same idempotent
  cleanup. Active-state SIGINT follows §2.4 and normally only cancels the
  current turn; it does not exit — except in two escalation cases where a
  cancel would be a silent no-op and the user would lose their exit path:
  when a cancel is already in flight (a hung Ctrl-C), and when there is
  nothing to cancel at all (a non-cancellable action such as `:config` or
  `:fork` is in flight: no active turn and no pending interaction). In both,
  SIGINT enters `shutting-down` instead. Shutdown handlers set
  `process.exitCode` only after the bounded `hub.quit()` settles; they do not
  call `process.exit()` and bypass cleanup.

## 6. If the CLI cannot do it, say so

Every behaviour above maps one-to-one onto a public API call. That is the
constraint the tool is built under, and it is what makes it useful as a check:
something the CLI wants and cannot express is a finding against
[`engine-adapter-api.md`](engine-adapter-api.md), to be filed rather than
worked around here.

- [`engine-adapter-api.md`](engine-adapter-api.md) — the frozen v1 surface,
  including every error class §4 formats.
- [`transcript-fold.md`](transcript-fold.md) — the presentation semantics §3
  renders.
- [`application-guide.md`](application-guide.md) — building your own consumer.
