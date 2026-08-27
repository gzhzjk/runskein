#!/usr/bin/env node
/**
 * The pi ACP shim.
 *
 * pi ships no ACP server: it speaks its own newline-delimited JSON-RPC-ish
 * protocol on stdio (`pi --mode rpc`). This process is the translator — ACP
 * agent towards runskein on its own stdio, pi RPC client towards one
 * `pi --mode rpc` child per session, because a pi process holds exactly one
 * session and switching it would make two runskein sessions corrupt each other.
 *
 * Usage: `node shim.mjs <pi-command> [pi args…]`; runskein's spawn layer supplies
 * the command line from the adapter's launch block.
 *
 * Permissions deserve a note. pi has no approval protocol — its built-in tools
 * simply run. The only interception point is an extension's `tool_call` hook,
 * so this shim loads `permission-gate.ts` into every child and recognises the
 * dialogs it raises by a nonce generated here and passed through the child's
 * environment. A dialog without that nonce belongs to one of the user's own
 * extensions: it is dismissed, never auto-approved, because approving an
 * unknown dialog is indistinguishable from approving a tool nobody asked
 * about.
 */
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';

const GATE_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), 'permission-gate.ts');

/** Bumped whenever this translation changes in a way a probe should notice. */
const SHIM_VERSION = 1;

/** Cap on how long a child may take to answer a command it always answers. */
const PI_COMMAND_TIMEOUT_MS = 30_000;
/** Shorter cap for the post-turn accounting read, which must not stall a turn. */
const USAGE_TIMEOUT_MS = 10_000;
/** How long a permission request may wait for runskein before failing closed. */
const PERMISSION_TIMEOUT_MS = 120_000;
/** Grace between asking a child to exit and killing it. */
const CHILD_EXIT_GRACE_MS = 3_000;

// ── pi RPC transport ───────────────────────────────────────────────────────

/**
 * Read strict LF-delimited JSON lines off a stream.
 *
 * Deliberately not `node:readline`: it also breaks on U+2028/U+2029, which are
 * legal inside JSON strings, so a model reply containing one would be split
 * into two unparseable halves.
 * @param stream - the readable byte stream to consume.
 * @param onLine - called with each complete line, without its terminator.
 */
function readJsonLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index === -1) break;
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on('end', () => {
    const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
    buffer = '';
    if (tail.length > 0) onLine(tail);
  });
}

/**
 * One `pi --mode rpc` child process and the command/event traffic to it.
 *
 * Commands are correlated by an id this class allocates; events and extension
 * dialogs are handed to the callbacks the owner installs.
 */
