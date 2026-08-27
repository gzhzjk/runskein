#!/usr/bin/env node
/**
 * A scripted ACP agent, for consumers who need to drive runskein end to end
 * without an engine, credentials, network, or model tokens.
 *
 * It is a JSON-RPC server on stdio that answers runskein's requests and emits the
 * session updates its configuration asks for. Everything it does is controlled
 * by `RUNSKEIN_TESTKIT_*` environment variables, listed below; that env contract
 * is this package's public surface and changes with its version.
 *
 * This file is a deliberate sibling of core's own test fixture, not a shared
 * module. The fixture answers to runskein's internal tests and carries whatever
 * toggles those tests need next; this one answers to consumers and changes only
 * when its documented contract does. One file serving both would eventually be
 * changed for one audience and break the other.
 *
 * Supported configuration:
 *
 *   RUNSKEIN_TESTKIT_REPLY=<text>          reply text (default: `OK<turn number>`)
 *   RUNSKEIN_TESTKIT_ECHO_PROMPT=1         reply with the prompt's own text
 *   RUNSKEIN_TESTKIT_PROMPT_DELAY_MS=<n>   hold the turn open for n ms, so a
 *                                       caller can cancel or observe streaming
 *   RUNSKEIN_TESTKIT_THOUGHT=1             emit an agent_thought_chunk
 *   RUNSKEIN_TESTKIT_TOOL_CALL=1           emit a completed tool_call pair
 *   RUNSKEIN_TESTKIT_ASK_PERMISSION=1      request permission mid-turn; a denial
 *                                       marks the tool call failed
 *   RUNSKEIN_TESTKIT_ASK_QUESTION=1        ask one elicitation question and echo
 *                                       the answer back as a message chunk
 *   RUNSKEIN_TESTKIT_EMIT_USAGE=1          emit usage_update (used/size/cost)
 *   RUNSKEIN_TESTKIT_STOP_REASON=<reason>  end the turn with this stop reason
 *   RUNSKEIN_TESTKIT_PROMPT_ERROR=<text>   fail every prompt with this message
 *   RUNSKEIN_TESTKIT_CRASH_ON_PROMPT=<n>   exit(7) while handling the nth prompt
 *   RUNSKEIN_TESTKIT_REFUSE_ENV=<name>     refuse to initialize when <name> is set
 *   RUNSKEIN_TESTKIT_NO_RESUME=1           do not advertise or answer session/resume
 *   RUNSKEIN_TESTKIT_NO_LOAD=1             do not advertise or answer session/load
 *   RUNSKEIN_TESTKIT_NO_FORK=1             do not advertise or answer session/fork
 *   RUNSKEIN_TESTKIT_NO_CLOSE=1            do not advertise or answer session/close
 */
import { createInterface } from 'node:readline';

const env = (name) => process.env[`RUNSKEIN_TESTKIT_${name}`];

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

let nextRequestId = 1000;
const pending = new Map();

/** Send an agent→client request and resolve with its result. */
function request(method, params) {
  return new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
}

function notify(method, params) {
  send({ method, params });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sessionCounter = 0;
let promptCounter = 0;
let usageTotal = 0;
/** sessionId → cancel callback for the turn currently running on it. */
const activePrompts = new Map();

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  void handle(JSON.parse(line));
});
process.stdin.on('end', () => process.exit(0));

/**
 * Route one incoming JSON-RPC message.
 * @param message - the parsed frame.
 */
async function handle(message) {
  // A response to one of our own requests.
  if (message.id !== undefined && message.method === undefined) {
    pending.get(message.id)?.(message.result);
    pending.delete(message.id);
    return;
  }

  const { id, method, params } = message;
  const reply = (result) => send({ id, result });
  const replyError = (code, msg) => send({ id, error: { code, message: msg } });

  switch (method) {
    case 'initialize': {
      const refuseVar = env('REFUSE_ENV');
      if (refuseVar && process.env[refuseVar] !== undefined) {
        replyError(-32000, `refusing to start: ${refuseVar} is set`);
        return;
      }
      reply({
        protocolVersion: 1,
        agentInfo: { name: 'runskein-testkit-agent', version: '1' },
        agentCapabilities: {
          loadSession: !env('NO_LOAD'),
          sessionCapabilities: {
            ...(env('NO_RESUME') ? {} : { resume: true }),
            ...(env('NO_FORK') ? {} : { fork: true }),
            ...(env('NO_CLOSE') ? {} : { close: true }),
            list: true,
          },
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false },
        },
      });
      return;
    }

    case 'session/new': {
      sessionCounter++;
      reply({
        sessionId: `testkit-session-${sessionCounter}`,
        modes: {
          currentModeId: 'default',
          availableModes: [
            { id: 'default', name: 'Default' },
            { id: 'plan', name: 'Plan' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'fast',
            options: [
              { value: 'fast', name: 'Fast' },
              { value: 'deep', name: 'Deep' },
            ],
          },
        ],
      });
      return;
    }

    case 'session/resume': {
      if (env('NO_RESUME')) replyError(-32601, 'Method not found');
      else reply({});
      return;
    }

    case 'session/load': {
      if (env('NO_LOAD')) {
        replyError(-32601, 'Method not found');
        return;
      }
      // History replay: updates precede the response, which is what a client
      // rebuilding a transcript has to tolerate.
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text: 'replayed-question' },
        },
      });
      notify('session/update', {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'replayed-answer' },
        },
      });
      reply({});
      return;
    }

    case 'session/fork': {
      if (env('NO_FORK')) {
        replyError(-32601, 'Method not found');
        return;
      }
      sessionCounter++;
      reply({ sessionId: `testkit-session-${sessionCounter}` });
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
              category: 'model',
              type: 'select',
              currentValue: params.value,
              options: [
                { value: 'fast', name: 'Fast' },
                { value: 'deep', name: 'Deep' },
              ],
            },
          ],
        },
      });
      reply(null);
      return;
    }

    case 'session/set_mode': {
      notify('session/update', {
        sessionId: params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
      });
      reply(null);
      return;
    }

    case 'session/prompt': {
      await runTurn(params, reply, replyError);
      return;
    }

    case 'session/cancel':
      activePrompts.get(params.sessionId)?.();
      return; // notification: no reply

    case 'session/close':
      if (env('NO_CLOSE')) replyError(-32601, 'Method not found');
      else reply(null);
      return;

    default:
      if (id !== undefined) replyError(-32601, `Method not found: ${method}`);
  }
}

