import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourceRoots = ['packages/core/src', 'packages/conformance/src', 'adapters'];
// A shim is the far side of the wire for an engine that speaks no ACP, so it
// implements the protocol and may import the SDK. Nothing a consumer can reach
// may. See docs/decisions/028.
const shimEntryPoint = /^adapters\/[^/]+\/(?:src\/)?shim\.mjs$/;
const extensions = new Set(['.ts', '.js', '.mjs']);

function filesUnder(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    // Installed dependencies are not this repo's code; scanning them turns
    // every vendored `catch {}` into a false failure.
    if (name === 'node_modules') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else if (extensions.has(extname(path))) files.push(path);
  }
  return files;
}

/** Generated artifacts carry their generator's style, not ours. */
const isGenerated = (source) => source.slice(0, 400).includes('GENERATED FILE');

const failures = [];
for (const sourceRoot of sourceRoots) {
  for (const file of filesUnder(join(root, sourceRoot))) {
    const rel = relative(root, file);
    const source = readFileSync(file, 'utf8');
    // Checked below for what actually matters in a generated file — that it is
    // self-contained — but not for hand-written-code rules.
    if (isGenerated(source)) continue;
    if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/s.test(source)) {
      failures.push(`${rel}: empty catch block`);
    }
    for (const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (rel.startsWith('packages/core/src/') && /(?:^|\/)adapters(?:\/|$)/.test(specifier)) {
        failures.push(`${rel}: core must not import adapters (${specifier})`);
      }
      if (
        specifier === '@agentclientprotocol/sdk' &&
        !rel.startsWith('packages/core/src/acp/') &&
        !shimEntryPoint.test(rel)
      ) {
        failures.push(`${rel}: ACP SDK imports are confined to core/src/acp and adapter shims`);
      }
    }
  }
}

// ── path-loaded assets must be self-contained ──────────────────────────────
//
// An asset reached by path — `new URL('./x.mjs', import.meta.url)` — is not
// visible to a bundler, so a consumer who bundles has to copy it next to their
// artifact, where there is no node_modules to resolve anything from. Such an
// asset may therefore import `node:` builtins and nothing else. Measured, not
// theoretical: the pi shim imported the ACP SDK and died with
// ERR_MODULE_NOT_FOUND once copied out of the workspace.
const PATH_ASSET = /new URL\(\s*['"](\.\.?\/[^'"]+\.mjs)['"]\s*,\s*import\.meta\.url\s*\)/g;
const IMPORT_SPECIFIER = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]/g;

const assets = new Set();
for (const sourceRoot of sourceRoots) {
  for (const file of filesUnder(join(root, sourceRoot))) {
    const source = readFileSync(file, 'utf8');
    PATH_ASSET.lastIndex = 0;
    for (const match of source.matchAll(PATH_ASSET)) {
      const asset = resolve(dirname(file), match[1]);
      if (existsSync(asset)) assets.add(asset);
    }
  }
}
for (const asset of assets) {
  const rel = relative(root, asset);
  const source = readFileSync(asset, 'utf8');
  IMPORT_SPECIFIER.lastIndex = 0;
  for (const match of source.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier.startsWith('node:')) continue;
    failures.push(
      `${rel}: loaded by path, so it must import only node: builtins ('${specifier}' would not resolve once copied out of node_modules)`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`quality gate failed:\n${failures.map((line) => `- ${line}`).join('\n')}`);
}
console.log('quality gate passed: import boundaries, empty catches');