class PiChild {
  /**
   * Spawn a pi child.
   * @param options - command/args to run, cwd, extra CLI args, and env additions.
   */
  constructor(options) {
    this.nextId = 1;
    this.pending = new Map();
    // pi talks before anyone is listening: extension notifications, and
    // anything malformed a stray extension prints, arrive before the session
    // that owns this child exists. Buffering until a handler is installed is
    // what keeps those first frames from being silently dropped.
    this.buffered = [];
    this.eventHandler = undefined;
    this.bufferedDialogs = [];
    this.dialogHandler = undefined;
    this.stderrTail = '';
    this.exitInfo = undefined;
    this.gateNonce = randomUUID();

    const args = [...(options.args ?? []), ...(options.extraArgs ?? [])];
    this.child = spawn(options.command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, RUNSKEIN_PI_GATE_NONCE: this.gateNonce },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.exitInfo = { code, signal };
        // Nothing else will ever answer these; leaving them pending would
        // hang a turn on a process that is already gone.
        for (const { reject } of this.pending.values()) reject(this.exitError());
        this.pending.clear();
        resolve(this.exitInfo);
      });
      this.child.on('error', (error) => {
        this.exitInfo = { code: null, signal: null, error };
        for (const { reject } of this.pending.values()) reject(error);
        this.pending.clear();
        resolve(this.exitInfo);
      });
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    readJsonLines(this.child.stdout, (line) => this.receive(line));
  }

  /**
   * Install the event handler, replaying whatever arrived before it existed.
   * @param handler - receives every non-response, non-dialog frame.
   */
  set onEvent(handler) {
    this.eventHandler = handler;
    const pending = this.buffered.splice(0);
    for (const event of pending) handler(event);
  }

  /**
   * Install the dialog handler, replaying anything raised before it existed.
   *
   * A dialog blocks the tool that raised it until it is answered, so dropping
   * one that arrived a moment too early would wedge that tool for good.
   * @param handler - receives every extension_ui_request frame.
   */
  set onDialog(handler) {
    this.dialogHandler = handler;
    const pending = this.bufferedDialogs.splice(0);
    for (const dialog of pending) handler(dialog);
  }

  /**
   * Deliver one event, or hold it until a handler is installed.
   * @param event - the pi event frame.
   */
  emitEvent(event) {
    if (this.eventHandler) this.eventHandler(event);
    else this.buffered.push(event);
  }

  /** @returns whether the child has exited. */
  get isDead() {
    return this.exitInfo !== undefined;
  }

  /**
   * Describe the child's death for an error message.
   * @returns an Error naming the exit status and the tail of its stderr.
   */
  exitError() {
    const how =
      this.exitInfo?.signal != null ? `signal ${this.exitInfo.signal}` : `code ${this.exitInfo?.code}`;
    const tail = this.stderrTail.trim();
    return new Error(`pi exited (${how})${tail ? `: ${tail}` : ''}`);
  }

  /**
   * Route one line from the child: a command response, an extension dialog, or
   * an agent event.
   * @param line - the raw JSON line.
   */
  receive(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // A malformed line is the engine's problem, not a reason to tear the
      // session down: report it and keep reading the stream.
      this.emitEvent({ type: 'runskein_protocol_error', line: line.slice(0, 500) });
      return;
    }
    if (frame?.type === 'response') {
      const entry = this.pending.get(frame.id);
      if (!entry) return; // late answer to a request nobody is waiting for
      this.pending.delete(frame.id);
      entry.resolve(frame);
      return;
    }
    if (frame?.type === 'extension_ui_request') {
      if (this.dialogHandler) this.dialogHandler(frame);
      else this.bufferedDialogs.push(frame);
      return;
    }
    this.emitEvent(frame);
  }

  /**
   * Send a command and wait for its response frame.
   * @param command - the command object, without an id.
   * @param timeoutMs - how long to wait before giving up.
   * @returns the response frame.
   * @throws `Error` when the child dies first or the response never arrives.
   */
  send(command, timeoutMs = PI_COMMAND_TIMEOUT_MS) {
    if (this.isDead) return Promise.reject(this.exitError());
    const id = `runskein-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi did not answer '${command.type}' within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  /**
   * Send a command and return its `data`, failing on an unsuccessful response.
   * @param command - the command object, without an id.
   * @param timeoutMs - how long to wait before giving up.
   * @returns the response's data payload.
   * @throws `Error` when pi reports the command failed.
   */
  async call(command, timeoutMs) {
    const frame = await this.send(command, timeoutMs);
    if (frame.success !== true) {
      throw new Error(`pi rejected '${command.type}': ${frame.error ?? 'unknown error'}`);
    }
    return frame.data;
  }

  /** Send a one-way frame (used for extension dialog answers). */
  write(frame) {
    if (!this.isDead) this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  /**
   * Stop the child: stdin EOF first (pi exits cleanly on it), then signals.
   * @returns resolves once the process is gone.
   */
  async stop() {
    if (this.isDead) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGTERM'), CHILD_EXIT_GRACE_MS);
    const hard = setTimeout(() => this.child.kill('SIGKILL'), CHILD_EXIT_GRACE_MS * 2);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
      clearTimeout(hard);
    }
  }
}

// ── vocabulary translation ─────────────────────────────────────────────────

/** pi tool names mapped onto ACP tool-call kinds. */
const TOOL_KINDS = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  multiedit: 'edit',
  bash: 'execute',
  glob: 'search',
  grep: 'search',
};

/**
 * Classify a pi tool for ACP.
 *
 * Unknown tools — every extension-registered one — are `other` on purpose: a
 * guessed kind puts a wrong label on a real action.
 * @param toolName - the pi tool name.
 * @returns the ACP tool-call kind.
 */
function toolKind(toolName) {
  return TOOL_KINDS[String(toolName).toLowerCase()] ?? 'other';
}

/**
 * Pull file locations out of a tool call's arguments, so path-based permission
 * rules have something to match.
 * @param args - the tool arguments, as pi reported them.
 * @returns an ACP locations array, empty when no path-like argument is present.
 */
function toolLocations(args) {
  if (typeof args !== 'object' || args === null) return [];
  for (const key of ['path', 'file_path', 'filePath', 'file']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return [{ path: value }];
  }
  return [];
}

/**
 * Convert a pi tool result's content blocks into ACP tool-call content.
 * @param result - the pi tool result, possibly partial.
 * @returns an array of ACP ToolCallContent entries.
 */
function toolContent(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => ({ type: 'content', content: { type: 'text', text: block.text } }));
}

/** pi assistant stop reasons mapped onto ACP ones; `toolUse` is not terminal. */
const STOP_REASONS = {
  stop: 'end_turn',
  length: 'max_tokens',
  aborted: 'cancelled',
};

/**
 * Build one ACP usage update out of pi's own session statistics.
 *
 * The protocol's usage update is a context-window gauge — `used` of `size`,
 * plus a cost — and runskein's token accounting rides the nested `usage` object.
 * Emitting token counts alone produced a frame consumers reject as malformed,
 * which is how this was found.
 *
 * pi prices in USD; a model with no pricing yields no cost at all, and is
 * reported that way rather than as a zero, which would read as a free turn.
 * @param stats - pi's `get_session_stats` payload.
 * @param contextWindow - the selected model's window, used when pi omits its own.
 * @returns a usage_update payload, or undefined when nothing usable was reported.
 */
function usageUpdate(stats, contextWindow) {
  const tokens = stats?.tokens;
  if (typeof tokens !== 'object' || tokens === null) return undefined;
  const size = stats?.contextUsage?.contextWindow ?? contextWindow;
  // pi reports no context reading until a post-compaction turn provides one;
  // total tokens is the honest stand-in for "how full the window is".
  const used = stats?.contextUsage?.tokens ?? tokens.total;
  if (typeof used !== 'number' || typeof size !== 'number') return undefined;
  const update = { sessionUpdate: 'usage_update', used, size };
  if (typeof stats.cost === 'number' && stats.cost > 0) {
    update.cost = { amount: stats.cost, currency: 'USD' };
  }
  const counts = {};
  if (typeof tokens.input === 'number') counts.input = tokens.input;
  if (typeof tokens.output === 'number') counts.output = tokens.output;
  if (typeof tokens.total === 'number') counts.totalTokens = tokens.total;
  if (Object.keys(counts).length > 0) update.usage = counts;
  return update;
}

// ── capability probe ───────────────────────────────────────────────────────

/**
 * Ask a short-lived pi process what this installation can actually do.
 *
 * The declared ACP capabilities and the config options offered to runskein both
 * come from here rather than from constants, so `prompt.image` tracks the
 * selected model and the model list is the user's own.
 * @param launch - the pi command and args to probe with.
 * @returns state, models and thinking levels, as pi reported them.
 * @throws `Error` when pi cannot be started or does not answer.
 */
async function probeInstallation(launch) {
  const version = await engineVersion(launch.command);
  const child = new PiChild({ ...launch, cwd: process.cwd(), extraArgs: ['--no-session'] });
  try {
    const state = await child.call({ type: 'get_state' });
    const models = await child.call({ type: 'get_available_models' });
    const levels = await child.call({ type: 'get_available_thinking_levels' });
    return {
      version,
      model: state?.model ?? null,
      models: Array.isArray(models?.models) ? models.models : [],
      thinkingLevels: Array.isArray(levels?.levels) ? levels.levels : [],
    };
  } finally {
    await child.stop();
  }
}

/**
 * Ask the engine binary for its version.
 *
 * The declared agentInfo names both this and the shim: drift between them is
 * the first thing to check when a translation starts misbehaving, and it is
 * unattributable if only one of the two is reported.
 * @param command - the pi command.
 * @returns the reported version, or 'unknown' when it cannot be read.
 */
function engineVersion(command) {
  return new Promise((resolve) => {
    execFile(command, ['--version'], { timeout: 20_000 }, (error, stdout) => {
      resolve(error ? 'unknown' : String(stdout).trim());
    });
  });
}

/**
 * Build the configOptions runskein publishes for a session.
 * @param probe - the installation probe result.
 * @returns an ACP configOptions array; empty when pi reported nothing usable.
 */
function configOptions(probe) {
  const options = [];
  if (probe.models.length > 0) {
    options.push({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: probe.model ? modelValue(probe.model) : undefined,
      options: probe.models.map((model) => ({
        value: modelValue(model),
        name: `${model.provider ?? 'unknown'}/${model.name ?? model.id}`,
      })),
    });
  }
  // A model without reasoning support reports exactly ["off"], which is not a
  // choice; publishing it would offer a setting that cannot change anything.
  if (probe.thinkingLevels.length > 1) {
    options.push({
      id: 'reasoning',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      options: probe.thinkingLevels.map((level) => ({ value: level, name: level })),
    });
  }
  return options;
}

/**
 * The `provider/id` string runskein uses to name one pi model.
 * @param model - a pi model object.
 * @returns the composite model value.
 */
function modelValue(model) {
  return model.provider ? `${model.provider}/${model.id}` : String(model.id);
}

// ── session ────────────────────────────────────────────────────────────────

/**
 * One runskein session: a pi child, the turn currently running on it, and the
 * translation of pi's event stream into ACP session notifications.
 */
class PiSession {
  /**
   * @param options - the child, its session id, cwd, and the ACP notifier.
   */
  constructor(options) {
    this.child = options.child;
    this.sessionId = options.sessionId;
    this.instructions = options.instructions;
    this.notify = options.notify;
    this.requestPermission = options.requestPermission;
    this.turn = undefined;
    this.contextWindow = options.contextWindow;
    this.child.onEvent = (event) => this.handleEvent(event);
    this.child.onDialog = (dialog) => void this.handleDialog(dialog);
    void this.child.exited.then(() => this.failActiveTurn());
  }

  /**
   * Emit one ACP session update.
   * @param update - the update payload, ACP vocabulary.
   */
  emit(update) {
    void this.notify({ sessionId: this.sessionId, update });
  }

  /**
   * Run one turn and wait for pi to settle.
   * @param blocks - the ACP prompt content blocks.
   * @returns the ACP stop reason for the turn.
   * @throws `RequestError` when a turn is already running, pi rejects the prompt, or pi dies mid-turn.
   */
  async prompt(blocks) {
    // runskein serialises turns per session, so a second one arriving here means
    // the client is confused. Overwriting the running turn would strand its
    // caller on a promise nothing can settle any more.
    if (this.turn) {
      throw acp.RequestError.invalidRequest(undefined, 'a turn is already running on this session');
    }
    const text = promptText(blocks);
    const images = blocks
      .filter((block) => block?.type === 'image' && typeof block.data === 'string')
      .map((block) => ({ type: 'image', data: block.data, mimeType: block.mimeType }));

    let settle;
    const settled = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    this.turn = { settle, stopReason: undefined, cancelled: false };
    try {
      await this.child.call({
        type: 'prompt',
        message: text,
        ...(images.length > 0 ? { images } : {}),
      });
    } catch (error) {
      this.turn = undefined;
      throw acp.RequestError.internalError(undefined, String(error?.message ?? error));
    }
    return await settled;
  }

  /**
   * Ask pi to abort whatever it is doing. The turn still settles; runskein's
   * contract is that a cancelled turn resolves rather than rejects.
   */
  async cancel() {
    if (this.turn) this.turn.cancelled = true;
    // Both are needed: `abort` stops the model loop, `abort_bash` stops a
    // shell command that would otherwise keep running past it.
    await Promise.allSettled([this.child.send({ type: 'abort' }), this.child.send({ type: 'abort_bash' })]);
  }

  /** Reject the running turn when the child dies underneath it. */
  failActiveTurn() {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    turn.settle.reject(acp.RequestError.internalError(undefined, this.child.exitError().message));
  }

  /**
   * Translate one pi event into ACP notifications, and end the turn when pi
   * reports it has fully settled.
   * @param event - the pi event frame.
   */
  handleEvent(event) {
    switch (event?.type) {
      case 'message_update':
        this.handleMessageUpdate(event);
        break;
      case 'message_end':
        this.handleMessageEnd(event);
        break;
      case 'tool_execution_start':
        this.emit({
          sessionUpdate: 'tool_call',
          toolCallId: event.toolCallId,
          title: String(event.toolName ?? 'tool'),
          kind: toolKind(event.toolName),
          status: 'pending',
          rawInput: event.args ?? {},
          locations: toolLocations(event.args),
        });
        break;
      case 'tool_execution_update':
        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: 'in_progress',
          // pi resends the whole output so far, so this replaces rather than
          // appends — treating it as a delta would duplicate every chunk.
          content: toolContent(event.partialResult),
        });
        break;
      case 'tool_execution_end':
        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: event.isError === true ? 'failed' : 'completed',
          content: toolContent(event.result),
        });
        break;
      case 'agent_settled':
        void this.settleTurn();
        break;
      case 'compaction_start':
      case 'compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'extension_error':
      case 'runskein_protocol_error':
        // runskein has no vocabulary for these, and inventing one would mean a
        // second event language. They stay visible as engine-private detail.
        this.emit({ sessionUpdate: 'session_info_update', _meta: { pi: event } });
        break;
      default:
        break;
    }
  }

  /**
   * Stream assistant text, thinking, and usage as they arrive.
   * @param event - a pi message_update frame.
   */
  handleMessageUpdate(event) {
    const delta = event.assistantMessageEvent;
    if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
      this.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta.delta } });
    } else if (delta?.type === 'thinking_delta' && typeof delta.delta === 'string') {
      this.emit({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta.delta } });
    }
  }

  /**
   * Record the assistant's stop reason; the turn itself ends at agent_settled,
   * because pi may still retry or compact after a message completes.
   * @param event - a pi message_end frame.
   */
  handleMessageEnd(event) {
    const message = event.message;
    if (message?.role !== 'assistant') return;
    if (this.turn && typeof message.stopReason === 'string') this.turn.stopReason = message.stopReason;
    // Keep whatever pi said about the failure. "The turn ended with an error"
    // is not something a caller can act on, and pi is the only party that
    // knows why — a refused model, a provider rejection, output it could not
    // parse. Measured: turns fail this way on models pi advertises but cannot
    // reach, and the reason was being dropped here.
    if (this.turn && message.stopReason === 'error') {
      this.turn.errorDetail = firstString([
        message.error,
        message.errorMessage,
        message.stopReasonDetail,
        message.detail,
      ]);
    }
  }

  /**
   * Report the turn's accounting from pi's own session statistics.
   *
   * One reading per settled turn, not one per delta: pi's per-message usage
   * carries no context-window reading, and a usage update without one is not a
   * usage update the protocol recognises.
   */
  async reportUsage() {
    try {
      const stats = await this.child.call({ type: 'get_session_stats' }, USAGE_TIMEOUT_MS);
      const update = usageUpdate(stats, this.contextWindow);
      if (update) this.emit(update);
    } catch {
      // Accounting is not worth failing a completed turn over; the turn's
      // result is the answer the caller asked for.
    }
  }

  /**
   * Resolve the running turn with the stop reason pi ended on.
   *
   * Usage is emitted first, because runskein snapshots a turn's accounting from
   * the notifications that arrived before the prompt response.
   */
  async settleTurn() {
    const turn = this.turn;
    if (!turn) return;
    this.turn = undefined;
    if (!turn.cancelled) await this.reportUsage();
    if (turn.cancelled) {
      turn.settle.resolve('cancelled');
      return;
    }
    if (turn.stopReason === 'error') {
      turn.settle.reject(
        acp.RequestError.internalError(
          undefined,
          turn.errorDetail === undefined
            ? 'pi ended the turn with an error, and reported no reason'
            : `pi ended the turn with an error: ${turn.errorDetail}`,
        ),
      );
      return;
    }
    turn.settle.resolve(STOP_REASONS[turn.stopReason] ?? 'end_turn');
  }

  /**
   * Answer an extension dialog raised inside the child.
   *
   * Only dialogs carrying this child's nonce are permission requests; any
   * other extension's dialog is dismissed, because this process cannot know
   * what agreeing to it would authorise.
   * @param dialog - the extension_ui_request frame.
   */
  async handleDialog(dialog) {
    const request = parseGateRequest(dialog, this.child.gateNonce);
    if (request === undefined) {
      if (isDialogMethod(dialog.method)) {
        this.child.write({ type: 'extension_ui_response', id: dialog.id, cancelled: true });
      }
      return;
    }
    let choice = 'reject_once';
    try {
      const response = await withTimeout(
        this.requestPermission({
          sessionId: this.sessionId,
          toolCall: {
            toolCallId: request.toolCallId,
            title: request.toolName,
            kind: toolKind(request.toolName),
            rawInput: request.args,
            locations: toolLocations(request.args),
          },
          options: PERMISSION_OPTIONS,
        }),
        PERMISSION_TIMEOUT_MS,
      );
      const outcome = response?.outcome;
      if (outcome?.outcome === 'selected' && typeof outcome.optionId === 'string') {
        choice = outcome.optionId;
      }
    } catch {
      // An unanswered or failed request must not become an approval: the tool
      // is waiting, and the only safe default is to refuse it.
      choice = 'reject_once';
    }
    this.child.write({ type: 'extension_ui_response', id: dialog.id, value: choice });
  }

  /** Stop the child process backing this session. */
  async close() {
    await this.child.stop();
  }
}

/**
 * Flatten a prompt's content blocks into the single message pi accepts.
 *
 * pi's RPC takes one text message plus images, so embedded context has to be
 * inlined. A block kind that cannot be represented is refused rather than
 * dropped: a prompt silently missing the file it was about is worse than a
 * prompt that fails.
 * @param blocks - the ACP content blocks.
 * @returns the flattened message text.
 * @throws `RequestError` when a block carries content pi cannot be given.
 */
function promptText(blocks) {
  const parts = [];
  for (const block of blocks) {
    switch (block?.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'image':
        break; // carried separately, as pi's own image attachments
      case 'resource':
        // An embedded resource is inlined with its uri, which is how the model
        // is told what it is looking at.
        if (typeof block.resource?.text === 'string') {
          const uri = block.resource.uri ?? 'unknown';
          parts.push(`<context uri="${uri}">\n${block.resource.text}\n</context>`);
        } else {
          throw acp.RequestError.invalidParams(undefined, 'pi cannot take a binary embedded resource');
        }
        break;
      case 'resource_link':
        parts.push(`@${block.uri}`);
        break;
      default:
        throw acp.RequestError.invalidParams(undefined, `pi cannot take a '${block?.type}' prompt block`);
    }
  }
  return parts.join('\n');
}

/** The choices runskein's policy picks between for every pi tool call. */
const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Reject and stop', kind: 'reject_always' },
];

/** Dialog methods block the extension until answered; the rest are one-way. */
function isDialogMethod(method) {
  return method === 'select' || method === 'confirm' || method === 'input' || method === 'editor';
}

/**
 * Recognise a permission dialog raised by this shim's own gate extension.
 *
 * The gate encodes the nonce and the tool call in the dialog title, which is
 * the only field pi's `select` carries from the extension to the client.
 * @param dialog - the extension_ui_request frame.
 * @param nonce - the nonce handed to this child's gate extension.
 * @returns the decoded tool call, or undefined when this is not ours.
 */
function parseGateRequest(dialog, nonce) {
  if (dialog?.method !== 'select' || typeof dialog.title !== 'string') return undefined;
  const parts = dialog.title.split(':');
  if (parts.length !== 3 || parts[0] !== 'runskein-pi-permission' || parts[1] !== nonce) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[2], 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Race a promise against a deadline.
 * @param promise - the promise to bound.
 * @param ms - the deadline in milliseconds.
 * @returns the promise's value.
 * @throws `Error` when the deadline passes first.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── ACP agent ──────────────────────────────────────────────────────────────

const [, , piCommand, ...piArgs] = process.argv;
if (!piCommand) {
  process.stderr.write('pi shim: usage: shim.mjs <pi-command> [args…]\n');
  process.exit(2);
}

const launch = { command: piCommand, args: piArgs };
/**
 * Where pi stores its session trees. Unset means pi's own default, which is
 * the right answer for a host that wants its sessions where the user's own
 * `pi -r` will find them; a host that wants runskein-owned storage sets this. It
 * is one directory for every session either way, because a resume respawns a
 * child that has to find the same tree.
 */
const sessionDir = process.env['RUNSKEIN_PI_SESSION_DIR'];
const sessions = new Map();
/** The installation probe, kept as a promise so concurrent callers share one. */
let installation;
let connection;

/**
 * Emit an ACP session notification.
 * @param params - the sessionId + update payload.
 */
const notify = (params) => connection.client.notify('session/update', params);

/**
 * Ask runskein's permission policy about one tool call.
 * @param params - the ACP request_permission params.
 * @returns runskein's answer.
 */
const requestPermission = (params) => connection.client.request('session/request_permission', params);

/**
 * Probe the installation once, sharing the result with concurrent callers.
 *
 * The probe spawns a throwaway pi, so two requests arriving together must not
 * each start one; caching the promise rather than the value is what prevents
 * that.
 * @returns the installation facts.
 * @throws `Error` when pi cannot be started or does not answer.
 */
function probeOnce() {
  installation ??= probeInstallation(launch);
  return installation;
}

/**
 * First usable string in a list of candidate fields.
 *
 * pi's frames are not schema-pinned here, so the reason for a failed turn may
 * arrive under any of several names — take whichever is present rather than
 * guessing one and dropping the rest.
 * @param candidates - possible carriers of the detail.
 * @returns the first non-empty string, or undefined when none carries one.
 */
function firstString(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 300);
    if (value !== null && typeof value === 'object') {
      const nested = firstString([value.message, value.detail, value.error]);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Start a pi child and adopt whatever session it opened.
 * @param cwd - the working directory for the session.
 * @param extraArgs - CLI arguments selecting or forking a stored session.
 * @param systemInstructions - text appended to pi's system prompt, if any.
 * @returns the child plus the state pi reported for it.
 * @throws `RequestError` when the child cannot be started or reports no session.
 */
async function startChild(cwd, extraArgs = [], systemInstructions) {
  const args = [
    ...(sessionDir ? ['--session-dir', sessionDir] : []),
    ...(systemInstructions ? ['--append-system-prompt', systemInstructions] : []),
    '--extension',
    GATE_EXTENSION,
    ...extraArgs,
  ];
  const child = new PiChild({ ...launch, cwd, extraArgs: args });
  try {
    const state = await child.call({ type: 'get_state' });
    if (typeof state?.sessionId !== 'string') {
      throw new Error('pi reported no session id');
    }
    return { child, state };
  } catch (error) {
    await child.stop();
    throw acp.RequestError.internalError(undefined, String(error?.message ?? error));
  }
}

/**
 * Look up a live session.
 * @param sessionId - the ACP session id.
 * @returns the session.
 * @throws `RequestError` when the id is unknown or its child has died.
 */
function requireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw acp.RequestError.invalidParams(undefined, `unknown session '${sessionId}'`);
  if (session.child.isDead) {
    // Respawning here would answer the next prompt from a process with no
    // memory of this conversation, which is a wrong answer dressed as a
    // recovery. Resume is runskein's job and rebuilds the context properly.
    throw acp.RequestError.internalError(undefined, session.child.exitError().message);
  }
  return session;
}

/**
 * Retire the session an id currently maps to, stopping its process.
 *
 * Resume and load both replace a live session with a freshly started child;
 * dropping the map entry without stopping the old one would leak a pi process
 * holding the same session file.
 * @param sessionId - the session being replaced.
 */
async function retire(sessionId) {
  const previous = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (previous) await previous.close();
}

/**
 * Register a started child as a live session.
 * @param child - the pi child.
 * @param state - the state pi reported for it.
 * @param instructions - system instructions to reapply if this session is respawned.
 * @param contextWindow - the selected model's window, for usage reporting.
 * @returns the ACP session id.
 */
function adopt(child, state, instructions, contextWindow) {
  const session = new PiSession({
    child,
    sessionId: state.sessionId,
    instructions,
    contextWindow,
    notify,
    requestPermission,
  });
  // The entry is kept even after the child dies: a dead session must answer
  // "this died", not "no such session", which would read as a client bug
  // rather than the engine failure it is.
  sessions.set(state.sessionId, session);
  return state.sessionId;
}

const app = acp
  .agent({ name: 'pi-acp-shim' })
  .onRequest(
    'initialize',
    (params) => params,
    async () => {
      const probed = await probeOnce();
      const imageCapable = Array.isArray(probed.model?.input)
        ? probed.model.input.includes('image')
        : false;
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentInfo: { name: 'pi (runskein shim)', version: `${probed.version} (shim ${SHIM_VERSION})` },
        authMethods: [],
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: true, close: true, fork: true, list: false, delete: false },
          promptCapabilities: { image: imageCapable, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
        },
      };
    },
  )
  .onRequest(
    'session/new',
    (params) => params,
    async (ctx) => {
      const probed = await probeOnce();
      const instructions = ctx.params?._meta?.['runskein.dev/systemInstructions'];
      const { child, state } = await startChild(ctx.params.cwd, [], instructions);
      return {
        sessionId: adopt(child, state, instructions, probed.model?.contextWindow),
        modes: null,
        configOptions: configOptions(probed),
      };
    },
  )
  .onRequest(
    'session/prompt',
    (params) => params,
    async (ctx) => {
      const session = requireSession(ctx.params.sessionId);
      const stopReason = await session.prompt(ctx.params.prompt ?? []);
      return { stopReason };
    },
  )
  .onNotification(
    'session/cancel',
    (params) => params,
    async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      if (session && !session.child.isDead) await session.cancel();
    },
  )
  .onRequest(
    'session/close',
    (params) => params,
    async (ctx) => {
      const session = sessions.get(ctx.params.sessionId);
      sessions.delete(ctx.params.sessionId);
      if (session) await session.close();
      return {};
    },
  )
  .onRequest(
    'session/resume',
    (params) => params,
    async (ctx) => {
      // A respawned pi is a fresh process, so anything runskein passed only at
      // creation has to be passed again or it is silently lost.
      const instructions = sessions.get(ctx.params.sessionId)?.instructions;
      const { child, state } = await startChild(
        ctx.params.cwd,
        ['--session', ctx.params.sessionId],
        instructions,
      );
      // pi silently opens a fresh session when the stored one is gone, so an
      // empty history here means the resume did not happen. Reporting success
      // would hand runskein an engine that has forgotten the conversation.
      //
      // A message count is not enough on its own. Measured after killing pi
      // mid-session: the stored session survives with a non-zero count, the
      // resume reports success, and pi then answers "there's no prior context
      // in this session". Counting messages asks whether a file exists;
      // requiring a reply that was actually exchanged asks whether there is a
      // conversation to continue, which is what native resume claims.
      //
      // Getting this wrong is worse than failing: runskein's resume chain would
      // otherwise degrade to the transcript digest and restore the context for
      // real, and a false success is exactly what stops it from trying.
      const restored = await child.call({ type: 'get_entries' }).catch(() => undefined);
      const exchanged = (restored?.entries ?? []).some((entry) => entry?.message?.role === 'assistant');
      if (!(state.messageCount > 0) || state.sessionId !== ctx.params.sessionId || !exchanged) {
        await child.stop();
        throw acp.RequestError.internalError(
          undefined,
          `pi could not resume session '${ctx.params.sessionId}'` +
            (exchanged ? '' : ' (the stored session carries no exchanged reply)'),
        );
      }
      await retire(ctx.params.sessionId);
      adopt(child, state, instructions, (await probeOnce()).model?.contextWindow);
      return {};
    },
  )
  .onRequest(
    'session/load',
    (params) => params,
    async (ctx) => {
      const instructions = sessions.get(ctx.params.sessionId)?.instructions;
      const { child, state } = await startChild(
        ctx.params.cwd,
        ['--session', ctx.params.sessionId],
        instructions,
      );
      if (state.sessionId !== ctx.params.sessionId) {
        await child.stop();
        throw acp.RequestError.internalError(
          undefined,
          `pi could not load session '${ctx.params.sessionId}'`,
        );
      }
      const entries = await child.call({ type: 'get_entries' });
      await retire(ctx.params.sessionId);
      adopt(child, state, instructions, (await probeOnce()).model?.contextWindow);
      replayEntries(ctx.params.sessionId, entries?.entries ?? []);
      return {};
    },
  )
  .onRequest(
    'session/fork',
    (params) => params,
    async (ctx) => {
      const probed = await probeOnce();
      // Forking through a fresh child leaves the source session's process
      // untouched, which a same-process clone would not.
      const instructions = sessions.get(ctx.params.sessionId)?.instructions;
      const { child, state } = await startChild(
        ctx.params.cwd,
        ['--fork', ctx.params.sessionId],
        instructions,
      );
      if (state.sessionId === ctx.params.sessionId) {
        await child.stop();
        throw acp.RequestError.internalError(
          undefined,
          `pi returned the source session when forking '${ctx.params.sessionId}'`,
        );
      }
      return {
        sessionId: adopt(child, state, instructions, probed.model?.contextWindow),
        modes: null,
        configOptions: configOptions(probed),
      };
    },
  )
  .onRequest(
    'session/set_config_option',
    (params) => params,
    async (ctx) => {
      const session = requireSession(ctx.params.sessionId);
      const { configId, value } = ctx.params;
      if (configId === 'model') {
        const [provider, ...rest] = String(value).split('/');
        const modelId = rest.join('/');
        if (!modelId) {
          throw acp.RequestError.invalidParams(undefined, `model must be 'provider/id', got '${value}'`);
        }
        await session.child.call({ type: 'set_model', provider, modelId });
      } else if (configId === 'reasoning') {
        try {
          await session.child.call({ type: 'set_thinking_level', level: String(value) });
        } catch (error) {
          // pi rejects a level the current model does not support, which is a
          // bad argument rather than an engine fault.
          throw acp.RequestError.invalidParams(undefined, String(error?.message ?? error));
        }
      } else {
        throw acp.RequestError.invalidParams(undefined, `pi has no config option '${configId}'`);
      }
      const options = configOptions(await probeOnce()).map((option) =>
        option.id === configId ? { ...option, currentValue: value } : option,
      );
      void notify({
        sessionId: ctx.params.sessionId,
        update: { sessionUpdate: 'config_option_update', configOptions: options },
      });
      return { configOptions: options };
    },
  );

/**
 * Replay a loaded session's stored messages as ACP notifications, which is how
 * a `session/load` rebuilds runskein's view of a conversation it did not watch.
 * @param sessionId - the session being loaded.
 * @param entries - pi's stored entries, in append order.
 */
function replayEntries(sessionId, entries) {
  for (const entry of entries) {
    const message = entry?.message;
    const role = message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text =
      typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content) ? message.content : [])
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('');
    if (text.length === 0) continue;
    void notify({
      sessionId,
      update: {
        sessionUpdate: role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
connection = app.connect(stream);

/**
 * Tear every child down. Engines run in the shim's process group, so a killed
 * shim already takes them with it; this covers the orderly paths, where the
 * group is never signalled.
 */
async function shutdown() {
  const live = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(live.map((session) => session.close()));
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
void connection.closed.then(() => {
  void shutdown().finally(() => process.exit(0));
});
