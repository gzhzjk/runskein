/**
 * ST-DIG-05 — hand a structured digest from one live engine to another.
 *
 * This case is intentionally standalone because the normal live runner owns
 * one hub per engine group. It keeps the source and destination sessions in
 * one hub here, while still forcing different engines by default.
 *
 * Usage: pnpm --filter @runskein/conformance st:dig [source] [destination]
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAdapters, createHub, jsonlStore, type StructuredDigest } from 'runskein';
import {
  collectNativeSessionIds,
  deleteEngineSessions,
  LIVE_MODEL_PINS,
  isLiveEnvironmentUnavailable,
  withLiveTimeout,
} from './liveSupport.js';

const [sourceEngine = 'kimi', destinationEngine = 'codex'] = process.argv.slice(2);
const adapterIds = new Set(builtinAdapters.map((adapter) => adapter.id));
if (!adapterIds.has(sourceEngine) || !adapterIds.has(destinationEngine)) {
  throw new Error(
    `unknown engine pair '${sourceEngine} ${destinationEngine}'; known: ${[...adapterIds].join(', ')}`,
  );
}

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const store = jsonlStore(tmp('runskein-st-dig-store-'));
const hub = createHub({ store });
let source: Awaited<ReturnType<typeof hub.session>> | undefined;
let destination: Awaited<ReturnType<typeof hub.session>> | undefined;

async function replyText(
  session: Awaited<ReturnType<typeof hub.session>>,
  prompt: string,
): Promise<string> {
  let text = '';
  const off = session.on('update', (event) => {
    const update = event.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      text += update.content.text ?? '';
    }
  });
  try {
    await withLiveTimeout(session.prompt(prompt), 180_000, 'st-dig-05 prompt');
    return text;
  } finally {
    off();
  }
}

try {
  const reason = `DIG-REASON-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  source = await hub.session({
    engine: sourceEngine,
    cwd: tmp(`runskein-st-dig-source-${sourceEngine}-`),
    ...(LIVE_MODEL_PINS[sourceEngine] !== undefined
      ? { config: { model: LIVE_MODEL_PINS[sourceEngine]!.model } }
      : {}),
  });
  await replyText(
    source,
    `Make a decision about a parser implementation. Choose the streaming parser. ` +
      `The stated reason must include the exact token ${reason}. Reply with the decision and reason.`,
  );

  const digest = await hub.transcripts.digest(source.id, { format: 'structured' });
  if (!('segments' in digest)) throw new Error('structured digest was not returned');
  const rendered = JSON.stringify(digest as StructuredDigest);
  destination = await hub.session({
    engine: destinationEngine,
    cwd: tmp(`runskein-st-dig-destination-${destinationEngine}-`),
    ...(LIVE_MODEL_PINS[destinationEngine] !== undefined
      ? { config: { model: LIVE_MODEL_PINS[destinationEngine]!.model } }
      : {}),
  });
  const answer = await replyText(
    destination,
    `Use this structured handoff from another agent:\n\n${rendered}\n\n` +
      `What exact reason token justified the streaming parser decision? Reply with the token only.`,
  );
  const passed = answer.includes(reason);
  console.log(
    JSON.stringify(
      {
        case: 'ST-DIG-05',
        sourceEngine,
        destinationEngine,
        reason,
        digestSegments: digest.segments.length,
        answer: answer.trim(),
        verdict: passed ? 'pass' : 'fail',
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
} catch (error) {
  if (isLiveEnvironmentUnavailable(error)) {
    console.log(
      JSON.stringify({
        case: 'ST-DIG-05',
        sourceEngine,
        destinationEngine,
        verdict: 'skip',
        waiver: String(error),
      }),
    );
  } else {
    throw error;
  }
} finally {
  await source?.close().catch(() => undefined);
  await destination?.close().catch(() => undefined);
  await hub.quit().catch(() => undefined);
  const sourceAdapter = builtinAdapters.find((adapter) => adapter.id === sourceEngine);
  const destinationAdapter = builtinAdapters.find((adapter) => adapter.id === destinationEngine);
  const sourceIds = await collectNativeSessionIds(store, sourceEngine).catch(() => []);
  const destinationIds = await collectNativeSessionIds(store, destinationEngine).catch(() => []);
  if (sourceAdapter !== undefined && sourceAdapter.id === destinationAdapter?.id) {
    await deleteEngineSessions(sourceAdapter, [...new Set([...sourceIds, ...destinationIds])]).catch(
      () => undefined,
    );
  } else {
    if (sourceAdapter !== undefined)
      await deleteEngineSessions(sourceAdapter, sourceIds).catch(() => undefined);
    if (destinationAdapter !== undefined)
      await deleteEngineSessions(destinationAdapter, destinationIds).catch(() => undefined);
  }
}
