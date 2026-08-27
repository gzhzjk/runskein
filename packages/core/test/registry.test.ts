/**
 * Registry tests: explicit adapters, workspace and installed-package
 * discovery via the runskein.adapter marker, failure isolation of broken candidates, layer
 * precedence, detect caching, and rescan.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Registry, validateAdapter } from '../src/registry.js';
import type { EngineAdapter } from '../src/types.js';

const okAdapter = (id: string): EngineAdapter => ({
  specVersion: 1,
  id,
  launch: { command: 'true' },
});

function writeAdapterDir(
  base: string,
  dirName: string,
  opts: {
    id?: string;
    marker?: boolean;
    specVersion?: number;
    body?: string;
  } = {},
): void {
  const dir = join(base, 'adapters', dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@runskein/adapter-${dirName}`,
      type: 'module',
      main: 'index.mjs',
      runskein: { adapter: opts.marker ?? true, specVersion: opts.specVersion ?? 1 },
    }),
  );
  const id = opts.id ?? dirName;
  writeFileSync(
    join(dir, 'index.mjs'),
    opts.body ??
      `export default { specVersion: 1, id: ${JSON.stringify(id)}, launch: { command: 'true' } };`,
  );
}

/**
 * An adapter as npm would leave it: a package directory under `node_modules`,
 * named the way a third party publishes one. `writeAdapterDir` covers the
 * workspace layer; this covers the installed layer, which the scan reaches by
 * package-name prefix rather than by directory position.
 */
function writeInstalledAdapter(cwd: string, packageName: string, id: string, marker = true): void {
  const dir = join(cwd, 'node_modules', packageName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: packageName,
      type: 'module',
      main: 'index.mjs',
      runskein: { adapter: marker, specVersion: 1 },
    }),
  );
  writeFileSync(
    join(dir, 'index.mjs'),
    `export default { specVersion: 1, id: ${JSON.stringify(id)}, launch: { command: 'true' } };`,
  );
}

describe('validateAdapter', () => {
  it('accepts a conforming adapter', () => {
    expect(validateAdapter(okAdapter('foo')).id).toBe('foo');
  });

  it('rejects wrong specVersion / bad id / missing launch', () => {
    expect(() => validateAdapter({ ...okAdapter('foo'), specVersion: 2 })).toThrow();
    expect(() => validateAdapter({ ...okAdapter('Bad_Id') })).toThrow();
    expect(() => validateAdapter({ specVersion: 1, id: 'x' })).toThrow();
  });
});

describe('Registry — explicit adapters', () => {
  it('registers explicit adapters without discovery', async () => {
    const r = new Registry({ adapters: [okAdapter('foo')], discovery: false });
    expect([...(await r.adapters()).keys()]).toEqual(['foo']);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('isolates an invalid explicit adapter and keeps the rest', async () => {
    const r = new Registry({
      adapters: [okAdapter('good'), { id: 'bad' } as unknown as EngineAdapter],
      discovery: false,
    });
    expect([...(await r.adapters()).keys()]).toEqual(['good']);
    const invalid = await r.invalidCandidates();
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ id: 'bad', health: 'invalid' });
    expect(invalid[0]!.error).toBeTruthy();
  });

  it('same-layer duplicate id invalidates the id instead of picking by scan order', async () => {
    const r = new Registry({
      adapters: [okAdapter('dup'), { ...okAdapter('dup') }],
      discovery: false,
    });
    expect([...(await r.adapters()).keys()]).toEqual([]);
    expect((await r.invalidCandidates())[0]?.error).toMatch(/duplicate adapter id/);
  });

  it('a later layer resolves a lower-layer collision without duplicate inventory', async () => {
    const explicit = { ...okAdapter('dup'), launch: { command: 'explicit' } };
    const r = new Registry({
      builtins: [okAdapter('dup'), { ...okAdapter('dup') }],
      adapters: [explicit],
      discovery: false,
    });
    expect((await r.adapters()).get('dup')).toStrictEqual(explicit);
    expect(await r.invalidCandidates()).toEqual([]);
  });
});

