#!/usr/bin/env node
/**
 * `pnpm conformance [engineId ...]` — the adapter registration gate
 * (design §2.2 rule 4).
 *
 * No arguments: the Core gate against the hermetic mock agent (what CI
 * runs). With engine ids: the SAME cases against those real installed
 * engines (needs auth; nothing is faked).
 */
import { spawn } from 'node:child_process';

const ids = process.argv.slice(2);
const childEnv = { ...process.env };
if (ids.length > 0) childEnv.RUNSKEIN_GATE_ENGINES = ids.join(',');
else delete childEnv.RUNSKEIN_GATE_ENGINES;
const child = spawn('pnpm', ['--filter', '@runskein/conformance', 'gate'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: childEnv,
});
child.on('exit', (code) => process.exit(code ?? 1));
