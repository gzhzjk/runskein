#!/usr/bin/env node
/**
 * Every published package must carry the licence it claims.
 *
 * npm publishes one directory per package, so the repository root's LICENSE
 * and NOTICE do not travel: a consumer who installs `@runskein/core` gets that
 * package's directory and nothing above it. Apache-2.0 §4(a) requires a copy of
 * the License to accompany the work, and §4(d) requires the attribution notices
 * to travel with any derivative — neither of which a root-only file satisfies
 * once the tarball is built.
 *
 * The copies are therefore committed per package, which creates the failure
 * this script exists to catch: nine files that must stay byte-identical to the
 * root, edited by whoever next changes the copyright year or adds a bundled
 * dependency. A stale copy is a licence claim that is quietly wrong, and
 * nothing else in the build would notice.
 *
 * `files` is checked too. npm always includes `LICENSE` regardless of the
 * field, but **not** `NOTICE` — so a package whose `files` is an explicit list
 * ships the attribution only if it says so.
 *
 * Usage: `node scripts/verify-license-files.mjs` (chained into `pnpm quality`).
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { publishable } from './workspace.mjs';

const root = resolve(import.meta.dirname, '..');
const REQUIRED = ['LICENSE', 'NOTICE'];
const SPDX = 'Apache-2.0';

const failures = [];
const expected = Object.fromEntries(REQUIRED.map((name) => [name, readFileSync(join(root, name), 'utf8')]));

for (const pkg of publishable()) {
  const dir = dirname(pkg.manifest);
  const manifest = JSON.parse(readFileSync(pkg.manifest, 'utf8'));
  const where = relative(root, dir);

  if (manifest.license !== SPDX) {
    failures.push(`${pkg.name}: license field is ${JSON.stringify(manifest.license)}, expected "${SPDX}"`);
  }

  for (const name of REQUIRED) {
    const path = join(dir, name);
    if (!existsSync(path)) {
      failures.push(`${where}/${name} is missing — the published tarball would carry no ${name}`);
      continue;
    }
    if (readFileSync(path, 'utf8') !== expected[name]) {
      failures.push(
        `${where}/${name} differs from the root ${name} — copy it rather than editing one side`,
      );
    }
  }

  // An explicit `files` list is a whitelist: anything unlisted is dropped from
  // the tarball. LICENSE is the one exception npm makes on its own.
  if (Array.isArray(manifest.files)) {
    for (const name of REQUIRED) {
      if (name !== 'LICENSE' && !manifest.files.includes(name)) {
        failures.push(`${pkg.name}: "files" does not list ${name}, so it would not be published`);
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `license files out of sync:\n${failures.map((line) => `- ${line}`).join('\n')}\n` +
      'Fix by copying the root LICENSE/NOTICE into the package directory.',
  );
}
console.log(`license files present and current: ${publishable().length} published package(s)`);
