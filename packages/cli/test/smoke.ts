/**
 * Fixture-level e2e entry point for @runskein/cli. No real engine
 * required: suites drive the CLI through scripted ACP agent fixtures
 * loaded via `--adapter-path`.
 *
 * Run: pnpm --filter @runskein/cli test
 * Live-engine confirmation layer: pnpm --filter @runskein/cli test:live
 */
import { summarize, cleanStaleEngines } from './helpers.js';
import { unitSuite } from './suite-unit.js';
import { invocationSuite } from './suite-invocation.js';
import { describeSuite } from './suite-describe.js';
import { chatSuite } from './suite-chat.js';
import { renderSuite } from './suite-render.js';
import { signalsSuite } from './suite-signals.js';

// Isolate each suite from engine processes left behind by an interrupted run
// or a previous suite (teardown gate must only see this run's processes).
cleanStaleEngines();
await unitSuite();
cleanStaleEngines();
await invocationSuite();
cleanStaleEngines();
await describeSuite();
cleanStaleEngines();
await chatSuite();
cleanStaleEngines();
await renderSuite();
// Signal cases run last and serially (plan: process management).
cleanStaleEngines();
await signalsSuite();

process.exitCode = summarize();
