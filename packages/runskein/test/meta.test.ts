/**
 * The runskein meta-package — the entry point a consumer actually imports.
 * Asserts its createHub really does bundle the built-in adapters, so the
 * quickstart works without any adapter configuration.
 */
import { describe, expect, it } from 'vitest';
import { Hub, builtinAdapters, createHub, policies, jsonlStore } from '../src/index.js';
import { createDiffCoverageJudge, createFolder } from '../src/fold.js';
import { scrubEnv, validateAdapter } from '@runskein/core/internal';
import type { EngineAdapter } from '@runskein/core';
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

  // Decision 045 moved the env scrub out of core and into the adapters, so
  // this is where "no marker was lost on the way" is now provable. Core's list
  // is empty; if a bundled adapter drops its declaration, nothing else fails.
  describe('each engine declares the session markers it leaves behind', () => {
    /** Scrub the name with the named adapter's own patterns only. */
    const scrubbedFor = (id: string, name: string): boolean => {
      const adapter = builtinAdapters.find((a) => a.id === id);
      expect(adapter).toBeDefined();
      return !Object.hasOwn(scrubEnv({ [name]: 'v' }, adapter?.envScrubExtra ?? []), name);
    };

    // Every marker core used to hold, attributed to the engine that leaves it.
    it.each([
      ['claude-code', 'CLAUDE_SESSION_ID'],
      ['claude-code', 'CLAUDECODE'],
      ['codex', 'CODEX_SANDBOX_MODE'],
      ['opencode', 'OPENCODE_SESSION'],
      ['opencode', 'OPENCODE_CALLER'],
      ['pi', 'PI_CODING_AGENT'],
      ['pi', 'PI_SESSION_ID'],
    ])('%s scrubs %s', (id, name) => {
      expect(scrubbedFor(id, name)).toBe(true);
    });

    // The patterns are anchored, and these are what the anchoring is for: a
    // variable a host deliberately sets, close enough in name to be caught by
    // a lazier pattern. `OPENCODE_CONFIG_CONTENT` is how the live suite hands
    // opencode its permission settings, and `PI_CODING_AGENT_DIR` is the
    // user's pi configuration directory.
    it.each([
      ['claude-code', 'MY_CLAUDE_KEY'],
      ['codex', 'CODEX_HOME'],
      ['opencode', 'OPENCODE_CONFIG_CONTENT'],
      ['pi', 'PI_CODING_AGENT_DIR'],
    ])('%s spares %s', (id, name) => {
      expect(scrubbedFor(id, name)).toBe(false);
    });

    // kimi declares nothing, and that is the honest entry: no kimi session
    // marker has been measured, and a guessed pattern would scrub a variable
    // no one has seen.
    it('kimi declares no marker, because none was measured', () => {
      expect(builtinAdapters.find((a) => a.id === 'kimi')?.envScrubExtra).toBeUndefined();
    });
  });

  // What `createHub`'s note says, pinned against what it does. The note used to
  // claim `discovery: false` disabled the built-ins and that explicit
  // `adapters` gave "fully static wiring"; measured, neither was true, and a
  // consumer who believed it would expose five engines from a deployment meant
  // to expose one.
  describe('what narrows the adapter set, and what does not', () => {
    /**
     * A stand-in that shares no id with a built-in, written out rather than
     * spread from one: spreading would tie what these cases prove to whatever
     * shape `opencode` happens to have, and the registry path being exercised
     * is the same either way.
     */
    const mine: EngineAdapter = { specVersion: 1, id: 'mine-only', launch: { command: 'true' } };

    it('discovery: false leaves every built-in registered', async () => {
      const hub = createHub({ discovery: false });
      const ids = (await hub.engines()).map((e) => e.id).sort();
      expect(ids).toEqual(['claude-code', 'codex', 'kimi', 'opencode', 'pi']);
    });

    it('explicit adapters are added to the built-ins, not substituted for them', async () => {
      const hub = createHub({ discovery: false, adapters: [mine] });
      const ids = (await hub.engines()).map((e) => e.id).sort();
      expect(ids).toEqual(['claude-code', 'codex', 'kimi', 'mine-only', 'opencode', 'pi']);
    });

    it('Hub built directly registers only the adapters it is given', async () => {
      // The path the corrected note sends a consumer to for a closed hub, so
      // the recommendation is checked rather than asserted.
      const hub = new Hub({ adapters: [mine] });
      const engines = await hub.engines();
      expect(engines.map((e) => e.id)).toEqual(['mine-only']);
      // Asserting ids alone would pass on an adapter that failed validation and
      // was listed as `health: 'invalid'` — registered in name only. The note
      // sends consumers here for a working hub, so check it is one.
      expect(engines[0]?.health).not.toBe('invalid');
    });
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
