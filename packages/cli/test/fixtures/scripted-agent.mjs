/**
 * Parameterized scripted ACP agent fixture (CLI-local companion to core's
 * mock-agent.mjs). A minimal ndjson JSON-RPC server on stdio whose behaviour
 * is defined by a JSON script, so one fixture covers every rendering /
 * interaction scenario without hand-writing an agent per case.
 *
 * Configuration (env):
 *   SCRIPTED_AGENT_SCRIPT       inline JSON script, or '@<path>' to read a file
 *   SCRIPTED_AGENT_TRACE_FILE   append one 'spawn' line per process start
 *   SCRIPTED_AGENT_WEDGED=1     ignore stdin close and SIGTERM (CL-07)
 *
 * Script shape:
 * {
 *   capabilities: { fork?: bool, resume?: bool, load?: bool, close?: bool,
 *                   providers?: bool },        // defaults: all false except load/close/resume true
 *   configOptions: [...],                      // session/new configOptions (probe fixtures)
 *   modes: {...},                              // session/new modes, optional
 *   wedged: bool,                              // same as the env toggle
 *   stopReason: 'end_turn',                    // default prompt stop reason
 *   onPrompt: [steps],                         // shorthand for a single turn script
 *   turns: [[steps], ...]                      // per-turn scripts; last one repeats
 * }
 *
 * Prompt steps (executed in order; cancel stops the sequence):
 *   { "update": {...} }        raw session/update notification body
 *   { "chunk": "text" }        agent_message_chunk text
 *   { "thought": "text" }      agent_thought_chunk text
 *   { "delayMs": n }           sleep (cancel wakes it)
 *   { "permission": { toolCall?, options? }, "await": bool }
 *                              send session/request_permission; default await: true
 *   { "question": { "message": "...", "options": [...] }, "await": bool }
 *                              send elicitation/create; default await: true
 *   { "awaitAll": true }       wait for every outstanding fire-and-forget request
 */
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';

let raw = process.env.SCRIPTED_AGENT_SCRIPT ?? '{}';
if (raw.startsWith('@')) raw = readFileSync(raw.slice(1), 'utf8');
const script = JSON.parse(raw);
const caps = script.capabilities ?? {};
const wedged = script.wedged === true || process.env.SCRIPTED_AGENT_WEDGED === '1';

const traceFile = process.env.SCRIPTED_AGENT_TRACE_FILE;
if (traceFile) appendFileSync(traceFile, 'spawn\n');

const logFile = process.env.SCRIPTED_AGENT_LOG_FILE;
function log(direction, msg) {
  if (logFile) appendFileSync(logFile, `${direction} ${JSON.stringify(msg)}\n`);
}

if (wedged) {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
}

function send(msg) {
  log('>>', msg);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

let nextId = 1000;
const pendingByRequestId = new Map();

function request(method, params) {
  return new Promise((res) => {
    const id = nextId++;
    pendingByRequestId.set(id, res);
    send({ id, method, params });
  });
}

function notify(method, params) {
  send({ method, params });
}

// ── session state ──────────────────────────────────────────────────────────

let sessionCounter = 0;
let promptCounter = 0;
/** sessionId → cancel fn for the in-flight prompt. */
const activePrompts = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  log('<<', msg);
  void handle(msg);
});
process.stdin.on('end', () => {
  if (!wedged) process.exit(0);
});

function questionSchema(q) {
  if (Array.isArray(q.options) && q.options.length > 0) {
    return { type: 'object', properties: { value: { type: 'string', enum: q.options } } };
  }
  return { type: 'object', properties: { value: { type: 'string' } } };
}

