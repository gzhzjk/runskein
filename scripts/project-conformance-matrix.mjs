#!/usr/bin/env node
/**
 * Project the probe matrix down to the part that may be published, and keep the
 * committed projection honest.
 *
 * `docs/conformance/matrix.json` is the probe's full output and cannot leave
 * this repository: its `configOptions` key is the operator's own machine
 * configuration — of the file's 47,335 bytes, opencode's `configOptions` alone
 * is 25,371 of them, listing the providers that machine happens to have logged
 * into. The published capability tables,
 * however, are generated from probe data, so the release repository needs
 * *some* input or its `pnpm quality` step dies on a missing file.
 *
 * The decision that matters is not "add a projection file" but **which single
 * file the generator reads**. It reads this projection, in both repositories,
 * always. Renaming the projection to `matrix.json` on export was rejected: two
 * repositories holding same-named files with different content is the seed of
 * exactly the drift the two-repo model already has to fight.
 *
 * Two checks, because a committed generated artifact needs a keeper:
 *
 * 1. The projection still equals what the current `matrix.json` projects to —
 *    otherwise a probe refresh silently leaves the published tables behind.
 * 2. The generator produces the same tables from the full matrix as from the
 *    projection. That is what makes the coarse, whole-subtree projection safe:
 *    a new generator path added under a kept key just works, and one added
 *    outside them fails here instead of rendering a silent `—` in a published
 *    table.
 *
 * Usage:
 *   node scripts/project-conformance-matrix.mjs          # --check (pnpm quality)
 *   node scripts/project-conformance-matrix.mjs --write  # after `pnpm probe`
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

// Resolved against the repository, not the shell's cwd: `--write` is documented
// as the step after `pnpm probe`, which is run from `packages/conformance`.
const root = resolve(import.meta.dirname, '..');
const SOURCE = 'docs/conformance/matrix.json';
const TARGET = 'docs/conformance/matrix.public.json';
const GENERATOR = 'scripts/generate-capability-tables.mjs';
const at = (path) => join(root, path);
const WRITE = process.argv.includes('--write');

// Whole top-level keys, not the individual dotted paths the generator reads:
// coarse enough that adding a measured cell under one of them needs no change
// here, and the second check below catches the case where that assumption
// breaks.
const KEEP = ['id', 'agentInfo', 'capabilities', 'prompt', 'usage'];

// Read but never published. The generator deliberately spells the engine names
// itself rather than take `agentInfo.name`, because the probe records whatever
// the engine called itself on the day it ran — pi's row still names the shim by
// the product's pre-rename name. Publishing that string would carry a stale
// fact and a dead brand into the release repository for no reader's benefit.
//
// `prompt.replyText` is the engine's own words, generated on the probe machine,
// and the only free-text field the projection would carry. Measured: a Stop
// hook configured in the operator's Claude Code installation appended
// "**Notice:** Stop says: …" to the engine's reply, and the projection
// published it verbatim. A hook printing a ticket number, a hostname or a
// customer name would travel the same path just as silently, and the export's
// internal-content scan looks for known internal strings — it cannot recognise
// an arbitrary sentence. What the field was evidence for, that the engine
// answered and how, is carried structurally by `prompt.stopReason` and
// `prompt.updateKinds`; the full text stays in `matrix.json`, which never
// leaves this repository.
const DROP = [
  ['agentInfo', 'name'],
  ['prompt', 'replyText'],
];

/**
 * @param {unknown[]} matrix - parsed `matrix.json`
 * @returns {unknown[]} the publishable projection
 * @throws {Error} when a row records a probe that did not succeed — publishing
 *   one states a measurement that was never taken.
 */
