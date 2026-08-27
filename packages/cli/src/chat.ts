/**
 * `runskein chat` — the readline REPL and its input state machine.
 *
 * One stdin, several consumers (prompts, :cancel, permission picks, question
 * answers). The REPL loop is the ONLY code that ever touches readline; event
 * handlers request state transitions and await promises the REPL resolves.
 *
 * States: idle | running | awaiting-permission | awaiting-question |
 * shutting-down. Permission/question requests queue FIFO and are answered in
 * arrival order; plain lines typed mid-turn queue as `[queued]` prompts.
 */
import { createInterface, type Interface } from 'node:readline';
import {
  CancelledError,
  isPromptEcho,
  policies,
  type Answer,
  type Hub,
  type PermissionDecision,
  type PermissionRequest,
  type QuestionRequest,
  type Session,
  type TurnResult,
  type Usage,
  type UsageSummary,
} from '@runskein/core';
import { parseConfigAssignment } from './config.js';
import { UsageError } from './errors.js';
import { Fifo } from './fifo.js';
import { createFolder, type Folder } from '@runskein/fold';
import { createPresenter, printLine, type Presenter } from './render.js';
import type { Shutdown } from './shutdown.js';

export interface ChatOptions {
  engineId: string;
  /** Resolved absolute path; the transcript store lands under it. */
  cwd: string;
  config: Record<string, string | boolean>;
  resume?: string;
  permission: 'allow-all' | 'deny-all' | 'ask';
}

export interface ChatContext {
  shutdown: Shutdown;
  /** Print + record a failure for the final exit-code calculation. */
  recordFailure: (e: unknown) => void;
  /** Resolves when stdout/stderr is no longer writable (for example EPIPE). */
  outputClosed: Promise<void>;
}

type ReplState = 'idle' | 'running' | 'awaiting-permission' | 'awaiting-question' | 'shutting-down';

interface PendingPermission {
  kind: 'permission';
  req: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
}

interface PendingQuestion {
  kind: 'question';
  req: QuestionRequest;
}

type Interaction = PendingPermission | PendingQuestion;

type Action =
  | { type: 'prompt'; text: string }
  | { type: 'config'; patch: Record<string, string | boolean> }
  | { type: 'fork' };

/**
 * Render a usage record's token fields, omitting the ones no engine reported.
 * @param u - the usage record.
 * @returns the space-joined `field=value` text.
 */
function formatUsage(u: Usage): string {
  const fields: Array<keyof Usage> = [
    'input',
    'output',
    'total',
    'uncached',
    'cacheRead',
    'cacheCreation',
    'thought',
  ];
  return fields
    .filter((f) => u[f] !== undefined)
    .map((f) => `${f}=${u[f]}`)
    .join(' ');
}

/**
 * Render the cumulative usage summary.
 * @param u - the summary.
 * @returns its text or '(no usage reported)'.
 */
function formatUsageSummary(u: UsageSummary): string {
  const base = formatUsage(u);
  const cost = u.cost !== undefined ? `cost=${u.cost} ${u.currency ?? ''}`.trimEnd() : '';
  return [base, cost].filter((s) => s !== '').join(' ') || '(no usage reported)';
}

/**
 * Choose how to refuse a permission request, preferring one of the engine's
 * own reject options so the refusal reads the way that engine expects.
 * @param req - the permission request.
 * @returns the reject decision.
 */
function rejectDecision(req: PermissionRequest): PermissionDecision {
  const reject = req.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
  return reject ? { optionId: reject.optionId } : { outcome: 'deny' };
}

