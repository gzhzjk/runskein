# Capability matrix

What every bundled engine can actually do, and which of the three capability
tiers each feature sits in. Two things are folded together here on purpose: the
tier tells you what the library _promises_, the Measured column tells you what
the engines _did_ on the last probe. A promise without a measurement is how a
capability table rots.

**Generated.** The Measured cells and the whole built-in support table are
rendered from
[`conformance/matrix.public.json`](conformance/matrix.public.json) by
`node scripts/generate-capability-tables.mjs`, and `pnpm quality` fails if the
document has drifted from the matrix. Do not hand-edit anything between the
`<!-- generated:… -->` markers. The Capability, Tier and API columns are
judgement rather than measurement and are hand-maintained.

**A snapshot, not a compatibility promise.** The matrix records what one
version of each engine advertised on one probe run; each engine's measured
version is in the built-in support table below. For what _your_ machine has,
call `hub.engines()` and `hub.describe()` — those are the runtime facts, and
they are the ones a program should branch on.

## Legend

**Tiers** — **Core**: guaranteed, conformance-gated on every engine ·
**Negotiated**: passed through where the engine has it, typed
`NotSupportedError` where it does not, never silently dropped · **Emulated**:
the library fills the gap, so it is always available.

**Measured symbols** — `✓` advertised and observed · `✗` probed and explicitly
unsupported · `—` the wire capability is absent or was never advertised.
`✅` marks a Core row: every bundled engine passes the same gate for it, so
there is nothing to differentiate.

## Session lifecycle

<!-- generated:lifecycle-capabilities -->
<!-- prettier-ignore -->
| Capability            | Tier                           | API                                                | Measured (oc·ki·cl·cx·pi)                                                                                                                 |
| --------------------- | ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------              |
| New session           | Core                           | `hub.session()`                                    | ✅ ✅ ✅ ✅ ✅                                                                                                                                 |
| Prompt (turn promise) | Core                           | `s.prompt()` → `TurnResult`                        | ✅ ✅ ✅ ✅ ✅ · all `end_turn`                                                                                                                |
| Cancel active turn    | Core                           | `s.cancel()`                                       | active prompt resolves `stopReason:'cancelled'`; queued prompts reject `CancelledError`; every bundled engine advertises `session/cancel` |
| Streaming updates     | Core                           | `s.on('update')`                                   | ✅ ✅ ✅ ✅ ✅                                                                                                                                 |
| Close session         | Core (API) / Negotiated (wire) | `s.close()`                                        | ✓ · ✓ · ✓ · ✓ · ✓                                                                                                                         |
| **Resume**            | **Emulated**                   | `hub.session({engine,cwd,resume})`, `s.resumeTier` | native `session/resume`: ✓ ✓ ✓ ✓ ✓                                                                                                        |
| Load (history replay) | Negotiated (resume tier 2)     | internal                                           | `loadSession`: ✓ ✓ ✓ ✓ ✓                                                                                                                  |
| Fork                  | Negotiated                     | `s.fork()`                                         | ✓ · ✓ · ✓ · — · ✓                                                                                                                         |
| List sessions         | Emulated                       | `hub.sessions()`                                   | wire `session/list`: ✓ ✓ ✓ ✓ ✗                                                                                                            |
| Attach                | Emulated                       | `hub.attach(id)`                                   | store-backed; independent of engine                                                                                                       |

<!-- /generated:lifecycle-capabilities -->

Notes for the Measured column above: absent wire `session/close` degrades to
local release with process reaping unaffected; native resume covers all
bundled engines today and tiers 2–3 are insurance; the local session store is
authoritative for listing, with wire `session/list` as a cross-check where
advertised; fork reached kimi in 0.33.0.

### Resume degradation chain

```
hub.session({ engine, cwd, resume: id })
  1. native   engine session/resume        (every bundled engine supports it today)
  2. load     engine session/load          (history replay)
  3. rebuilt  store.digest(id) → injected as opening context of a fresh session
```

The RunSkein `sessionId` is stable across all three; `s.resumeTier:
'native'|'load'|'rebuilt'` is the only observable difference. Tier 3 is why
**every engine resumes**, including a future one with no persistence at all.

## Conversation features

<!-- generated:conversation-capabilities -->
<!-- prettier-ignore -->
| Capability                         | Tier                                | API                                     | Measured                                                                                                                                        |
| ---------------------------------- | ----------------------------------- | --------------------------------------- | -----------------------------------------------------------------------------------------------                                                 |
| Text out (chunks)                  | Core                                | `update: agent_message_chunk`           | ✅×5                                                                                                                                             |
| Thinking out                       | Core (pass-through)                 | `agent_thought_chunk`                   | streamed by opencode, kimi and codex; claude-code streams none at any thought level — see the note below                                        |
| Tool calls (kind/status/locations) | Core (pass-through)                 | `tool_call` / `tool_call_update`        | ACP ToolKind: read/edit/execute/…                                                                                                               |
| Diffs                              | Negotiated (pass-through)           | `ToolCallContent.diff`                  |                                                                                                                                                 |
| Plan / todo stream                 | Negotiated (pass-through)           | `plan` / `plan_update` / `plan_removed` |                                                                                                                                                 |
| Multimodal prompt                  | Negotiated                          | `s.prompt(ContentBlock[])`              | `promptCapabilities.image`: true on oc·ki·cl·cx, false on pi; ki·pi additionally report `audio: false`                                          |
| Questions / elicitation            | Negotiated                          | `s.on('question')` + `s.respond()`      | engines without it simply never emit                                                                                                            |
| Terminal stream                    | Negotiated (read-only pass-through) | inside tool_call content                | client-side `terminal/*` methods **implemented** (decision 029): permission-gated on command, args, cwd and env; cwd contained by resolved path |
| Available commands                 | Negotiated (pass-through)           | `available_commands_update`             | not observed on pi                                                                                                                              |