/**
 * Run one scripted turn: stream what the configuration asks for, then settle.
 * @param params - the session/prompt params.
 * @param reply - sends the prompt response.
 * @param replyError - fails the prompt request.
 */
async function runTurn(params, reply, replyError) {
  const turn = ++promptCounter;
  const chunk = (text) =>
    notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });

  const promptError = env('PROMPT_ERROR');
  if (promptError) {
    replyError(-32000, promptError);
    return;
  }

  let cancelled = false;
  let wake;
  activePrompts.set(params.sessionId, () => {
    cancelled = true;
    wake?.();
  });

  const crashOn = Number(env('CRASH_ON_PROMPT') ?? 0);
  if (crashOn === turn) process.exit(7);

  if (env('THOUGHT') && !cancelled) {
    notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } },
    });
  }

  if (env('TOOL_CALL') && !cancelled) {
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: `tool-${turn}`,
        title: 'write-file',
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: '/tmp/testkit.txt' }],
      },
    });
    notify('session/update', {
      sessionId: params.sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId: `tool-${turn}`, status: 'completed' },
    });
  }

  if (env('ASK_PERMISSION') && !cancelled) await askPermission(params, turn);
  if (env('ASK_QUESTION') && !cancelled) await askQuestion(params, chunk);

  // Streaming before the delay, so a caller that cancels mid-turn has already
  // seen output — which is the state cancellation has to be correct in.
  const text = env('ECHO_PROMPT') ? promptText(params.prompt) : (env('REPLY') ?? `OK${turn}`);
  const delay = Number(env('PROMPT_DELAY_MS') ?? 0);
  if (delay) {
    chunk(text);
    await Promise.race([sleep(delay), new Promise((resolve) => (wake = resolve))]);
  } else {
    chunk(text);
  }

  if (env('EMIT_USAGE')) {
    usageTotal += 10;
    // The protocol's usage update is a context-window gauge plus a cost.
    notify('session/update', {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: usageTotal * 100,
        size: 1_000_000,
        cost: { amount: usageTotal / 1000, currency: 'USD' },
      },
    });
  }

  activePrompts.delete(params.sessionId);
  reply({ stopReason: cancelled ? 'cancelled' : (env('STOP_REASON') ?? 'end_turn') });
}

/** The text blocks of a prompt, concatenated. */
function promptText(prompt) {
  return (Array.isArray(prompt) ? prompt : [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * Request permission for a scripted tool call and reflect the answer.
 * @param params - the session/prompt params.
 * @param turn - the turn number, used for the tool call id.
 */
async function askPermission(params, turn) {
  notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: `perm-${turn}`,
      title: 'write-file',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: '/tmp/testkit.txt' }],
    },
  });
  const res = await request('session/request_permission', {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId: `perm-${turn}`,
      title: 'write-file',
      kind: 'edit',
      rawInput: { path: '/tmp/testkit.txt' },
      locations: [{ path: '/tmp/testkit.txt' }],
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  const denied = !res || res.outcome?.outcome !== 'selected' || res.outcome.optionId === 'deny';
  notify('session/update', {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: `perm-${turn}`,
      status: denied ? 'failed' : 'completed',
    },
  });
}

/**
 * Ask one elicitation question and echo the answer into the message stream.
 * @param params - the session/prompt params.
 * @param chunk - emits an agent message chunk.
 */
async function askQuestion(params, chunk) {
  const res = await request('elicitation/create', {
    sessionId: params.sessionId,
    message: 'Which flavor?',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: { flavor: { type: 'string', enum: ['vanilla', 'chocolate'] } },
    },
  });
  chunk(`answer:${res?.content?.flavor ?? `(${res?.action ?? 'no answer'})`}`);
}
