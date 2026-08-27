import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every case here spawns processes — an engine or a shim plus the children
    // it starts — so the wall clock is dominated by process startup on a
    // loaded machine, not by the assertion. vitest's 5s default is a budget
    // for in-memory unit tests; three cases blew through it on the CI runner
    // while passing in about a second locally, which fails a release for a
    // reason that has nothing to do with the code under test.
    //
    // Cases with a genuinely different budget still set their own.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
