/**
 * The consumer path, driven the way the README documents it: `createHub` from
 * `runskein` and `createFolder` from `runskein/fold`, folding a real
 * session's update stream.
 *
 * The existing meta test only proves the subpath resolves and hands back an
 * object with push/flush. That would still pass if folding itself broke on
 * this path, which is the half a consumer actually depends on.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHub, jsonlStore, policies } from '../src/index.js';
import { collectToolRows, createFolder, toolCallText, type PresentationEvent } from '../src/fold.js';
import type { EngineAdapter, TranscriptEvent } from '@runskein/core';

const FIXTURE = resolve(import.meta.dirname, '../../core/test/fixtures/mock-agent.mjs');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function mockAdapter(env: Record<string, string>): EngineAdapter {
  return {
    specVersion: 1,
    id: 'mock',
    launch: { command: process.execPath, args: [FIXTURE], env, startTimeoutMs: 10_000 },
  };
}

interface TurnFold {
  presented: PresentationEvent[];
  /** Live updates by sessionUpdate kind, so a test can show folding worked. */
  rawKinds: Record<string, number>;
  /** The persisted transcript, read back the way an after-the-fact reader would. */
  transcript: TranscriptEvent[];
}

/** Run one turn, collecting both the raw stream and what folding made of it. */
async function foldOneTurn(env: Record<string, string>): Promise<TurnFold> {
  const hub = createHub({
    adapters: [mockAdapter(env)],
    discovery: false,
    store: jsonlStore(tmp('runskein-consumer-')),
    defaults: { permissionPolicy: policies.allowAll },
  });
  const presented: PresentationEvent[] = [];
  const rawKinds: Record<string, number> = {};
  const transcript: TranscriptEvent[] = [];
  try {
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-consumer-ws-') });
    const folder = createFolder();
    session.on('update', (event) => {
      const kind = String((event.update as { sessionUpdate?: unknown }).sessionUpdate);
      rawKinds[kind] = (rawKinds[kind] ?? 0) + 1;
      for (const folded of folder.push(event)) presented.push(folded.event);
    });
    await session.prompt('go');
    for (const folded of folder.flush()) presented.push(folded.event);
    for await (const event of session.transcript()) transcript.push(event);
    await session.close();
  } finally {
    await hub.quit();
  }
  return { presented, rawKinds, transcript };
}

describe('consumer path: runskein + runskein/fold', () => {
  it('coalesces a chunked reply into one message run', async () => {
    // The mock emits 12 separate agent_message_chunk updates. A consumer
    // rendering the raw stream would print 12 fragments; folding turns them
    // into one run that opens once, appends, and closes on flush.
    const { presented, rawKinds } = await foldOneTurn({ MOCK_LONG_TURN: '1' });

    // Self-evidencing: the raw stream really did carry many chunks, so the
    // single run below is folding doing work, not an empty turn passing.
    expect(rawKinds['agent_message_chunk']).toBeGreaterThanOrEqual(12);

    // The live stream carries runskein's own echo of the prompt as well, so the
    // run being coalesced here is the agent's one.
    const starts = presented.filter((e) => e.type === 'messageStart');
    expect(starts.map((e) => (e as Extract<PresentationEvent, { type: 'messageStart' }>).kind)).toEqual([
      'user',
      'agent',
    ]);

    const text = presented
      .filter((e): e is Extract<PresentationEvent, { type: 'messageAppend' }> => e.type === 'messageAppend')
      .map((e) => e.block.text)
      .join('');
    expect(text).toContain('chunk1');
    expect(text).toContain('chunk12');

    // flush() closes the run the transcript never marked as ended. Closing the
    // session records its own status event afterwards, so the end is the last
    // thing about the message, not the last thing in the list.
    expect(presented.findLastIndex((e) => e.type === 'messageEnd')).toBeGreaterThan(
      presented.findLastIndex((e) => e.type === 'messageAppend'),
    );
  }, 30_000);

  it('merges tool_call and its deltas into a single row', async () => {
    // tool_call (pending) followed by tool_call_update (completed): two wire
    // events, one row, with `changed` naming what the delta touched.
    const { presented, rawKinds } = await foldOneTurn({ MOCK_ASK_PERMISSION: '1' });
    expect(rawKinds['tool_call']).toBe(1);
    expect(rawKinds['tool_call_update']).toBe(1);

    const rows = presented.filter(
      (e): e is Extract<PresentationEvent, { type: 'toolRow' }> => e.type === 'toolRow',
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const ids = new Set(rows.map((r) => r.row.toolCallId));
    expect(ids.size).toBe(1); // one call, not one row per event

    const last = rows.at(-1)!;
    expect(last.row.title).toBe('write-file'); // carried over from the first event
    expect(last.row.status).toBe('completed'); // supplied by the delta
    expect(last.changed).toContain('status');
  }, 30_000);

  it('collects the settled tool rows from a stored transcript', async () => {
    // What a reader gets after the fact — including for a sub-agent, whose
    // whole run an engine reports as one tool call on the parent session.
    const { transcript, presented } = await foldOneTurn({ MOCK_ASK_PERMISSION: '1' });
    expect(transcript.length).toBeGreaterThan(0);

    const rows = collectToolRows(transcript);
    expect(rows.size).toBe(1);
    const row = [...rows.values()][0]!;
    expect(row.title).toBe('write-file');
    expect(row.status).toBe('completed'); // the delta merged in, not the pending create

    // Replaying the store agrees with what the live folder ended on.
    const live = presented.filter(
      (e): e is Extract<PresentationEvent, { type: 'toolRow' }> => e.type === 'toolRow',
    );
    expect(row).toEqual(live.at(-1)!.row);

    // The mock reports this call with neither content nor rawOutput, so the
    // honest answer is empty text — not an invented rendering of the row.
    expect(toolCallText(row)).toBe('');
  }, 30_000);

  it('never drops an update it does not recognise', async () => {
    // Engines add update variants faster than any client tracks them. Folding
    // must surface the unknown ones rather than swallow them.
    const { presented } = await foldOneTurn({ MOCK_UNKNOWN_UPDATE: '1' });
    const raw = presented.filter((e): e is Extract<PresentationEvent, { type: 'raw' }> => e.type === 'raw');
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[0]!.reason).toBe('unknown-update');
  }, 30_000);
});
