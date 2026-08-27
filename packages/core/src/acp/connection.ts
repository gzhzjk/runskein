/**
 * AcpConnection — one per engine process. Owns the JSON-RPC/stdio framing,
 * the single `initialize` handshake, request routing with timeouts, and the
 * client-method handlers (permission bridge + update dispatch).
 *
 * This module (src/acp/) is the ONLY place in core that may import
 * `@agentclientprotocol/sdk`. Everything it exposes to the rest of core
 * is runskein-owned structural typing.
 */
import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import {
  autoAllowPermission,
  type AcpClientHandlers,
  type PermissionRequestLike,
  type QuestionRequestLike,
  type TerminalRequestLike,
} from './clientMethods.js';
import { normalizeCapabilities, type RawAgentCapabilities } from './capabilities.js';
import { AcpInbound, AcpOutbound } from './inbound.js';

/**
 * This package's version, reported to every engine in the `initialize`
 * handshake.
 *
 * Read from the manifest rather than written out here, because a literal is
 * wrong the moment it is written: this line said `0.0.0` from the day it was
 * added until alpha.24, and every engine was told so on every connection. The
 * relative path holds for both the source tree and the compiled output — `dist`
 * mirrors `src`, so this module sits two levels below the package root either
 * way — and npm ships `package.json` in every tarball regardless of `files`.
 */
const CLIENT_VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string })
  .version;
import type { WireObserver } from './wireTrace.js';
import type { CapabilityMatrix } from '../types.js';

// ── Structural result shapes (runskein-owned; ACP fields pass through) ────────

export interface AcpInitializeResult {
  protocolVersion?: string | number;
  agentInfo?: unknown;
  authMethods?: unknown;
  agentCapabilities?: RawAgentCapabilities & Record<string, unknown>;
  [key: string]: unknown;
}

export interface AcpModeState {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string | null }[];
}

export interface AcpModelState {
  currentModelId?: string;
  availableModels: { modelId: string; name: string; description?: string | null }[];
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: AcpModeState | null;
  models?: AcpModelState | null;
  configOptions?: unknown[];
  [key: string]: unknown;
}

export interface AcpPromptResult {
  stopReason: string;
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** RunSkein-owned timeout marker for a request that exceeded its ceiling. */
export class RequestTimeoutError extends Error {
  readonly operation: string;

  /**
   * @param ms - elapsed request ceiling.
   * @param operation - ACP method that did not settle in time.
   */
  constructor(ms: number, operation: string) {
    super(`timeout after ${String(ms)}ms: ${operation}`);
    this.name = 'RequestTimeoutError';
    this.operation = operation;
  }
}

/**
 * Race a promise against a timeout; the unref'd timer never keeps the
 * process alive while waiting.
 * @param p - The promise to wait on.
 * @param ms - Timeout in milliseconds; expiry rejects the returned promise.
 * @param label - Operation name embedded in the timeout error message.
 * @returns A promise that resolves with p's value or rejects on timeout/p's error.
 * @throws Rejects with RequestTimeoutError when ms elapses first, or re-rejects with p's own error.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new RequestTimeoutError(ms, label)), ms);
    t.unref?.();
    p.then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

// ── Connection ─────────────────────────────────────────────────────────────

export interface AcpConnectionOptions {
  stdin: Writable;
  stdout: Readable;
  clientName?: string;
  handlers?: AcpClientHandlers;
  /**
   * Internal diagnostic seam: receives every JSON-RPC frame in both
   * directions. Never part of the public surface; absent means no tracing and
   * no behaviour change.
   */
  onWireFrame?: WireObserver;
}

export class AcpConnection {
  private readonly conn: acp.ClientConnection;
  private readonly terminalEnabled: boolean;
  private initResult: AcpInitializeResult | undefined;
  private initPromise: Promise<AcpInitializeResult> | undefined;
  private closedFlag = false;

