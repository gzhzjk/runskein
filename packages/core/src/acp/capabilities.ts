/**
 * CapabilityMatrix normalization from the agent's `initialize` response,
 * plus the mask-only `capabilityOverride` test seam.
 */
import { ConfigError } from '../errors.js';
import type { CapabilityMatrix } from '../types.js';

/** Structural view of the ACP initialize response fields core cares about. */
export interface RawAgentCapabilities {
  loadSession?: boolean;
  sessionCapabilities?: Record<string, unknown>;
  promptCapabilities?: Record<string, unknown>;
  mcpCapabilities?: Record<string, unknown>;
  providers?: unknown;
}

/**
 * Coerce a raw capability record into boolean flags, tolerating missing keys.
 * @param raw - Optional capability record from the initialize response.
 * @returns A record of the same keys with truthy values coerced to booleans.
 */
function toBooleanRecord(raw: Record<string, unknown> | undefined): Record<string, boolean> {
  return Object.fromEntries(Object.entries(raw ?? {}).map(([k, v]) => [k, !!v]));
}

/**
 * Normalize the agent's raw capability fields into the runskein CapabilityMatrix.
 * @param caps - The raw initialize capability fields (may be undefined).
 * @returns A CapabilityMatrix with loadSession/providers flags and boolean records.
 */
export function normalizeCapabilities(caps: RawAgentCapabilities | undefined): CapabilityMatrix {
  return {
    loadSession: caps?.loadSession ?? false,
    session: toBooleanRecord(caps?.sessionCapabilities),
    prompt: toBooleanRecord(caps?.promptCapabilities),
    mcp: toBooleanRecord(caps?.mcpCapabilities),
    providers: !!caps?.providers,
  };
}

/** Test-only seam: re-exported via @runskein/conformance. */
export type CapabilityOverride = Record<string, Partial<CapabilityMatrix>>;

/**
 * Apply a mask to the measured matrix. Mask-only: an entry that would turn a
 * capability bit ON that the engine did not advertise is a ConfigError.
 * @param engineId - Engine id used in the ConfigError message/key.
 * @param matrix - The measured capability matrix.
 * @param override - The mask to apply; undefined returns the matrix unchanged.
 * @returns The masked capability matrix.
 * @throws `ConfigError` when the override would widen a capability the engine did not advertise.
 */
export function applyCapabilityOverride(
  engineId: string,
  matrix: CapabilityMatrix,
  override: Partial<CapabilityMatrix> | undefined,
): CapabilityMatrix {
  if (!override) return matrix;

  const widen = (path: string): never => {
    throw new ConfigError({
      engineId,
      message: `capabilityOverride for '${engineId}' may only mask capabilities off; '${path}' would widen`,
      key: path,
    });
  };

  const maskRecord = (
    current: Record<string, boolean>,
    mask: Record<string, boolean> | undefined,
    prefix: string,
  ): Record<string, boolean> => {
    if (!mask) return current;
    const out = { ...current };
    for (const [k, v] of Object.entries(mask)) {
      if (v && !current[k]) widen(`${prefix}.${k}`);
      out[k] = v;
    }
    return out;
  };

  if (override.loadSession && !matrix.loadSession) widen('loadSession');
  if (override.providers && !matrix.providers) widen('providers');
  return {
    loadSession: override.loadSession ?? matrix.loadSession,
    session: maskRecord(matrix.session, override.session, 'session'),
    prompt: maskRecord(matrix.prompt, override.prompt, 'prompt'),
    mcp: maskRecord(matrix.mcp, override.mcp, 'mcp'),
    providers: override.providers ?? matrix.providers,
  };
}
