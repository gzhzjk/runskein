/**
 * Streaming JSONL transcript store. Each session has an independent append
 * queue and a crash-repairable metadata sidecar, keeping reads bounded and
 * inventory proportional to the number of sessions rather than all history.
 */
import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { NotFoundError, StoreError } from '../errors.js';
import {
  createDigestBuilder,
  type DigestOptions,
  type DigestResult,
  type StructuredDigestOptions,
  type TextDigestOptions,
} from './digest.js';
import type { StructuredDigest, TranscriptDigest, TranscriptEvent } from './event.js';
import {
  matchesFilter,
  updateSessionMeta,
  type SessionFilter,
  type SessionMeta,
  type TranscriptStore,
} from './store.js';

const FILE_RE = /^(?<id>.+)\.jsonl$/;
const INVENTORY_CONCURRENCY = 16;

interface MetaSidecar {
  byteSize: number;
  meta: SessionMeta;
}

/** Distinguish the persisted metadata sidecar from a transcript file. */
function isMetaSidecar(value: unknown, sessionId: string, byteSize: number): value is MetaSidecar {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<MetaSidecar>;
  const meta = candidate.meta;
  return (
    candidate.byteSize === byteSize &&
    typeof meta === 'object' &&
    meta !== null &&
    meta.sessionId === sessionId &&
    typeof meta.engineId === 'string' &&
    typeof meta.cwd === 'string' &&
    ['idle', 'running', 'awaiting-input', 'closed', 'failed'].includes(meta.status) &&
    typeof meta.createdAt === 'number' &&
    typeof meta.updatedAt === 'number'
  );
}

/**
 * Test whether an fs error is ENOENT (missing file).
 * @param error - the thrown error.
 * @returns true when the error is ENOENT.
 */
