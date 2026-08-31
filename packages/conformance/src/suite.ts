/**
 * The Core gate — the adapter registration mechanism: an adapter is
 * registrable if and only if this suite passes against it. It drives the
 * public Hub/Session surface only, so it tests what consumers actually get
 * rather than internals, and covers the capabilities every engine must have:
 *
 *   spawn → initialize → session/new → prompt → streamed updates → stop
 *   reason → cleanup, plus a spawn from a polluted environment, cancel
 *   mid-turn, and a permission round-trip under a rules policy.
 *
 * CI runs it against the scripted mock agent; setting `RUNSKEIN_GATE_ENGINES`
 * runs the same cases against real installed engines.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, type TaskContext } from 'vitest';
import {
  createHub,
  jsonlStore,
  policies,
  CancelledError,
  ConfigError,
  type EngineAdapter,
  type Hub,
  type PermissionRule,
  type Session,
  type TranscriptEvent,
} from '@runskein/core';
import { livePinRejectionReason } from './liveSupport.js';

export interface CoreGateOptions {
  /** A prompt that finishes quickly with a short deterministic reply. */
  quickPrompt?: string;
  /** A prompt long enough that cancel() lands mid-turn. */
  longPrompt?: string;
  /**
   * Permission round-trip config: a prompt that makes the engine request
   * permission, plus the policies.rules table answering it. Live engines
   * need a trigger recipe; the mock uses its toggle env.
   */
  permission?: {
    prompt: string;
    rules: PermissionRule[];
    /** Expected to have been asked at least once. */
    expectRequest?: boolean;
  };
  /** Per-case timeout budget (real engines need generous ones). */
  timeoutMs?: number;
  /** Extra adapter env for the permission case only (mock toggles). */
  permissionEnv?: Record<string, string>;
  /** Extra adapter env for the cancel case only (mock toggles). */
  cancelEnv?: Record<string, string>;
  /** Extra adapter env for the env-hygiene case only (mock toggles). */
  envHygieneEnv?: Record<string, string>;
  /**
   * The scrub the adapter under test declares for the env-hygiene case — the
   * marker a scripted agent refuses on. A real engine needs nothing here: its
   * own adapter already declares its markers (decision 045). A fixture agent
   * has no adapter of its own, so the case hands it one, which is also what
   * keeps the case honest — core scrubs nothing on its own, so a case that
   * passed without this would be proving something else.
   */
  envHygieneScrub?: RegExp[];
  /**
   * Pinned live config applied at every session creation — the live branch
   * passes the engine's adapter live.config.json record. When set and the
   * engine rejects it with a ConfigError, the case skips rather than fails:
   * the pin names the machine's environment, not a gate regression. The mock
   * branch must leave this unset — the mock has no config surface and would
   * rightly refuse one.
   */
  config?: Record<string, string | boolean>;
}

/**
 * Return the adapter with extra env vars merged into its launch env.
 * @param adapter - the base adapter.
 * @param extra - the env vars to add, or undefined to return the adapter unchanged.
 * @returns the modified adapter.
 */
function withEnv(adapter: EngineAdapter, extra: Record<string, string> | undefined): EngineAdapter {
  if (!extra) return adapter;
  return {
    ...adapter,
    launch: { ...adapter.launch, env: { ...adapter.launch.env, ...extra } },
  };
}

/**
 * Give an adapter the scrub patterns a fixture agent's own package would carry.
 * @param adapter - the adapter to gate.
 * @param extra - patterns to declare, or undefined to leave the adapter alone.
 * @returns the adapter, or a copy declaring the patterns.
 */
function withScrub(adapter: EngineAdapter, extra: RegExp[] | undefined): EngineAdapter {
  if (!extra) return adapter;
  return { ...adapter, envScrubExtra: [...(adapter.envScrubExtra ?? []), ...extra] };
}

/**
 * Register the Core gate cases against one adapter.
 * @param adapter - the adapter to gate.
 * @param opts - prompts, timeouts, and per-case env toggles.
 */
