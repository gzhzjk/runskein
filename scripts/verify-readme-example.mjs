#!/usr/bin/env node
/**
 * Keep the README Quickstart and `examples/hello-world.mjs` byte-identical.
 *
 * The Quickstart has to be pasteable without opening another file, and the
 * example file has to be runnable without reading the README, so the same code
 * is in three places: both language peers of the README and the example. That
 * is duplication on purpose, and duplication rots — the only defence is a gate
 * that reads all three.
 *
 * The example file is the one a reader downloads, so it is the source: edit it,
 * then paste it back into both READMEs.
 *
 * Usage: `node scripts/verify-readme-example.mjs` (part of `pnpm quality`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const EXAMPLE = 'examples/hello-world.mjs';
// Both language peers: code is not translated, so the block is the same in each.
const READMES = ['README.md', 'README.zh-CN.md'];

const example = readFileSync(resolve(root, EXAMPLE), 'utf8');
const block = `\`\`\`js\n${example}\`\`\``;

const failures = [];
for (const readme of READMES) {
  if (!readFileSync(resolve(root, readme), 'utf8').includes(block)) {
    failures.push(
      `${readme} does not contain ${EXAMPLE} verbatim as a \`\`\`js block — ` +
        `paste the current ${EXAMPLE} into its Quickstart`,
    );
  }
}

if (failures.length > 0) {
  console.error('README example check failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`README quickstart matches ${EXAMPLE} in ${READMES.length} document(s)`);
