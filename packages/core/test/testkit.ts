/**
 * Shared helpers for the core test suites: a mock agent adapter factory, hub
 * and store construction that tracks quits for cleanup, and small assertion
 * utilities.
 *
 * Every suite builds its mock agent and temp dirs from here. Two keep their own
 * cleanup and say why in place: regressions.test.ts hands hubs a failing store
 * on purpose, and functional.test.ts owns bare ProcessManagers alongside hubs.
 * A suite that needs a different construction shape wraps makeHub rather than
 * copying it — resume.test.ts does, in one line.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect } from 'vitest';
import { Hub, type InternalHubOptions } from '../src/hub.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import type { EngineAdapter } from '../src/types.js';
import type { TranscriptEvent, UsageMapping } from '../src/transcript/event.js';

export const FIXTURE = resolve(import.meta.dirname, 'fixtures/mock-agent.mjs');

export function mockAdapter(env: Record<string, string> = {}, id = 'mock'): EngineAdapter {
  return {
    specVersion: 1,
    id,
    launch: { command: process.execPath, args: [FIXTURE], env, startTimeoutMs: 10_000 },
  };
}

/** A mock-fixture adapter carrying a usage declaration, registered under `id`. */
export function declared(env: Record<string, string>, id: string, usage: UsageMapping): EngineAdapter {
  return { ...mockAdapter(env, id), usage };
}

/** A per-turn usage reporter whose `_meta` IS the report object (decision 033). */
export const PER_TURN_META: UsageMapping = {
  source: { kind: 'prompt_response_meta', path: ['_meta'] },
  semantics: 'per-turn',
};

/** JSON.stringify as an expression helper for MOCK_* plan env values. */
export const json = (value: unknown): string => JSON.stringify(value);

export const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

const hubs: Hub[] = [];
export function makeHub(
  env: Record<string, string> = {},
  extra: InternalHubOptions = {},
  adapters?: EngineAdapter[],
): Hub {
  const hub = new Hub({
    discovery: false,
    adapters: adapters ?? [mockAdapter(env)],
    store: jsonlStore(tmp('runskein-tk-store-')),
    ...extra,
  });
  hubs.push(hub);
  return hub;
}
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((h) => h.quit()));
});

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

export const textOf = (e: TranscriptEvent): string =>
  'content' in e.update && (e.update.content as { type?: string; text?: string }).type === 'text'
    ? ((e.update.content as { text: string }).text ?? '')
    : '';

/** Counts 'spawn' lines written by the fixture's MOCK_TRACE_FILE. */
export function countSpawns(traceFile: string): number {
  if (!existsSync(traceFile)) return 0;
  return readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((l) => l === 'spawn').length;
}

/** Writes an adapter directory directly under `base` (adapterPaths layout). */
export function writeAdapterDir(
  base: string,
  dirName: string,
  opts: { id?: string; specVersion?: number; body?: string } = {},
): void {
  const dir = join(base, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `@runskein/adapter-${dirName}`,
      type: 'module',
      main: 'index.mjs',
      runskein: { adapter: true, specVersion: opts.specVersion ?? 1 },
    }),
  );
  const id = opts.id ?? dirName;
  const body =
    opts.body ??
    `export default ${JSON.stringify({
      specVersion: 1,
      id,
      launch: { command: process.execPath, args: [FIXTURE], startTimeoutMs: 10_000 },
    })};`;
  writeFileSync(join(dir, 'index.mjs'), body);
}

/** Polls an (optionally async) condition until it passes or the deadline hits. */
export async function expectEventually(
  cond: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(await cond()).toBe(true);
}