export function coreGateSuite(adapter: EngineAdapter, opts: CoreGateOptions = {}): void {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const quickPrompt =
    opts.quickPrompt ?? 'Reply with exactly the word OK and nothing else. Do not use any tools.';
  const longPrompt =
    opts.longPrompt ??
    'Write a very detailed 10,000-word essay about the history of computing. Do not use tools.';

  describe(`Core gate: ${adapter.id}`, () => {
    const hubs: Hub[] = [];
    function hub(engineAdapter: EngineAdapter = adapter): Hub {
      const h = createHub({
        discovery: false,
        adapters: [engineAdapter],
        store: jsonlStore(mkdtempSync(join(tmpdir(), `runskein-gate-${adapter.id}-`))),
      });
      hubs.push(h);
      return h;
    }
    const cwd = () => mkdtempSync(join(tmpdir(), `runskein-gate-ws-`));

    /**
     * Create a session with the pinned live config when one is set. A live
     * engine that rejects the pin skips the case (see CoreGateOptions.config);
     * the reason is logged first because ctx.skip() carries no note.
     * @param h - the case's hub.
     * @param ctx - the test context, used to skip on a rejected pin.
     * @param params - session parameters, minus the engine id, which the gate owns.
     * @returns the created session.
     * @throws anything that is not a pin rejection.
     */
    async function gateSession(
      h: Hub,
      ctx: TaskContext,
      params: Omit<Parameters<Hub['session']>[0], 'engine' | 'config'>,
    ): Promise<Session> {
      try {
        return await h.session({
          ...params,
          engine: adapter.id,
          ...(opts.config !== undefined ? { config: opts.config } : {}),
        });
      } catch (error) {
        if (opts.config !== undefined && error instanceof ConfigError) {
          // The engine's own message names the rejected key and valid values.
          console.log(
            `SKIP core gate ${adapter.id}: ${livePinRejectionReason(adapter.id, { config: opts.config })}: ${error.message}`,
          );
          ctx.skip();
        }
        throw error;
      }
    }

    afterAll(async () => {
      // Cleanup is part of the registration contract: a quit failure must
      // fail the gate instead of being silently discarded.
      await Promise.all(hubs.splice(0).map((h) => h.quit()));
    });

    it(
      'registers and reports inventory without spawning',
      async () => {
        const h = hub();
        const engines = await h.engines();
        expect(engines.map((e) => e.id)).toContain(adapter.id);
        expect((await h.health())[adapter.id]).toBe('stopped');
      },
      timeoutMs,
    );

    it(
      'spawn → initialize → session/new → prompt → streamed updates → stop reason → cleanup',
      async (ctx) => {
        const h = hub();
        const s = await gateSession(h, ctx, { cwd: cwd() });
        expect(s.status).toBe('idle');

        const updates: TranscriptEvent[] = [];
        const statuses: string[] = [];
        s.on('update', (e) => updates.push(e));
        s.on('status', (st) => statuses.push(st));

        const result = await s.prompt(quickPrompt);
        expect(result.stopReason).toBe('end_turn');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        // Streamed text reached the consumer, correctly enveloped.
        expect(updates.some((e) => e.update.sessionUpdate === 'agent_message_chunk')).toBe(true);
        for (const e of updates) {
          expect(e.sessionId).toBe(s.id);
          expect(e.engineId).toBe(adapter.id);
          expect(e.ts).toBeGreaterThan(1_700_000_000_000);
        }
        const seqs = updates.map((e) => e.seq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        expect(new Set(seqs).size).toBe(seqs.length);
        expect(statuses[0]).toBe('running');
        expect(statuses).toContain('idle');

        // The turn persisted; the transcript replays through the public API.
        const persisted: TranscriptEvent[] = [];
        for await (const e of s.transcript()) persisted.push(e);
        expect(persisted.some((e) => e.update.sessionUpdate === 'user_message_chunk')).toBe(true);

        // Cleanup: close is honored and idempotent; late prompts reject.
        await s.close();
        expect(s.status).toBe('closed');
        await s.close();
        await expect(s.prompt('nope')).rejects.toBeInstanceOf(CancelledError);
        expect((await h.sessions({ status: 'closed' })).map((m) => m.sessionId)).toContain(s.id);
      },
      timeoutMs,
    );

    it(
      'env hygiene: a polluted host-agent environment does not break the spawn',
      async (ctx) => {
        // Simulates running inside a parent agent session: leaked CLAUDE*
        // markers were measured to make the Claude Code ACP wrapper refuse to
        // start. What is proved is that core applies the scrub the adapter
        // being spawned declares — a real engine declares its own, and a
        // scripted one is handed the same thing through `envHygieneScrub`.
        process.env['CLAUDE_GATE_MARKER'] = 'leaky-parent-session';
        process.env['CODEX_SANDBOX_GATE'] = '1';
        try {
          const h = hub(withScrub(withEnv(adapter, opts.envHygieneEnv), opts.envHygieneScrub));
          const s = await gateSession(h, ctx, { cwd: cwd() });
          const result = await s.prompt(quickPrompt);
          expect(result.stopReason).toBe('end_turn');
          await s.close();
        } finally {
          delete process.env['CLAUDE_GATE_MARKER'];
          delete process.env['CODEX_SANDBOX_GATE'];
        }
      },
      timeoutMs,
    );

    it(
      'cancel mid-turn: active prompt RESOLVES stopReason=cancelled; session survives',
      async (ctx) => {
        const h = hub(withEnv(adapter, opts.cancelEnv));
        const s = await gateSession(h, ctx, { cwd: cwd() });
        const firstChunk = new Promise<void>((res) => {
          const un = s.on('update', (e) => {
            if (
              e.update.sessionUpdate === 'agent_message_chunk' ||
              e.update.sessionUpdate === 'agent_thought_chunk'
            ) {
              un();
              res();
            }
          });
        });
        const active = s.prompt(longPrompt);
        const queued = s.prompt('never runs');
        queued.catch(() => {});
        await firstChunk;
        await s.cancel();
        const result = await active; // the active turn resolves, not rejects
        expect(result.stopReason).toBe('cancelled');
        await expect(queued).rejects.toBeInstanceOf(CancelledError);
        expect(s.status).toBe('idle'); // survives
        const again = await s.prompt(quickPrompt);
        expect(again.stopReason).toBe('end_turn');
        await s.close();
      },
      timeoutMs,
    );

    if (opts.permission) {
      const permission = opts.permission;
      it(
        'permission round-trip under policies.rules answers the engine',
        async (ctx) => {
          const h = hub(withEnv(adapter, opts.permissionEnv));
          let requests = 0;
          const s = await gateSession(h, ctx, {
            cwd: cwd(),
            permissionPolicy: (req) => {
              requests++;
              return policies.rules(permission.rules)(req);
            },
          });
          const result = await s.prompt(permission.prompt);
          expect(['end_turn', 'refusal']).toContain(result.stopReason);
          if (permission.expectRequest !== false) {
            expect(requests).toBeGreaterThan(0);
          }
          await s.close();
        },
        timeoutMs,
      );
    }
  });
}
