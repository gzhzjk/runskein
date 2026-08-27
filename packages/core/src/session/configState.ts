/**
 * Session config state — what runskein asked for versus what the engine says.
 *
 * These are deliberately two different questions. `setConfig` only ever told a
 * host that a write was accepted on the wire; whether the engine actually runs
 * on that model afterwards is something only the engine can report, and most
 * engines never do. Collapsing the two would let runskein claim knowledge it does
 * not have — so `desired` and `observed` are kept apart, and `desired` is never
 * copied into `observed` to fill a gap.
 */

/**
 * Calls that produce a session and may echo its current config state.
 *
 * All three are distinct sources rather than one "creation" bucket: a value a
 * host reads back is only as trustworthy as the call that reported it, so
 * collapsing them would erase the difference between an engine that restored
 * state and one that merely started fresh.
 */
export type SessionStateSource = 'session/new' | 'session/resume' | 'session/load';

/** The raw result of a session-producing call, with the call that returned it. */
export interface SessionCreationState {
  state: unknown;
  source: SessionStateSource;
}

/** One engine-originated report of a config value, with its provenance. */
export interface ConfigObservation {
  value: string | boolean;
  /** The wire event that carried this value. */
  source: SessionStateSource | 'current_mode_update' | 'config_option_update';
  /** When runskein received the report, in epoch milliseconds. */
  observedAt: number;
  /**
   * The engine-side option id this observation came from, when the report
   * carried one. Present on every config-option report so a host can always
   * trace an entry back to its wire identifier; absent for reports that have no
   * option id on the wire (a pushed current mode, or a model named in session
   * creation state). An entry whose key equals this id is keyed by the raw
   * engine identifier because no runskein key could be resolved for it.
   */
  engineOptionId?: string;
}

/**
 * A session's configuration as two independent views.
 *
 * `desired` holds values whose write the engine acknowledged — including the
 * config passed at session creation and anything runskein re-applies after a
 * reactivation. `observed` holds only what the engine itself reported. A key
 * missing from `observed` means the engine never said, which is not the same as
 * the value being unset, and must not be read as agreement with `desired`.
 */
export interface SessionConfigState {
  desired: Readonly<Record<string, string | boolean>>;
  observed: Readonly<Record<string, ConfigObservation>>;
}

/** Engine option categories that runskein addresses under a different key. */
const CATEGORY_ALIAS: Readonly<Record<string, string>> = {
  model: 'model',
  thought_level: 'reasoning',
  mode: 'mode',
};

/**
 * Read a config value off an engine-reported option payload.
 * @param option - one entry of a configOptions array, unvalidated.
 * @returns the id, value, and category when the entry is usable, else undefined.
 */
function readOption(
  option: unknown,
): { id: string; value: string | boolean; category?: string } | undefined {
  if (typeof option !== 'object' || option === null) return undefined;
  const raw = option as Record<string, unknown>;
  const id = raw['id'];
  const value = raw['currentValue'];
  if (typeof id !== 'string') return undefined;
  if (typeof value !== 'string' && typeof value !== 'boolean') return undefined;
  const category = raw['category'];
  return {
    id,
    value,
    ...(typeof category === 'string' ? { category } : {}),
  };
}

/**
 * Accumulates a session's desired writes and engine observations.
 *
 * Every recording path is synchronous and free of wire calls, so it can run
 * inside a notification handler and so the public getter never blocks or emits
 * traffic.
 */
export class ConfigStateTracker {
  private readonly desired = new Map<string, string | boolean>();
  private readonly observed = new Map<string, ConfigObservation>();

  /**
   * Record a config write the engine acknowledged.
   * @param key - the runskein config key the caller wrote.
   * @param value - the acknowledged value.
   */
  recordDesired(key: string, value: string | boolean): void {
    this.desired.set(key, value);
  }

