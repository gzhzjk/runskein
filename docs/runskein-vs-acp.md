# runskein vs ACP

The [Agent Client Protocol (ACP)](https://agentclientprotocol.com) tells a
client and one agent process how to talk. It says nothing about where that
process comes from, what to do when it crashes, how to make five engines that
disagree look alike, or where the conversation is kept.

runskein is the layer that answers those questions. Same protocol underneath,
but you get process management, one shared API across engines, saved
transcripts, resume, permissions, and typed errors instead of raw JSON-RPC
faults.

## The full comparison

|                 | ACP gives you                             | You would still build                                                                                              | runskein gives you                                                                                                                                                                             |
| --------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Processes       | nothing — you spawn them                  | start, quit, restart after a crash, reference counting, idle release, cleaning up orphans after your own host dies | all of it, plus environment scrubbing that was measured, not guessed: starting an engine from inside a Claude Code session leaks `CLAUDE*` markers that make `claude-code-acp` refuse to start |
| Many engines    | one connection per agent                  | one API over engines that differ; engines that speak no ACP cannot join at all                                     | one API; `engine: 'pi'` reads like `engine: 'codex'` even though pi speaks no ACP                                                                                                              |
| Settings        | per-engine keys                           | your own mapping table                                                                                             | one name each: `effort` on OpenCode, `thinking` on Kimi, `reasoning_effort` on Codex, a creation-time thinking budget on Claude Code — you write `config: { reasoning }`                       |
| Capability gaps | booleans in `initialize`                  | deciding, gap by gap, whether to fail, emulate, or degrade                                                         | three tiers, so a gap is a branch you can take, never a call that quietly did nothing                                                                                                          |
| Resume          | `session/load`, unstable `session/resume` | the fallback chain when an engine has neither, and an id that survives it                                          | native → load → transcript rebuild, with `session.resumeTier` naming the path                                                                                                                  |
| Record          | an event stream                           | storage, ordering, replay, export, summarising                                                                     | a saved transcript that is the authority for lists and resume                                                                                                                                  |
| Permissions     | one request and response                  | a policy mechanism, and something to do when an engine has no approval protocol                                    | per-session policies, with `policies.allowAll`, `policies.denyAll`, and a `policies.rules` table built in                                                                                      |
| Failure         | a JSON-RPC error                          | sorting out expired logins, quota, crashes, and cancellation                                                       | typed errors carrying the login command, the last saved sequence number, the valid values                                                                                                      |
| Accounting      | a context-window gauge                    | token totals across turns, and cost                                                                                | per-turn `usage` and a running `session.usage()`, from real token fields only                                                                                                                  |
| Testing         | nothing                                   | a fake agent                                                                                                       | `@runskein/testkit` — the real code path, no engine, no tokens                                                                                                                                 |
| Rendering       | a raw event stream                        | coalescing chunks and merging tool updates                                                                         | `runskein/fold`, optional and separate                                                                                                                                                         |

## What this costs you

ACP is deliberately out of reach. The public types are runskein's own mirrors
of the protocol, so a protocol feature runskein has not modelled is reachable
only through `_meta` passthrough. That is the trade: you do not deal with the
wire, and you also cannot reach past it without runskein modelling the
feature first.

See [Limitations](../README.md#limitations) for the rest of what runskein does
not promise.

## Where ACP lives in the code

Only `packages/core/src/acp/` and the shim entry points (`adapters/*/shim.mjs`,
the far side of the wire for engines that do not speak ACP) may import
`@agentclientprotocol/sdk`. Nothing a consumer can reach does. The reasoning is
in [decision 028](decisions/028-non-acp-engines-via-shim.md).
