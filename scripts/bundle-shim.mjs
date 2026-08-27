#!/usr/bin/env node
/**
 * Bundle an adapter's shim into a self-contained module, and keep the checked-in
 * result honest.
 *
 * A shim is spawned by absolute path, so it can end up anywhere: inside
 * `node_modules` for an ordinary install, but also copied next to a consumer's
 * bundle, where there is no `node_modules` above it to resolve a bare
 * specifier from. A shim that imports a package therefore works in this
 * repository and fails after distribution — measured, not theoretical
 * (`ERR_MODULE_NOT_FOUND: Cannot find package '@agentclientprotocol/sdk'`).
 *
 * The output is committed rather than generated at install time, because the
 * adapter ships as plain files with no build step of its own. `--check` proves
 * the committed copy still matches its source, the same way the generated
 * vocabulary is kept from drifting.
 *
 * Usage, from an adapter directory: `node ../../scripts/bundle-shim.mjs [--check]`
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const pkgDir = process.cwd();
const entry = join(pkgDir, 'src', 'shim.mjs');
const output = join(pkgDir, 'shim.mjs');
const check = process.argv.includes('--check');

if (!existsSync(entry)) {
  console.error(`bundle-shim: no shim source at ${entry}`);
  process.exit(2);
}

const result = await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Node builtins stay external: they resolve everywhere, and inlining them is
  // not possible anyway.
  external: ['node:*'],
  write: false,
  banner: {
    js: [
      '// GENERATED FILE — do not edit.',
      '// Built from src/shim.mjs by scripts/bundle-shim.mjs so the shim carries',
      '// its dependencies with it: it is spawned by path and may live where no',
      '// node_modules can be resolved from.',
    ].join('\n'),
  },
});

const bundled = result.outputFiles[0].text;

if (check) {
  const current = existsSync(output) ? readFileSync(output, 'utf8') : '';
  if (current !== bundled) {
    console.error(`bundle-shim: ${output} is stale — run \`pnpm build\` in that adapter`);
    process.exit(1);
  }
  console.log('bundle-shim: shim bundle matches its source');
} else {
  writeFileSync(output, bundled);
  console.log(`bundle-shim: wrote ${(bundled.length / 1024).toFixed(0)} kB to ${output}`);
}