class Repl {
  private static readonly ACTION_QUEUE_HIGH_WATER = 64;
  private static readonly ACTION_QUEUE_LOW_WATER = 32;
  private state: ReplState = 'idle';
  private turnActive = false;
  private actionActive = false;
  private cancelling = false;
  /** FIFO of pending permission/question requests; the head owns the next line. */
  private interactions: Interaction[] = [];
  /** CLI-local queue of prompts/:config/:fork submitted while not idle. */
  private readonly actionQueue = new Fifo<Action>();
  /** Update folding + terminal presentation for the current session. */
  private folder: Folder = createFolder();
  private presenter: Presenter = createPresenter();
  private rl: Interface | undefined;
  private session!: Session;
  private activeAction: Promise<void> | undefined;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private sessionUnsubscribers: Array<() => void> = [];
  private finish!: () => void;
  private readonly finished: Promise<void>;

  constructor(
    private readonly hub: Hub,
    private readonly opts: ChatOptions,
    private readonly ctx: ChatContext,
  ) {
    this.finished = new Promise<void>((resolve) => {
      this.finish = resolve;
    });
  }

  /**
   * Open the session, wire readline and the signal handlers, then wait until
   * shutdown completes.
   */
  async run(): Promise<void> {
    // Signal handlers must exist BEFORE the spawn await: engine start can take
    // tens of seconds, and a Ctrl-C in that window would otherwise hit Node's
    // default handler — killing the CLI without Shutdown.run() and abandoning
    // the half-started engine (detached, so the terminal's SIGINT never
    // reaches it).
    process.on('SIGINT', this.onProcessSigint);
    process.on('SIGTERM', this.onProcessSigterm);
    printLine(`[hub] spawning ${this.opts.engineId} ...`);
    let session;
    try {
      session = await this.hub.session({
        engine: this.opts.engineId,
        cwd: this.opts.cwd,
        permissionPolicy: this.permissionPolicy(),
        ...(Object.keys(this.opts.config).length > 0 ? { config: this.opts.config } : {}),
        ...(this.opts.resume !== undefined ? { resume: this.opts.resume } : {}),
      });
    } catch (e) {
      process.removeListener('SIGINT', this.onProcessSigint);
      process.removeListener('SIGTERM', this.onProcessSigterm);
      throw e;
    }
    this.session = session;
    this.ctx.shutdown.attach(session);
    printLine(`[hub] ready`);
    const tier = session.resumeTier !== undefined ? ` resumeTier=${session.resumeTier}` : '';
    printLine(`[session] id=${session.id} engine=${session.engine} status=${session.status}${tier}`);
    this.attachSession(session);

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    this.rl = rl;
    rl.on('line', (line) => this.onLine(line));
    // EOF / Ctrl-D enters shutting-down from any state.
    rl.on('close', () => void this.initiateShutdown());
    // TTY Ctrl-C: readline owns SIGINT when it has a listener.
    rl.on('SIGINT', () => this.onSigint());
    // Non-TTY Ctrl-C and all SIGTERM route through the process handlers
    // installed before the spawn await above.
    // This promise intentionally remains pending during normal operation; do
    // not add it to backgroundTasks, which shutdown waits to empty.
    void this.ctx.outputClosed.then(() => this.initiateShutdown());

    if (process.stdin.isTTY === true) {
      rl.setPrompt(`${this.opts.engineId}> `);
      rl.prompt();
    }
    await this.finished;
    process.removeListener('SIGINT', this.onProcessSigint);
    process.removeListener('SIGTERM', this.onProcessSigterm);
  }

  private readonly onProcessSigint = (): void => this.onSigint();
  private readonly onProcessSigterm = (): void => void this.initiateShutdown();

  /**
   * Handle SIGINT. At idle it starts shutdown; while a turn or interaction is
   * in flight it only cancels, so one Ctrl-C never loses an active session.
   */
  private onSigint(): void {
    if (this.state === 'idle') {
      void this.initiateShutdown();
      return;
    }
    if (this.state === 'shutting-down') return;
    // Escalate instead of doing nothing: a repeat Ctrl-C while a cancel is
    // already hanging, or Ctrl-C during a non-cancellable action
    // (:config/:fork with no turn and no pending interaction), must still
    // give the user an exit — doCancel() would be a silent no-op for both.
    if (this.cancelling || (!this.turnActive && this.interactions.length === 0)) {
      void this.initiateShutdown();
      return;
    }
    this.trackBackground(this.doCancel());
  }