async function runPrompt(params, reply) {
  const sessionId = params.sessionId;
  const turn = ++promptCounter;
  const turns = script.turns ?? (script.onPrompt ? [script.onPrompt] : [[]]);
  const steps = turns[Math.min(turn - 1, turns.length - 1)] ?? [];

  let cancelled = false;
  let wake;
  activePrompts.set(sessionId, () => {
    cancelled = true;
    wake?.();
  });

  const outstanding = [];
  const update = (u) => notify('session/update', { sessionId, update: u });

  for (const step of steps) {
    if (cancelled) break;
    if (step.update !== undefined) {
      update(step.update);
    } else if (step.chunk !== undefined) {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.chunk } });
    } else if (step.thought !== undefined) {
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } });
    } else if (step.delayMs !== undefined) {
      await Promise.race([sleep(step.delayMs), new Promise((r) => (wake = r))]);
    } else if (step.permission !== undefined) {
      const p = step.permission;
      const promise = request('session/request_permission', {
        sessionId,
        toolCall: p.toolCall ?? {
          toolCallId: `perm-${turn}`,
          title: 'write-file',
          kind: 'edit',
          rawInput: { path: '/tmp/scripted.txt' },
        },
        options: p.options ?? [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      if (step.await === false) outstanding.push(promise);
      else await promise;
    } else if (step.question !== undefined) {
      const promise = request('elicitation/create', {
        sessionId,
        message: step.question.message ?? 'Pick one',
        mode: 'form',
        requestedSchema: questionSchema(step.question),
      });
      if (step.await === false) outstanding.push(promise);
      else await promise;
    } else if (step.awaitAll === true) {
      await Promise.all(outstanding);
    }
  }
  if (!cancelled) await Promise.all(outstanding);

  activePrompts.delete(sessionId);
  reply({ stopReason: cancelled ? 'cancelled' : (script.stopReason ?? 'end_turn') });
}

async function handle(msg) {
  // Response to one of our own agent→client requests.
  if (msg.id !== undefined && msg.method === undefined) {
    pendingByRequestId.get(msg.id)?.(msg.result);
    pendingByRequestId.delete(msg.id);
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => send({ id, result });
  const replyError = (code, message) => send({ id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      reply({
        protocolVersion: 1,
        agentInfo: { name: 'scripted-agent', version: '1.0.0' },
        agentCapabilities: {
          loadSession: caps.load !== false,
          sessionCapabilities: {
            ...(caps.resume === false ? {} : { resume: true }),
            list: true,
            ...(caps.fork === true ? { fork: true } : {}),
            ...(caps.close === false ? {} : { close: true }),
          },
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          ...(caps.providers === true ? { providers: {} } : {}),
        },
      });
      return;
    }
    case 'session/new': {
      sessionCounter++;
      reply({
        sessionId: `scripted-${sessionCounter}`,
        ...(script.modes !== undefined ? { modes: script.modes } : {}),
        configOptions: script.configOptions ?? [],
      });
      return;
    }
    case 'session/resume': {
      if (caps.resume === false) replyError(-32601, 'Method not found');
      else reply({});
      return;
    }
    case 'session/load': {
      if (caps.load === false) replyError(-32601, 'Method not found');
      else reply({});
      return;
    }
    case 'session/fork': {
      if (caps.fork !== true) {
        replyError(-32601, 'Method not found');
        return;
      }
      sessionCounter++;
      reply({ sessionId: `scripted-${sessionCounter}` });
      return;
    }
    case 'session/set_mode': {
      reply(null);
      return;
    }
    case 'session/set_config_option': {
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              id: params.configId,
              name: params.configId,
              type: typeof params.value === 'boolean' ? 'boolean' : 'select',
              currentValue: params.value,
            },
          ],
        },
      });
      reply(null);
      return;
    }
    case 'providers/list': {
      if (caps.providers !== true) {
        replyError(-32601, 'Method not found');
        return;
      }
      reply({
        providers: [
          {
            providerId: 'main',
            supported: ['openai', 'anthropic'],
            required: true,
            current: { apiType: 'anthropic', baseUrl: 'https://api.example.test' },
          },
        ],
      });
      return;
    }
    case 'session/prompt': {
      void runPrompt(params, reply);
      return;
    }
    case 'session/cancel': {
      activePrompts.get(params.sessionId)?.();
      return; // notification, no reply
    }
    case 'session/close': {
      if (script.closeError === true) replyError(-32000, 'scripted close failure');
      else if (caps.close === false) replyError(-32601, 'Method not found');
      else reply(null);
      return;
    }
    default:
      if (id !== undefined) replyError(-32601, `Method not found: ${method}`);
  }
}
