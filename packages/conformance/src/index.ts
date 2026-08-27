/**
 * @runskein/conformance — the adapter registration gate.
 *
 * Re-exports the test-only seams (capability override, wire trace) that
 * deliberately do not exist on the public runskein surface. The gate suites
 * themselves live in suite.ts (Core gate) and storeSuite.ts (TranscriptStore
 * gate).
 */
import { builtinAdapters } from 'runskein';
import { Hub, type InternalHubOptions } from '@runskein/core/internal';

export { Hub, type InternalHubOptions };
export type { CapabilityOverride, WireFrame, WireObserver } from '@runskein/core/internal';

/**
 * Create a Hub with the mask-only capability override applied.
 * @param options - InternalHubOptions, including the test-only capabilityOverride.
 * @returns a Hub honoring the override in its capability masks.
 */
export function createHubWithOverride(options: InternalHubOptions): Hub {
  return new Hub(options);
}

/**
 * Create a Hub over the built-in adapters with the internal seams available.
 *
 * The live harness needs both at once: real engines, and the wire trace that
 * gives it an oracle independent of runskein's own bookkeeping. The public
 * `createHub` cannot carry the seams by design, and `createHubWithOverride`
 * does not bundle the built-in adapters, so neither alone covers a live run.
 * @param options - InternalHubOptions, including wireObserver and capabilityOverride.
 * @returns a Hub with the built-in adapters pre-registered and the seams applied.
 */
export function createLiveHub(options: InternalHubOptions = {}): Hub {
  return new Hub({ ...options, builtins: [...builtinAdapters] });
}