  // ── state ────────────────────────────────────────────────────────────────

  // A method rather than a getter: TypeScript would narrow a property read and
  // then treat the state as unchanged across an await, which it is not.
  private isShuttingDown(): boolean {
    return this.state === 'shutting-down';
  }

  /**
   * Recompute which input state the REPL is in. A pending interaction wins
   * over a running action, because its answer must come from the next line.
   */
  private refreshState(): void {
    if (this.state === 'shutting-down') return;
    const head = this.interactions[0];
    this.state = head
      ? head.kind === 'permission'
        ? 'awaiting-permission'
        : 'awaiting-question'
      : this.actionActive
        ? 'running'
        : 'idle';
    // An awaiting-* state must always be able to read its answer: high-water
    // backpressure may have paused readline mid-turn, and the drain() resume
    // path only runs at idle — a paused readline here would deadlock the turn
    // on a permission answer that can never arrive.
    if (head) this.rl?.resume();
  }

  /**
   * Wire the session's update/permission/question/status listeners.
   * @param session - the session to attach.
   */
  private attachSession(session: Session): void {
    this.detachSessionListeners();
    this.sessionUnsubscribers = [
      session.on('update', (e) => {
        // The stream carries runskein's echo of the prompt (decision 035). The
        // operator just typed it and the terminal still shows it, so replaying
        // it would print every prompt twice — while a user chunk the ENGINE
        // sent is something the operator has not seen and must still get.
        if (isPromptEcho(e.update)) return;
        for (const folded of this.folder.push(e)) this.presenter.consume(folded);
      }),
      session.on('question', (q) => this.onQuestion(q)),
      session.on('permission', (req) => {
        // Observation only — the policy already answered. In 'ask' mode the
        // policy prints the full request itself, so this would duplicate it.
        if (this.opts.permission !== 'ask') {
          printLine(`[permission] tool=${req.tool} kind=${req.kind ?? 'other'} → ${this.opts.permission}`);
        }
      }),
      session.on('status', (st) => printLine(`[status] ${st}`)),
    ];
  }

  private detachSessionListeners(): void {
    for (const unsubscribe of this.sessionUnsubscribers.splice(0)) unsubscribe();
  }

  /**
   * Build the session permission policy for the selected mode.
   * @returns the policy function.
   */
  private permissionPolicy() {
    if (this.opts.permission === 'allow-all') return policies.allowAll;
    if (this.opts.permission === 'deny-all') return policies.denyAll;
    return (req: PermissionRequest): Promise<PermissionDecision> => {
      if (this.cancelling || this.isShuttingDown()) {
        return Promise.resolve(rejectDecision(req));
      }
      return new Promise((resolve) => {
        this.interactions.push({ kind: 'permission', req, resolve });
        this.printPermissionRequest(req);
        this.refreshState();
      });
    };
  }

  // ── interaction intake (event handlers never read input) ─────────────────

