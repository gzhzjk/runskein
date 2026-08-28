#!/usr/bin/env node
/**
 * Copy a package's non-TypeScript runtime assets from `src` into `dist`, then
 * assert that every asset the built code loads by path is actually there.
 *
 * `tsc` compiles TypeScript and copies nothing else, so a file that the code
 * reaches through `new URL('./x', import.meta.url)` silently disappears from a
 * published package: it exists in the source tree, the workspace keeps working,
 * and only a consumer installing the tarball hits `MODULE_NOT_FOUND`. That is
 * exactly how the parent-death watchdog shipped broken in 0.1.0-alpha.9.
 *
 * The check derives its expectations from the built output rather than from a
 * maintained list, so the next asset added is covered without anyone
 * remembering to add it here.
 *
 * What it does not ask is whether the path survives leaving this tree: a
 * reference that resolves here is exactly the one that ships and then resolves
 * into a consumer's build directory. `verify-runtime-paths.mjs` asks that, and
 * the two are separate on purpose — this one catches an asset that was not
 * copied, which is a different mistake from a path that should not have been
 * resolved at run time at all.
 *
 * Usage: `node ../../scripts/build-assets.mjs` from a package directory.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const pkgDir = process.cwd();
const srcDir = join(pkgDir, 'src');
const distDir = join(pkgDir, 'dist');

/** Every file under `dir`, recursively. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

// ── copy ────────────────────────────────────────────────────────────────────

const copied = [];
for (const file of filesUnder(srcDir)) {
  if (file.endsWith('.ts')) continue; // tsc's job
  const target = join(distDir, relative(srcDir, file));
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(file, target);
  copied.push(relative(pkgDir, target));
}

// ── verify ──────────────────────────────────────────────────────────────────

// Two shapes reach a file by path instead of by import: an explicit URL against
// import.meta.url, and a bare relative literal naming an extension no compiler
// emits. Both survive compilation unchanged, which is what makes them findable.
const URL_ASSET = /new URL\(\s*['"](\.\.?\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
const RAW_ASSET = /['"](\.\.?\/[^'"]+\.(?:mjs|cjs|wasm|node))['"]/g;

const missing = [];
for (const file of filesUnder(distDir)) {
  if (!file.endsWith('.js')) continue;
  const source = readFileSync(file, 'utf8');
  for (const pattern of [URL_ASSET, RAW_ASSET]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const referenced = resolve(dirname(file), match[1]);
      if (!existsSync(referenced)) {
        missing.push(`${relative(pkgDir, file)} → ${match[1]}`);
      }
    }
  }
}

if (missing.length > 0) {
  console.error('build-assets: the built output loads files that are not there:');
  for (const line of missing) console.error(`  ${line}`);
  console.error('Add them to src/ (they are copied automatically) or fix the reference.');
  process.exit(1);
}
console.log(`build-assets: ${copied.length} asset(s) copied, references verified`);
