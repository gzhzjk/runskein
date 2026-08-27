# @runskein/testkit

A scripted ACP agent, so a consumer can drive runskein end to end — engine
start, session creation, turns, streaming, permissions, cancellation,
transcript, close — **without an engine installed, credentials, network access,
or model tokens**.

It exists because that path is a consumer's build input, not runskein's test
fixture. A default CI run should exercise the whole matrix on every commit;
real engines belong in the runs that specifically need them.

## Use

```ts
import { createHub, jsonlStore } from 'runskein';
import { scriptedAdapter } from '@runskein/testkit';

const hub = createHub({
  discovery: false,
  adapters: [scriptedAdapter({ env: { RUNSKEIN_TESTKIT_ECHO_PROMPT: '1' } })],
  store: jsonlStore('.transcripts'),
});

const session = await hub.session({ engine: 'scripted', cwd: process.cwd() });
const result = await session.prompt('hello'); // stopReason: 'end_turn'
```

Register it explicitly, as above. Discovery finds whatever is installed on the
machine; a test that depends on that is a test that fails on someone else's.

Need the agent as a process rather than an adapter — a shim under test, a
harness of your own? `scriptedAgentPath()` returns the absolute path to run
with node, and the package also exports it as `@runskein/testkit/agent`.

## Configuration

The agent is configured entirely through environment variables, passed via
`scriptedAdapter({ env })`.

| Variable                             | Effect                                                              |
| ------------------------------------ | ------------------------------------------------------------------- |
| `RUNSKEIN_TESTKIT_REPLY=<text>`      | reply text (default: `OK<turn number>`)                             |
| `RUNSKEIN_TESTKIT_ECHO_PROMPT=1`     | reply with the prompt's own text                                    |
| `RUNSKEIN_TESTKIT_PROMPT_DELAY_MS=n` | hold the turn open for n ms after streaming, so it can be cancelled |
| `RUNSKEIN_TESTKIT_THOUGHT=1`         | emit an `agent_thought_chunk`                                       |
| `RUNSKEIN_TESTKIT_TOOL_CALL=1`       | emit a `tool_call` / `tool_call_update` pair                        |
| `RUNSKEIN_TESTKIT_ASK_PERMISSION=1`  | request permission mid-turn; a denial marks the tool call failed    |
| `RUNSKEIN_TESTKIT_ASK_QUESTION=1`    | ask one elicitation question and echo the answer as a message chunk |
| `RUNSKEIN_TESTKIT_EMIT_USAGE=1`      | emit `usage_update` with `used` / `size` / `cost`                   |
| `RUNSKEIN_TESTKIT_STOP_REASON=<r>`   | end the turn with this stop reason                                  |
| `RUNSKEIN_TESTKIT_PROMPT_ERROR=<t>`  | fail every prompt with this message                                 |
| `RUNSKEIN_TESTKIT_CRASH_ON_PROMPT=n` | exit(7) while handling the nth prompt                               |
| `RUNSKEIN_TESTKIT_REFUSE_ENV=<name>` | refuse to initialize when `<name>` is set — the env-hygiene case    |
| `RUNSKEIN_TESTKIT_NO_RESUME=1`       | do not advertise or answer `session/resume`                         |
| `RUNSKEIN_TESTKIT_NO_LOAD=1`         | do not advertise or answer `session/load`                           |
| `RUNSKEIN_TESTKIT_NO_FORK=1`         | do not advertise or answer `session/fork`                           |
| `RUNSKEIN_TESTKIT_NO_CLOSE=1`        | do not advertise or answer `session/close`                          |

## What is promised

**Public contract**, changed only with a version bump and a note in the
changelog:

- the exports — `scriptedAdapter`, `scriptedAgentPath`, `@runskein/testkit/agent`;
- the variables in the table above, and the observable behaviour each one
  produces: which update kinds arrive, which stop reason ends the turn, whether
  a request is made of the client.

**Not promised**, and safe to change in a patch:

- the exact reply strings, session ids, tool call ids, and usage numbers —
  assert on shape and on the parts you configured, not on `testkit-session-1`;
- the order of updates within a turn beyond what the table states;
- anything the agent does that no variable above asks for.

If you need a behaviour that is not in the table, ask for it rather than
depending on an accident: an accident will be changed without a version bump,
because nobody knows you are relying on it.

## Why it is a separate package

runskein's own tests drive a similar agent in `packages/core/test/fixtures`.
This one is a **deliberate copy that evolves on its own**. That fixture answers
to runskein's internal tests and grows whatever toggle the next test needs; this
package answers to consumers and changes only when the contract above does. One
file serving both audiences would eventually be changed for one and break the
other — quietly, since only one of them is in this repository's CI.
