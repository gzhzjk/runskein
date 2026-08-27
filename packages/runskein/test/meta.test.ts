/**
 * The runskein meta-package — the entry point a consumer actually imports.
 * Asserts its createHub really does bundle the built-in adapters, so the
 * quickstart works without any adapter configuration.
 */
import { describe, expect, it } from 'vitest';
import { builtinAdapters, createHub, policies, jsonlStore } from '../src/index.js';
import { createDiffCoverageJudge, createFolder } from '../src/fold.js';
import { validateAdapter } from '@runskein/core/internal';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runskein meta-package', () => {
  it('bundles the v1 adapters', () => {
    expect(builtinAdapters.map((a) => a.id).sort()).toEqual([
      'claude-code',
      'codex',
      'kimi',
      'opencode',
      'pi',
    ]);
    for (const adapter of builtinAdapters) {
      expect(adapter.specVersion).toBe(1);
      expect(adapter.launch.command.length).toBeGreaterThan(0);
      expect(typeof adapter.detect).toBe('function');
      // The shipped adapters must clear the same zod gate discovery enforces.
      expect(() => validateAdapter(adapter)).not.toThrow();
    }
  });

  it('createHub() registers the built-ins; engines() never spawns', async () => {
    const hub = createHub({ store: jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-meta-'))) });
    const engines = await hub.engines();
    const ids = engines.map((e) => e.id);
    for (const id of ['opencode', 'kimi', 'claude-code', 'codex']) {
      expect(ids).toContain(id);
    }
    // detect() ran (installed is a real boolean), but no process was spawned.
    const health = await hub.health();
    for (const id of ['opencode', 'kimi', 'claude-code', 'codex']) {
      expect(['stopped', 'not-installed', 'unauthenticated']).toContain(health[id]);
    }
    await hub.quit();
  });

  it('explicit adapters override a built-in by id', async () => {
    const hub = createHub({
      adapters: [
        {
          specVersion: 1,
          id: 'opencode',
          launch: { command: 'overridden-binary' },
        },
      ],
      store: jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-meta-'))),
    });
    const engines = await hub.engines();
    const opencode = engines.find((e) => e.id === 'opencode');
    // The override has no detect() hook, so installed defaults to assumed-true.
    expect(opencode).toMatchObject({ installed: true });
    await hub.quit();
  });

  it('HD-02: engines() reports the real installed version per adapter', async () => {
    // Each built-in detect() runs `<binary> --version`; assert the surfaced
    // EngineInfo.version matches, for every engine actually on this host.
    // Engines that are absent skip (environment-dependent, like PM-09).
    const versionCmd: Record<string, [string, string[]]> = {
      opencode: ['opencode', ['--version']],
      kimi: ['kimi', ['--version']],
      'claude-code': ['claude', ['--version']],
      codex: ['codex', ['--version']],
      pi: ['pi', ['--version']],
    };
    const hub = createHub({ store: jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-meta-'))) });
    const byId = new Map((await hub.engines()).map((e) => [e.id, e]));
    for (const adapter of builtinAdapters) {
      const info = byId.get(adapter.id);
      const [binary, args] = versionCmd[adapter.id]!;
      let real: string | undefined;
      try {
        real = execFileSync(binary, args, { encoding: 'utf8' }).trim();
      } catch {
        real = undefined; // engine absent on this host — skip
      }
      expect(info).toBeDefined();
      if (real === undefined) {
        expect(info!.installed).toBe(false);
      } else {
        expect(info!.installed).toBe(true);
        expect(info!.version).toBe(real);
        // Detect only — nothing was spawned, so health comes from discovery
        // alone and can never be a process state. An adapter shipping a real
        // auth probe (AC-4.5) legitimately reports 'unauthenticated' on a host
        // without credentials, which is exactly what CI's isolated HOME is;
        // hard-coding 'stopped' asserted the pre-probe world.
        expect(info!.health).toBe(info!.authenticated === false ? 'unauthenticated' : 'stopped');
      }
    }
    await hub.quit();
  });

  it('re-exports the core public surface', () => {
    expect(typeof policies.allowAll).toBe('function');
    expect(typeof jsonlStore).toBe('function');
  });

  it('re-exports the fold entry on its own subpath', () => {
    const folder = createFolder();
    expect(typeof folder.push).toBe('function');
    expect(typeof folder.flush).toBe('function');
    // The chain judgement is reachable on its own, for a consumer that needs
    // diff coverage without folding (decision 036).
    expect(typeof createDiffCoverageJudge().push).toBe('function');
  });
});
