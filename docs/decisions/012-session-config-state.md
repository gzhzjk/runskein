# 012 — `session.configState()`: desired writes and engine observations stay separate

Date: 2026-08-08 · Status: **accepted** · Trigger:
stabilization requirements AC-8.1 … AC-8.4. `setConfig` had no read
counterpart, so a host could write config but could not distinguish what realm
successfully requested from what the engine independently reports as active —
which also made the re-apply-on-reactivation behaviour of decision 014
unverifiable.

## Decision

`Session` gains one read-only method, `configState(): SessionConfigState`,
returning two deliberately different views:

```ts
interface SessionConfigState {
  desired: Readonly<Record<string, string | boolean>>;
  observed: Readonly<Record<string, ConfigObservation>>;
}

interface ConfigObservation {
  value: string | boolean;
  source:
    'session/new' | 'session/resume' | 'session/load' | 'current_mode_update' | 'config_option_update';
  observedAt: number; // epoch ms
  engineOptionId?: string;
}
```

- **`desired`** holds a key once the engine has acknowledged its write, recorded
  per write rather than per patch: a `setConfig` patch is several wire calls, so
  a later key failing must not erase what the engine already accepted. Config
  passed to `hub.session({ config })` lands here through the same path.
- **`observed`** holds only engine-originated reports: config state echoed by
  whichever call produced the session — `session/new`, `session/resume`, or
  `session/load`, each recorded under its own name — and pushed
  `current_mode_update` / `config_option_update` notifications. The three
  session-producing calls stay distinct rather than collapsing into one
  "creation" source, because a value a host reads back is only as trustworthy
  as the call that reported it.
- **`desired` is never copied into `observed`.** A key absent from `observed`
  means the engine never reported it.
- `configState()` issues no wire requests and returns a snapshot; later changes
  do not mutate an object a caller already holds.
- No new verbs beyond this getter, and `setConfig`'s behaviour is unchanged.

### Key space

Both maps use **realm keys** — `model`, `mode`, `reasoning`, or an engine option
id used directly — the same space `setConfig` accepts, so an observed key can be
fed straight back into a write. Reverse-mapping an engine report follows the
same precedence `setConfig` uses forward: a well-known id wins, then a category
alias (`model` → `model`, `thought_level` → `reasoning`, `mode` → `mode`), then
the option's own id.

That mapping is not total, and where it fails **the observation is recorded
under the raw engine option id rather than dropped** — losing an engine's report
would be exactly the silent degradation this capability exists to prevent. Two
options sharing one category would collide on a single alias; the first keeps
the alias and the rest fall back to their own ids, which is lossless and still
addressable.

## Rationale

The resume-fidelity experiment's model/mode column reads "no evidence either
way" because there was no surface to ask. The tempting fix — have `setConfig`
remember what it wrote and call that the session's config — would have closed
the gap on paper while making it permanently unmeasurable: realm would report
its own intent back to the host as though it were engine truth, and a model
silently reset by a resume would look identical to one correctly restored. The
whole value here is the _difference_ between the two maps, so they are built to
be different and are never merged.

`observedAt` and `source` exist for the same reason. A host reconciling state
after a reactivation needs to know whether the engine's report predates or
follows the re-application, and a value observed at session creation is weaker
evidence than one the engine pushed afterwards.

## Consequences

- `SessionConfigState` and `ConfigObservation` are public types exported from
  `@realm-node/core` and `realm-node`; changing them needs a new note.
- **`session/load` is its own source.** An earlier draft of this note left load
  state unrecorded because the source union had no member for it, and
  mislabelling a load result as `'session/resume'` would have misattributed
  provenance. The union was the thing that was wrong: a load-tier resume
  genuinely observed state, and leaving `observed` empty for those sessions is
  the same silent degradation the capability exists to prevent. All three
  session-producing calls now report under their own names.
- **`engineOptionId` is populated on every observation that came from an engine
  config-option report**, including entries whose realm key already equals that
  id. The design chapter's field comment says "present when it differs from the
  realm key", but that reading conflicts with the same chapter's stated purpose
  ("a caller can always tell which wire identifier produced the entry", and an
  unmapped key must be recognizable) — an entry keyed by a raw engine id has
  key == id, so a differs-only rule would omit the field exactly where it is
  needed. Always populating it satisfies both stated purposes; the cost is that
  presence alone does not imply the key is an alias. Callers wanting that test
  should compare `key !== engineOptionId`. Reports that carry no option id on
  the wire — a pushed current mode, or a model named in session creation state —
  leave the field absent.
- `observed` reflects what the engine said, so an engine that reports nothing
  leaves it empty forever. That is the measurement §2.2's verification needs:
  absence stays explicit and is never counted as fidelity evidence.