  /**
   * Record the config state an engine reported when creating or resuming a
   * session: its current mode, its current model, and any config options that
   * came with a current value.
   * @param state - the raw result of the session-producing call, unvalidated.
   * @param source - which call produced it.
   */
  recordSessionState(state: unknown, source: SessionStateSource): void {
    if (typeof state !== 'object' || state === null) return;
    const raw = state as Record<string, unknown>;

    const modes = raw['modes'];
    if (typeof modes === 'object' && modes !== null) {
      const current = (modes as Record<string, unknown>)['currentModeId'];
      // No option id rides on the modes block; 'mode' is runskein's own name for
      // this control, so there is no wire identifier to attribute.
      if (typeof current === 'string') this.put('mode', current, source, undefined);
    }

    const models = raw['models'];
    if (typeof models === 'object' && models !== null) {
      const current = (models as Record<string, unknown>)['currentModelId'];
      if (typeof current === 'string') this.put('model', current, source, undefined);
    }

    const options = raw['configOptions'];
    if (Array.isArray(options)) this.putOptions(options, source);
  }

  /**
   * Record an engine-pushed mode change.
   * @param currentModeId - the mode the engine says is now active.
   */
  recordModeUpdate(currentModeId: unknown): void {
    if (typeof currentModeId !== 'string') return;
    this.put('mode', currentModeId, 'current_mode_update', undefined);
  }

  /**
   * Record an engine-pushed config option change.
   * @param options - the configOptions array from the notification, unvalidated.
   */
  recordConfigOptionUpdate(options: unknown): void {
    if (!Array.isArray(options)) return;
    this.putOptions(options, 'config_option_update');
  }

  /**
   * Snapshot both views.
   *
   * Observations are shared with the tracker rather than copied, which is safe
   * because each one is frozen when recorded — a caller cannot reach through
   * the snapshot and rewrite what the engine reported.
   * @returns the current desired and observed maps; later changes do not affect it.
   */
  snapshot(): SessionConfigState {
    return {
      desired: Object.freeze(Object.fromEntries(this.desired)),
      observed: Object.freeze(Object.fromEntries(this.observed)),
    };
  }

  /**
   * Record every usable option in an engine-reported configOptions array.
   * @param options - the raw array.
   * @param source - the wire event that carried it.
   */
  private putOptions(options: unknown[], source: ConfigObservation['source']): void {
    for (const entry of options) {
      const option = readOption(entry);
      if (option === undefined) continue;
      this.put(this.runskeinKeyFor(option), option.value, source, option.id);
    }
  }

  /**
   * Choose the key an engine option is recorded under.
   *
   * It mirrors how `setConfig` resolves a key forward — option id first, then
   * category alias — so a host can feed an observed key straight back into a
   * write. When no runskein key can be resolved the raw engine id is used, because
   * dropping an engine's report is the silent failure this class exists to
   * prevent.
   * @param option - the reported option's id and category.
   * @returns the key to record the observation under.
   */
  private runskeinKeyFor(option: { id: string; category?: string }): string {
    if (option.id === 'model' || option.id === 'mode' || option.id === 'reasoning') return option.id;
    const alias = option.category === undefined ? undefined : CATEGORY_ALIAS[option.category];
    if (alias === undefined) return option.id;
    // Two options sharing one category would collapse into a single key and
    // lose a report. The first keeps the alias; the rest fall back to their own
    // ids, which is lossless and still addressable.
    const held = this.observed.get(alias);
    if (held !== undefined && held.engineOptionId !== undefined && held.engineOptionId !== option.id) {
      return option.id;
    }
    return alias;
  }

  /**
   * Store one observation, replacing any earlier report for the same key.
   * @param key - the runskein key (or raw engine id when unmapped).
   * @param value - the reported value.
   * @param source - the wire event that carried it.
   * @param engineOptionId - the wire option id, when the report carried one.
   */
  private put(
    key: string,
    value: string | boolean,
    source: ConfigObservation['source'],
    engineOptionId: string | undefined,
  ): void {
    // Frozen on the way in: snapshots hand these objects straight to callers,
    // and `Readonly<...>` alone would let one rewrite a recorded observation at
    // runtime — corrupting the engine's report inside the tracker.
    this.observed.set(
      key,
      Object.freeze({
        value,
        source,
        observedAt: Date.now(),
        ...(engineOptionId !== undefined ? { engineOptionId } : {}),
      }),
    );
  }
}
