/**
 * @runskein/testkit — a scripted ACP agent for consumers.
 *
 * Drives the whole runskein path — engine start, session creation, turns,
 * permissions, transcript, close — with no engine installed, no credentials,
 * no network and no model tokens. Intended for a consumer's own default CI
 * path, with real engines reserved for the runs that need them.
 *
 * What is promised, and what is not, is in this package's README: the agent's
 * `RUNSKEIN_TESTKIT_*` environment contract is public and versioned; its internal
 * wire chatter is not.
 */
import { fileURLToPath } from 'node:url';
import type { EngineAdapter } from '@runskein/core';

/**
 * Absolute path to the scripted agent's entry point.
 *
 * Resolved from this module rather than guessed from a package layout, so it
 * keeps working wherever the package is installed.
 * @returns the path to run with node.
 */
export function scriptedAgentPath(): string {
  return fileURLToPath(new URL('./scripted-agent.mjs', import.meta.url));
}

export interface ScriptedAdapterOptions {
  /** Engine id the adapter registers under. Default `'scripted'`. */
  id?: string;
  /** `RUNSKEIN_TESTKIT_*` variables configuring the agent's behaviour. */
  env?: Record<string, string>;
  /** Start budget in ms. Default 10 000, which is generous for a local node process. */
  startTimeoutMs?: number;
}

/**
 * Build an EngineAdapter that launches the scripted agent.
 *
 * Register it explicitly — `createHub({ adapters: [scriptedAdapter()] })` — so
 * a test hub never depends on what happens to be installed on the machine.
 * @param options - engine id, agent configuration, and start budget.
 * @returns an adapter ready to pass to `createHub`.
 */
export function scriptedAdapter(options: ScriptedAdapterOptions = {}): EngineAdapter {
  const adapter: EngineAdapter = {
    specVersion: 1,
    id: options.id ?? 'scripted',
    launch: {
      command: process.execPath,
      args: [scriptedAgentPath()],
      startTimeoutMs: options.startTimeoutMs ?? 10_000,
    },
    // A scripted agent is always installed and never authenticates: reporting
    // anything else would make a hub refuse sessions that work.
    detect: () => Promise.resolve({ installed: true, version: 'testkit' }),
  };
  if (options.env) adapter.launch.env = options.env;
  return adapter;
}
