# runskein

One TypeScript API for coding-agent engines — process lifecycle, sessions,
permissions, and a single persistent transcript format — with engines
integrated as auto-discovered adapters over the Agent Client Protocol
(which is never exposed to you).

## Quickstart

```ts
import { createHub, policies } from 'runskein';

const hub = createHub(); // bundles the opencode / kimi / claude-code / codex / pi adapters

// What's available on this machine? (cheap; never spawns)
console.table(await hub.engines());

// One conversation on one engine (spawns on demand, engines share processes)
const session = await hub.session({
  engine: 'opencode',
  cwd: process.cwd(),
  permissionPolicy: policies.allowAll, // the default; denyAll / rules([...]) / your own
});

session.on('update', (e) => {
  if (e.update.sessionUpdate === 'agent_message_chunk' && e.update.content.type === 'text') {
    process.stdout.write(e.update.content.text);
  }
});

const result = await session.prompt('Summarize this repository.');
console.log('\nturn ended:', result.stopReason, `${result.durationMs}ms`);

// The transcript persisted itself (.transcripts/ by default; sqliteStore available)
for await (const event of session.transcript()) {
  // {seq, ts, sessionId, engineId, update} — ACP vocabulary, runskein envelope
}

// Resume later — native when the engine supports it, transcript-digest
// rebuild when it doesn't; the session id stays the same either way:
const resumed = await hub.session({ engine: 'opencode', cwd: process.cwd(), resume: session.id });
console.log(resumed.resumeTier); // 'native' | 'load' | 'rebuilt'

await session.close();
await hub.quit();
```

## Adding an engine

Drop a directory with a `runskein.adapter` marker in `<cwd>/adapters/<id>/` (or
publish a `runskein-adapter-<id>` package) whose default export follows the
adapter spec — no core or consumer changes. See `docs/adapter-guide.md` and the
bundled `adapters/*` packages for reference.

## Docs

- `docs/engine-adapter-api.md` — the frozen v1 API surface
- `docs/capability-matrix.md` — capability tiers and what each engine measured
- `docs/architecture.md` — how the pieces fit together
- `docs/adapter-guide.md` — writing an adapter
- `docs/conformance/matrix.public.json` — measured engine capabilities
