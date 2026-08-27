/**
 * Acceptance cases for the capabilities an engine may or may not have: MCP
 * server plumbing, an interactive permission policy, mode configuration, and
 * resuming a session written by one store from another.
 *
 * Test-plan cases: SL-13, PE-04, PE-07, RS-07.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, NotSupportedError } from '../src/errors.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { sqliteStore } from '../src/transcript/sqliteStore.js';
import type { PermissionRequest } from '../src/permission/policy.js';
import type { TranscriptEvent } from '../src/transcript/event.js';
import type { McpServerConfig } from '../src/vocabulary.js';
import { makeHub, tmp } from './testkit.js';

describe('C — mcpServers plumbing (SL-13)', () => {
  it('an empty array succeeds; an http MCP server is plumbed and called', async () => {
    const nonce = `nonce-${Date.now()}`;
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: `echo:${nonce}` }));
    });
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}`;
    try {
      const hub = makeHub({ MOCK_MCP_NONCE: nonce });

      // Empty array must be accepted, not treated as "no plumbing".
      const empty = await hub.session({ engine: 'mock', cwd: tmp('runskein-sl13-'), mcpServers: [] });
      await empty.prompt('no server');
      await empty.close();

      const mcp: McpServerConfig = { type: 'http', name: 'echo', url, headers: [] };
      const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-sl13-'), mcpServers: [mcp] });
      const events: TranscriptEvent[] = [];
      s.on('update', (e) => events.push(e));
      await s.prompt('call echo_nonce');

      expect(requests.some((u) => u.includes('/echo_nonce') && u.includes(nonce))).toBe(true);
      const toolDone = events.find((e) => e.update.sessionUpdate === 'tool_call_update');
      expect(toolDone?.update).toMatchObject({ status: 'completed' });
      await s.close();
    } finally {
      server.close();
    }
  });

  it('an engine that does not advertise http MCP rejects with NotSupportedError', async () => {
    const hub = makeHub({ MOCK_NO_MCP_HTTP: '1' });
    const mcp: McpServerConfig = {
      type: 'http',
      name: 'echo',
      url: 'http://127.0.0.1:1',
      headers: [],
    };
    const err = await hub
      .session({ engine: 'mock', cwd: tmp('runskein-sl13-'), mcpServers: [mcp] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotSupportedError);
    expect((err as NotSupportedError).engineId).toBe('mock');
    expect((err as NotSupportedError).capability).toBe('mcp:http');
  });
});

describe('F — permission policy mechanics (PE)', () => {
  it('PE-04: mock-human picks an offered optionId; a bare outcome also maps', async () => {
    const hub = makeHub({ MOCK_ASK_PERMISSION: '1' });

    const human = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-pe04-'),
      permissionPolicy: async (req: PermissionRequest) => ({
        optionId: req.options.find((o) => o.kind === 'allow_once')!.optionId,
      }),
    });
    const ev1: TranscriptEvent[] = [];
    human.on('update', (e) => ev1.push(e));
    await human.prompt('do it');
    expect(ev1.find((e) => e.update.sessionUpdate === 'tool_call_update')?.update).toMatchObject({
      status: 'completed',
    });
    await human.close();

    const bare = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-pe04-'),
      permissionPolicy: () => ({ outcome: 'allow' }),
    });
    const ev2: TranscriptEvent[] = [];
    bare.on('update', (e) => ev2.push(e));
    await bare.prompt('do it');
    expect(ev2.find((e) => e.update.sessionUpdate === 'tool_call_update')?.update).toMatchObject({
      status: 'completed',
    });
    await bare.close();
  });

  it('PE-07: config.mode is accepted per engine modes; unknown mode is ConfigError', async () => {
    const hub = makeHub();
    const s = await hub.session({
      engine: 'mock',
      cwd: tmp('runskein-pe07-'),
      config: { mode: 'plan' },
    });
    await s.setConfig({ mode: 'default' });
    const err = await s.setConfig({ mode: 'bogus' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toMatchObject({ key: 'mode', validValues: ['default', 'plan'] });
    await s.close();
  });
});

describe('E — cross-store resume oracle (RS-07)', () => {
  it('migrated transcripts resume as rebuilt on the target store, both directions', async () => {
    const nonce = `magic-${Date.now()}`;
    const directions = [
      ['jsonl', 'sqlite'],
      ['sqlite', 'jsonl'],
    ] as const;

    for (const [from, to] of directions) {
      const srcDir = tmp('runskein-rs07-src-');
      const srcStore = from === 'jsonl' ? jsonlStore(srcDir) : sqliteStore(join(srcDir, 'events.db'));
      const hub = makeHub({}, { store: srcStore });
      const s = await hub.session({ engine: 'mock', cwd: tmp('runskein-rs07-') });
      await s.prompt(`remember the magic word: ${nonce}`);
      await s.close();
      const jsonl = await hub.transcripts.export(s.id, 'jsonl');
      await hub.quit();

      const tgtDir = tmp('runskein-rs07-tgt-');
      const targetStore = to === 'sqlite' ? sqliteStore(join(tgtDir, 'events.db')) : jsonlStore(tgtDir);
      for (const line of jsonl.split('\n').filter(Boolean)) {
        await targetStore.append(JSON.parse(line) as TranscriptEvent);
      }

      const hub2 = makeHub(
        {},
        {
          store: targetStore,
          capabilityOverride: { mock: { loadSession: false, session: { resume: false } } },
        },
      );
      const r = await hub2.session({ engine: 'mock', cwd: tmp('runskein-rs07-'), resume: s.id });
      expect(r.resumeTier).toBe('rebuilt');
      expect(r.id).toBe(s.id); // runskein identity survives the migration
      const digest = await hub2.transcripts.digest(s.id);
      expect(digest.text).toContain(nonce);
      await r.close();
    }
  });
});
