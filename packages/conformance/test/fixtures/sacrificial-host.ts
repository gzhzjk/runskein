/**
 * A host process that exists to be killed.
 *
 * AC-1.1 is a claim about what happens when a host dies *uncleanly*, so it
 * cannot be tested from inside the process making the claim: the test has to
 * own a real host, SIGKILL it, and then look at what is left behind. This is
 * that host.
 *
 * It brings up a Hub on the mock engine, runs one turn so the tree is fully
 * live, records what the test needs to find the processes afterwards, and then
 * idles forever waiting to be killed.
 *
 * Usage: tsx sacrificial-host.ts <config.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Hub, fileOwnershipRegistry, memoryStore, type EngineAdapter } from '@runskein/core/internal';

interface HostConfig {
  fixture: string;
  supervise: boolean;
  cwd: string;
  registryPath: string;
  readyFile: string;
  grandchildPidFile: string;
}

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as HostConfig;

const adapter: EngineAdapter = {
  specVersion: 1,
  id: 'mock',
  ...(config.supervise ? { supervise: true } : {}),
  launch: {
    command: process.execPath,
    args: [config.fixture],
    // The engine spawns a descendant of its own, so the tree under test is
    // host -> (supervisor) -> engine -> grandchild. The depth is load-bearing:
    // real trees are npx -> node -> engine and codex goes four deep, so a
    // fixture with a single-level child passes while proving nothing about the
    // tree that actually leaks. This descendant also ignores SIGTERM, so only
    // a group-wide kill removes it.
    env: { MOCK_STUBBORN_CHILD_PID_FILE: config.grandchildPidFile },
    startTimeoutMs: 20_000,
  },
};

const hub = new Hub({
  discovery: false,
  adapters: [adapter],
  store: memoryStore(),
  orphanSweep: { ownership: fileOwnershipRegistry(config.registryPath) },
});

const session = await hub.session({ engine: 'mock', cwd: config.cwd });
await session.prompt('stay alive');

// Only now is the whole tree up; the test may kill from here on. The host's
// own pid goes in the file because tsx runs this in a child of the process the
// test spawned — killing the wrapper would leave the real host alive.
writeFileSync(config.readyFile, JSON.stringify({ hostPid: process.pid }));

// Idle forever. Nothing here ever runs a clean shutdown: that is the point.
setInterval(() => {}, 1000);
