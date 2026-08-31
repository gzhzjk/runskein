/**
 * The Core registration gate, wired for two modes:
 *
 * - CI (always): against the scripted mock agent fixture — hermetic, no
 *   engines, no auth. This is what makes the gate ENFORCED BY TEST.
 * - Live (opt-in): RUNSKEIN_GATE_ENGINES="opencode,kimi" runs the SAME cases
 *   against real installed engines — `pnpm conformance <id...>` from the
 *   repo root. Missing auth/binaries fail loudly; nothing is faked.
 */
import { resolve } from 'node:path';
import { coreGateSuite } from '../src/suite.js';
import { liveConfigFor } from '../src/liveSupport.js';
import { builtinAdapters } from 'runskein';
import type { EngineAdapter } from '@runskein/core';

// ── CI mode: the mock agent fixture ────────────────────────────────────────

const FIXTURE = resolve(import.meta.dirname, '../../core/test/fixtures/mock-agent.mjs');

const mockAdapter: EngineAdapter = {
  specVersion: 1,
  id: 'mock',
  launch: { command: process.execPath, args: [FIXTURE], startTimeoutMs: 10_000 },
};

coreGateSuite(mockAdapter, {
  timeoutMs: 30_000,
  // Makes env hygiene a REAL assertion: the fixture refuses initialize when
  // it sees the marker, so the case fails if core's scrub ever regresses.
  envHygieneEnv: { MOCK_REFUSE_ENV: 'CLAUDE_GATE_MARKER' },
  envHygieneScrub: [/^CLAUDE_GATE_MARKER$/],
  cancelEnv: { MOCK_PROMPT_DELAY_MS: '3000' },
  permissionEnv: { MOCK_ASK_PERMISSION: '1' },
  permission: {
    prompt: 'Try to write a file.',
    // The mock's tool call is kind 'edit' at /tmp/root.txt: allowed here so
    // the turn completes end_turn with the request answered through rules().
    rules: [{ tool: 'edit', pattern: '*', action: 'allow' }],
    expectRequest: true,
  },
});

// ── Live mode: real engines on demand ──────────────────────────────────────

const liveIds = (process.env['RUNSKEIN_GATE_ENGINES'] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

for (const id of liveIds) {
  const adapter = builtinAdapters.find((a) => a.id === id);
  if (!adapter) {
    throw new Error(
      `RUNSKEIN_GATE_ENGINES: unknown engine '${id}' — known: ${builtinAdapters.map((a) => a.id).join(', ')}`,
    );
  }
  // The pinned live config comes from the adapter package's live.config.json;
  // an engine that rejects it skips rather than fails (CoreGateOptions.config).
  const pinned = liveConfigFor(id).config;
  coreGateSuite(adapter, {
    timeoutMs: 300_000,
    ...(pinned !== undefined ? { config: pinned } : {}),
    permission: {
      prompt: 'Create a file named gate-permission.txt containing the word OK, using your file tools.',
      rules: [
        { tool: 'edit', pattern: '*', action: 'allow' },
        { tool: '*', pattern: '*', action: 'allow' },
      ],
      // Engines in permissive default modes may not ask at all; the
      // round-trip is asserted strictly only where we control the agent.
      expectRequest: false,
    },
  });
}
