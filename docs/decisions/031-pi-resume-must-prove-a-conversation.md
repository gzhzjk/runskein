# 031 - a resume that restored no conversation must not report success

Date: 2026-08-21 · Status: **accepted** · Cases: ST-LIFE-06, RS-06 live on pi ·
Informs: note 028 (shim path), the configuration-discovery capability table

## Context

pi joined `builtinAdapters` in `c53ae73` on 2026-08-18; the previous live run
was 08-17, so 2026-08-21 was the first time pi ran a live suite at all. It
failed ST-LIFE-06 with the sharpest symptom a lifetime case can produce: realm
reported `tiers=[native,native]` while pi answered

> I don't have any codeword. There's no prior context in this session.

The shim guarded `session/resume` by asking whether pi's stored session had
messages — `state.messageCount > 0` and a matching id. Measured after killing
pi mid-session, that is a different question from the one native resume
answers. The session file survives with a non-zero count, the resume reports
success, and the model has nothing.

## Decision

**1. The shim requires an exchanged reply, not a message count.** Resume now
also demands an assistant entry in the restored history, read through
`get_entries` — the call `session/load` already uses to replay. No reply
exchanged means there is no conversation to continue, whatever the file says.

**2. Failing a resume is preferable to succeeding falsely.** realm's chain
degrades to the transcript digest when native and load are refused, and the
digest restores the context for real. A false success is precisely what stops
it from trying.

## Rationale

Counting messages asks whether a file exists. Native resume claims something
stronger — that the engine is holding the same conversation — and a claim that
cannot be checked should not be made. The check is available here and costs one
RPC round-trip on a path that already spawns a process.

The new rejection covers one case that used to pass: a session whose engine
died before any reply. Native resume there restores nothing anyway, so
degrading costs a digest rebuild and buys a conversation that is actually
continuous.

## Consequences

- pi is 6/6 live. Verified on the wire rather than inferred: ST-LIFE-06 passing
  proves nothing about the guard, because that run resumed natively. RS-06,
  which kills mid-turn before any reply is stored, is where the guard fires —
  `STEP 3/3 resume → tier=rebuilt`, where it previously took a native resume
  that had lost the conversation.
- The shim carries pi's own reason for a failed turn instead of "pi ended the
  turn with an error". The live suite has always classified "insufficient
  balance" as an environmental waiver and could not classify this one, because
  the message it was handed said nothing.

## Measured, not fixed: two facts about pi

Recorded so they are not rediscovered as defects. Neither is realm's to repair.

- **Four of pi's five advertised models are unfunded on this account.** Its
  descriptor lists five ids under the `model` config option; the minimax ones
  answer `402 insufficient_balance_error`. Only
  `DeepSeek-V4-Flash-0731/DeepSeek-V4-Flash` — the id pi reports as current —
  is served, and it is what `LIVE_MODEL_PINS` pins. Advertising is not
  reachability, and a pin picked from a capability list rather than from what
  the engine is actually configured with will pick a model the account cannot
  use.
- **pi's model intermittently emits tool-call syntax as assistant text.**
  `ctx_execute_file(path: …)` and DSML markup arrive as prose instead of a tool
  call, and the tool does not run. Reproduced in isolation in both orders,
  concurrently and sequentially: it is per-turn and random, not positional and
  not a concurrency effect. This is what failed ST-CWD-01 twice; the case was
  right that the file was not read, and wrong about why — it reported "wrong
  directory" for a tool that never ran. ST-CWD-01 now separates the two: a
  sibling's marker is the cwd defect, and a reply carrying tool-call syntax as
  prose is named as such.