function project(matrix) {
  // `ok` is not in KEEP, and must not be: the published tables have no column
  // for it. That is exactly why a failed row cannot be projected. It would come
  // through as `{id, agentInfo}`, and the generator renders every absent cell as
  // `—`, which the tables define as "wire capability not advertised" — so an
  // engine that was merely not logged in would be published as an engine that
  // advertises nothing, with no trace of the failure anywhere in the data, and
  // every gate green because both inputs lack it equally.
  const failed = matrix.filter((entry) => entry.ok !== true);
  if (failed.length > 0) {
    throw new Error(
      `${SOURCE} holds ${failed.length} row(s) from a probe that did not succeed: ` +
        `${failed.map((entry) => `${entry.id} (${entry.error ?? 'no error recorded'})`).join('; ')}.\n` +
        'Re-probe those engines — authentication is the usual cause — or drop the rows. A failed row ' +
        'publishes as an engine that advertises nothing, which is a measurement nobody made.',
    );
  }
  return matrix.map((entry) => {
    const kept = Object.fromEntries(KEEP.filter((key) => key in entry).map((key) => [key, entry[key]]));
    for (const [parent, field] of DROP) {
      if (kept[parent] && field in kept[parent]) {
        kept[parent] = Object.fromEntries(Object.entries(kept[parent]).filter(([name]) => name !== field));
      }
    }
    return kept;
  });
}

const serialize = (projection) => `${JSON.stringify(projection, null, 2)}\n`;

if (!existsSync(at(SOURCE))) {
  // The release repository has the projection but not the probe output it comes
  // from: there is nothing to check, and saying so beats a missing-file crash
  // in a gate a contributor there is expected to run.
  if (!existsSync(at(TARGET))) {
    throw new Error(`neither ${SOURCE} nor ${TARGET} exists — run \`pnpm probe\` to measure engines`);
  }
  console.log(`conformance projection: ${SOURCE} is not in this repository, nothing to project from`);
  process.exit(0);
}

const expected = serialize(project(JSON.parse(readFileSync(at(SOURCE), 'utf8'))));

if (WRITE) {
  // A projection that loses engines is refused rather than written. `pnpm
  // probe <id>` merges into an existing matrix so a partial run cannot erase
  // the other rows — but only when a matrix is there to merge into. In the
  // release repository it never is, so a contributor following the adapter
  // guide probes one engine, gets a one-row matrix, and this command would
  // quietly delete four engines from the published capability tables. The
  // regenerated tables then pass every gate.
  if (existsSync(at(TARGET))) {
    const before = JSON.parse(readFileSync(at(TARGET), 'utf8')).map((row) => row.id);
    const after = new Set(JSON.parse(expected).map((row) => row.id));
    const lost = before.filter((id) => !after.has(id));
    if (lost.length > 0) {
      throw new Error(
        `${TARGET} would lose ${lost.length} engine(s): ${lost.join(', ')}.\n` +
          `${SOURCE} measures only ${[...after].join(', ')}. A partial \`pnpm probe <id>\` merges into an ` +
          'existing matrix; if this repository has no matrix.json, it has nothing to merge into and the ' +
          'result is one row. Probe the missing engines, or restore the full matrix, before projecting.',
      );
    }
  }
  writeFileSync(at(TARGET), expected);
  console.log(`wrote ${TARGET} (${Buffer.byteLength(expected)} bytes) from ${SOURCE}`);
  process.exit(0);
}

if (!existsSync(at(TARGET)) || readFileSync(at(TARGET), 'utf8') !== expected) {
  throw new Error(
    `${TARGET} is not the projection of the current ${SOURCE}.\n` +
      'Refresh it with `node scripts/project-conformance-matrix.mjs --write` and commit both files.',
  );
}

// Check 2: the projection is sufficient for the generator. `pnpm quality` runs
// the generator against the projection; running it here against the full matrix
// proves the two inputs render the same document.
try {
  // The generator reads its own paths relative to the cwd, so give it the one
  // it expects rather than whichever directory this script was invoked from.
  execFileSync('node', [at(GENERATOR), '--check', `--matrix=${SOURCE}`], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
} catch (cause) {
  // The generator's own message says "tables stale", which is the wrong story
  // here: the tables match the projection — it is the full matrix that renders
  // something else, so the generator is reading a field the projection drops.
  throw new Error(
    `the capability tables render differently from ${SOURCE} than from ${TARGET}, ` +
      `so the generator now reads a field the projection does not keep. Widen KEEP ` +
      `(or narrow DROP) in this script, refresh the projection with --write, and ` +
      `check the field is publishable before you do.\n${String(cause.stderr ?? '').trim()}`,
    { cause },
  );
}

console.log(`conformance projection current: ${TARGET} matches ${SOURCE}, and both render the same tables`);
