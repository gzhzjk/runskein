# 009 — Model selection is its own protocol surface, not a config option

Date: 2026-08-06 · Status: accepted · Trigger: `hub.session({engine:'claude-code',
config:{model:'sonnet'}})` validated against a static adapter hint and then
failed with `NotSupportedError: does not support 'setConfig'`. The gap was
reported as a missing engine capability. It was not: the engine offers model
selection, and realm was looking in the wrong place.

## What was actually measured

On 2026-08-06, against `claude-code-acp`:

- `session/new` returns **`models`** alongside `modes` and `configOptions`:
  `{currentModelId, availableModels: [{modelId:'default'…}, {modelId:'sonnet'…},
{modelId:'haiku'…}]}`. realm read `configOptions` and `modes` and ignored
  `models` entirely.
- The wrapper implements **`session/set_model`**. Calling it with
  `{sessionId, modelId:'sonnet'}` succeeded, and the session then reported
  `claude-sonnet-4-5-20250929` where the unpinned default was `opus-4-6`.
- realm pins ACP SDK 1.3.0, whose method table has no model method at all; the
  wrapper bundles 0.14.1, which does. The surface was invisible from realm's
  side of the pin, which is why `configOptions` looked like the only route.

Two workarounds already in the tree were also measured, and **neither works**:

- `ANTHROPIC_MODEL` in the engine environment reaches the wrapper but not the
  `claude` process it spawns — the wrapper rebuilds the child environment, so
  the child runs with no `ANTHROPIC_*` set.
- `--model <id>` appended to the wrapper's launch arguments is accepted by the
  process but never reaches the child, which runs bare.

Under both, the session answered with the account default model.

## Decision

- `EngineDescriptor` gains **`models?: SessionModel[]`** and
  **`currentModel?: string`**, populated from `session/new`'s `models`.
- `setConfig({model})` routes to **`session/set_model`** when the engine
  advertised models and has **no** `model` config option, mirroring how `mode`
  routes to `session/set_mode`.
- When an engine exposes **both** surfaces, the config option wins. codex is
  this shape: it advertises `models` with reasoning-effort suffixes
  (`gpt-5.6-luna[medium]`) while its config option takes the bare id
  (`gpt-5.6-luna`). Preferring `models` there would have rejected ids that
  already worked, so the measured, stable surface takes precedence and
  `session/set_model` is the fallback for engines that have nothing else.
- The value is validated against the advertised model ids before anything is
  sent, so an unknown model is a `ConfigError` naming the valid ids rather than
  a wire rejection.
- `session/set_model` is issued through the raw request path: it is not in the
  pinned SDK's method table, and it is still unstable in the protocol. Presence
  of `models` in `session/new` is the capability gate.
- The claude-code adapter drops its static `configHints` for `model`. The real
  list is now discovered, and a hint would only shadow it.

## Rationale

1. The original report classified this as a negotiated-capability gap and
   proposed three directions, all of which routed around the problem — passing
   config through `session/new` (which has no config field), pinning the model
   through adapter environment (measured ineffective), or marking hint-sourced
   options unsettable (honest, but it would have frozen a capability the engine
   actually has). The defect was a missing implementation, not a missing
   capability.
2. Model belongs beside `modes`, not inside `configOptions`, because that is how
   engines model it on the wire. Folding it into `configOptions` would have
   required inventing a synthetic option and then special-casing its write path
   anyway.
3. Gating on the advertised `models` list rather than on a capability flag keeps
   the check truthful for an unstable method: an engine that stops advertising
   models stops being asked.

## Consequences

- `config: { model }` now works uniformly across engines. Verified live:
  `model=sonnet` produced `claude-sonnet-4-5-20250929` and `model=haiku`
  produced `claude-haiku-4-5-20251001`.
- `describe` reports models with the current one marked.
- The live suites' claude-code model pin was fixed as part of this change. Both
  its mechanisms were ineffective, so every pinned claude-code live run had been
  silently using the account default — opus — while reporting that it ran on
  sonnet. `LIVE_MODEL_PINS` now carries only a model id and every engine takes
  it through `config`.
- `session/set_model` is unstable. If it is renamed or restructured, the failure
  is a typed `NotSupportedError` from the existing wire-error mapping, and the
  gate is one line.
