# 042 - a launch environment names each variable once

Date: 2026-08-28 · Status: **accepted** · Cases: doubled launch variable
refused, distinct names accepted, in `packages/core/test/registry.test.ts` ·
Informs: api §9, adapter guide §3

## Context

`launch.env` is a `Record<string, string>`, and object keys are case-sensitive
while Windows environment variable names are not. `{ PATH_EXTRA: 'a',
Path_Extra: 'b' }` therefore declares two variables on POSIX and one on
Windows, where the value the engine receives is settled by key order and the
platform's own collapsing rather than by the adapter.

Decision 029's later amendments closed this for terminals from the other end:
an agent that names one variable twice is refused, compared without case,
because it cannot mean both. The launch path was left accepting the same
ambiguity from adapter authors, who have less excuse for it and more reason to
be told — an adapter is written once and read by people, and its author sees
one behaviour on their machine and another on a user's.

## Decision

- **Registration refuses a `launch.env` that spells one name two ways.** The
  schema compares names without case and names both spellings in the message,
  so the author learns which pair to resolve. The refusal is on every platform:
  a declaration whose meaning depends on the host it reaches is the thing being
  rejected, not one host's reading of it.

- **Refused, not normalised.** Collapsing to the last value would make the
  record mean one thing everywhere, at the price of silently discarding what
  the author wrote. That is the trade decision 029's amendment rejected for
  agents, and it is worse here: an agent's request is machine-generated and
  transient, an adapter's declaration is deliberate and durable.

- **The failure is isolation, not a crash.** A refused adapter becomes
  `health: 'invalid'` with the reason attached, reaching a consumer through
  `hub.engines()` and the loader's own `invalidCandidates()` internally, like
  every other schema refusal. One malformed adapter does not stop a hub from
  serving the others.

- **`envScrubExtra` keeps no such rule.** Scrub patterns are cumulative and
  removal-only: whether two of them overlap, or match different names, either
  one matching removes the variable and neither selects between competing
  values. Ambiguity needs two answers to choose from, and a scrub list has one.

## Consequences

An adapter that declared two spellings of one name no longer registers. None
exists in this repository, and none is known outside it; the launch
environments in the tree are conventionally upper-cased.

The frozen surface is unchanged in shape — `env?: Record<string, string>` still
— and narrowed in what it accepts. That is why this record exists rather than a
line in the adapter guide alone.
