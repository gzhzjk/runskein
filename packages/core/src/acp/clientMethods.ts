/**
 * Client-method handlers for the ACP connection: the permission→policy
 * bridge, the update dispatch hook, and the terminals runskein runs on an
 * agent's behalf. fs client methods stay out of scope — they are declined in
 * `initialize` clientCapabilities and never registered here.
 *
 * A live session answers permissions through its own PermissionPolicy. These
 * handlers are the connection-level fallback: without one, permission requests
 * are auto-allowed, which is what the headless capability probe relies on.
 */

/** Structural mirror of the fields the chooser needs. */
export interface PermissionOptionLike {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface PermissionRequestLike {
  sessionId?: string;
  options: PermissionOptionLike[];
  [key: string]: unknown;
}

export type PermissionOutcome = { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

export interface PermissionResponseLike {
  outcome: PermissionOutcome;
}

export type PermissionHandler = (
  params: PermissionRequestLike,
) => PermissionResponseLike | Promise<PermissionResponseLike>;

/**
 * Headless default chooser: allow_once > allow_always > first option > cancelled.
 * @param params - The permission request with the agent's offered options.
 * @returns A 'selected' outcome for the best-matching option, or 'cancelled' when none fits.
 */
export const autoAllowPermission: PermissionHandler = (params) => {
  const opts = params.options ?? [];
  const allow =
    opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => o.kind === 'allow_always') ?? opts[0];
  return {
    outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' },
  };
};

/** Structural view of a session/update notification (ACP vocabulary). */
export interface SessionUpdateNotification {
  sessionId: string;
  update: { sessionUpdate: string; [key: string]: unknown };
  [key: string]: unknown;
}

/** Structural view of an elicitation/create request (ACP UNSTABLE). */
export interface QuestionRequestLike {
  sessionId?: string;
  message?: string;
  requestedSchema?: {
    properties?: Record<string, { type?: string; enum?: string[]; oneOf?: unknown[] } | undefined>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type QuestionResponseLike =
  | { action: 'accept'; content?: Record<string, unknown> | null }
  | { action: 'decline' }
  | { action: 'cancel' };

export type QuestionHandler = (
  params: QuestionRequestLike,
) => QuestionResponseLike | Promise<QuestionResponseLike>;

/** Structural view of the terminal requests, keyed by the session they belong to. */
export interface TerminalRequestLike {
  sessionId?: string;
  terminalId?: string;
  command?: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string | null;
  outputByteLimit?: number | null;
  [key: string]: unknown;
}

/**
 * The five client methods an agent uses to run commands through its client.
 *
 * Absent handlers mean the capability is not advertised, which is a real
 * choice rather than a gap in the plumbing: an engine that delegates command
 * execution cannot run anything without them.
 */
export interface TerminalHandlers {
  create: (params: TerminalRequestLike) => Promise<{ terminalId: string }>;
  output: (
    params: TerminalRequestLike,
  ) => Promise<{ output: string; truncated: boolean; exitStatus?: unknown }>;
  waitForExit: (
    params: TerminalRequestLike,
  ) => Promise<{ exitCode?: number | null; signal?: string | null }>;
  kill: (params: TerminalRequestLike) => Promise<void>;
  release: (params: TerminalRequestLike) => Promise<void>;
}

export interface AcpClientHandlers {
  /** Called for every session/update notification, in arrival order. */
  onUpdate?: (notification: SessionUpdateNotification) => void;
  /** Answers session/request_permission. Default: autoAllowPermission. */
  onPermissionRequest?: PermissionHandler;
  /** Answers elicitation/create (questions/HITL); absent = not advertised. */
  onQuestion?: QuestionHandler;
  /** Runs commands for agents that delegate execution to their client. */
  onTerminal?: TerminalHandlers;
}
