# 035 - realm's own events reach the live update stream

Date: 2026-08-24 · Status: **accepted** · Cases: `UA-LIVE-STREAM` in
`packages/core/test/usageTranscript.test.ts`, `SL-14` · Rests on: decisions 033,
034 · Informs: api §3.1, §4.1

> Accepted in the change that landed the emission, the parity tests and the
> contract-document update together — the requirement
> `docs/decisions/README.md` sets for flipping a record out of _proposed_.

## Context

A session writes two kinds of event to its transcript. An engine notification
arrives at `handleUpdate()`, which persisted **and** emitted it. Everything realm
generates itself went through `record()`, which only persisted: the session-meta
events that carry `idle`/`failed`/`closed`, the user prompt realm echoes back so
a transcript reads as a conversation, and the synthesized `usage_update` that
carries token counts for an engine whose usage comes from its prompt response
(decision 033).

So `on('update')` and `s.transcript()` described different sessions. A live
subscriber never saw realm's token accounting at all, and learned that a session
had failed or closed only by reading the transcript afterwards. The asymmetry
was invisible in the contract — both surfaces are typed `TranscriptEvent` — and
surfaced downstream as "the console shows no session token usage", which the
fold-side fix in decision 034's sibling work could not have repaired: the event
was never delivered to fold in the first place.

## Decision

`record()` persists and emits, exactly as `handleUpdate()` does. Every event
realm puts in a session's transcript is delivered to that session's `update`
subscribers, in the same order and carrying the same `seq`.

The rule is "all of them", not a chosen subset. The alternative — emitting the
usage event because a consumer asked for it, and leaving the prompt echo out
because it looks redundant — would leave the two surfaces almost the same, which
is worse than either being clearly the same or clearly different: a consumer
cannot tell which events it must go to the transcript for.

Emission stays synchronous and immediately after the envelope is built, so live
order matches transcript order. Persistence remains a serialized chain, so the
store still lands events in `seq` order whatever the listeners do.

## Consequences

- A consumer that subscribes and _also_ replays the transcript sees each event
  twice. That was already true for engine notifications; it is now uniformly
  true, and `seq` is what a consumer deduplicates on.
- Live subscribers now receive `user_message_chunk` events for the prompt as the
  engine received it — what the host submitted, plus the recovered-context
  preamble a rebuilt resume prepends to the first turn.
  A renderer that draws its own input would print each prompt twice, and it
  cannot tell realm's echo from the identical-looking chunk an engine sends when
  it replays context — so realm marks its own with a `realm.dev/promptEcho`
  `_meta` entry and exports `isPromptEcho(update)` to read it. This repo's CLI
  drops echoes on the live path and is the worked example. The marker rides
  realm's own event, not an engine's: the verbatim rule is untouched.
- Events recorded before a caller can subscribe — session creation and the
  resume that opened the session — are emitted to nobody. They are on the
  transcript, which is where a subscriber that missed them reads them from. A
  later in-place reactivation, after an idle suspension or a crash, records its
  meta event while subscribers exist, and they receive it.
- Emission precedes durability: `persist()` captures store failures and
  `flushPersist()` raises them at the next API boundary, so a subscriber can see
  an event whose append later failed. The failure is reported rather than
  swallowed, but parity between the two views is a property of a transcript that
  persisted, not a guarantee against a failing store.
- `close()` emits its `closed` status event, so a subscriber sees the session end
  on the same channel it saw the work on, rather than only through `on('status')`.
