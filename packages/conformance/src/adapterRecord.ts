/**
 * Project a probe summary down to the part an adapter may publish as evidence.
 *
 * `adapters/<id>/conformance.json` is committed as evidence and exported to the
 * release repository. It used to be the engine's `docs/conformance/matrix.json`
 * row verbatim — byte-identical, measured — and that row is the file the export
 * manifest excludes, because probe output carries the operator's machine with
 * it. So the same data left this repository twice: once as
 * `matrix.public.json`, projected, and once per adapter, not.
 *
 * Two things it carried, both live when this was written:
 *
 * - claude-code's `agent` config option listed the eighteen agents that machine
 *   happened to have installed, by name and description — 8.6 kB of a 10 kB
 *   file. opencode's `model` option listed the providers it was logged into,
 *   19 kB of 20 kB.
 * - claude-code's `prompt.replyText` read
 *   `"OK**Notice:** Stop says: Shared memory: session complete."` — a Stop hook
 *   configured in the operator's own installation, appended to the engine's
 *   reply and published verbatim. That is decision-record territory: the same
 *   defect GZH-86 fixed in the matrix projection, in the file it did not touch.
 *   The export's internal-content scan cannot catch it, because it looks for
 *   known internal strings and this is an arbitrary sentence.
 *
 * This is a *sibling* of `scripts/project-conformance-matrix.mjs`, not a reuse
 * of it. That projection feeds the published capability tables, so it keeps five
 * whole keys and drops `agentInfo.name`. This one is the drift baseline the
 * adapter guide points at, so it keeps `agentInfo` whole — a capability claim is
 * only reproducible against the engine version it was measured on —
 * along with `protocolVersion`, `authMethods`, `modes`, `models`,
 * `commandExecution` and `close`, none of which the tables read.
 */

/** The fields the projection reads; everything else is carried through. */
export interface ProbeSummaryLike {
  configOptions?: {
    id: string;
    name: string;
    category?: string | null;
    type: string;
    options?: unknown;
  }[];
  prompt?: { replyText?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** One config option as it is published: what it is, not what it holds. */
export interface PublishedConfigOption {
  id: string;
  name: string;
  category?: string | null;
  type: string;
  optionCount: number;
}

/**
 * Count the settings an option offers, without reading any of their names.
 *
 * Deliberately not `optionValues` from `liveSupport.ts`, which flattens the same
 * two shapes for the live cases. That one reads a descriptor core has already
 * normalised and may throw on anything else; this one reads whatever the engine
 * put on the wire, where an unrecognised entry must count as one setting rather
 * than fail a probe write. The duplication is six lines and the alternative is a
 * `try` that would hide a shape change instead of recording it.
 * @param options - the option's `options` field, as recorded.
 * @returns the number of leaf settings, or 0 when the option offers none.
 */
function countSettings(options: unknown): number {
  if (!Array.isArray(options)) return 0;
  return options.reduce<number>((total, entry) => {
    const group = (entry as { options?: unknown } | null)?.options;
    return total + (Array.isArray(group) ? group.length : 1);
  }, 0);
}

/**
 * Project one probe summary into the adapter's publishable conformance record.
 *
 * Two cuts, and nothing else changes:
 *
 * - `prompt.replyText` is removed. It is the only free-text field, it is
 *   generated on the probe machine, and what it was evidence for — that the
 *   engine answered, and how — is carried by `prompt.stopReason` and
 *   `prompt.updateKinds`.
 * - Each config option keeps its identity and loses its values. Which values are
 *   the engine's own vocabulary (codex's `reasoning_effort`) and which are the
 *   machine's configuration (opencode's `model`) cannot be told apart
 *   structurally: `category` is `null` for claude-code's `agent` and `"model"`
 *   for both a provider list and a fixed one, and an allowlist of option ids
 *   would be engine knowledge in library code, which decision 045 has just
 *   finished removing. `optionCount` is kept because an option's *number* of
 *   settings is the drift the probe has actually caught — codex gaining `max`
 *   and `ultra` reasoning levels, CG-03 — and it names nothing. The values stay
 *   in `matrix.json`, which never leaves this repository and is where a
 *   maintainer looks when a count moves.
 *
 * @param summary - a probe summary, which is also a `matrix.json` row.
 * @returns a new object; the input is not modified.
 */
export function projectAdapterRecord<T extends ProbeSummaryLike>(
  summary: T,
): Omit<T, 'configOptions' | 'prompt'> & {
  configOptions?: PublishedConfigOption[];
  prompt?: Record<string, unknown>;
} {
  // Rebuilt in the input's own key order, not spread-then-append: the record is
  // a committed file a person reads and diffs, and moving `configOptions` and
  // `prompt` to the end would rewrite every line of it to say nothing.
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => {
      if (key === 'configOptions' && Array.isArray(value)) {
        return [
          key,
          (value as NonNullable<ProbeSummaryLike['configOptions']>).map((option) => ({
            id: option.id,
            name: option.name,
            ...(option.category === undefined ? {} : { category: option.category }),
            type: option.type,
            optionCount: countSettings(option.options),
          })),
        ];
      }
      if (key === 'prompt' && value !== null && typeof value === 'object') {
        return [key, Object.fromEntries(Object.entries(value).filter(([f]) => f !== 'replyText'))];
      }
      return [key, value];
    }),
  ) as Omit<T, 'configOptions' | 'prompt'> & {
    configOptions?: PublishedConfigOption[];
    prompt?: Record<string, unknown>;
  };
}
