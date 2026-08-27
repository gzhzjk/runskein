# 032 - one config interface: uniform at creation, described at runtime

Date: 2026-08-21 · Status: **accepted** · Cases: setConfig.test.ts (creation
group, 8 cases), CF-10 live · Informs: api §D15

## Context

The same `setConfig({reasoning:'high'})` had four outcomes across five engines.
Measured on the wire: opencode, kimi and codex take it as
`session/set_config_option`; claude-code answered `ConfigError: unknown config
key`, because it advertises no config options over ACP at all. Its model is
settable — through `session/set_model`, the surface note 009 added — but its
thinking depth reached nothing realm could write.

The proposal on the table was to unify by levelling down: every engine supports
config at creation, none at runtime, one interface for callers.

## Decision

**1. Level up at creation, not down at runtime.** `session({config})` accepts
the same keys on every engine. Runtime writes stay a measured capability, and
`describe()` now says per option when it can be written.

**2. `ConfigOption.settable`.** Absent means `'session'` — creation and any
time after, which is every engine-advertised option. `'creation'` marks an
option the engine only accepts while the session is being built.

**3. `setConfig()` refuses a creation-only key with `NotSupportedError`**,
capability `config:<key>@runtime`. Not `ConfigError`: the key is known and the
value may be perfectly valid; what is absent is the engine's ability to take it
now, which is what Negotiated means.

**4. Adapters declare it as data.** `creationConfig` names the `_meta` path on
the creation request and maps realm's levels onto engine values. What `high`
means is the adapter's knowledge — a token budget here, a keyword elsewhere.

**5. Creation-only config rides every request that creates a session.** Not
just the first: the rebuilt resume tier and every reactivation that lands on it
create a new engine session, and a value that only arrives at creation cannot
be written back afterwards. A fork inherits its parent's.

## Rationale

Levelling down would have removed a capability three engines have, that CF-06
measured live, that realm's own CLI uses through `:config`, and that is frozen
v1 surface. It is also none of the three tiers: Core is what must work
everywhere, Negotiated is a typed refusal, Emulated is the library filling a
gap. "The engine can, and realm will not" is a fourth thing, and it makes realm
the ceiling rather than the substrate.

The gap that actually existed was at creation. Closing it gives callers one
interface and one rule — ask `describe()` what is settable and when — without
taking anything away. A host that wants no engine branching at all can restrict
itself to creation-time config; that is the caller's choice to make, not a
limit for realm to impose on every caller.

## Consequences

- claude-code takes `session({config:{reasoning}})`. Verified live (CF-10):
  `reasoning=high` accepted at creation and four `agent_thought_chunk` observed
  on the turn, with the runtime write refused as `NotSupportedError`.
- Engines that declare nothing are untouched: `settable` is absent, the split
  is empty, and no `_meta` is added — an empty object is a different message on
  the wire.
- `describe().source` does not change for a synthesised option. It is a
  descriptor-level field about probe versus adapter fallback, and
  claude-code's capabilities, models and modes really are probed; per-option
  provenance is what `settable` carries.
- The CLI's `describe` prints `creation only` beside such an option, so a
  reader does not follow the listing into a refusal.
- **This route is a wrapper contract, not ACP.** claude-code's thinking budget
  rides `_meta.claudeCode.options`, read once inside `@zed-industries/claude-code-acp`'s
  own session construction, and we fetch that package with `npx -y`. It can
  stop working on any release with no error at all — the setting would simply
  return to default. CF-10 exists for that: it asks the engine to think and
  counts what came back, so the drift shows up as a warn rather than as
  silence. It is opt-in (`LIVE_INCLUDE=CF-10`) because it costs a turn.
