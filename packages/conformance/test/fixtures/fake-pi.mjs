#!/usr/bin/env node
/**
 * A scripted stand-in for `pi --mode rpc`.
 *
 * It speaks pi's JSONL RPC well enough to drive the shim through every path
 * the hermetic cases need, and badly enough — on demand — to drive the failure
 * paths: malformed frames, separators that a naive line reader would split on,
 * deaths mid-turn, permission dialogs, retries.
 *
 * Behaviour toggles (env):
 *   FAKE_PI_SESSION_DIR=<p>     where session state files live (required for
 *                               resume/fork; the real pi has its own default)
 *   FAKE_PI_MODEL_INPUT=<list>  comma-separated model input kinds (default
 *                               "text,image"); drives the shim's declared
 *                               prompt.image capability
 *   FAKE_PI_THINKING=<list>     comma-separated thinking levels (default
 *                               "off,low,high")
 *   FAKE_PI_STARTUP_NOISE=1     emit an unsolicited extension_ui_request and a
 *                               malformed line before answering anything
 *   FAKE_PI_ECHO_PROMPT=1      reply with the prompt text pi was given, so a
 *                               test can assert what the shim actually sent
 *   FAKE_PI_TRICKY_TEXT=1       reply with text containing U+2028/U+2029/CR
 *   FAKE_PI_SPLIT_WRITES=1      write every frame in three chunks
 *   FAKE_PI_CRLF=1              terminate frames with CRLF instead of LF
 *   FAKE_PI_STOP_REASON=<r>     assistant stop reason (default "stop")
 *   FAKE_PI_RETRY_ONCE=1        end the first run with willRetry, then settle
 *   FAKE_PI_TOOL=1              run a scripted tool call during the turn
 *   FAKE_PI_TOOL_NAME=<n>       tool name for the scripted call (default bash)
 *   FAKE_PI_ASK=1               ask the permission gate before the tool runs
 *   FAKE_PI_FOREIGN_DIALOG=1    raise a dialog that carries no runskein marker
 *   FAKE_PI_NO_ANSWER_DIALOG=1  raise the permission dialog and ignore the answer
 *   FAKE_PI_USAGE=1             answer get_session_stats with token counts and a
 *                               context reading; without it the fixture reports
 *                               no stats at all, like an engine that cannot
 *   FAKE_PI_COST=1              include a cost in those stats (an unpriced model
 *                               reports none, and must not be given a zero)
 *   FAKE_PI_PROMPT_MS=<n>       how long a turn takes (default 40)
 *   FAKE_PI_DIE_ON_PROMPT=1     exit(9) mid-turn
 *   FAKE_PI_DIE_ONCE_FILE=<p>   with the above, only the first child to reach a
 *                               turn dies; the flag file spans processes
 *   FAKE_PI_REJECT_PROMPT=1     answer the prompt command with success:false
 *   FAKE_PI_EMPTY_RESUME=1      report messageCount 0 even when resuming
 *   FAKE_PI_FORK_SAME_ID=1      return the source session id when forking
 *   FAKE_PI_REFUSE_ENV=<name>   exit(3) before answering anything when <name> is
 *                               set, which makes the env-hygiene case a real
 *                               assertion rather than a hopeful one
 *   FAKE_PI_TRACE_FILE=<p>      append one JSON line per spawn: argv + env of
 *                               interest, for argv/env assertions
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);

/**
 * Read a CLI flag's value.
 * @param name - the flag, including dashes.
 * @returns the value, or undefined when the flag is absent.
 */