  /**
   * Wire the child's stdio into an ACP client connection and register the
   * client-method handlers (permission and question), defaulting to auto-allow.
   * @param options - stdio streams plus optional client name and handlers.
   */
  constructor(options: AcpConnectionOptions) {
    const handlers = options.handlers ?? {};
    const permission = handlers.onPermissionRequest ?? autoAllowPermission;
    this.terminalEnabled = handlers.onTerminal !== undefined;
    const inbound = new AcpInbound(handlers.onUpdate, options.onWireFrame);
    const outbound = new AcpOutbound(inbound, options.onWireFrame);
    options.stdout.pipe(inbound);
    outbound.pipe(options.stdin);
    options.stdout.once('error', (error) => inbound.destroy(error));
    options.stdin.once('error', (error) => outbound.destroy(error));
    const stream = acp.ndJsonStream(
      Writable.toWeb(outbound) as WritableStream<Uint8Array>,
      Readable.toWeb(inbound) as ReadableStream<Uint8Array>,
    );
    const app = acp
      .client({ name: options.clientName ?? 'runskein' })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        inbound.acknowledge(ctx.requestId);
        const res = await permission(ctx.params as unknown as PermissionRequestLike);
        return res as never;
      });
    if (handlers.onTerminal) {
      const terminal = handlers.onTerminal;
      // Registered through the raw path: the SDK's typed table would pull its
      // schema types into core, and these params are runskein-owned mirrors.
      const route = <T>(method: string, run: (params: TerminalRequestLike) => Promise<T>): void => {
        app.onRequest(
          method,
          (v: unknown) => v as TerminalRequestLike,
          async (ctx) => {
            inbound.acknowledge(ctx.requestId);
            try {
              return (await run(ctx.params as TerminalRequestLike)) as never;
            } catch (error) {
              // The reason has to reach the agent: "refused by policy" and
              // "cwd outside the session" are things it can report to a user
              // or work around, and a generic internal error is neither.
              throw acp.RequestError.invalidParams(undefined, String((error as Error)?.message ?? error));
            }
          },
        );
      };
      route('terminal/create', (params) => terminal.create(params));
      route('terminal/output', (params) => terminal.output(params));
      route('terminal/wait_for_exit', (params) => terminal.waitForExit(params));
      route('terminal/kill', async (params) => {
        await terminal.kill(params);
        return {};
      });
      route('terminal/release', async (params) => {
        await terminal.release(params);
        return {};
      });
    }
    if (handlers.onQuestion) {
      const onQuestion = handlers.onQuestion;
      // elicitation/create is UNSTABLE in ACP; parse params ourselves.
      app.onRequest(
        'elicitation/create',
        (v: unknown) => v as QuestionRequestLike,
        async (ctx) => {
          inbound.acknowledge(ctx.requestId);
          return (await onQuestion(ctx.params as QuestionRequestLike)) as never;
        },
      );
    }
    this.conn = app.connect(stream);
    void this.conn.closed.then(() => {
      this.closedFlag = true;
    });
  }

  /**
   * True once the connection has closed (process exit or close()).
   * @returns Whether the connection has closed.
   */
  get isClosed(): boolean {
    return this.closedFlag;
  }

  /**
   * Resolves when the connection closes (stream end / close()).
   * @returns A promise that settles once the underlying connection is closed.
   */
  get closed(): Promise<void> {
    return this.conn.closed;
  }

  /**
   * Close the connection, marking it closed and notifying the peer.
   * @param error - Optional error to surface to the peer on close.
   */
  close(error?: unknown): void {
    this.closedFlag = true;
    this.conn.close(error);
  }

  /**
   * The cached initialize result; undefined before initialize().
   * @returns The raw initialize response, or undefined until initialize() completes.
   */
  get initializeResult(): AcpInitializeResult | undefined {
    return this.initResult;
  }

  /**
   * Normalized capability matrix; throws if called before initialize().
   * @returns The capability matrix normalized from the initialize response.
   * @throws `Error` when initialize() has not completed yet.
   */
  get capabilities(): CapabilityMatrix {
    if (!this.initResult) throw new Error('AcpConnection: initialize() has not completed');
    return normalizeCapabilities(this.initResult.agentCapabilities);
  }

  /**
   * Perform the initialize handshake exactly once; later calls share the
   * in-flight or already-completed result. Filesystem client capabilities are
   * declined, so engines never ask this process to read or write files.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The raw initialize response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  initialize(opts?: { timeoutMs?: number }): Promise<AcpInitializeResult> {
    this.initPromise ??= (async () => {
      const result = await withTimeout(
        this.conn.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          // Declared from what is actually wired up: an engine that delegates
          // command execution asks this question before its first tool call,
          // and answering yes without the handlers would fail every command.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: this.terminalEnabled,
          },
          clientInfo: { name: 'runskein', version: CLIENT_VERSION },
        }),
        opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        'initialize',
      );
      this.initResult = result as unknown as AcpInitializeResult;
      return this.initResult;
    })();
    return this.initPromise;
  }

  /**
   * Open a new ACP session at the given working directory.
   * @param params - cwd plus optional mcpServers and request _meta.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The new session result (sessionId plus optional modes/config options).
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  newSession(
    params: { cwd: string; mcpServers?: unknown[]; _meta?: Record<string, unknown> },
    opts?: { timeoutMs?: number },
  ): Promise<AcpNewSessionResult> {
    return withTimeout(
      this.rawRequest('session/new', {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        ...(params._meta !== undefined ? { _meta: params._meta } : {}),
      }),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'session/new',
    ) as Promise<AcpNewSessionResult>;
  }

  /**
   * Send a prompt to an existing session.
   * @param params - sessionId and the prompt message array.
   * @param opts - Optional timeoutMs; when set, the request is raced against it.
   * @returns The prompt result (stopReason plus engine-specific fields).
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  prompt(
    params: { sessionId: string; prompt: unknown[] },
    opts?: { timeoutMs?: number },
  ): Promise<AcpPromptResult> {
    const req = this.rawRequest('session/prompt', params) as Promise<AcpPromptResult>;
    return opts?.timeoutMs ? withTimeout(req, opts.timeoutMs, 'session/prompt') : req;
  }

  /**
   * Close a session on the engine.
   * @param sessionId - Id of the session to close.
   * @param opts - Optional timeoutMs (default 10s).
   * @returns The engine's raw session/close response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  closeSession(sessionId: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    return withTimeout(
      this.rawRequest('session/close', { sessionId }),
      opts?.timeoutMs ?? 10_000,
      'session/close',
    );
  }

  /**
   * Delete a session and its engine-owned history where the agent advertises
   * the unstable `session/delete` capability.
   * @param sessionId - Id of the session to delete.
   * @param opts - Optional timeoutMs (default 10s).
   * @returns The engine's raw session/delete response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  deleteSession(sessionId: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    return withTimeout(
      this.rawRequest('session/delete', { sessionId }),
      opts?.timeoutMs ?? 10_000,
      'session/delete',
    );
  }

  /**
   * Send a session/cancel notification; per ACP this is fire-and-forget.
   * @param sessionId - Id of the session to cancel.
   * @returns Resolves once the notification is delivered.
   * @throws Rejects with the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  cancelSession(sessionId: string): Promise<void> {
    const notify = this.conn.agent.notify.bind(this.conn.agent) as (
      method: string,
      params: unknown,
    ) => Promise<void>;
    return notify('session/cancel', { sessionId });
  }

  /**
   * List providers via providers/list (UNSTABLE in ACP); only call where
   * capabilities.providers is present.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The raw providers/list response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  listProviders(opts?: { timeoutMs?: number }): Promise<Record<string, unknown>> {
    return withTimeout(
      this.rawRequest('providers/list', {}),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'providers/list',
    ) as Promise<Record<string, unknown>>;
  }

  /**
   * Resume a session via session/resume — native continuation, the cheapest
   * resume path and only available where the engine advertises it.
   * @param params - sessionId, cwd, and optional mcpServers to resume.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The raw session/resume response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  resumeSession(
    params: { sessionId: string; cwd: string; mcpServers?: unknown[] },
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    return withTimeout(
      this.rawRequest('session/resume', {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      }),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'session/resume',
    ) as Promise<Record<string, unknown>>;
  }

  /**
   * Replay a session's history via session/load — the fallback when the engine
   * cannot resume natively but can still rehydrate from its own history.
   * @param params - sessionId, cwd, and optional mcpServers to load.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The raw session/load response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  loadSession(
    params: { sessionId: string; cwd: string; mcpServers?: unknown[] },
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    return withTimeout(
      this.rawRequest('session/load', {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      }),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'session/load',
    ) as Promise<Record<string, unknown>>;
  }

  /**
   * Fork a new session from an existing one via session/fork.
   * @param params - Source sessionId, cwd, and optional mcpServers.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The new forked session result.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  forkSession(
    params: { sessionId: string; cwd: string; mcpServers?: unknown[] },
    opts?: { timeoutMs?: number },
  ): Promise<AcpNewSessionResult> {
    return withTimeout(
      this.rawRequest('session/fork', {
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
      }),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'session/fork',
    ) as Promise<AcpNewSessionResult>;
  }

  /**
   * Switch an existing session to a different model.
   *
   * `session/set_model` is not in the pinned SDK's method table — it is still
   * unstable in the protocol — so it goes out through the raw request path.
   * Call it only where session/new advertised a `models` list.
   * @param sessionId - Id of the session to reconfigure.
   * @param modelId - Id of the target model, as advertised in `models`.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The engine's raw session/set_model response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  setModel(sessionId: string, modelId: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    return withTimeout(
      this.rawRequest('session/set_model', { sessionId, modelId }),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'session/set_model',
    );
  }

  /**
   * Switch an existing session to a different mode.
   * @param sessionId - Id of the session to reconfigure.
   * @param modeId - Id of the target mode.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The engine's raw session/set_mode response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  setMode(sessionId: string, modeId: string, opts?: { timeoutMs?: number }): Promise<unknown> {
    return withTimeout(
      this.rawRequest('session/set_mode', { sessionId, modeId }),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'session/set_mode',
    );
  }

  /**
   * Set a config option on a session; ACP keys the param as `configId`.
   * @param sessionId - Id of the session to reconfigure.
   * @param configId - Id of the config option (ACP param is configId, not configOptionId).
   * @param value - New value for the option.
   * @param opts - Optional timeoutMs overrides the 30s default request timeout.
   * @returns The engine's raw session/set_config_option response.
   * @throws Rejects with `Error` on timeout, the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
    opts?: { timeoutMs?: number },
  ): Promise<unknown> {
    // ACP session/set_config_option params use `configId` (schema, not
    // configOptionId); sending the wrong key makes real engines reject
    // with Invalid params.
    return withTimeout(
      this.rawRequest('session/set_config_option', { sessionId, configId, value }),
      opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      'session/set_config_option',
    );
  }

  /**
   * Generic passthrough for negotiated/probed methods.
   * @param method - The ACP JSON-RPC method name.
   * @param params - The request params object.
   * @returns The raw method response.
   * @throws Rejects with the SDK's `RequestError` on an RPC error, or `Error` when the connection closes.
   */
  rawRequest(method: string, params: unknown): Promise<unknown> {
    const request = this.conn.agent.request.bind(this.conn.agent) as (
      method: string,
      params: unknown,
    ) => Promise<unknown>;
    return request(method, params);
  }
}
