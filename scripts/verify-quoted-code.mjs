#!/usr/bin/env node
/**
 * Keep a document's quoted code honest about the file it says it came from.
 *
 * `docs/adapter-guide.md` teaches by walking through kimi's real adapter and
 * printing pieces of it. That is the right shape for a guide — a pointer would
 * gut it — and it is duplication, so it rots. It did: when kimi's quota pattern
 * turned out to be broken in production, the guide went on teaching the broken
 * one in both languages, and nothing noticed. The Chinese peer's hash gate
 * cannot see this, because the English had not changed.
 *
 * The rule is opt-in per block, never inferred from a match, because a document
 * is allowed to show code that is deliberately nobody's:
 *
 *     <!-- from: adapters/kimi/index.mjs -->
 *     ```js
 *     launch: { command: 'kimi', args: ['acp'], startTimeoutMs: 30_000 },
 *     ```
 *
 * Two blocks in that same guide would break a gate that guessed. §3b's
 * `creationConfig` example is a *former* adapter's declaration, and the
 * paragraph beneath it says so; §3d's `usage` example is deliberately not any
 * adapter's, written that way so the guide would stop reprinting a real one.
 * Both stay unmarked and untouched.
 *
 * **Each quoted line appears somewhere in the file, not the block as a whole.**
 * The guide reformats what it shows: it wraps three of kimi's fields in an
 * `export default { … }` that exists in no file, and lifts `detect()` out of the
 * object it lives in. A rule that wanted the block contiguous fails both.
 *
 * Whitespace is collapsed on both sides before comparing, across line breaks as
 * well as within them, because prettier wraps the same declaration differently
 * at different indentation — the first run of this gate found kimi's pattern
 * split over two lines in the adapter and joined onto one in the guide, which
 * is a formatting difference and not a lie. Comment-only lines and elision
 * markers are dropped: the annotations are the page's own, and showing part of
 * a file is the point. So a page may indent, wrap and elide, and may not
 * invent.
 *
 * What this deliberately does not check: that the block shows *enough* of the
 * file, or that the file has not grown something the block should mention. It
 * catches a quotation that has stopped being true, which is the failure that
 * shipped.
 *
 * That limit is why the API specification is not marked. An inventory of every
 * published page found thirteen blocks in `engine-adapter-api.md` and
 * `transcript-fold.md` that mirror declarations in `packages/core/src` and
 * `packages/fold/src` — and there the direction of truth is reversed. Those
 * documents are the frozen surface, which the implementation conforms to, so
 * what matters is that neither has grown a field the other lacks. This gate
 * only ever asks the one question, and would report a doc that had fallen
 * behind the code as fine. Marking them would buy a false sense of coverage,
 * which is the failure that produced this script.
 *
 * `verify-readme-example.mjs` stays separate. It asserts a stronger property —
 * the block is the whole file, byte for byte — which is right for a quickstart
 * someone pastes and runs, and wrong for a fragment.
 *
 * Usage: `node scripts/verify-quoted-code.mjs` (part of `pnpm quality`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');

/**
 * Every document the gate reads: each published English page and its peer.
 * Code is not translated, so a marked block appears identically in both — and
 * the translated copy is the one that outlived its original last time.
 * @param from - the repository root to read from.
 * @returns document paths, relative to that root.
 */
export function publishedDocuments(from = root) {
  return JSON.parse(readFileSync(resolve(from, 'docs/published-documents.json'), 'utf8')).documents.flatMap(
    (entry) => [entry.source, entry.translation],
  );
}

/** A `from:` marker and the fenced block it introduces. */
const QUOTED = /<!--\s*from:\s*(\S+?)\s*-->\n+```[a-z]*\n([\s\S]*?)```/g;

/** Collapse every run of whitespace to one space, so that where a formatter
 *  chose to break a line stops being part of the comparison. */
const collapse = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * The lines of a code block that make a claim about the source.
 *
 * Comment-only lines are dropped: a page annotates what it quotes, and those
 * annotations are the page's own. An elision marker is dropped for the same
 * reason — showing part of a file is the point.
 * @param body - the fenced block's contents.
 * @returns comparable lines, whitespace collapsed.
 */
function claimedLines(body) {
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith('//') &&
        !line.startsWith('*') &&
        line !== '…' &&
        line !== '...',
    )
    .map(collapse);
}

/**
 * Check every marked block in every document against the file it names.
 * @param documents - document paths, relative to `from`.
 * @param from - the repository root to read from.
 * @returns the failures found and how many marked blocks were checked.
 */
export function checkQuotedCode(documents = publishedDocuments(), from = root) {
  const failures = [];
  let checked = 0;

  for (const doc of documents) {
    const path = resolve(from, doc);
    if (!existsSync(path)) {
      failures.push(`${doc} is listed in published-documents.json but is not there`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    for (const [, source, body] of text.matchAll(QUOTED)) {
      const sourcePath = resolve(from, source);
      if (!existsSync(sourcePath)) {
        // A marker naming a file that has moved is the same defect one step
        // earlier, so it fails rather than passing over.
        failures.push(`${doc} quotes ${source}, which does not exist`);
        continue;
      }
      checked += 1;
      // The whole file as one collapsed string: a quoted line has to occur in it,
      // wherever the file happened to break. Short lines like `},` occur trivially
      // and carry no claim, which costs nothing — the failure this catches is a
      // line whose *content* has stopped being true.
      const haystack = collapse(readFileSync(sourcePath, 'utf8'));
      for (const line of claimedLines(body)) {
        if (!haystack.includes(line)) {
          failures.push(
            `${doc} quotes ${source} but that file has no line \`${line}\` — ` +
              'update the block, or point the marker at what it really shows',
          );
        }
      }
    }
  }
  return { failures, checked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { failures, checked } = checkQuotedCode();
  if (failures.length > 0) {
    console.error('quoted-code check failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`quoted code matches its source in ${checked} marked block(s)`);
}
