/** Acceptance coverage for the structured, bounded handoff digest. */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hub } from '../src/hub.js';
import {
  buildDigest,
  createDigestBuilder,
  estimateTokens,
  renderStructuredDigest,
  type DigestOptions,
} from '../src/transcript/digest.js';
import type { StructuredDigest, TranscriptDigest, TranscriptEvent } from '../src/transcript/event.js';
import { jsonlStore } from '../src/transcript/jsonlStore.js';
import { memoryStore } from '../src/transcript/memoryStore.js';
import { sqliteStore } from '../src/transcript/sqliteStore.js';

const GOLDENS = resolve(import.meta.dirname, 'fixtures/digest-golden');
const EXPLICITLY_FIXED_GOLDENS = new Set(['boundary-budget-below-marker', 'utf8-split-surrogate']);

interface GoldenInput {
  sessionId: string;
  events: TranscriptEvent[];
  opts?: DigestOptions;
}

function golden(name: string): { input: GoldenInput; expected: TranscriptDigest } {
  return {
    input: JSON.parse(readFileSync(join(GOLDENS, `${name}.input.json`), 'utf8')) as GoldenInput,
    expected: JSON.parse(readFileSync(join(GOLDENS, `${name}.digest.json`), 'utf8')) as TranscriptDigest,
  };
}

function goldenNames(): string[] {
  return readdirSync(GOLDENS)
    .filter((name) => name.endsWith('.input.json'))
    .map((name) => name.slice(0, -'.input.json'.length))
    .sort();
}

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= text.length) return true;
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('ST-DIG-01 — structured extraction and canonical rendering', () => {
  it('folds chronological role runs and renders them exactly as text', () => {
    const { input } = golden('mixed-roles');
    const structured = buildDigest(input.sessionId, input.events, {
      format: 'structured',
    }) as StructuredDigest;
    const text = buildDigest(input.sessionId, input.events, { format: 'text' }) as TranscriptDigest;

    expect(structured.segments).toEqual([
      { role: 'user', text: 'Refactor the parser and keep the tests green.', fromSeq: 1, toSeq: 2 },
      { role: 'assistant', text: 'Sure — I will start with the tokenizer.', fromSeq: 4, toSeq: 5 },
      { role: 'tool', text: 'Read src/parser.ts (read)', fromSeq: 6, toSeq: 6 },
      { role: 'tool', text: 'result (t1): completed — export function parse() {}', fromSeq: 7, toSeq: 7 },
      { role: 'assistant', text: 'The tokenizer is small.', fromSeq: 8, toSeq: 8 },
      { role: 'user', text: 'Good, proceed.', fromSeq: 9, toSeq: 9 },
      { role: 'assistant', text: 'Done.', fromSeq: 10, toSeq: 10 },
    ]);
    expect(renderStructuredDigest(structured)).toBe(text.text);
    expect(structured.segments.map((segment) => segment.text).join('')).not.toBe(text.text);
  });

  it('threads structured options through Hub transcript access', async () => {
    const { input } = golden('mixed-roles');
    const store = memoryStore();
    for (const event of input.events) await store.append(event);
    const hub = new Hub({ discovery: false, adapters: [], store });

    const digest = await hub.transcripts.digest(input.sessionId, { format: 'structured' });

    expect(digest).toMatchObject({ sessionId: input.sessionId, throughSeq: 10 });
    expect('segments' in digest).toBe(true);
  });

  it('returns the same structured extraction from every bundled store', async () => {
    const { input } = golden('mixed-roles');
    const stores = [
      memoryStore(),
      jsonlStore(mkdtempSync(join(tmpdir(), 'runskein-digest-jsonl-'))),
      sqliteStore(join(mkdtempSync(join(tmpdir(), 'runskein-digest-sqlite-')), 'digest.db')),
    ];
    const expected = buildDigest(input.sessionId, input.events, { format: 'structured' });

    for (const store of stores) {
      for (const event of input.events) await store.append(event);
      await expect(store.digest(input.sessionId, { format: 'structured' })).resolves.toEqual(expected);
    }
  });
});

