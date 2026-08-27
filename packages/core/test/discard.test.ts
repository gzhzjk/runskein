/** Hermetic acceptance coverage for negotiated engine-side session deletion. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EngineOperationError, NotSupportedError } from '../src/errors.js';
import { collect, makeHub, tmp } from './testkit.js';

/** Count delete requests recorded by the scripted agent, including failures. */
function deleteCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).length;
}

describe('ST-DISC-03 - local closure and transcript retention', () => {
  it('keeps plain close unchanged and discard leaves the local transcript intact', async () => {
    const plainDeleteTrace = `${tmp('runskein-discard-')}/plain-delete.ndjson`;
    const plainHub = makeHub({ MOCK_DELETE: '1', MOCK_RECORD_DELETE_FILE: plainDeleteTrace });
    const plain = await plainHub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });
    await plain.prompt('plain-close-history');
    await plain.close();
    expect(deleteCount(plainDeleteTrace)).toBe(0);

    const discardDeleteTrace = `${tmp('runskein-discard-')}/discard-delete.ndjson`;
    const discardHub = makeHub({ MOCK_DELETE: '1', MOCK_RECORD_DELETE_FILE: discardDeleteTrace });
    const discarded = await discardHub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });
    await discarded.prompt('discarded-history');
    const before = await collect(discarded.transcript());

    await discarded.close({ discard: true });

    expect(discarded.status).toBe('closed');
    expect(deleteCount(discardDeleteTrace)).toBe(1);
    expect(await collect(discardHub.transcripts.get(discarded.id))).toEqual([
      ...before,
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'session_info_update' }),
      }),
    ]);
  });
});

describe('ST-DISC-04 - failure and concurrency semantics', () => {
  it('rejects unsupported discard after local closure without deleting', async () => {
    const hub = makeHub();
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });

    const error = await session.close({ discard: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotSupportedError);
    expect(error).toMatchObject({ capability: 'session.delete', sessionId: session.id });
    expect(session.status).toBe('closed');
  });

  it('reports a delete failure only after local closure', async () => {
    const hub = makeHub({ MOCK_DELETE: '1', MOCK_DELETE_ERROR: '1' });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });

    const error = await session.close({ discard: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineOperationError);
    expect(error).toMatchObject({ operation: 'session/delete', sessionId: session.id });
    expect(session.status).toBe('closed');
  });

  it('attempts delete after close fails and preserves both failures', async () => {
    const hub = makeHub({ MOCK_DELETE: '1', MOCK_CLOSE_ERROR: '1', MOCK_DELETE_ERROR: '1' });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });

    const error = await session.close({ discard: true }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EngineOperationError);
    expect(error).toMatchObject({ operation: 'session/delete', sessionId: session.id });
    expect((error as EngineOperationError).cause).toBeInstanceOf(AggregateError);
    expect(((error as EngineOperationError).cause as AggregateError).errors).toHaveLength(2);
    expect(session.status).toBe('closed');
  });

  it('attempts delete after close fails even when deletion succeeds', async () => {
    const trace = `${tmp('runskein-discard-')}/delete.ndjson`;
    const hub = makeHub({ MOCK_DELETE: '1', MOCK_CLOSE_ERROR: '1', MOCK_RECORD_DELETE_FILE: trace });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });

    await expect(session.close({ discard: true })).rejects.toMatchObject({ operation: 'session/close' });

    expect(deleteCount(trace)).toBe(1);
    expect(session.status).toBe('closed');
  });

  it('shares a discarding close outcome and never repeats engine deletion', async () => {
    const trace = `${tmp('runskein-discard-')}/delete.ndjson`;
    const hub = makeHub({ MOCK_DELETE: '1', MOCK_DELETE_ERROR: '1', MOCK_RECORD_DELETE_FILE: trace });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });

    const first = session.close({ discard: true });
    const plain = session.close();
    const repeated = session.close({ discard: true });

    expect(plain).toBe(first);
    expect(repeated).toBe(first);
    await expect(first).rejects.toMatchObject({ operation: 'session/delete' });
    expect(deleteCount(trace)).toBe(1);
    expect(session.status).toBe('closed');
  });

  it('rejects a discard requested after a plain close instead of claiming deletion', async () => {
    const trace = `${tmp('runskein-discard-')}/delete.ndjson`;
    const hub = makeHub({ MOCK_DELETE: '1', MOCK_RECORD_DELETE_FILE: trace });
    const session = await hub.session({ engine: 'mock', cwd: tmp('runskein-discard-') });

    const plain = session.close();
    const lateDiscard = session.close({ discard: true }).catch((e: unknown) => e);

    await expect(plain).resolves.toBeUndefined();
    await expect(lateDiscard).resolves.toMatchObject({
      operation: 'session/delete',
      sessionId: session.id,
    });
    expect(deleteCount(trace)).toBe(0);
  });
});
