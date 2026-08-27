/**
 * How the CLI is invoked: argument parsing, adapter registration and
 * discovery, the `engines` command, and the exit codes a usage error or a
 * typed error produces end to end.
 *
 * Test-plan cases: IN-01…07, DI-01…05, EN-01/03/04, EE-07.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  cliDir,
  noLingering,
  repoRoot,
  runCli,
  scratch,
  writeBrokenAdapter,
  writeMockAdapter,
} from './helpers.js';

const BUILTIN_IDS = ['opencode', 'kimi', 'claude-code', 'codex', 'pi'];

/** The built-in rows of an `engines` table, in order. */
function builtinRows(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => BUILTIN_IDS.some((id) => line.startsWith(`${id} `) || line.startsWith(`${id}\t`)));
}

export async function invocationSuite(): Promise<void> {
  const fixtures = scratch('runskein-cli-fixtures-inv-');
  const chatCwd = scratch('runskein-cli-cwd-inv-');
  writeMockAdapter(fixtures, 'mock');
  writeMockAdapter(fixtures, 'mock-slow', { MOCK_PROMPT_DELAY_MS: '500' });
  writeBrokenAdapter(fixtures);

  // ── engines + discovery (DI-02/03/04, EN-01) ───────────────────────────────
  {
    const r = runCli(['--adapter-path', fixtures, 'engines']);
    check('engines exit 0', r.status === 0, r.stderr);
    check(
      'engines lists built-ins and fixture adapters',
      [...BUILTIN_IDS, 'mock', 'mock-slow'].every((id) => r.stdout.includes(id)),
      r.stdout,
    );
    check(
      'engines table shape (EN-01)',
      /^ID\s+INSTALLED\s+VERSION\s+AUTH\s+HEALTH/.test(r.stdout),
      r.stdout,
    );
    check(
      'broken adapter shows invalid, does not crash the hub (DI-04)',
      r.stdout.includes('invalid:') && r.stdout.includes('broken adapter'),
      r.stdout,
    );
    check('--adapter-path prints a warning (DI-03)', r.stderr.includes('[warn]'), r.stderr);
    check('engines spawns no engine process (EN-04)', noLingering());
  }

  {
    // Without the flag, a cwd-local adapter is NOT imported (DI-02).
    const r = runCli(['engines']);
    check('plain engines exit 0', r.status === 0, r.stderr);
    check('no cwd-dependent loading without the flag (DI-02)', !r.stdout.includes('mock'), r.stdout);
  }

  // ── DI-01: built-ins identical regardless of cwd ───────────────────────────
  {
    const runs = [cliDir, repoRoot, '/tmp'].map((cwd) => runCli(['engines'], undefined, { cwd }));
    check(
      'DI-01 engines exits 0 from packages/cli, repo root, /tmp',
      runs.every((r) => r.status === 0),
      runs.map((r) => `${r.status}: ${r.stderr}`).join('\n'),
    );
    const rowSets = runs.map((r) => builtinRows(r.stdout));
    check(
      'DI-01 every built-in id listed from every cwd',
      rowSets.every((rows) => rows.length === BUILTIN_IDS.length),
      rowSets.map((rows) => rows.join('\n')).join('\n---\n'),
    );
    check(
      'DI-01 built-in rows identical across cwds',
      rowSets[1]!.join('\n') === rowSets[0]!.join('\n') &&
        rowSets[2]!.join('\n') === rowSets[0]!.join('\n'),
      rowSets.map((rows) => rows.join('\n')).join('\n---\n'),
    );
  }

  // ── DI-05: a scanned fixture reusing a built-in id never shadows it ────────
  {
    // The fixture advertises a detect() with a tell-tale version; the explicit
    // built-in registration (layer 3) must win over --adapter-path (layer 2).
    const root = scratch('runskein-cli-fixtures-di05-');
    const dir = join(root, 'kimi');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'runskein-adapter-kimi-fixture',
        type: 'module',
        main: 'index.mjs',
        runskein: { adapter: true, specVersion: 1 },
      }),
    );
    writeFileSync(
      join(dir, 'index.mjs'),
      `export default {
  specVersion: 1,
  id: 'kimi',
  detect: async () => ({ installed: true, version: 'fixture-kimi-shadow' }),
  launch: { command: process.execPath, args: ['-e', ''] },
};
`,
    );
    const r = runCli(['--adapter-path', root, 'engines']);
    check('DI-05 engines exit 0 with id-colliding fixture', r.status === 0, r.stderr);
    check(
      'DI-05 fixture does not shadow the explicit built-in',
      !r.stdout.includes('fixture-kimi-shadow') &&
        builtinRows(r.stdout).some((row) => row.startsWith('kimi ')),
      r.stdout,
    );
  }

  // ── usage errors (exit 2): IN-01…06 ────────────────────────────────────────
  {
    check('IN-01 unknown command → 2', runCli(['frobnicate']).status === 2);
    check('IN-02 unknown flag → 2', runCli(['engines', '--bogus']).status === 2);
    check('IN-02 describe unknown flag → 2', runCli(['describe', 'mock', '--bogus']).status === 2);
    check('IN-02 chat unknown flag → 2', runCli(['chat', 'mock', '--bogus']).status === 2);
    check('IN-03 bad -c → 2', runCli(['chat', 'mock', '-c', 'novalue']).status === 2);
    check('IN-04 bad --permission → 2', runCli(['chat', 'mock', '--permission', 'maybe']).status === 2);
    check('IN-05 pnpm `--` separator skipped', runCli(['--', 'engines']).status === 0);
    const noArgDescribe = runCli(['describe']);
    check('IN-06 describe without engineId → 2', noArgDescribe.status === 2, `${noArgDescribe.status}`);
    const noArgChat = runCli(['chat']);
    check('IN-06 chat without engineId → 2', noArgChat.status === 2, `${noArgChat.status}`);
    check(
      'IN-06 missing-argument errors print usage on stderr',
      noArgDescribe.stderr.includes('[error]') && noArgChat.stderr.includes('usage:'),
      noArgChat.stderr,
    );
  }

  // ── IN-07: --adapter-path before the command, repeatable ───────────────────
  {
    const second = scratch('runskein-cli-fixtures-in07-');
    writeMockAdapter(second, 'mock-two');
    const r = runCli(['--adapter-path', fixtures, '--adapter-path', second, 'engines']);
    check('IN-07 repeated --adapter-path exits 0', r.status === 0, r.stderr);
    check(
      'IN-07 every occurrence prints its own warning',
      r.stderr.split('[warn]').length - 1 === 2 && r.stderr.includes(fixtures) && r.stderr.includes(second),
      r.stderr,
    );
    check(
      'IN-07 adapters from both dirs are registered',
      r.stdout.includes('mock-slow') && r.stdout.includes('mock-two'),
      r.stdout,
    );
  }

  // ── typed errors (exit 1) ──────────────────────────────────────────────────
  {
    const r = runCli(['chat', 'no-such-engine', '--cwd', chatCwd], '');
    check('unknown engine → exit 1', r.status === 1, `${r.status}`);
    check(
      'unknown engine → NotInstalledError via formatter',
      r.stderr.includes('[error] NotInstalledError:') && r.stderr.includes('no-such-engine'),
      r.stderr,
    );
  }

  {
    const r = runCli(
      ['--adapter-path', fixtures, 'chat', 'mock', '--cwd', chatCwd, '-c', 'model=nope'],
      '',
    );
    check('bad config → exit 1 (CH-12)', r.status === 1, `${r.status}\n${r.stderr}`);
    check(
      'bad config → ConfigError with valid values (CH-12)',
      r.stderr.includes('[error] ConfigError:') &&
        r.stderr.includes('validValues') &&
        r.stderr.includes('m1'),
      r.stderr,
    );
  }

  // ── stream discipline (EE-08) ──────────────────────────────────────────────
  {
    const r = runCli(['--adapter-path', fixtures, 'engines']);
    check(
      'EE-08 [warn]/[error] stay on stderr, stdout machine-greppable',
      !r.stdout.includes('[warn]') && !r.stdout.includes('[error]') && r.stderr.includes('[warn]'),
      `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  }
}
