/**
 * Internal wire-trace seam — an optional observer of raw JSON-RPC frames.
 *
 * Some contracts runskein makes are claims about the wire: that an engine's quota
 * blob is passed through verbatim, that a config write was really re-applied
 * and acknowledged after a reactivation. Asserting those through the state the
 * implementation itself maintains would be testing the implementation against
 * itself, and the live harness only drives the public API, so there was no
 * independent oracle at all.
 *
 * This provides one. It is a test/diagnostic seam in the same family as the
 * capability override and the manager's injectable sleep: never on the public
 * surface, carries no policy, and does nothing whatsoever when no observer is
 * installed.
 */

/** One JSON-RPC frame as it crossed the child process's stdio. */
export interface WireFrame {
  /** `out` is runskein → engine; `in` is engine → runskein. */
  direction: 'in' | 'out';
  /** Present on requests and notifications; absent on responses. */
  method?: string;
  /** Present on requests and responses; absent on notifications. */
  id?: string | number;
  /** Request/notification payload, exactly as it appeared on the wire. */
  params?: unknown;
  /** Successful response payload, exactly as it appeared on the wire. */
  result?: unknown;
  /**
   * Failed response payload. The seam reports errors as well as results
   * because a refusal is a frame too, and an observer blind to them would be
   * blind precisely where a failure needs explaining.
   */
  error?: unknown;
}

/** Receives every frame in both directions. Must not throw; throwing is logged and ignored. */
export type WireObserver = (frame: WireFrame) => void;

/**
 * Build a frame from an already-parsed JSON-RPC message.
 *
 * Fields are copied only when the message actually carries them, so an
 * observer can distinguish "no result" from "result: undefined" — the kind of
 * difference a verbatim-passthrough assertion turns on.
 * @param direction - which way the message crossed the wire.
 * @param message - the parsed message; non-objects yield undefined.
 * @returns the frame, or undefined when the message is not a JSON-RPC object.
 */
export function toWireFrame(direction: WireFrame['direction'], message: unknown): WireFrame | undefined {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined;
  const raw = message as Record<string, unknown>;
  const frame: WireFrame = { direction };
  if (typeof raw['method'] === 'string') frame.method = raw['method'];
  const id = raw['id'];
  if (typeof id === 'string' || typeof id === 'number') frame.id = id;
  if ('params' in raw) frame.params = raw['params'];
  if ('result' in raw) frame.result = raw['result'];
  if ('error' in raw) frame.error = raw['error'];
  return frame;
}

/**
 * Deliver one frame to an observer, absorbing anything it throws.
 *
 * A trace is diagnostic scaffolding; letting a faulty observer error the
 * transform would sever a live connection and leave the child running as a
 * zombie the manager never notices.
 * @param observer - the installed observer, or undefined to do nothing.
 * @param direction - which way the message crossed the wire.
 * @param message - the parsed JSON-RPC message.
 */
export function emitWireFrame(
  observer: WireObserver | undefined,
  direction: WireFrame['direction'],
  message: unknown,
): void {
  if (observer === undefined) return;
  const frame = toWireFrame(direction, message);
  if (frame === undefined) return;
  try {
    observer(frame);
  } catch (error) {
    console.error(`[runskein] wire observer threw: ${String(error)}`);
  }
}