  /**
   * Print an awaiting-permission prompt.
   * @param req - the permission request.
   */
  private printPermissionRequest(req: PermissionRequest): void {
    const position = this.interactions.length;
    printLine(
      `[permission]${position > 1 ? ` (queued #${position})` : ''} tool=${req.tool} kind=${req.kind ?? 'other'}`,
    );
    if (req.input !== undefined) {
      printLine(`  input: ${JSON.stringify(req.input) ?? ''}`);
    }
    for (const loc of req.locations ?? []) {
      printLine(`  at ${loc.path}${loc.line != null ? `:${loc.line}` : ''}`);
    }
    this.printPermissionOptions(req);
  }

  private printPermissionOptions(req: PermissionRequest): void {
    req.options.forEach((o, i) => printLine(`  ${i + 1}) ${o.optionId} — ${o.name} (${o.kind})`));
    printLine('  pick <number|optionId>:');
  }

  /**
   * Handle an agent question by entering the awaiting-question state.
   * @param req - the question request.
   */
  private onQuestion(req: QuestionRequest): void {
    if (this.cancelling || this.isShuttingDown()) {
      // The library owns this question's promise. Re-running cancel settles a
      // request that arrived just after the first cancel swept the pending
      // ones, which would otherwise hang the turn.
      this.trackBackground(this.session.cancel());
      return;
    }
    this.interactions.push({ kind: 'question', req });
    const position = this.interactions.length;
    printLine(`[question]${position > 1 ? ` (queued #${position})` : ''} ${req.question}`);
    req.options?.forEach((o, i) => printLine(`  ${i + 1}) ${o.id} — ${o.label}`));
    this.refreshState();
  }

  // ── line dispatch (the only readline consumer) ───────────────────────────

  /**
   * Dispatch one readline line: command, interaction answer, or prompt.
   * @param line - the raw input line.
   */
  private onLine(line: string): void {
    if (this.state === 'shutting-down') return;
    if (line.startsWith(':')) {
      const task = this.runCommand(line);
      if (line.trim().split(/\s+/, 1)[0] === ':quit') {
        void task.catch((e: unknown) => this.ctx.recordFailure(e));
      } else {
        this.trackBackground(task);
      }
      return;
    }
    // Awaiting-* takes precedence over prompt interpretation.
    const head = this.interactions[0];
    if (head) {
      this.answerInteraction(head, line);
      return;
    }
    // A blank line is a REPL habit (re-show the prompt), not a turn: never
    // spend a real engine turn on empty input.
    if (line.trim() === '') {
      if (!this.actionActive && process.stdin.isTTY === true) this.rl?.prompt();
      return;
    }
    if (this.actionActive) {
      this.enqueueAction({ type: 'prompt', text: line }, line);
      return;
    }
    this.startAction({ type: 'prompt', text: line });
  }

  /**
   * Feed a line to the head pending interaction (permission/question).
   * @param head - the pending interaction.
   * @param line - the raw answer.
   */
  private answerInteraction(head: Interaction, line: string): void {
    const pick = line.trim();
    if (head.kind === 'permission') {
      const byNumber = /^\d+$/.test(pick) ? head.req.options[Number(pick) - 1] : undefined;
      const option = byNumber ?? head.req.options.find((o) => o.optionId === pick);
      if (!option) {
        printLine(`[permission] invalid pick '${pick}' — choose:`);
        this.printPermissionOptions(head.req);
        return;
      }
      this.interactions.shift();
      printLine(`[permission] → ${option.optionId}`);
      head.resolve({ optionId: option.optionId });
    } else {
      const options = head.req.options ?? [];
      const byNumber = /^\d+$/.test(pick) ? options[Number(pick) - 1] : undefined;
      const matched = byNumber ?? options.find((o) => o.id === pick);
      const answer: Answer = matched ? { optionId: matched.id } : { text: line };
      this.interactions.shift();
      printLine(`[question] → ${matched ? matched.id : line}`);
      this.trackBackground(this.session.respond(head.req.requestId, answer));
    }
    this.refreshState();
    this.drain();
  }

  // ── turns and queued actions ─────────────────────────────────────────────

  private async runAction(action: Action): Promise<void> {
    if (this.state === 'shutting-down') return;
    this.actionActive = true;
    if (action.type === 'prompt') this.turnActive = true;
    this.refreshState();
    try {
      switch (action.type) {
        case 'prompt': {
          let result: TurnResult | undefined;
          try {
            result = await this.session.prompt(action.text);
          } catch (e) {
            // Closing during shutdown rejects the active prompt with
            // CancelledError; that is the clean-exit path, not a failure.
            if (!(this.isShuttingDown() && e instanceof CancelledError)) {
              this.ctx.recordFailure(e);
            }
          }
          // The turn settled: end any open message stream before the
          // turn-summary lines (transcript events carry no turn-end marker).
          for (const folded of this.folder.flush()) this.presenter.consume(folded);
          if (result !== undefined) this.printTurnResult(result);
          return;
        }
        case 'config': {
          try {
            await this.session.setConfig(action.patch);
            printLine('[config] applied');
          } catch (e) {
            if (!(this.isShuttingDown() && e instanceof CancelledError)) {
              this.ctx.recordFailure(e);
            }
          }
          return;
        }
        case 'fork': {
          try {
            const parent = this.session;
            const forked = await parent.fork();
            this.session = forked;
            this.folder = createFolder();
            this.presenter = createPresenter();
            this.ctx.shutdown.attach(forked);
            this.attachSession(forked);
            printLine(`[fork] now on session id=${forked.id}`);
            await parent.close();
          } catch (e) {
            if (!(this.isShuttingDown() && e instanceof CancelledError)) {
              this.ctx.recordFailure(e);
            }
          }
          return;
        }
      }
    } finally {
      if (action.type === 'prompt') {
        this.turnActive = false;
        this.cancelling = false;
      }
      this.actionActive = false;
      this.refreshState();
      this.drain();
    }
  }

  /**
   * Start one action, retaining its promise so shutdown can wait for it.
   * @param action - the action to run.
   */
  private startAction(action: Action): void {
    let tracked!: Promise<void>;
    tracked = this.runAction(action)
      .catch((e: unknown) => this.ctx.recordFailure(e))
      .finally(() => {
        if (this.activeAction === tracked) this.activeAction = undefined;
      });
    this.activeAction = tracked;
  }

  /**
   * Retain a fire-and-forget task until it settles, so shutdown cannot compute
   * the exit code before every failure has been recorded.
   * @param task - the async task.
   */
  private trackBackground(task: Promise<void>): void {
    let tracked!: Promise<void>;
    tracked = task
      .catch((e: unknown) => this.ctx.recordFailure(e))
      .finally(() => this.backgroundTasks.delete(tracked));
    this.backgroundTasks.add(tracked);
  }

  /**
   * Once back at idle, start the next queued action, or re-show the prompt.
   * Also lifts readline backpressure as the queue drains.
   */
  private drain(): void {
    if (this.state !== 'idle') return;
    const next = this.actionQueue.shift();
    if (this.actionQueue.length <= Repl.ACTION_QUEUE_LOW_WATER) this.rl?.resume();
    if (next) {
      this.startAction(next);
      return;
    }
    if (process.stdin.isTTY === true) this.rl?.prompt();
  }

  /**
   * Queue an action for later and echo it back. Readline is paused past the
   * high-water mark so a firehose of piped input cannot grow the queue without
   * bound.
   * @param action - the action to run later.
   * @param display - the text echoed to the user.
   */
  private enqueueAction(action: Action, display: string): void {
    this.actionQueue.push(action);
    if (this.actionQueue.length >= Repl.ACTION_QUEUE_HIGH_WATER) this.rl?.pause();
    printLine(`[queued] ${display}`);
  }

  /**
   * Drop every queued but not-yet-run action.
   */
  private clearActionQueue(): void {
    this.actionQueue.clear();
    if (!this.isShuttingDown()) this.rl?.resume();
  }

  /**
   * Render a completed turn (stop reason, duration, usage).
   * @param result - the turn result.
   */
  private printTurnResult(result: TurnResult): void {
    printLine(`[turn] stopReason=${result.stopReason} durationMs=${result.durationMs}`);
    if (result.usage !== undefined) printLine(`[usage] turn ${formatUsage(result.usage)}`);
    printLine(`[usage] session ${formatUsageSummary(this.session.usage())}`);
  }

  // ── ':' commands (CLI-local, never sent to the engine) ───────────────────

  private async runCommand(line: string): Promise<void> {
    if (this.state === 'shutting-down') return;
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case ':cancel':
        await this.doCancel();
        return;
      case ':config': {
        // Take the raw remainder so values may contain whitespace — the
        // launch-time `-c` flag accepts the same assignment as one argv
        // element, and the runtime spelling must not be narrower.
        const kv = line.replace(/^\s*:config\s*/, '');
        if (kv === '') {
          this.ctx.recordFailure(new UsageError('usage: :config key=value'));
          return;
        }
        let assignment;
        try {
          assignment = parseConfigAssignment(kv, 'usage: :config key=value');
        } catch (e) {
          this.ctx.recordFailure(e);
          return;
        }
        const action: Action = {
          type: 'config',
          patch: { [assignment.key]: assignment.value },
        };
        if (this.state === 'idle') this.startAction(action);
        else {
          this.enqueueAction(action, line);
        }
        return;
      }
      case ':fork': {
        if (rest.length > 0) {
          this.ctx.recordFailure(new UsageError('usage: :fork'));
          return;
        }
        if (this.state === 'idle') this.startAction({ type: 'fork' });
        else {
          this.enqueueAction({ type: 'fork' }, line);
        }
        return;
      }
      case ':status': {
        printLine(`[status] session=${this.session.status}`);
        try {
          const health = await this.hub.health();
          for (const [id, h] of Object.entries(health)) printLine(`  ${id}: ${h}`);
        } catch (e) {
          this.ctx.recordFailure(e);
        }
        return;
      }
      case ':quit':
        await this.initiateShutdown();
        return;
      default:
        this.ctx.recordFailure(
          new UsageError(`unknown command '${cmd}' — :cancel :config :fork :status :quit`),
        );
    }
  }

  /**
   * Cancel the current turn, from `:cancel` or a SIGINT that arrived while
   * busy. Clears the CLI-local queue and settles every pending permission with
   * a refusal first: an unanswered policy promise would otherwise keep the
   * turn alive forever. Pending questions are dropped here and cancelled by
   * the library. The active turn then resolves as cancelled rather than
   * rejecting.
   */
  private async doCancel(): Promise<void> {
    if (!this.turnActive && this.interactions.length === 0) {
      printLine('[repl] nothing to cancel');
      return;
    }
    if (this.cancelling) return;
    this.cancelling = true;
    this.clearActionQueue();
    for (const item of this.interactions.splice(0)) {
      if (item.kind === 'permission') item.resolve(rejectDecision(item.req));
    }
    this.refreshState();
    try {
      await this.session.cancel();
    } catch (e) {
      this.ctx.recordFailure(e);
    } finally {
      // When no prompt is running there is no runAction finally block coming
      // to release the gate, so release it here.
      if (!this.turnActive) this.cancelling = false;
    }
  }

  /**
   * Begin shutdown, from `:quit`, EOF, SIGTERM, or an idle SIGINT. Stops
   * reading input, clears the local queues, settles pending permissions, then
   * runs the shared cleanup — which closes the session and quits the hub
   * exactly once no matter how many paths lead here.
   */
  private async initiateShutdown(): Promise<void> {
    if (this.state === 'shutting-down') return;
    this.state = 'shutting-down';
    this.actionQueue.clear();
    for (const item of this.interactions.splice(0)) {
      if (item.kind === 'permission') item.resolve(rejectDecision(item.req));
    }
    // Closing the session cancels the pending questions and the active prompt,
    // so only the readline handle needs releasing here.
    this.rl?.close();
    // An open (piped) stdin keeps the event loop alive even after rl.close();
    // release it so a clean shutdown can actually exit.
    (process.stdin as unknown as { unref?: () => void }).unref?.();
    await this.ctx.shutdown.run();
    const action = this.activeAction;
    if (action) await action;
    await Promise.all([...this.backgroundTasks]);
    this.detachSessionListeners();
    this.finish();
  }
}

/**
 * Create or resume a session and run the REPL until it shuts down.
 * @param hub - the hub to open the session on.
 * @param opts - the parsed chat options.
 * @param ctx - shutdown handle, failure sink, and the output-closed signal.
 */
export async function runChat(hub: Hub, opts: ChatOptions, ctx: ChatContext): Promise<void> {
  await new Repl(hub, opts, ctx).run();
}
