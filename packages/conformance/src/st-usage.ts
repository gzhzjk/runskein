/**
 * ST-USAGE — decide an adapter's `usage.semantics` from measurement.
 *
 * `pnpm st:usage [engine]` (default claude-code). Costs four live turns.
 *
 * Decision 033 requires `semantics` to be declared as `cumulative` or
 * `per-turn`, and the wrong one silently misreports every turn. This runs one
 * session of four turns, deliberately alternating a terse answer with a verbose
 * one: a cumulative counter only ever grows, a per-turn counter falls back on
 * turn 3.
 *
 * Read the `outputTokens` column, not the total. Measured on claude-code,
 * `totalTokens` rose across all four turns — 46233, 48292, 48317, 48342 — while
 * the report was per-turn all along; it rises because `cachedReadTokens` grows
 * with the conversation. Judging by the total would have declared `cumulative`.
 *
 * It reads the wire as well as `TurnResult.usage`, because the parsed value is
 * empty until the declaration this measurement exists to write.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonlStore } from '@runskein/core';
import { createLiveHub, type WireFrame } from '@runskein/conformance';
import { liveConfigFor } from '@runskein/conformance/live-support';

const engine = process.argv[2] ?? 'claude-code';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const frames: WireFrame[] = [];
const hub = createLiveHub({
  store: jsonlStore(tmp('gzh88-')),
  wireObserver: () => (f: WireFrame) => frames.push(f),
});
const live = liveConfigFor(engine);
const s = await hub.session({ engine, cwd: tmp('gzh88-ws-'), config: { ...live.config } });

const usageUpdates: unknown[] = [];
s.on('update', (e) => {
  const u = (e as { update: { sessionUpdate?: string } }).update;
  if (u.sessionUpdate === 'usage_update') usageUpdates.push(u);
});

const TURNS = [
  ['terse   ', 'Reply with exactly the word ONE and nothing else.'],
  ['verbose ', 'Count from 1 to 120, one number per line, nothing else.'],
  ['terse   ', 'Reply with exactly the word TWO and nothing else.'],
  ['terse   ', 'Reply with exactly the word THREE and nothing else.'],
] as const;

console.log(
  `ENGINE ${engine}  declared semantics: ${JSON.stringify(
    (await import('runskein')).builtinAdapters.find((a) => a.id === engine)?.usage?.semantics ??
      '(none declared)',
  )}`,
);
console.log('turn      in      out     cacheRd  cacheWr  total    | TurnResult.usage | usage_update seen');
for (const [label, prompt] of TURNS) {
  const before = frames.length;
  const beforeUpdates = usageUpdates.length;
  const r = await s.prompt(prompt);
  const responses = frames
    .slice(before)
    .filter((f) => f.direction === 'in' && (f.result as { usage?: unknown })?.usage !== undefined);
  const u = (responses.at(-1)?.result as { usage?: Record<string, number> })?.usage ?? {};
  const cell = (n: number | undefined) => String(n ?? '-').padStart(7);
  console.log(
    `${label} ${cell(u['inputTokens'])} ${cell(u['outputTokens'])} ${cell(u['cachedReadTokens'])} ${cell(u['cachedWriteTokens'])} ${cell(u['totalTokens'])} | ${JSON.stringify(r.usage) ?? 'undefined'} | ${usageUpdates.length - beforeUpdates}`,
  );
}
console.log('\nlast three usage_update payloads:');
for (const u of usageUpdates.slice(-3)) console.log(' ', JSON.stringify(u));
await s.close();
await hub.quit();
process.exit(0);
