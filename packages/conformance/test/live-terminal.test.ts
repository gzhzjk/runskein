/**
 * Client terminals against a real engine — opt-in.
 *
 * Run with `RUNSKEIN_LIVE_TERMINAL=1 pnpm --filter @runskein/conformance test`.
 * Needs kimi installed and authenticated, and spends model tokens.
 *
 * The hermetic cases in core drive the five terminal methods from a scripted
 * agent, which proves the plumbing. This proves the thing that plumbing exists
 * for: an engine that delegates command execution can actually do work under
 * runskein. It is the case whose absence let kimi pass every gate while being
 * unable to run a single command.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, createHub, jsonlStore, type TranscriptEvent } from 'runskein';
import { liveConfigFor, livePinRejectionReason } from '../src/liveSupport.js';

const live = process.env['RUNSKEIN_LIVE_TERMINAL'] === '1';

describe.skipIf(!live)('live client terminals', () => {
  it('kimi runs a command through runskein and answers from its output', async (ctx) => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-live-term-'));
    const marker = `marker-${Date.now()}`;
    writeFileSync(join(cwd, 'note.txt'), `alpha\nbeta\n${marker}\n`);

    const hub = createHub({
      store: jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-live-term-store-'))),
    });
    const asked: string[] = [];
    // The pinned model comes from the adapter's live.config.json; a kimi that
    // rejects it skips the case — the pin is this machine's environment, not
    // the code under test. The reason is logged first: ctx.skip() carries no
    // note.
    const liveConfig = liveConfigFor('kimi');
    let session: Awaited<ReturnType<typeof hub.session>>;
    try {
      session = await hub.session({
        engine: 'kimi',
        cwd,
        ...(liveConfig.config !== undefined ? { config: liveConfig.config } : {}),
        permissionPolicy: (request) => {
          asked.push(`${request.tool}/${request.kind ?? ''}`);
          return { outcome: 'allow' };
        },
      });
    } catch (error) {
      if (error instanceof ConfigError) {
        await hub.quit();
        console.log(`SKIP: ${livePinRejectionReason('kimi', liveConfig)}: ${error.message}`);
        ctx.skip();
      }
      throw error;
    }
    const updates: TranscriptEvent[] = [];
    const reply: string[] = [];
    session.on('update', (event) => {
      updates.push(event);
      if (event.update.sessionUpdate === 'agent_message_chunk') {
        reply.push((event.update as { content?: { text?: string } }).content?.text ?? '');
      }
    });

    const result = await session.prompt(
      'Run the shell command `cat note.txt` in the current directory using your tools, then reply with only the third line.',
    );
    await hub.quit();

    expect(result.stopReason).toBe('end_turn');
    // The engine got real output back, which is only possible if runskein ran the
    // command for it.
    expect(reply.join('')).toContain(marker);
    // And runskein's policy was on the path, rather than the command running
    // behind it.
    expect(asked.some((entry) => entry.startsWith('terminal/execute'))).toBe(true);
    expect(
      updates.some(
        (event) =>
          event.update.sessionUpdate === 'tool_call_update' &&
          (event.update as { status?: string }).status === 'failed',
      ),
    ).toBe(false);
  }, 300_000);
});