<!-- /generated:conversation-capabilities -->

## Built-in engine support

The same matrix read per engine rather than per capability — the wire
capabilities each bundled engine advertised, at the version it was probed at.

<!-- generated:builtin-support -->
<!-- prettier-ignore -->
| Engine      | Measured version | Native resume | Load | Fork | List | Delete | Image input | MCP HTTP | MCP SSE | Providers | Token usage |
| ----------- | ---------------- | ------------- | ---- | ---- | ---- | ------ | ----------- | -------- | ------- | --------- | ----------- |
| OpenCode    | 1.18.25          | ✓             | ✓    | ✓    | ✓    | —      | ✓           | ✓        | ✓       | ✗         | ✓           |
| Kimi Code   | 0.38.0           | ✓             | ✓    | ✓    | ✓    | ✓      | ✓           | ✓        | ✓       | ✗         | ✗           |
| Claude Code | 0.70.0           | ✓             | ✓    | ✓    | ✓    | ✓      | ✓           | ✓        | ✓       | ✓         | ✓           |
| Codex       | 1.7.0            | ✓             | ✓    | —    | ✓    | ✓      | ✓           | ✓        | ✗       | ✓         | ✓           |
| pi          | 0.84.2 (shim 1)  | ✓             | ✓    | ✓    | ✗    | ✗      | ✗           | ✗        | ✗       | ✗         | ✓           |

<!-- /generated:builtin-support -->

**Thinking out, and what a raised thought level buys you.** Whether an engine
_streams_ thinking and whether it _does_ more thinking are two different
questions, and they have different answers per engine. Every engine except pi
publishes a thought level, but only some let you watch the result — and a
pinned model can narrow which levels it will actually take, which is why
`hub.describe()` on your own machine beats this table:

| Engine      | Publishes a thought level | Streams thinking text | Reports `usage.thought` | A raised level is visible as |
| ----------- | ------------------------- | --------------------- | ----------------------- | ---------------------------- |
| opencode    | yes                       | yes                   | yes                     | either                       |
| kimi        | yes                       | yes                   | no                      | streamed text                |
| codex       | yes                       | yes, but not always   | yes                     | thought tokens               |
| claude-code | yes                       | no                    | no                      | nothing runskein surfaces    |
| pi          | no                        | no                    | no                      | —                            |

Provenance: the thought-token column is each engine's `usage.fields` in the
matrix; whether an engine publishes a thought level was read from
`hub.describe()` on 2026-08-31; the streaming column is the live run of the
same day (cases CF-06, CF-10, PV-02) — except kimi's, which carries the
matrix's own earlier measurement because that account's quota was spent, so no
live turn could run.

claude-code's ACP wrapper emits a thought chunk only when the thinking text is
non-empty, and recent Claude models omit that text, so a turn that spent
thousands of tokens thinking arrives as silence. **Do not read an absent
`agent_thought_chunk` as "the model did not think."** The work is real — it is
billed inside the turn's output tokens, which is where the live suite measures
it (case CF-10) — but Anthropic does not break it out, so no `usage.thought`
can ever reach you for this engine. A host that renders a thought pane should
branch on the engine, not assume every engine fills it.

**Token usage** means the probe read real token numbers off that engine's
wire: the `usage.fields` list of its matrix entry is non-empty, so the numbers
reach `TurnResult.usage` and `session.usage()`. `TurnResult.usage` describes
the completed turn, while `session.usage()` is cumulative for that RunSkein
session. Bare context-window gauges such as `{used, size}` do not count as
token usage and are never converted into token estimates.

The matrix entry also carries `usage.ok`, which is a stricter and different
flag: it is true only when the adapter _declares_ a usage source and that
declaration resolved. An engine can report usable tokens without declaring
anything, because core reads `usage_update` with its built-in field names by
default. pi is exactly that case — `usage.ok: false` with `usage.fields`
populated — so it is `✓` in this column. Read `usage.fields` for what a
consumer gets, and `usage.ok` for whether the adapter pinned the source down.

Resume stays available at the RunSkein level even where an engine lacks a
native mechanism, through the three-tier chain above. Inspect
`session.resumeTier` if the distinction matters to your application.

## Where the rest lives

- [`engine-support.md`](engine-support.md) — how to choose an engine, what the
  normalized capability keys mean, and how to read them at runtime.
- [`engine-adapter-api.md`](engine-adapter-api.md) — the frozen v1 API surface
  these capabilities are reached through, including the exact error types a
  Negotiated capability raises when absent.
