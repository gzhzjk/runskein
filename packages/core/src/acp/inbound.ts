/**
 * ACP inbound coordinator.
 *
 * The upstream SDK validates `session/update` against a closed zod union and
 * dispatches request handlers concurrently. RunSkein needs two stronger wire
 * guarantees: future update variants must survive, and interactive requests
 * must be announced in arrival order. This transform enforces both before the
 * SDK sees the NDJSON stream.
 */
import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { SessionUpdateNotification } from './clientMethods.js';
import { emitWireFrame, type WireObserver } from './wireTrace.js';

const INTERACTIVE_METHODS = new Set(['elicitation/create', 'session/request_permission']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestKey(id: unknown): string | undefined {
  return typeof id === 'string' || typeof id === 'number' ? `${typeof id}:${String(id)}` : undefined;
}

function rawUpdate(message: unknown): SessionUpdateNotification | undefined {
  if (!isRecord(message) || message['method'] !== 'session/update' || message['id'] !== undefined)
    return undefined;
  const params = message['params'];
  if (!isRecord(params) || typeof params['sessionId'] !== 'string') return undefined;
  const update = params['update'];
  if (!isRecord(update) || typeof update['sessionUpdate'] !== 'string') return undefined;
  return params as unknown as SessionUpdateNotification;
}

function interactiveRequest(message: unknown): string | undefined {
  if (!isRecord(message) || !INTERACTIVE_METHODS.has(String(message['method']))) return undefined;
  return requestKey(message['id']);
}

export class AcpInbound extends Transform {
  private buffered = '';
  // Per-chunk Buffer.toString() would corrupt a multi-byte UTF-8 codepoint
  // split across a pipe-chunk boundary (U+FFFD on both fragments); the
  // decoder carries the partial sequence over to the next chunk.
  private readonly decoder = new StringDecoder('utf8');
  private readonly acknowledgements = new Map<string, () => void>();

  constructor(
    private readonly onUpdate: ((notification: SessionUpdateNotification) => void) | undefined,
    private readonly onWireFrame?: WireObserver,
  ) {
    super();
  }

  /**
   * Report that the SDK has entered the handler for an interactive request,
   * releasing the next wire item.
   * @param id - the JSON-RPC request id; unusable ids are ignored.
   */
  acknowledge(id: unknown): void {
    const key = requestKey(id);
    if (key === undefined) return;
    this.acknowledgements.get(key)?.();
  }

  /**
   * Watch an outgoing JSON-RPC response and treat it as an acknowledgement.
   * A request the SDK rejected as invalid never reaches a handler, so its
   * error response is the only signal that it will not be entered.
   * @param message - a parsed outbound message; non-responses are ignored.
   */
  observeOutbound(message: unknown): void {
    if (!isRecord(message) || message['method'] !== undefined) return;
    if (message['result'] === undefined && message['error'] === undefined) return;
    this.acknowledge(message['id']);
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.buffered += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const parts = this.buffered.split('\n');
    this.buffered = parts.pop() ?? '';
    void this.forward(parts).then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  override _flush(callback: TransformCallback): void {
    const tail = this.buffered + this.decoder.end();
    this.buffered = '';
    void this.forward(tail === '' ? [] : [tail]).then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  private async forward(lines: string[]): Promise<void> {
    for (const line of lines) {
      if (line.trim() === '') {
        this.push(`${line}\n`);
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line) as unknown;
      } catch {
        // Let the SDK own malformed JSON diagnostics and connection handling.
        this.push(`${line}\n`);
        continue;
      }

      // Traced before any routing decision, so the observer sees every frame
      // the engine sent — including the updates handled and consumed below.
      emitWireFrame(this.onWireFrame, 'in', message);

      const update = rawUpdate(message);
      if (update !== undefined && this.onUpdate !== undefined) {
        // A throwing handler must degrade one update, not error the Transform:
        // that would sever the connection while the child process keeps
        // running, leaving a zombie the manager never notices (no exit, no
        // crash event, health still 'ready').
        try {
          this.onUpdate(update);
        } catch (error) {
          console.error(`[runskein] update handler threw: ${String(error)}`);
        }
        continue;
      }

      const key = interactiveRequest(message);
      if (key === undefined) {
        this.push(`${line}\n`);
        continue;
      }

      // Do not expose the next interactive wire item until the SDK has entered
      // this one's handler. We wait for handler entry, never for the user's
      // response, so multiple pending requests remain visible concurrently.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          this.acknowledgements.delete(key);
          resolve();
        };
        this.acknowledgements.set(key, finish);
        this.push(`${line}\n`);
      });
    }
  }
}

/** Pass SDK output through while observing JSON-RPC responses for ingress ack. */
export class AcpOutbound extends Transform {
  private buffered = '';
  private readonly decoder = new StringDecoder('utf8');

  constructor(
    private readonly inbound: AcpInbound,
    private readonly onWireFrame?: WireObserver,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.push(chunk);
    this.buffered += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines = this.buffered.split('\n');
    this.buffered = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const message = JSON.parse(line) as unknown;
        emitWireFrame(this.onWireFrame, 'out', message);
        this.inbound.observeOutbound(message);
      } catch {
        // The SDK owns its output framing; observation must remain transparent.
      }
    }
    callback();
  }
}
