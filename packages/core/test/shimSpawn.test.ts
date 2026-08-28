/**
 * The shim launch path: how core spawns an engine that cannot speak the
 * protocol itself, and what it records about the process it started — plus the
 * environment every engine is launched with, which is the same spawn.
 *
 * These are core-side cases only — nothing here knows what pi is. They cover
 * the shim entry point being resolved and vetted at load, the child being the
 * shim rather than the engine, and the ownership line staying specific enough
 * for an orphan sweep to match on.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { spawnEngine } from '../src/process/spawn.js';
import type { EngineAdapter } from '../src/types.js';

/**
 * Write a discoverable adapter directory whose adapter declares a shim.
 * @param base - the scan root; the adapter lands in `<base>/adapters/<id>`.
 * @param id - the adapter (and directory) id.
 * @param shim - the shim path exactly as the adapter should declare it.
 * @param opts - whether to create the shim file itself (default true).
 * @returns the adapter directory.
 */
function writeShimAdapter(base: string, id: string, shim: string, opts: { create?: boolean } = {}): string {
  const dir = join(base, 'adapters', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@runskein/adapter-${id}`,
      type: 'module',
      main: 'index.mjs',
      runskein: { adapter: true },
    }),
  );
  writeFileSync(
    join(dir, 'index.mjs'),
    `export default { specVersion: 1, id: '${id}', launch: { command: 'engine', args: ['serve'] }, shim: ${JSON.stringify(shim)} };\n`,
  );
  if (opts.create !== false) writeFileSync(join(dir, 'shim.mjs'), 'process.exit(0);\n');
  return dir;
}

describe('shim launch path', () => {
  it('resolves a directory-relative shim to an absolute path at load', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-shim-'));
    const dir = writeShimAdapter(cwd, 'shimmed', './shim.mjs');
    const registry = new Registry({ discovery: true, cwd });
    const adapter = (await registry.adapters()).get('shimmed');
    expect(adapter?.shim).toBe(join(dir, 'shim.mjs'));
  });

  it('rejects a shim that escapes the adapter directory, keeping the hub alive', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-shim-'));
    writeShimAdapter(cwd, 'escaper', '../escape.mjs');
    writeFileSync(join(cwd, 'adapters', 'escape.mjs'), 'process.exit(0);\n');
    writeShimAdapter(cwd, 'healthy', './shim.mjs');
    const registry = new Registry({ discovery: true, cwd });

    expect((await registry.adapters()).has('escaper')).toBe(false);
    const invalid = await registry.invalidCandidates();
    expect(
      invalid.some((entry) => entry.id === 'escaper' && /outside the adapter directory/.test(entry.error)),
    ).toBe(true);
    // Failure isolation: the neighbouring adapter is untouched.
    expect((await registry.adapters()).has('healthy')).toBe(true);
  });

  it('rejects a shim entry point that does not exist', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-shim-'));
    writeShimAdapter(cwd, 'missing', './shim.mjs', { create: false });
    const registry = new Registry({ discovery: true, cwd });
    const invalid = await registry.invalidCandidates();
    expect(
      invalid.some((entry) => entry.id === 'missing' && /shim entry point not found/.test(entry.error)),
    ).toBe(true);
  });

  it('requires an absolute shim from an adapter registered as a bare object', async () => {
    const registry = new Registry({
      adapters: [{ specVersion: 1, id: 'bare', launch: { command: 'engine' }, shim: './shim.mjs' }],
    });
    const invalid = await registry.invalidCandidates();
    expect(
      invalid.some((entry) => entry.id === 'bare' && /must be an absolute path/.test(entry.error)),
    ).toBe(true);
  });

  it('spawns the shim with the engine command line as its arguments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runskein-shim-'));
    const shim = join(dir, 'shim.mjs');
    const out = join(dir, 'argv.json');
    writeFileSync(
      shim,
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));\n`,
    );
    const adapter: EngineAdapter = {
      specVersion: 1,
      id: 'shimmed',
      launch: { command: 'engine-binary', args: ['--mode', 'rpc'] },
      shim,
    };

    const spawned = spawnEngine(adapter, { cwd: dir });
    await new Promise((resolve) => spawned.child.on('exit', resolve));

    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(['engine-binary', '--mode', 'rpc']);
    // The ownership line names the shim and the engine it drives. The node
    // executable is deliberately absent: a sweep matches on this string before
    // killing, and `node` alone would match half the machine.
    expect(spawned.argv0).toBe(`${shim} engine-binary --mode rpc`);
  });
});

describe('engine launch environment', () => {
  it('replaces the inherited variable a Windows host would resolve the adapter to', async () => {
    // `launch.env` is promised to win over the scrub. On a host that resolves
    // names without case the adapter's spelling has to displace the inherited
    // one rather than sit beside it — and this runner is not such a host, so
    // the platform is stubbed. Without the stub the old spread and the merge
    // are indistinguishable here: both leave the two spellings side by side,
    // and a case asserting that would pass whichever one was in place.
    const dir = mkdtempSync(join(tmpdir(), 'runskein-launch-env-'));
    const out = join(dir, 'env.json');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (platform === undefined) throw new Error('process.platform is not describable');
    const previous = process.env['RUNSKEIN_LAUNCH_CASE'];
    process.env['RUNSKEIN_LAUNCH_CASE'] = 'host';
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const adapter: EngineAdapter = {
        specVersion: 1,
        id: 'launch-env',
        launch: {
          command: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify([process.env.RUNSKEIN_LAUNCH_CASE ?? null, process.env.runskein_launch_case ?? null]))`,
          ],
          env: { runskein_launch_case: 'adapter' },
        },
      };

      const spawned = spawnEngine(adapter, { cwd: dir });
      await new Promise((resolve) => spawned.child.on('exit', resolve));

      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual([null, 'adapter']);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      if (previous === undefined) delete process.env['RUNSKEIN_LAUNCH_CASE'];
      else process.env['RUNSKEIN_LAUNCH_CASE'] = previous;
    }
  });
});
