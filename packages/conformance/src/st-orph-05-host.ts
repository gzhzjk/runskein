/**
 * The sacrificial host for ST-ORPH-05: brings a real engine up, then waits to
 * be killed. Separate from the harness because the harness has to survive it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Hub, fileOwnershipRegistry, memoryStore } from '@runskein/core/internal';
import { builtinAdapters } from 'runskein';
import { liveConfigFor } from './liveSupport.js';

interface HostConfig {
  engineId: string;
  cwd: string;
  registryPath: string;
  readyFile: string;
}

const config = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as HostConfig;
const adapter = builtinAdapters.find((a) => a.id === config.engineId)!;
const pinned = liveConfigFor(config.engineId).config;

const hub = new Hub({
  discovery: false,
  adapters: [adapter],
  store: memoryStore(),
  orphanSweep: { ownership: fileOwnershipRegistry(config.registryPath) },
});

const session = await hub.session({
  engine: config.engineId,
  cwd: config.cwd,
  ...(pinned !== undefined ? { config: pinned } : {}),
});
// A turn, so the engine is fully warmed rather than merely spawned — the leak
// this case exists for happens to engines that have really been working.
await session.prompt('Reply with exactly the word OK. Use no tools.');

writeFileSync(config.readyFile, JSON.stringify({ hostPid: process.pid }));

// Wait to be killed. No shutdown path here on purpose.
setInterval(() => {}, 1000);
