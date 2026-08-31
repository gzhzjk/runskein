import { createHub, policies, UnauthenticatedError } from 'runskein';

const hub = createHub();

// Which agents are on this machine? Cheap — it never starts one.
const engines = await hub.engines();
const usable = engines.filter((e) => e.installed && e.health !== 'invalid' && e.authenticated !== false);
// Some agents cannot report their login state, so `authenticated` is undefined
// for them. Take one that says it is logged in before one that cannot say.
const engine = usable.find((e) => e.authenticated === true)?.id ?? usable[0]?.id;
if (!engine) {
  console.error('No coding agent found. Install one and log in, then run this again.');
  process.exit(1);
}
console.log(`using ${engine}`);

const session = await hub.session({
  engine,
  cwd: process.cwd(),
  // Demo only: approves every permission request. cwd is not a sandbox.
  permissionPolicy: policies.allowAll,
});

// The agent's reply arrives as it is written.
session.on('update', (event) => {
  const update = event.update;
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    process.stdout.write(update.content.text);
  }
});

try {
  const result = await session.prompt('Read package.json here and tell me the package name.');
  console.log(`\n\nstop reason: ${result.stopReason}`);
} catch (error) {
  // The one failure a first run really hits: installed, but not logged in.
  if (!(error instanceof UnauthenticatedError)) throw error;
  console.error(`\n${engine} is not logged in — try: ${error.loginHint ?? 'its login command'}`);
} finally {
  await session.close();
  await hub.quit();
}
