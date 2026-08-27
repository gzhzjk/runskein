/**
 * What the release tooling needs to know about this workspace's shape, in one
 * place rather than restated per script.
 *
 * The product name in particular was written out six times across four release
 * scripts — a release note heading, its Chinese peer, an annotated tag message
 * and two live-run headers. A rename had to find all six or the release gate
 * would refuse a note it had just been asked to write. Deriving it instead
 * means a rename touches the manifest and nothing here.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

/**
 * Every workspace package directory that ships to a registry.
 * @returns {{name: string, version: string, manifest: string}[]} one entry per non-private manifest under packages/ and adapters/.
 */
export function publishable() {
  const dirs = [];
  for (const base of ['packages', 'adapters']) {
    for (const name of readdirSync(join(root, base))) {
      const manifest = join(root, base, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.private === true) continue;
      dirs.push({ name: pkg.name, version: pkg.version, manifest });
    }
  }
  return dirs;
}

/**
 * The product's name, as a consumer types it into `npm install`.
 *
 * Every package but one is scoped; the unscoped one is the meta-package, and
 * its name is the product's. Deriving it this way survives both a rename and a
 * directory move, because neither changes which manifest lacks a scope.
 *
 * @returns {string} the sole unscoped publishable package name.
 * @throws {Error} when the workspace does not hold exactly one — a state no
 *   caller can paper over, since the release note heading and the tag message
 *   would otherwise be silently wrong.
 */
export function productName() {
  const unscoped = publishable().filter((pkg) => !pkg.name.startsWith('@'));
  if (unscoped.length !== 1) {
    throw new Error(
      `workspace: expected exactly one unscoped publishable package, found ${unscoped.length}` +
        (unscoped.length > 0 ? ` (${unscoped.map((p) => p.name).join(', ')})` : ''),
    );
  }
  return unscoped[0].name;
}