describe('Registry — workspace discovery', () => {
  it('does not execute workspace adapters unless discovery is explicitly enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    const marker = join(cwd, 'executed');
    writeAdapterDir(cwd, 'hostile', {
      body: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes'); export default { specVersion: 1, id: 'hostile', launch: { command: 'true' } };`,
    });
    const r = new Registry({ cwd });
    expect((await r.adapters()).size).toBe(0);
    expect(() => readFileSync(marker)).toThrow();
  });

  it('always registers statically supplied built-ins', async () => {
    const r = new Registry({ builtins: [okAdapter('builtin')], discovery: false });
    expect([...(await r.adapters()).keys()]).toEqual(['builtin']);
  });

  it('discovers marked directories, skips unmarked ones', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeAdapterDir(cwd, 'alpha');
    writeAdapterDir(cwd, 'unmarked', { marker: false });
    const r = new Registry({ cwd, discovery: true });
    expect([...(await r.adapters()).keys()]).toEqual(['alpha']);
  });

  it('accepts the publishing prefix in the workspace layer too', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeAdapterDir(cwd, 'runskein-adapter-prefixed', { id: 'prefixed' });
    const r = new Registry({ cwd, discovery: true });
    expect([...(await r.adapters()).keys()]).toEqual(['prefixed']);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('direct and prefixed directory forms collide honestly within the workspace layer', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    // Both directories identify foo under the relaxed rule; neither adapter
    // needs a mismatched id to reach the same-layer collision path.
    writeAdapterDir(cwd, 'foo');
    writeAdapterDir(cwd, 'runskein-adapter-foo', { id: 'foo' });
    const r = new Registry({ cwd, discovery: true });
    expect([...(await r.adapters()).keys()]).toEqual([]);
    expect((await r.invalidCandidates())[0]?.error).toMatch(/duplicate adapter id 'foo' in the same layer/);
  });

  it('skips unsupported specVersion with a warning, not an invalid entry', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeAdapterDir(cwd, 'future', { specVersion: 99 });
    const r = new Registry({ cwd, discovery: true });
    expect((await r.adapters()).size).toBe(0);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('id ≠ directory name is failure-isolated as invalid', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeAdapterDir(cwd, 'dirname', { id: 'othername' });
    const r = new Registry({ cwd, discovery: true });
    expect((await r.adapters()).size).toBe(0);
    const invalid = await r.invalidCandidates();
    expect(invalid[0]?.error).toMatch(/must match directory name/);
  });

  it('broken module import is failure-isolated, other adapters survive', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeAdapterDir(cwd, 'alpha');
    writeAdapterDir(cwd, 'broken', { body: 'throw new Error("boom at import");' });
    const r = new Registry({ cwd, discovery: true });
    expect([...(await r.adapters()).keys()]).toEqual(['alpha']);
    expect((await r.invalidCandidates())[0]?.error).toMatch(/boom at import/);
  });

  it('explicit adapters override discovered ones by id', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeAdapterDir(cwd, 'alpha');
    const override: EngineAdapter = {
      ...okAdapter('alpha'),
      launch: { command: 'overridden' },
    };
    const r = new Registry({ cwd, adapters: [override], discovery: true });
    expect((await r.adapters()).get('alpha')?.launch.command).toBe('overridden');
  });

  it('adapterPaths layer scans extra directories', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    const extra = mkdtempSync(join(tmpdir(), 'runskein-extra-'));
    writeAdapterDir(extra, 'beta');
    // adapterPaths entries are directories whose subdirectories are adapters
    const r = new Registry({ cwd, adapterPaths: [join(extra, 'adapters')] });
    expect([...(await r.adapters()).keys()]).toEqual(['beta']);
  });
});

describe('Registry — installed package discovery', () => {
  // These pin both sides of layer 3: the package prefix controls what the scan
  // reaches, and the same prefix is stripped when its directory names the id.
  it('registers an unscoped runskein-adapter-* package', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeInstalledAdapter(cwd, 'runskein-adapter-gamma', 'gamma');
    const r = new Registry({ cwd, discovery: true });
    expect([...(await r.adapters()).keys()]).toEqual(['gamma']);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('registers a scoped @scope/runskein-adapter-* package', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    // Any scope: a third party publishes under their own, never under ours.
    writeInstalledAdapter(cwd, '@someco/runskein-adapter-delta', 'delta');
    const r = new Registry({ cwd, discovery: true });
    expect([...(await r.adapters()).keys()]).toEqual(['delta']);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('the prefix is what the scan reaches by — a marker alone is not enough', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    // Reading every dependency's package.json to find markers would cost a
    // full node_modules walk on every discovery.
    writeInstalledAdapter(cwd, 'adapter-epsilon', 'epsilon');
    writeInstalledAdapter(cwd, '@runskein/adapter-zeta', 'zeta');
    const r = new Registry({ cwd, discovery: true });
    expect((await r.adapters()).size).toBe(0);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('a prefixed package without the marker is not a candidate', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeInstalledAdapter(cwd, 'runskein-adapter-eta', 'eta', false);
    const r = new Registry({ cwd, discovery: true });
    expect((await r.adapters()).size).toBe(0);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('node_modules is not scanned unless discovery is enabled', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeInstalledAdapter(cwd, 'runskein-adapter-theta', 'theta');
    const r = new Registry({ cwd });
    expect((await r.adapters()).size).toBe(0);
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('matches an installed adapter id after stripping the package prefix', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeInstalledAdapter(cwd, 'runskein-adapter-iota', 'iota');
    const r = new Registry({ cwd, discovery: true });
    expect((await r.adapters()).get('iota')?.id).toBe('iota');
    expect(await r.invalidCandidates()).toEqual([]);
  });

  it('rejects an installed package whose basename does not identify its adapter', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'runskein-reg-'));
    writeInstalledAdapter(cwd, 'runskein-adapter-kappa', 'lambda');
    const r = new Registry({ cwd, discovery: true });
    expect((await r.adapters()).size).toBe(0);
    expect((await r.invalidCandidates())[0]?.error).toContain(
      "adapter id 'lambda' must match directory name 'runskein-adapter-kappa' directly or after stripping prefix 'runskein-adapter-'",
    );
  });
});

describe('Registry — detect cache + rescan', () => {
  it('runs detect() once and caches, rescan clears', async () => {
    let calls = 0;
    const adapter: EngineAdapter = {
      ...okAdapter('probe'),
      detect: async () => {
        calls++;
        return { installed: true, version: `v${calls}` };
      },
    };
    const r = new Registry({ adapters: [adapter], discovery: false });
    expect((await r.detect('probe'))?.version).toBe('v1');
    expect((await r.detect('probe'))?.version).toBe('v1');
    expect(calls).toBe(1);
    r.rescan();
    expect((await r.detect('probe'))?.version).toBe('v2');
  });

  it('a throwing detect() rejects with a typed operation error', async () => {
    const adapter: EngineAdapter = {
      ...okAdapter('flaky'),
      detect: async () => {
        throw new Error('detect exploded');
      },
    };
    const r = new Registry({ adapters: [adapter], discovery: false });
    await expect(r.detect('flaky')).rejects.toMatchObject({
      name: 'EngineOperationError',
      engineId: 'flaky',
      operation: 'adapter/detect',
    });
  });

  it('no detect hook → undefined', async () => {
    const r = new Registry({ adapters: [okAdapter('plain')], discovery: false });
    expect(await r.detect('plain')).toBeUndefined();
  });
});
