# runskein

One TypeScript API for coding-agent engines — process lifecycle, sessions,
permissions, and a single persistent transcript format — with engines
integrated as auto-discovered adapters over the Agent Client Protocol
(which is never exposed to you).

```bash
npm install runskein
```

Node.js 22 or newer, ESM only. This installs no engine: runskein drives
OpenCode, Kimi Code, Claude Code, Codex or pi already on your `PATH`, so
install at least one and log in first.

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

The default policy is `allowAll`, so the agent may read and write files under
the `cwd` you pass. Point a first experiment at a directory you can throw away.

## Adding an engine

Drop a directory with a `runskein.adapter` marker in `<cwd>/adapters/<id>/` (or
publish a `runskein-adapter-<id>` package) whose default export follows the
adapter spec — no core or consumer changes. See the
[adapter guide](https://github.com/gzhzjk/runskein/blob/main/docs/adapter-guide.md)
and the bundled `adapters/*` packages for reference.

## Docs

- [README](https://github.com/gzhzjk/runskein#readme) — the three-minute start, and why this exists
- [API specification](https://github.com/gzhzjk/runskein/blob/main/docs/engine-adapter-api.md) — the frozen v1 surface
- [Capability matrix](https://github.com/gzhzjk/runskein/blob/main/docs/capability-matrix.md) — capability tiers and what each engine measured
- [Architecture](https://github.com/gzhzjk/runskein/blob/main/docs/architecture.md) — how the pieces fit together
- [Adapter guide](https://github.com/gzhzjk/runskein/blob/main/docs/adapter-guide.md) — writing an adapter
- [Measured matrix](https://github.com/gzhzjk/runskein/blob/main/docs/conformance/matrix.public.json) — the probe output the tables are drawn from

Questions, or an engine behaving differently from the matrix?
[Open an issue](https://github.com/gzhzjk/runskein/issues).
