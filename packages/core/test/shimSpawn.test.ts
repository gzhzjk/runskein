/**
 * The shim launch path: how core spawns an engine that cannot speak the
 * protocol itself, and what it records about the process it started.
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
