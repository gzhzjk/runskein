/**
 * Live pi cases — opt-in, because they need a real pi, real credentials and a
 * real model, and they cost money and minutes.
 *
 * Run with `RUNSKEIN_LIVE_PI=1 pnpm --filter @runskein/conformance test`. They
 * are skipped otherwise so the hermetic gate stays the thing CI enforces.
 *
 * These exist because the two riskiest assumptions in the pi adapter cannot be
 * proven against a fixture: that pi's extension runtime loads the permission
 * gate and routes its dialog through RPC, and that a real model's tool call
 * arrives shaped the way the translation expects.
 *
 * Turn latency here is dominated by the provider, not by runskein: a rate-limited
 * account makes pi retry internally (visible as `_meta.pi.auto_retry_*`), which
 * is why the budgets are minutes rather than seconds.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, type TaskContext } from 'vitest';
import { ConfigError, createHub, jsonlStore, type TranscriptEvent } from 'runskein';
import { liveConfigFor, livePinRejectionReason } from '../src/liveSupport.js';

const live = process.env['RUNSKEIN_LIVE_PI'] === '1';
const workspace = (): string => mkdtempSync(join(tmpdir(), 'runskein-live-pi-ws-'));
const store = (): ReturnType<typeof jsonlStore> =>
  jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-live-pi-store-')));

type LiveHub = ReturnType<typeof createHub>;

/**
 * Create a pi session with the pinned live config from the adapter package's
 * live.config.json. A pi that rejects the pin skips the case instead of
 * failing it: the pin names this machine's environment, not the code under
 * test. The reason is logged first — ctx.skip() itself carries no note.
 * @param hub - the live hub.
 * @param ctx - the test context, used to skip on a rejected pin.
 * @param params - session parameters; the engine and config are owned here.
 * @returns the created session.
 * @throws anything that is not a pin rejection.
 */
async function liveSession(
  hub: LiveHub,
  ctx: TaskContext,
  params: Omit<Parameters<LiveHub['session']>[0], 'engine' | 'config'>,
): Promise<Awaited<ReturnType<LiveHub['session']>>> {
  const liveConfig = liveConfigFor('pi');
  try {
    return await hub.session({
      ...params,
      engine: 'pi',
      ...(liveConfig.config !== undefined ? { config: liveConfig.config } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      await hub.quit();
      console.log(`SKIP: ${livePinRejectionReason('pi', liveConfig)}: ${error.message}`);
      ctx.skip();
    }
    throw error;
  }
}

describe.skipIf(!live)('live pi', () => {
  it('PI-LV-01: spawn → prompt → streamed reply → usage', async (ctx) => {
    const hub = createHub({ store: store() });
    const s = await liveSession(hub, ctx, { cwd: workspace() });
    const chunks: string[] = [];
    s.on('update', (event) => {
      if (event.update.sessionUpdate === 'agent_message_chunk') {
        chunks.push((event.update as { content?: { text?: string } }).content?.text ?? '');
      }
    });

    const result = await s.prompt('Reply with exactly the word OK and nothing else. Do not use any tools.');
    expect(result.stopReason).toBe('end_turn');
    expect(chunks.join('')).toContain('OK');
    // pi reports usage per turn and prices it in USD; both must survive the
    // translation, and neither may be fabricated when the model is unpriced.
    const usage = s.usage();
    expect(usage.input).toBeGreaterThan(0);
    expect(usage.output).toBeGreaterThan(0);
    await hub.quit();
  }, 180_000);

  it('PI-LV-05: an allowed tool call runs and the file appears', async (ctx) => {
    const hub = createHub({ store: store() });
    const cwd = workspace();
    const asked: string[] = [];
    const s = await liveSession(hub, ctx, {
      cwd,
      permissionPolicy: (request) => {
        asked.push(`${request.tool}/${request.kind}`);
        return { outcome: 'allow' };
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));

    await s.prompt(
      'Create a file named gate.txt in the current directory containing exactly OK. Use your tools.',
    );
    // The gate really did intercept a real tool call, and the kind/locations
    // mapping is what a path-based policy would have matched on.
    expect(asked).toContain('write/edit');
    expect(existsSync(join(cwd, 'gate.txt'))).toBe(true);
    const calls = updates.filter((event) => event.update.sessionUpdate === 'tool_call');
    expect((calls[0]?.update as { locations?: { path: string }[] }).locations?.[0]?.path).toContain(
      'gate.txt',
    );
    await hub.quit();
  }, 300_000);

  it('PI-LV-05: a denied tool call never touches the filesystem', async (ctx) => {
    const hub = createHub({ store: store() });
    const cwd = workspace();
    let asked = 0;
    const s = await liveSession(hub, ctx, {
      cwd,
      permissionPolicy: () => {
        asked++;
        return { outcome: 'deny' };
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));

    await s.prompt('Create a file named denied.txt containing OK. Use your tools.');
    expect(asked).toBeGreaterThan(0);
    // The point of the whole permission bridge: a policy that says no means the
    // tool did not run, not that runskein reported a refusal after the fact.
    expect(existsSync(join(cwd, 'denied.txt'))).toBe(false);
    expect(
      updates.some(
        (event) =>
          event.update.sessionUpdate === 'tool_call_update' &&
          (event.update as { status?: string }).status === 'failed',
      ),
    ).toBe(true);
    await hub.quit();
  }, 300_000);
});
