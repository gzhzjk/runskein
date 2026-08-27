/**
 * The testkit's own gate: the scripted agent has to carry a consumer through
 * the path they would otherwise need a real engine for — create, turns,
 * streaming, permissions, cancellation, transcript, close.
 *
 * These run against the package's public surface (`scriptedAdapter`), because
 * that is what a consumer gets. A behaviour asserted here is one this package
 * promises; see README.md for the contract that goes with it.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createHub, jsonlStore, policies, type Hub, type TranscriptEvent } from '@runskein/core';
import { scriptedAdapter, scriptedAgentPath } from '../src/index.js';

const hubs: Hub[] = [];
const scratch = (): string => mkdtempSync(join(tmpdir(), 'runskein-testkit-'));

/**
 * A hub running only the scripted agent.
 * @param env - RUNSKEIN_TESTKIT_* configuration for the agent.
 * @returns the hub.
 */
function hub(env: Record<string, string> = {}): Hub {
  const created = createHub({
    discovery: false,
    adapters: [scriptedAdapter({ env })],
    store: jsonlStore(scratch()),
  });
  hubs.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.quit()));
});

describe('scripted agent', () => {
  it('resolves to a file that exists', () => {
    expect(scriptedAgentPath()).toMatch(/scripted-agent\.mjs$/);
  });

  it('carries a session through two turns, a transcript, and a close', async () => {
    const h = hub();
    const s = await h.session({ engine: 'scripted', cwd: scratch() });

    expect((await s.prompt('first')).stopReason).toBe('end_turn');
    expect((await s.prompt('second')).stopReason).toBe('end_turn');

    const persisted: TranscriptEvent[] = [];
    for await (const event of s.transcript()) persisted.push(event);
    const replies = persisted
      .filter((e) => e.update.sessionUpdate === 'agent_message_chunk')
      .map((e) => (e.update as { content?: { text?: string } }).content?.text);
    expect(replies).toEqual(['OK1', 'OK2']);

    await s.close();
    expect(s.status).toBe('closed');
  }, 30_000);

  it('echoes the prompt back when asked to', async () => {
    const h = hub({ RUNSKEIN_TESTKIT_ECHO_PROMPT: '1' });
    const s = await h.session({ engine: 'scripted', cwd: scratch() });
    const seen: string[] = [];
    s.on('update', (event) => {
      if (event.update.sessionUpdate === 'agent_message_chunk') {
        seen.push((event.update as { content?: { text?: string } }).content?.text ?? '');
      }
    });
    await s.prompt('say this back');
    expect(seen.join('')).toBe('say this back');
  }, 30_000);

  it('answers a permission request through the consumer policy', async () => {
    const h = hub({ RUNSKEIN_TESTKIT_ASK_PERMISSION: '1' });
    let asked = 0;
    const s = await h.session({
      engine: 'scripted',
      cwd: scratch(),
      permissionPolicy: (request) => {
        asked++;
        expect(request.kind).toBe('edit');
        return policies.rules([{ tool: 'edit', pattern: '*', action: 'allow' }])(request);
      },
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));

    expect((await s.prompt('write something')).stopReason).toBe('end_turn');
    expect(asked).toBe(1);
    expect(
      updates
        .filter((e) => e.update.sessionUpdate === 'tool_call_update')
        .map((e) => (e.update as { status?: string }).status),
    ).toContain('completed');
  }, 30_000);

  it('marks the tool call failed when the policy denies it', async () => {
    const h = hub({ RUNSKEIN_TESTKIT_ASK_PERMISSION: '1' });
    const s = await h.session({
      engine: 'scripted',
      cwd: scratch(),
      permissionPolicy: () => ({ outcome: 'deny' }),
    });
    const updates: TranscriptEvent[] = [];
    s.on('update', (event) => updates.push(event));
    await s.prompt('write something');
    expect(
      updates
        .filter((e) => e.update.sessionUpdate === 'tool_call_update')
        .map((e) => (e.update as { status?: string }).status),
    ).toContain('failed');
  }, 30_000);

  it('holds a turn open long enough to cancel it', async () => {
    const h = hub({ RUNSKEIN_TESTKIT_PROMPT_DELAY_MS: '5000' });
    const s = await h.session({ engine: 'scripted', cwd: scratch() });
    const active = s.prompt('take your time');
    await new Promise<void>((done) => {
      const off = s.on('update', (event) => {
        if (event.update.sessionUpdate === 'agent_message_chunk') {
          off();
          done();
        }
      });
    });
    await s.cancel();
    // The turn resolves rather than rejecting, which is runskein's contract and
    // therefore what a consumer's own tests need to be able to reproduce.
    expect((await active).stopReason).toBe('cancelled');
    expect((await s.prompt('and again')).stopReason).toBe('end_turn');
  }, 30_000);

  it('reports usage and a stop reason on request', async () => {
    const h = hub({ RUNSKEIN_TESTKIT_EMIT_USAGE: '1', RUNSKEIN_TESTKIT_STOP_REASON: 'max_tokens' });
    const s = await h.session({ engine: 'scripted', cwd: scratch() });
    expect((await s.prompt('hi')).stopReason).toBe('max_tokens');
    expect(s.usage().cost).toBeCloseTo(0.01, 6);
  }, 30_000);

  it('masks capabilities so a consumer can exercise the unsupported paths', async () => {
    const h = hub({ RUNSKEIN_TESTKIT_NO_FORK: '1' });
    const s = await h.session({ engine: 'scripted', cwd: scratch() });
    await expect(s.fork()).rejects.toThrow();
  }, 30_000);

  it('refuses to start when a named variable leaks in', async () => {
    // The env-hygiene case a consumer needs: prove your host is not handing the
    // engine markers from its own session.
    const h = hub({ RUNSKEIN_TESTKIT_REFUSE_ENV: 'RUNSKEIN_TESTKIT_MARKER' });
    process.env['RUNSKEIN_TESTKIT_MARKER'] = 'leaked';
    try {
      await expect(h.session({ engine: 'scripted', cwd: scratch() })).rejects.toThrow();
    } finally {
      delete process.env['RUNSKEIN_TESTKIT_MARKER'];
    }
  }, 30_000);
});
