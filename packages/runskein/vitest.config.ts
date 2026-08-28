import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `hub.engines()` runs every bundled adapter's `detect()`, and detection
    // executes the real engine binaries. That is the point of these cases —
    // they assert the meta-package works without configuration — but it makes
    // their wall clock the startup cost of five installed programs.
    //
    // On the CI runner that cost is higher than locally: the agent gives each
    // workflow an isolated home, so codex finds no home of its own and rebuilds
    // one under a temporary directory before answering. `engines() never
    // spawns` timed out at 5076ms against vitest's 5s default while its sibling
    // took 4448ms — the whole group sits on the line, and which side it lands
    // on is the runner's mood rather than anything about the code.
    //
    // Cases with a genuinely different budget still set their own.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