describe('ST-DIG-02 / ST-DIG-06 — deterministic, safe bounds', () => {
  it('honors the smaller token or character limit and reports truncation metadata', () => {
    const { input } = golden('utf8-multibyte-truncation');
    const tokenBound = buildDigest(input.sessionId, input.events, {
      format: 'structured',
      truncation: 'head-tail',
      maxChars: 1_000,
      maxTokens: 50,
    }) as StructuredDigest;
    const charBound = buildDigest(input.sessionId, input.events, {
      format: 'structured',
      truncation: 'head-tail',
      maxChars: 80,
      maxTokens: 100,
    }) as StructuredDigest;
    const tokenText = renderStructuredDigest(tokenBound, {
      truncation: 'head-tail',
      maxChars: 1_000,
      maxTokens: 50,
    });
    const charText = renderStructuredDigest(charBound, {
      truncation: 'head-tail',
      maxChars: 80,
      maxTokens: 100,
    });

    expect(Buffer.byteLength(tokenText, 'utf8')).toBeLessThanOrEqual(200);
    expect(tokenBound.estimatedTokens).toBe(estimateTokens(tokenText));
    expect(tokenBound.estimatedTokens).toBeLessThanOrEqual(50);
    expect(charText.length).toBeLessThanOrEqual(80);
    expect(Buffer.byteLength(charText, 'utf8')).toBeLessThanOrEqual(80);
    expect(charBound.truncatedRanges).not.toEqual([]);
    expect((tokenText.match(/\[\.\.\.middle context truncated\.\.\.\]/g) ?? []).length).toBe(1);
    expect(
      renderStructuredDigest(tokenBound, {
        truncation: 'head-tail',
        maxChars: 1_000,
        maxTokens: 50,
      }),
    ).toBe(
      (
        buildDigest(input.sessionId, input.events, {
          format: 'text',
          truncation: 'head-tail',
          maxChars: 1_000,
          maxTokens: 50,
        }) as TranscriptDigest
      ).text,
    );
  });

  it('never emits lone surrogates or exceeds either active bound across the golden corpus', () => {
    for (const name of goldenNames()) {
      const { input } = golden(name);
      for (const truncation of ['tail', 'head', 'head-tail'] as const) {
        for (const budget of [0, 1, 2, 10, 31, 32, 33, 80, 357, 600]) {
          const maxTokens = Math.floor(budget / 4);
          const digest = buildDigest(input.sessionId, input.events, {
            format: 'text',
            truncation,
            maxChars: budget,
            maxTokens,
          }) as TranscriptDigest;
          expect(digest.text.length, `${name}/${truncation}/${budget}`).toBeLessThanOrEqual(budget);
          expect(
            Buffer.byteLength(digest.text, 'utf8'),
            `${name}/${truncation}/${budget}`,
          ).toBeLessThanOrEqual(maxTokens * 4);
          expect(hasLoneSurrogate(digest.text), `${name}/${truncation}/${budget}`).toBe(false);
        }
      }
    }
  });
});

describe('ST-DIG-03 — selectable transcript end', () => {
  it('keeps the first intent in head mode and the latest state in tail mode', () => {
    const { input } = golden('oversized-tail-truncation');
    const head = buildDigest(input.sessionId, input.events, {
      format: 'text',
      truncation: 'head',
      maxChars: 600,
    }) as TranscriptDigest;
    const tail = buildDigest(input.sessionId, input.events, {
      format: 'text',
      truncation: 'tail',
      maxChars: 600,
    }) as TranscriptDigest;

    expect(head.text).toContain('HEAD-MARKER');
    expect(head.text).not.toContain('TAIL-MARKER');
    expect(tail.text).toContain('TAIL-MARKER');
    expect(tail.text).not.toContain('HEAD-MARKER');
  });
});

describe('ST-DIG-04 — frozen resume output', () => {
  it('matches every pre-change golden except the two explicitly corrected defects', () => {
    for (const name of goldenNames()) {
      const { input, expected } = golden(name);
      const actual = buildDigest(input.sessionId, input.events, input.opts) as TranscriptDigest;
      const builder = createDigestBuilder(input.sessionId, input.opts);
      for (const event of input.events) builder.add(event);
      expect(builder.finish()).toEqual(actual);
      if (EXPLICITLY_FIXED_GOLDENS.has(name)) {
        expect(actual).not.toEqual(expected);
        expect(actual.text.length).toBeLessThanOrEqual(input.opts?.maxChars ?? 32_000);
        expect(hasLoneSurrogate(actual.text)).toBe(false);
      } else {
        expect(actual).toEqual(expected);
      }
    }
  });
});
