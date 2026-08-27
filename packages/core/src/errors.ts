/**
 * Typed error classes.
 *
 * Every failure path in core surfaces as one of these; no error is ever
 * swallowed into a silent no-op. All carry `engineId` and, where relevant,
 * `sessionId`.
 */

/** Negotiated capability absent on this engine. */
export class NotSupportedError extends Error {
  readonly engineId: string;
  readonly capability: string;
  readonly sessionId?: string;

  /**
   * @param engineId - the engine lacking the capability.
   * @param capability - the absent Negotiated capability name.
   * @param sessionId - optional owning session.
   */
  constructor(engineId: string, capability: string, sessionId?: string) {
    super(`engine '${engineId}' does not support '${capability}'`);
    this.name = 'NotSupportedError';
    this.engineId = engineId;
    this.capability = capability;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

/** Engine binary not installed (detect() reported or spawn ENOENT). */
export class NotInstalledError extends Error {
  readonly engineId: string;

  /**
   * @param engineId - the engine id.
   * @param detail - optional additional context.
   */
  constructor(engineId: string, detail?: string) {
    super(`engine '${engineId}' is not installed${detail ? `: ${detail}` : ''}`);
    this.name = 'NotInstalledError';
    this.engineId = engineId;
  }
}

/** Engine installed but not authenticated; carries the login hint. */
export class UnauthenticatedError extends Error {
  readonly engineId: string;
  readonly loginHint?: string;
  override readonly cause?: unknown;

  /**
   * @param engineId - the engine id.
   * @param loginHint - command to authenticate, when known.
   * @param cause - raw engine failure or companion cleanup failure, when present.
   */
  constructor(engineId: string, loginHint?: string, cause?: unknown) {
    super(`engine '${engineId}' is not authenticated${loginHint ? ` — try: ${loginHint}` : ''}`);
    this.name = 'UnauthenticatedError';
    this.engineId = engineId;
    if (loginHint !== undefined) this.loginHint = loginHint;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Engine failed before reaching 'ready'. Distinct from
 * EngineCrashError, which describes a process that died after starting.
 */
export class EngineStartError extends Error {
  readonly engineId: string;
  readonly stage: 'spawn' | 'initialize' | 'timeout';
  override readonly cause?: unknown;

  /**
   * @param opts - engineId, the failing start stage, and the underlying cause.
   */
  constructor(opts: { engineId: string; stage: 'spawn' | 'initialize' | 'timeout'; cause?: unknown }) {
    const detail = opts.cause instanceof Error ? `: ${opts.cause.message}` : '';
    super(`engine '${opts.engineId}' failed to start (${opts.stage})${detail}`);
    this.name = 'EngineStartError';
    this.engineId = opts.engineId;
    this.stage = opts.stage;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Requested local session/transcript does not exist.
 * Store-only lookups carry engine/session ids only when known.
 */
export class NotFoundError extends Error {
  readonly resource: 'session' | 'transcript';
  readonly resourceId: string;
  readonly engineId?: string;
  readonly sessionId?: string;

  /**
   * @param opts - the missing resource kind, its id, and engine/session provenance when known.
   */
  constructor(opts: {
    resource: 'session' | 'transcript';
    resourceId: string;
    engineId?: string;
    sessionId?: string;
  }) {
    super(`${opts.resource} '${opts.resourceId}' not found`);
    this.name = 'NotFoundError';
    this.resource = opts.resource;
    this.resourceId = opts.resourceId;
    if (opts.engineId !== undefined) this.engineId = opts.engineId;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
  }
}

/** Transcript backend failure other than absence. */
export class StoreError extends Error {
  readonly operation: 'append' | 'read' | 'sessions' | 'digest' | 'delete' | 'export';
  override readonly cause?: unknown;
  readonly engineId?: string;
  readonly sessionId?: string;

  /**
   * @param opts - the failed store operation, cause, and engine/session provenance.
   */
  constructor(opts: {
    operation: StoreError['operation'];
    cause?: unknown;
    engineId?: string;
    sessionId?: string;
  }) {
    const detail = opts.cause instanceof Error ? `: ${opts.cause.message}` : '';
    super(`transcript store ${opts.operation} failed${detail}`);
    this.name = 'StoreError';
    this.operation = opts.operation;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.engineId !== undefined) this.engineId = opts.engineId;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
  }
}

/** Engine process died mid-turn; carries restart info + last persisted seq. */
export class EngineCrashError extends Error {
  readonly engineId: string;
  readonly sessionId?: string;
  /** Last transcript seq persisted before the crash, when one was recorded. */
  readonly lastSeq?: number;
  /** Whether an automatic restart is being attempted. */
  readonly restarting: boolean;

  /**
   * @param opts - engineId, sessionId, the last persisted seq, restarting flag, and detail.
   */
  constructor(opts: {
    engineId: string;
    sessionId?: string;
    lastSeq?: number;
    restarting: boolean;
    detail?: string;
  }) {
    super(`engine '${opts.engineId}' crashed${opts.detail ? `: ${opts.detail}` : ''}`);
    this.name = 'EngineCrashError';
    this.engineId = opts.engineId;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
    if (opts.lastSeq !== undefined) this.lastSeq = opts.lastSeq;
    this.restarting = opts.restarting;
  }
}

/** Prompt never completed: queued cancellation, or active/queued on close(). */
export class CancelledError extends Error {
  readonly engineId: string;
  readonly sessionId?: string;

  /**
   * @param engineId - the engine id.
   * @param sessionId - optional owning session.
   */
  constructor(engineId: string, sessionId?: string) {
    super('prompt cancelled before completion');
    this.name = 'CancelledError';
    this.engineId = engineId;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

/** Invalid config key/value; carries the valid options for the key. */
export class ConfigError extends Error {
  readonly engineId: string;
  readonly key?: string;
  readonly validValues?: readonly string[];

  /**
   * @param opts - engineId, the message, the config key, and the valid values.
   */
  constructor(opts: { engineId: string; message: string; key?: string; validValues?: readonly string[] }) {
    super(opts.message);
    this.name = 'ConfigError';
    this.engineId = opts.engineId;
    if (opts.key !== undefined) this.key = opts.key;
    if (opts.validValues !== undefined) this.validValues = opts.validValues;
  }
}

/** An ACP operation failed after the engine reached ready. */
/**
 * Why an engine operation failed, when runskein can tell.
 *
 * Absent means unclassified — the honest default. A host switching on this must
 * still handle the undefined case, because guessing a cause from engine-authored
 * text would produce a confidently wrong answer.
 */
export type EngineErrorKind = 'timeout' | 'rate-limit' | 'context-exceeded' | 'internal';

export class EngineOperationError extends Error {
  readonly engineId: string;
  readonly sessionId?: string;
  readonly operation: string;
  /** Recognised cause, when there is one; absent means unclassified. */
  readonly kind?: EngineErrorKind;
  override readonly cause?: unknown;

  /**
   * @param opts - engineId, sessionId, the failed operation, its kind, and the cause.
   */
  constructor(opts: {
    engineId: string;
    sessionId?: string;
    operation: string;
    kind?: EngineErrorKind;
    cause?: unknown;
  }) {
    const detail = opts.cause instanceof Error ? `: ${opts.cause.message}` : '';
    super(`engine '${opts.engineId}' operation '${opts.operation}' failed${detail}`);
    this.name = 'EngineOperationError';
    this.engineId = opts.engineId;
    this.operation = opts.operation;
    if (opts.sessionId !== undefined) this.sessionId = opts.sessionId;
    if (opts.kind !== undefined) this.kind = opts.kind;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/**
 * Normalize a failure from a custom TranscriptStore at a public API boundary,
 * so third-party store implementations cannot leak untyped errors to callers.
 * @param operation - the store operation that failed.
 * @param error - the raw failure.
 * @param provenance - engine/session ids to attach when the error lacks them.
 * @returns the original NotFoundError, or a StoreError wrapping the cause.
 */
export function storeBoundaryError(
  operation: StoreError['operation'],
  error: unknown,
  provenance: { engineId?: string; sessionId?: string } = {},
): NotFoundError | StoreError {
  if (error instanceof NotFoundError) return error;
  const prior = error instanceof StoreError ? error : undefined;
  const engineId = provenance.engineId ?? prior?.engineId;
  const sessionId = provenance.sessionId ?? prior?.sessionId;
  return new StoreError({
    operation,
    cause: prior?.cause ?? error,
    ...(engineId !== undefined ? { engineId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  });
}
