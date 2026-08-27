/**
 * The `describe` command at fixture level. The descriptor probe is driven by
 * the parameterized scripted agent; a trace file counts engine spawns, which
 * is how the --refresh case proves it re-probed.
 *
 * Test-plan cases: DE-01…07.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  noLingering,
  runCli,
  scratch,
  writeScriptedAdapter,
  SCRIPTED_AGENT_PATTERN,
} from './helpers.js';

const CONFIG_OPTIONS_SCRIPT = {
  capabilities: {},
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'plan', name: 'Plan', description: 'plan first' },
    ],
  },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'a1',
      options: [
        {
          name: 'GroupA',
          options: [
            { value: 'a1', name: 'A One' },
            { value: 'a2', name: 'A Two' },
          ],
        },
        { value: 'plain', name: 'Plain' },
      ],
    },
    {
      id: 'fast',
      name: 'Fast mode',
      category: 'model_config',
      type: 'boolean',
      currentValue: false,
    },
  ],
};

function spawnCount(traceFile: string): number {
  if (!existsSync(traceFile)) return 0;
  return readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).length;
}

export async function describeSuite(): Promise<void> {
  const fixtures = scratch('runskein-cli-fixtures-de-');
  const trace = join(scratch('runskein-cli-trace-de-'), 'spawns.log');
  writeScriptedAdapter(fixtures, 'scripted-config', CONFIG_OPTIONS_SCRIPT, {
    SCRIPTED_AGENT_TRACE_FILE: trace,
  });
  writeScriptedAdapter(
    fixtures,
    'hints-engine',
    { capabilities: {}, configOptions: [] },
    {},
    {
      configHints: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'h1',
          options: [{ value: 'h1', name: 'Hint One' }],
        },
      ],
    },
  );
  writeScriptedAdapter(fixtures, 'providers-engine', {
    capabilities: { providers: true },
    configOptions: [],
  });

  // ── DE-01/04: probe source + option shapes ─────────────────────────────────
  {
    const r = runCli(['--adapter-path', fixtures, 'describe', 'scripted-config']);
    check('DE-01 describe exits 0', r.status === 0, r.stderr);
    check('DE-01 probe-sourced descriptor', r.stdout.includes('source: probe'), r.stdout);
    check(
      'DE-04 grouped select values flattened with group prefixes',
      r.stdout.includes('values: GroupA/a1, GroupA/a2, plain'),
      r.stdout,
    );
    check(
      'DE-04 boolean option renders its current value',
      /^ {2}fast\s+\(model_config, boolean\)\s+current=false$/m.test(r.stdout),
      r.stdout,
    );
    check('DE-04 select current value rendered', r.stdout.includes('current=a1'), r.stdout);
    check(
      'describe renders modes and capabilities sections',
      r.stdout.includes('modes:') && r.stdout.includes('plan (Plan)') && /capabilities: \S/.test(r.stdout),
      r.stdout,
    );
    check(
      'DE-03 exactly one probe spawn for a plain describe',
      spawnCount(trace) === 1,
      `${spawnCount(trace)}`,
    );
  }

  // ── DE-03: --refresh re-probes (exactly one spawn per invocation) ──────────
  {
    const r = runCli(['--adapter-path', fixtures, 'describe', 'scripted-config', '--refresh']);
    check('DE-03 describe --refresh exits 0', r.status === 0, r.stderr);
    check(
      'DE-03 --refresh performs a fresh probe (one more spawn, not two)',
      spawnCount(trace) === 2,
      `${spawnCount(trace)}`,
    );
  }

  // ── DE-02: hints fallback when the probe reports no configOptions ──────────
  {
    const r = runCli(['--adapter-path', fixtures, 'describe', 'hints-engine']);
    check('DE-02 hints engine exits 0', r.status === 0, r.stderr);
    check('DE-02 config options fall back to hints', r.stdout.includes('source: hints'), r.stdout);
    check(
      'DE-02 hint rows render; capabilities still come from the probe',
      r.stdout.includes('h1') && /capabilities: \S/.test(r.stdout),
      r.stdout,
    );
  }

  // ── DE-05: providers section when advertised, absent otherwise ─────────────
  {
    const r = runCli(['--adapter-path', fixtures, 'describe', 'providers-engine']);
    check('DE-05 providers engine exits 0', r.status === 0, r.stderr);
    check(
      'DE-05 providers section rendered with current binding',
      r.stdout.includes('providers:') &&
        r.stdout.includes('main [openai, anthropic]') &&
        r.stdout.includes('current=anthropic@https://api.example.test'),
      r.stdout,
    );
    const plain = runCli(['--adapter-path', fixtures, 'describe', 'scripted-config']);
    check('DE-05 providers section never fabricated', !plain.stdout.includes('providers:'), plain.stdout);
  }

  // ── DE-06: unknown engine ──────────────────────────────────────────────────
  {
    const r = runCli(['describe', 'nope']);
    check('DE-06 describe unknown engine → exit 1', r.status === 1, `${r.status}\n${r.stderr}`);
    check(
      'DE-06 describe unknown engine → NotInstalledError on stderr',
      r.stderr.includes('[error] NotInstalledError:') && r.stderr.includes('nope'),
      r.stderr,
    );
  }

  // ── DE-07: probe engine reaped before the CLI exits ────────────────────────
  check('DE-07 no lingering probe engine after describe', noLingering(SCRIPTED_AGENT_PATTERN));
}