function isNoEnt(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Create the default jsonl-backed TranscriptStore.
 * @param dir - directory holding one `<sessionId>.jsonl` per session plus a metadata sidecar.
 * @returns a TranscriptStore whose append/read/sessions/digest/delete persist under `dir`.
 */
export function jsonlStore(dir: string): TranscriptStore {
  const validateId = (sessionId: string): void => {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith('.')) {
      throw new NotFoundError({ resource: 'session', resourceId: sessionId });
    }
  };
  const fileFor = (sessionId: string): string => {
    validateId(sessionId);
    return join(dir, `${sessionId}.jsonl`);
  };
  const metaFor = (sessionId: string): string => join(dir, `${sessionId}.meta.json`);

  let dirReady: Promise<unknown> | undefined;
  const ensureDir = (): Promise<unknown> => (dirReady ??= mkdir(dir, { recursive: true }));
  const appendChains = new Map<string, Promise<void>>();
  const metaCache = new Map<string, MetaSidecar>();

  async function* streamEvents(sessionId: string): AsyncIterable<TranscriptEvent> {
    let input: ReturnType<typeof createReadStream> | undefined;
    try {
      input = createReadStream(fileFor(sessionId), { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      // A crash mid-append leaves a torn partial line at EOF; its append was
      // never acknowledged, so skipping it is repair, not data loss. A parse
      // failure that is NOT the final line is real corruption and still throws.
      let torn: string | undefined;
      for await (const line of lines) {
        if (line.trim() === '') continue;
        if (torn !== undefined) {
          throw new StoreError({
            operation: 'read',
            sessionId,
            cause: new Error(`corrupt transcript line: ${torn.slice(0, 120)}`),
          });
        }
        try {
          yield JSON.parse(line) as TranscriptEvent;
        } catch {
          torn = line;
        }
      }
    } catch (cause) {
      input?.destroy();
      if (cause instanceof NotFoundError || cause instanceof StoreError) throw cause;
      if (isNoEnt(cause)) {
        throw new NotFoundError({ resource: 'transcript', resourceId: sessionId, sessionId });
      }
      throw new StoreError({ operation: 'read', cause, sessionId });
    }
  }

  async function scanMeta(sessionId: string): Promise<MetaSidecar> {
    // Metadata is fixed-size; fold through the stream without loading history.
    let meta: SessionMeta | undefined;
    for await (const event of streamEvents(sessionId)) meta = updateSessionMeta(meta, event);
    if (meta === undefined) {
      throw new StoreError({
        operation: 'sessions',
        sessionId,
        cause: new Error('empty transcript has no session metadata'),
      });
    }
    const info = await stat(fileFor(sessionId));
    return { byteSize: info.size, meta };
  }

  async function writeSidecar(sessionId: string, sidecar: MetaSidecar): Promise<void> {
    const target = metaFor(sessionId);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(sidecar), 'utf8');
      await rename(temporary, target);
    } catch (cause) {
      try {
        await unlink(temporary);
      } catch (cleanupCause) {
        if (!isNoEnt(cleanupCause)) {
          throw new AggregateError([cause, cleanupCause], 'sidecar write and cleanup failed');
        }
      }
      throw cause;
    }
  }

  async function loadMeta(sessionId: string): Promise<MetaSidecar> {
    const cached = metaCache.get(sessionId);
    const transcript = fileFor(sessionId);
    if (cached !== undefined) {
      try {
        if ((await stat(transcript)).size === cached.byteSize) return cached;
      } catch (cause) {
        if (!isNoEnt(cause)) {
          throw new StoreError({ operation: 'sessions', cause, sessionId });
        }
      }
      metaCache.delete(sessionId);
    }
    try {
      const [raw, info] = await Promise.all([readFile(metaFor(sessionId), 'utf8'), stat(transcript)]);
      const sidecar = JSON.parse(raw) as unknown;
      if (isMetaSidecar(sidecar, sessionId, info.size)) {
        metaCache.set(sessionId, sidecar);
        return sidecar;
      }
    } catch (cause) {
      if (!isNoEnt(cause) && !(cause instanceof SyntaxError)) {
        throw new StoreError({ operation: 'sessions', cause, sessionId });
      }
    }
    const repaired = await scanMeta(sessionId);
    await writeSidecar(sessionId, repaired);
    metaCache.set(sessionId, repaired);
    return repaired;
  }

  /**
   * Run an operation per session serially so disk order matches call order.
   * @param sessionId - the session the operation belongs to.
   * @param operation - the async work to serialize.
   * @returns the operation's result, surfaced to its own caller.
   */
  function serialize<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = appendChains.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    appendChains.set(sessionId, settled);
    void settled.finally(() => {
      if (appendChains.get(sessionId) === settled) appendChains.delete(sessionId);
    });
    return result;
  }

  return {
    /**
     * Append one event to its session file and update the metadata sidecar.
     * @param event - the event to persist; sessionId selects the file.
     * @throws StoreError when the append or the sidecar write fails.
     */
    append(event: TranscriptEvent): Promise<void> {
      return serialize(event.sessionId, async () => {
        try {
          await ensureDir();
          let sidecar: MetaSidecar | undefined;
          try {
            sidecar = await loadMeta(event.sessionId);
          } catch (cause) {
            if (!(cause instanceof NotFoundError)) throw cause;
          }
          const line = `${JSON.stringify(event)}\n`;
          await appendFile(fileFor(event.sessionId), line, 'utf8');
          const next: MetaSidecar = {
            byteSize: (sidecar?.byteSize ?? 0) + Buffer.byteLength(line),
            meta: updateSessionMeta(sidecar?.meta, event),
          };
          try {
            await writeSidecar(event.sessionId, next);
          } catch (sidecarCause) {
            // Keep append all-or-nothing from the caller's perspective. The
            // per-session queue prevents another local append racing rollback.
            try {
              if (sidecar?.byteSize === undefined || sidecar.byteSize === 0) {
                await unlink(fileFor(event.sessionId));
              } else {
                await truncate(fileFor(event.sessionId), sidecar.byteSize);
              }
            } catch (rollbackCause) {
              throw new AggregateError(
                [sidecarCause, rollbackCause],
                'metadata update failed and transcript append could not be rolled back',
              );
            }
            throw sidecarCause;
          }
          metaCache.set(event.sessionId, next);
        } catch (cause) {
          if (cause instanceof NotFoundError || cause instanceof StoreError) throw cause;
          throw new StoreError({
            operation: 'append',
            cause,
            sessionId: event.sessionId,
            engineId: event.engineId,
          });
        }
      });
    },

    /**
     * Stream a session's events in seq order, honoring inclusive seq bounds.
     * @param sessionId - the session to read.
     * @param opts - optional fromSeq/toSeq bounds.
     * @returns the matching events in order.
     * @throws NotFoundError for an unknown session.
     */
    async *read(sessionId, opts): AsyncIterable<TranscriptEvent> {
      await appendChains.get(sessionId);
      for await (const event of streamEvents(sessionId)) {
        if (opts?.fromSeq !== undefined && event.seq < opts.fromSeq) continue;
        if (opts?.toSeq !== undefined && event.seq > opts.toSeq) continue;
        yield event;
      }
    },

    /**
     * List sessions folded from their metadata sidecars.
     * @param filter - optional engine/status/cwd/time filtering.
     * @returns matching sessions sorted by creation time.
     * @throws StoreError when the directory or a sidecar read fails.
     */
    async sessions(filter?: SessionFilter): Promise<SessionMeta[]> {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (cause) {
        if (isNoEnt(cause)) return [];
        throw new StoreError({ operation: 'sessions', cause });
      }
      const ids = names.flatMap((name) => {
        const id = FILE_RE.exec(name)?.groups?.['id'];
        return id === undefined ? [] : [id];
      });
      const metas: SessionMeta[] = [];
      for (let offset = 0; offset < ids.length; offset += INVENTORY_CONCURRENCY) {
        const batch = ids.slice(offset, offset + INVENTORY_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (id) => {
            await appendChains.get(id);
            try {
              return (await loadMeta(id)).meta;
            } catch (cause) {
              if (cause instanceof NotFoundError) return undefined;
              // One damaged transcript must degrade to a skipped row, not
              // take down the listing of every other session — the store is
              // authoritative for session lists and resume.
              console.error(`[runskein] skipping unreadable transcript '${id}': ${String(cause)}`);
              return undefined;
            }
          }),
        );
        for (const meta of results) if (meta && matchesFilter(meta, filter)) metas.push(meta);
      }
      return metas.sort((a, b) => a.createdAt - b.createdAt);
    },

    digest: (() => {
      function digest(sessionId: string): Promise<TranscriptDigest>;
      function digest(sessionId: string, opts: StructuredDigestOptions): Promise<StructuredDigest>;
      function digest(sessionId: string, opts: TextDigestOptions): Promise<TranscriptDigest>;
      function digest(sessionId: string, opts: DigestOptions): Promise<DigestResult>;
      async function digest(sessionId: string, opts?: DigestOptions): Promise<DigestResult> {
        await appendChains.get(sessionId);
        const builder = createDigestBuilder(sessionId, opts);
        for await (const event of streamEvents(sessionId)) builder.add(event);
        return builder.finish();
      }
      return digest;
    })(),

    /**
     * Remove a session's transcript and metadata sidecar.
     * @param sessionId - the session to delete.
     * @throws NotFoundError when the session does not exist; StoreError on other failures.
     */
    delete(sessionId: string): Promise<void> {
      return serialize(sessionId, async () => {
        try {
          const transcript = fileFor(sessionId);
          try {
            await unlink(metaFor(sessionId));
          } catch (cause) {
            if (!isNoEnt(cause)) throw cause;
          }
          // Removing the derived index first is recoverable: if transcript
          // deletion fails or the process crashes, sessions() rebuilds it.
          await unlink(transcript);
          metaCache.delete(sessionId);
        } catch (cause) {
          if (cause instanceof NotFoundError) throw cause;
          if (isNoEnt(cause)) {
            throw new NotFoundError({ resource: 'session', resourceId: sessionId, sessionId });
          }
          throw new StoreError({ operation: 'delete', cause, sessionId });
        }
      });
    },
  };
}
