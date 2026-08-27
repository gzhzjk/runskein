/**
 * ST-STORE-02 — a Hub built on memoryStore() runs the whole session cycle and
 * touches no disk (AC-10.1, with the durability semantics AC-10.2 documents).
 *
 * The failure this guards against is the one that made the capability
 * necessary: persistence cannot be switched off, and omitting `store` does not
 * mean "keep nothing" — it means "write JSONL into the current working
 * directory". A memoryStore() that quietly fell back, or that left a
 * `.transcripts` directory behind, would reintroduce exactly that footgun for
 * the hosts (tests, embedded hosts, short-lived bridges) that chose it to
 * avoid durable transcripts.
 */
import { existsSync, mkdirSync, readdirSync, statSync, watch, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/transcript/memoryStore.js';
import { NotFoundError } from '../src/errors.js';
import { collect, makeHub, textOf, tmp } from './testkit.js';

/**
 * List a directory tree as sorted relative paths, for before/after comparison.
 * @param root - the directory to walk.
 * @returns every nested path relative to root, sorted.
 */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      out.push(relative(root, path));
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return out.sort();
}

describe('ST-STORE-02 — memoryStore()-backed Hub (AC-10.1)', () => {
  it('completes create → prompt → close → resume against the mock engine', async () => {
    const hub = makeHub({}, { store: memoryStore() });
    const cwd = tmp('runskein-st-store-02-');

    const s = await hub.session({ engine: 'mock', cwd });
    const created = await s.prompt('remember the magic word: swordfish');
    expect(created.stopReason).toBe('end_turn');
    const seqAfterFirstTurn = (await collect(hub.transcripts.get(s.id))).length;
    expect(seqAfterFirstTurn).toBeGreaterThan(0);
    await s.close();

    // Resume on the same run: the store is authoritative for resume, so a
    // memory-only store must support the full chain, not just appends.
    const resumed = await hub.session({ engine: 'mock', cwd, resume: s.id });
    expect(resumed.id).toBe(s.id);
    await resumed.prompt('and what was the magic word?');

    const events = await collect(hub.transcripts.get(s.id));
    expect(events.length).toBeGreaterThan(seqAfterFirstTurn);
    // Both turns are in one continuous transcript under the original id.
    const text = events.map(textOf).join(' ');
    expect(text).toContain('swordfish');
    expect(text).toContain('magic word');
    // Seq stays strictly increasing across the close/resume boundary.
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);

    // The session is listable from the store the Hub was given.
    const listed = await hub.sessions({ engineId: 'mock' });
    expect(listed.map((m) => m.sessionId)).toContain(s.id);
  });

  it('writes nothing to disk', async () => {
    const cwd = tmp('runskein-st-store-02-disk-');
    // A nested dir so a recursive watcher has something to report against.
    mkdirSync(join(cwd, 'sub'));
    const before = tree(cwd);

    // "fs watch on cwd": the watcher is the live signal, the tree diff is the
    // deterministic assertion — macOS recursive watch delivery is timing
    // dependent, so neither alone is trustworthy.
    //
    // Entries that already existed when the watcher started are filtered out:
    // FSEvents replays recent activity on the directory (its own creation, and
    // the `sub/` made just above), which says nothing about what the Hub did.
    // Only a path that is not in the pre-existing set can indicate a write —
    // and the self-check below proves that filter still catches one.
    const known = new Set([...before, basename(cwd)]);
    const touched: string[] = [];
    const watcher = watch(cwd, { recursive: true }, (_event, name) => {
      if (name !== null && !known.has(name)) touched.push(name);
    });

    // The default store is jsonlStore('.transcripts') resolved against the
    // process cwd; record whether it existed so an unrelated pre-existing
    // directory cannot mask a fallback.
    const defaultStoreDir = join(process.cwd(), '.transcripts');
    const defaultStoreExistedBefore = existsSync(defaultStoreDir);

    try {
      const hub = makeHub({}, { store: memoryStore() });
      const s = await hub.session({ engine: 'mock', cwd });
      await s.prompt('write something to the transcript');
      await s.close();
      await hub.session({ engine: 'mock', cwd, resume: s.id });

      await new Promise((r) => setTimeout(r, 50)); // let watch events drain
      expect(tree(cwd)).toEqual(before);
      expect(touched).toEqual([]);
      expect(existsSync(defaultStoreDir)).toBe(defaultStoreExistedBefore);

      // Self-check: a filtered watcher that can no longer see a write would
      // make the assertion above vacuous, so prove it still fires.
      writeFileSync(join(cwd, 'canary.txt'), 'x');
      await new Promise((r) => setTimeout(r, 200));
      expect(touched).toContain('canary.txt');
    } finally {
      watcher.close();
    }
  });

  it('keeps nothing beyond the run that created it', async () => {
    // The documented consequence of holding everything in memory: a fresh
    // store cannot see a previous one's transcripts. This is what proves the
    // absence of a hidden disk fallback — a durable store would resume here.
    const first = makeHub({}, { store: memoryStore() });
    const cwd = tmp('runskein-st-store-02-run-');
    const s = await first.session({ engine: 'mock', cwd });
    await s.prompt('remember: swordfish');
    await s.close();

    const second = makeHub({}, { store: memoryStore() });
    await expect(second.session({ engine: 'mock', cwd, resume: s.id })).rejects.toThrow(NotFoundError);
  });

  it('returns an independent store per call', async () => {
    // Documented: each memoryStore() owns its own events and shares nothing.
    const a = memoryStore();
    const b = memoryStore();
    await a.append({
      seq: 1,
      ts: 1,
      sessionId: 'sess-a',
      engineId: 'mock',
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
    });
    expect(await a.sessions()).toHaveLength(1);
    expect(await b.sessions()).toHaveLength(0);
    await expect(collect(b.read('sess-a'))).rejects.toThrow(NotFoundError);
  });
});
