import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Most cases here drive a real child process — the mock agent, a shim, or
    // the children those start — so the wall clock is process startup on a
    // loaded machine rather than the assertion. vitest's 5s default is a
    // budget for in-memory unit tests, and three live-stream cases blew
    // through it on the CI runner while passing in about a second locally,
    // failing a pipeline for a reason that has nothing to do with the code
    // under test. `packages/conformance` and `packages/testkit` already carry
    // the same allowance for the same reason; this package was the one that
    // spawns processes in fifteen files and had none.
    //
    // 30s rather than a larger number: the overshoots measured were five to
    // nine seconds, so this is several times the observed cost, and a case
    // that genuinely hangs still fails in well under a minute.
    //
    // Cases with a genuinely different budget still set their own.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