function flag(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const sessionDir = flag('--session-dir') ?? process.env['FAKE_PI_SESSION_DIR'];
const resumeId = flag('--session');
const forkId = flag('--fork');
const ephemeral = argv.includes('--no-session');

const refuseEnv = process.env['FAKE_PI_REFUSE_ENV'];
if (refuseEnv && process.env[refuseEnv]) process.exit(3);

const trace = process.env['FAKE_PI_TRACE_FILE'];
if (trace) {
  appendFileSync(
    trace,
    `${JSON.stringify({
      argv,
      pid: process.pid,
      cwd: process.cwd(),
      gateNonce: process.env['RUNSKEIN_PI_GATE_NONCE'] ?? null,
      // Env hygiene assertions read these back: the first three must be gone,
      // the last must have survived.
      env: {
        PI_SESSION_ID: process.env['PI_SESSION_ID'] ?? null,
        PI_SESSION_FILE: process.env['PI_SESSION_FILE'] ?? null,
        PI_CODING_AGENT: process.env['PI_CODING_AGENT'] ?? null,
        PI_CODING_AGENT_DIR: process.env['PI_CODING_AGENT_DIR'] ?? null,
        CLAUDE_GATE_MARKER: process.env['CLAUDE_GATE_MARKER'] ?? null,
      },
    })}\n`,
  );
}

// ── session state, persisted so a resume/fork can find it ──────────────────

/**
 * Load a stored session, or start a new one.
 * @returns the session id and its message count.
 */
function openSession() {
  if (ephemeral || !sessionDir) return { sessionId: randomUUID(), messageCount: 0 };
  mkdirSync(sessionDir, { recursive: true });
  if (resumeId) {
    const file = join(sessionDir, `${resumeId}.json`);
    // A pi that cannot find the stored session quietly opens an empty one.
    if (!existsSync(file)) return { sessionId: randomUUID(), messageCount: 0 };
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (process.env['FAKE_PI_EMPTY_RESUME']) return { sessionId: resumeId, messageCount: 0 };
    return { sessionId: resumeId, messageCount: stored.entries.length, entries: stored.entries };
  }
  if (forkId) {
    const file = join(sessionDir, `${forkId}.json`);
    const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { entries: [] };
    const sessionId = process.env['FAKE_PI_FORK_SAME_ID'] ? forkId : randomUUID();
    return { sessionId, messageCount: stored.entries.length, entries: [...stored.entries] };
  }
  return { sessionId: randomUUID(), messageCount: 0, entries: [] };
}

const session = openSession();
session.entries ??= [];

/** Persist the session so later resumes and forks see this conversation. */
function persist() {
  if (ephemeral || !sessionDir) return;
  writeFileSync(
    join(sessionDir, `${session.sessionId}.json`),
    JSON.stringify({ entries: session.entries }),
  );
}
persist();

// ── framing ────────────────────────────────────────────────────────────────

/**
 * Write one frame, optionally in pieces, to prove the reader reassembles.
 * @param frame - the object to send.
 */
function send(frame) {
  const line = `${JSON.stringify(frame)}${process.env['FAKE_PI_CRLF'] ? '\r\n' : '\n'}`;
  if (!process.env['FAKE_PI_SPLIT_WRITES']) {
    process.stdout.write(line);
    return;
  }
  const third = Math.ceil(line.length / 3);
  process.stdout.write(line.slice(0, third));
  process.stdout.write(line.slice(third, third * 2));
  process.stdout.write(line.slice(third * 2));
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\n');
    if (index === -1) break;
    const line = buffer.slice(0, index).replace(/\r$/, '');
    buffer = buffer.slice(index + 1);
    if (line.trim()) void handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

if (process.env['FAKE_PI_STARTUP_NOISE']) {
  send({
    type: 'extension_ui_request',
    id: randomUUID(),
    method: 'notify',
    message: 'custom providers ready',
    notifyType: 'info',
  });
  process.stdout.write('this line is not json\n');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingDialogs = new Map();

// ── commands ───────────────────────────────────────────────────────────────

/**
 * Handle one command frame from the shim.
 * @param command - the parsed command.
 */
async function handle(command) {
  const ok = (data) =>
    send({ id: command.id, type: 'response', command: command.type, success: true, data });
  switch (command.type) {
    case 'get_state':
      ok({
        model: {
          id: 'fake-model',
          provider: 'fake',
          input: (process.env['FAKE_PI_MODEL_INPUT'] ?? 'text,image').split(','),
        },
        thinkingLevel: 'off',
        isStreaming: false,
        sessionId: session.sessionId,
        messageCount: session.messageCount,
      });
      return;
    case 'get_available_models':
      ok({
        models: [
          { id: 'fake-model', name: 'Fake Model', provider: 'fake' },
          { id: 'other-model', name: 'Other Model', provider: 'fake' },
        ],
      });
      return;
    case 'get_available_thinking_levels':
      ok({ levels: (process.env['FAKE_PI_THINKING'] ?? 'off,low,high').split(',') });
      return;
    case 'get_session_stats':
      if (!process.env['FAKE_PI_USAGE']) {
        send({
          id: command.id,
          type: 'response',
          command: command.type,
          success: false,
          error: 'no stats',
        });
        return;
      }
      ok({
        sessionId: session.sessionId,
        tokens: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0, total: 220 },
        ...(process.env['FAKE_PI_COST'] ? { cost: 0.06 } : {}),
        contextUsage: { tokens: 220, contextWindow: 100_000, percent: 1 },
      });
      return;
    case 'get_entries':
      ok({ entries: session.entries, leafId: session.entries.at(-1)?.id ?? null });
      return;
    case 'set_model':
      ok({ model: { id: command.modelId, provider: command.provider } });
      return;
    case 'set_thinking_level':
      if (!(process.env['FAKE_PI_THINKING'] ?? 'off,low,high').split(',').includes(command.level)) {
        send({
          id: command.id,
          type: 'response',
          command: command.type,
          success: false,
          error: `unsupported level ${command.level}`,
        });
        return;
      }
      ok({});
      return;
    case 'abort':
      aborted = true;
      ok({});
      return;
    case 'abort_bash':
      ok({});
      return;
    case 'prompt':
      if (process.env['FAKE_PI_REJECT_PROMPT']) {
        send({
          id: command.id,
          type: 'response',
          command: 'prompt',
          success: false,
          error: 'prompt rejected',
        });
        return;
      }
      ok(undefined);
      void runTurn(command.message);
      return;
    case 'extension_ui_response': {
      const resolve = pendingDialogs.get(command.id);
      if (resolve) {
        pendingDialogs.delete(command.id);
        resolve(command.cancelled ? undefined : command.value);
      }
      return;
    }
    default:
      send({
        id: command.id,
        type: 'response',
        command: command.type,
        success: false,
        error: `unknown command ${command.type}`,
      });
  }
}

// ── the scripted turn ──────────────────────────────────────────────────────

let aborted = false;
let retried = false;

/**
 * Raise a dialog and wait for the shim's answer.
 * @param title - the dialog title.
 * @returns the selected value, or undefined when dismissed.
 */
function ask(title) {
  const id = randomUUID();
  return new Promise((resolve) => {
    pendingDialogs.set(id, resolve);
    send({ type: 'extension_ui_request', id, method: 'select', title, options: ['a', 'b'] });
  });
}

/**
 * Run one scripted assistant turn.
 * @param message - the prompt text, echoed into the stored history.
 */
async function runTurn(message) {
  aborted = false;
  session.entries.push({ type: 'message', id: randomUUID(), message: { role: 'user', content: message } });
  send({ type: 'agent_start' });

  const text = process.env['FAKE_PI_ECHO_PROMPT']
    ? String(message)
    : process.env['FAKE_PI_TRICKY_TEXT']
      ? 'a b c\rd'
      : 'OK';
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  send({
    type: 'message_update',
    ...(process.env['FAKE_PI_USAGE'] ? { usage: usage(1) } : {}),
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
  });

  if (process.env['FAKE_PI_TOOL']) await runTool();
  if (process.env['FAKE_PI_FOREIGN_DIALOG']) {
    const answer = await ask('Some other extension asks a question');
    send({ type: 'extension_error', extensionPath: 'foreign', event: 'tool_call', error: String(answer) });
  }

  await sleep(Number(process.env['FAKE_PI_PROMPT_MS'] ?? 40));
  if (process.env['FAKE_PI_DIE_ON_PROMPT'] && dieNow()) process.exit(9);

  const stopReason = aborted ? 'aborted' : (process.env['FAKE_PI_STOP_REASON'] ?? 'stop');
  const assistant = {
    role: 'assistant',
    content: [{ type: 'text', text }],
    stopReason,
    ...(process.env['FAKE_PI_USAGE'] ? { usage: usage(2) } : {}),
  };
  session.entries.push({ type: 'message', id: randomUUID(), message: assistant });
  session.messageCount = session.entries.length;
  persist();
  send({ type: 'message_end', message: assistant });

  if (process.env['FAKE_PI_RETRY_ONCE'] && !retried) {
    // A retry looks like the end of a run without being the end of the turn:
    // the shim must not report a stop reason here.
    retried = true;
    send({ type: 'agent_end', willRetry: true });
    send({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1 });
    await sleep(10);
    send({ type: 'auto_retry_end', attempt: 2 });
    send({ type: 'message_end', message: assistant });
  }
  send({ type: 'agent_end', willRetry: false });
  send({ type: 'agent_settled' });
}

/**
 * Whether this process should die on the turn it is running.
 * @returns true when no die-once flag is configured, or this process claimed it.
 */
function dieNow() {
  const flag = process.env['FAKE_PI_DIE_ONCE_FILE'];
  if (!flag) return true;
  if (existsSync(flag)) return false;
  writeFileSync(flag, 'died');
  return true;
}

/** Emit the scripted tool call, asking the gate first when configured. */
async function runTool() {
  const toolCallId = 'call-1';
  const toolName = process.env['FAKE_PI_TOOL_NAME'] ?? 'bash';
  const args = { command: 'ls -la', path: '/tmp/root.txt' };
  send({ type: 'tool_execution_start', toolCallId, toolName, args });

  if (process.env['FAKE_PI_ASK']) {
    const payload = Buffer.from(JSON.stringify({ toolCallId, toolName, args }), 'utf8').toString('base64');
    const title = `runskein-pi-permission:${process.env['RUNSKEIN_PI_GATE_NONCE']}:${payload}`;
    const answer = process.env['FAKE_PI_NO_ANSWER_DIALOG']
      ? await Promise.race([ask(title), sleep(50).then(() => 'timed-out')])
      : await ask(title);
    send({ type: 'runskein_test_permission_answer', answer: String(answer) });
    if (answer !== 'allow_once' && answer !== 'allow_always') {
      send({
        type: 'tool_execution_end',
        toolCallId,
        toolName,
        result: { content: [{ type: 'text', text: 'Denied by runskein permission policy' }] },
        isError: true,
      });
      return;
    }
  }

  send({
    type: 'tool_execution_update',
    toolCallId,
    toolName,
    partialResult: { content: [{ type: 'text', text: 'ab' }] },
  });
  send({
    type: 'tool_execution_update',
    toolCallId,
    toolName,
    partialResult: { content: [{ type: 'text', text: 'abcd' }] },
  });
  send({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: { content: [{ type: 'text', text: 'abcd' }] },
    isError: false,
  });
}

/**
 * Cumulative usage, growing with each report.
 * @param step - which report this is.
 * @returns a pi usage object.
 */
function usage(step) {
  const base = {
    input: 100 * step,
    output: 10 * step,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 110 * step,
  };
  if (!process.env['FAKE_PI_COST']) return base;
  return {
    ...base,
    cost: { input: 0.01 * step, output: 0.02 * step, cacheRead: 0, cacheWrite: 0, total: 0.03 * step },
  };
}
