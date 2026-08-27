/**
 * Scripted ACP agent fixture — a minimal ndjson JSON-RPC server on stdio,
 * used by core's functional tests (: "engines mocked with a
 * scripted ACP agent fixture").
 *
 * This file is internal and answers to these tests alone: add whatever toggle
 * the next case needs. Consumers get `@runskein/testkit`, which is a separate
 * copy with a documented, versioned env contract — deliberately not shared with
 * this one, so changing a fixture for an internal test cannot break a consumer
 * whose CI this repository never runs.
 *
 * Behaviour toggles (env):
 *   MOCK_EXIT_BEFORE_INIT=1     exit(3) immediately (spawn-failure path)
 *   MOCK_EXIT_BEFORE_INIT_AFTER=<n>  exit(3) before init once this fixture has
 *                               been started more than n times (counted from
 *                               MOCK_TRACE_FILE, so it spans process restarts).
 *                               Lets a session exist first and every later
 *                               spawn fail, which is what exhausts a
 *                               reactivation cap.
 *   MOCK_CRASH_AFTER_MS=<n>     exit(7) n ms after initialize (crash path)
 *   MOCK_CRASH_FLAG_FILE=<p>    crash only if <p> does not exist (crash once)
 *   MOCK_CRASH_ON_PROMPT=<n>    exit(7) while handling the nth prompt, so the
 *                               crash always lands mid-turn (honours the flag
 *                               file for crash-once)
 *   MOCK_NO_CLOSE=1             session/close answers -32601
 *   MOCK_DELETE=1               advertise/answer session/delete
 *   MOCK_NO_CONFIG=1            session/new reports no configOptions
 *   MOCK_MODELS=1               session/new advertises a `models` list
 *   MOCK_NO_SET_MODEL=1         session/set_model answers -32601
 *   MOCK_RECORD_SET_MODEL_FILE=<p>  append each session/set_model params
 *   MOCK_NO_MODES=1             session/new reports no modes
 *   MOCK_NO_FORK=1              do not advertise/answer session/fork
 *   MOCK_NO_RESUME=1            do not advertise/answer session/resume
 *   MOCK_NO_LOAD=1              loadSession=false; session/load answers -32601
 *   MOCK_ASK_PERMISSION=1       prompt round-trips session/request_permission
 *                               (tool_call update first; denied ⇒ tool_call_update failed)
 *   MOCK_ASK_QUESTION=1         prompt round-trips elicitation/create; the
 *                               accepted answer is echoed as a message chunk
 *   MOCK_Q_THEN_P=1             emit the question BEFORE the permission request
 *                               (issue-2 ordering regression; do not combine
 *                               with the two ASK_* toggles)
 *   MOCK_UNKNOWN_UPDATE=1       emit top-level and nested update variants absent
 *                               from the ACP schema (issue-1 regression)
 *   MOCK_EMIT_USAGE=1           emit usage_update (cumulative) before replying
 *   MOCK_USAGE_CURRENCY=<code>  currency for MOCK_EMIT_USAGE (default USD)
 *   MOCK_PROMPT_DELAY_MS=<n>    delay the prompt reply by n ms (cancel/FIFO)
 *   MOCK_PROMPT_ERROR=<text>    reject every prompt with the supplied RPC error text
 *   MOCK_ECHO_PROMPT=1          reply with the text prompt after the configured delay
 *   MOCK_NEW_DELAY_MS=<n>       delay the session/new reply by n ms (setup-class
 *                               timeout); the session is still created, so a
 *                               timed-out creation has something to clean up
 *   MOCK_NEW_DELAY_AFTER_FIRST=1 apply MOCK_NEW_DELAY_MS after the first
 *                               session/new in one fixture process
 *   MOCK_RECORD_NEW_FILE=<p>    append each received session/new params
 *   MOCK_RESUME_DELAY_MS=<n>    delay session/resume and session/load replies
 *   MOCK_PROMPT_DELAY_ONCE=1    apply MOCK_PROMPT_DELAY_MS to the FIRST prompt
 *                               only, so a later turn can be fast enough to
 *                               show it waited for the slot rather than for
 *                               the engine
 *   MOCK_NEVER_REPLY_PROMPT=1   accept session/prompt and never answer it at all
 *                               (the wedged engine: no reply, no error)
 *   MOCK_NEVER_REPLY_ONCE=1     restrict the above to the FIRST prompt, so a
 *                               later turn can show the session recovered
 *   MOCK_IGNORE_CANCEL=1        accept session/cancel but do not end the turn,
 *                               so a timed-out prompt's slot really does stay
 *                               occupied until the original reply arrives
 *   MOCK_REFUSE_ENV=<name>      refuse initialize if env var <name> is set
 *   MOCK_DUMP_ENV_FILE=<p>      write JSON of process.env at startup
 *   MOCK_TRACE_FILE=<p>         append one line per process start
 *   MOCK_STALL_INIT=1           never answer initialize (start-timeout path)
 *   MOCK_RECORD_INIT_FILE=<p>   write the received initialize params
 *   MOCK_RECORD_SET_CONFIG_FILE=<p> append each session/set_config_option request
 *   MOCK_CONFIG_FAIL_AFTER=<n>  session/set_config_option fails from the (n+1)th
 *                               request on, so a re-application after a
 *                               reactivation can be made to fail on demand.
 *                               Counted from MOCK_RECORD_SET_CONFIG_FILE when
 *                               set, so the budget spans process restarts.
 *   MOCK_CONFIG_DELAY_MS=<n>    delay set_config_option replies (CLI FIFO tests)
 *   MOCK_CONFIG_ERROR_ON_WRITE=<n> reject the nth config write as an auth failure
 *   MOCK_FORK_DELAY_MS=<n>      delay session/fork replies (CLI FIFO tests)
 *   MOCK_INTERACTION_DELAY_MS=<n> delay permission/question requests after prompt starts
 *   MOCK_EXPECT_SYSTEM_INSTRUCTIONS=<s> require the exact session/new _meta value
 *   MOCK_EARLY_UPDATE=1         notify before the session/new response
 *   MOCK_EARLY_FORK_UPDATE=1    notify before the session/fork response
 *   MOCK_FAIL_FIRST_NEW_AFTER_EARLY=1 fail once after an early update
 *   MOCK_CLOSE_ERROR=1          advertise close but fail the request
 *   MOCK_DELETE_ERROR=1         advertise delete but fail the request
 *   MOCK_RECORD_DELETE_FILE=<p> append each session/delete params
 *   MOCK_STUBBORN_CHILD_PID_FILE=<p> spawn a SIGTERM-ignoring descendant
 *   MOCK_MULTI_CONFIG=1         session/new reports options across every
 *                               config category (model/thought_level/model_config/mode)
 *   MOCK_MCP_NONCE=<n>          prompt calls the session's first http MCP server
 *                               at <url>/echo_nonce?nonce=<n> and reports the result
 *   MOCK_NO_MCP_HTTP=1          initialize advertises mcpCapabilities.http=false
 *   MOCK_RECORD_PROMPT_FILE=<p> append each session/prompt.params.prompt
 *   MOCK_TERMINAL_CONTENT=1     emit a tool_call whose content is a terminal block
 *   MOCK_THOUGHT=1              emit an agent_thought_chunk before the reply
 *   MOCK_PLAN=1                 emit plan + plan_update + plan_removed
 *   MOCK_TOOL_DIFF=1            emit a tool_call whose content is a diff
 *   MOCK_AVAILABLE_COMMANDS=1   emit available_commands_update before the reply
 *   MOCK_LONG_TURN=1            emit 12 agent_message_chunks (PV-11)
 *   MOCK_PUSH_MODE=<id>         emit an unsolicited current_mode_update naming
 *                               <id> during a prompt (engine-initiated change)
 *   MOCK_RESUME_STATE=1         session/resume and session/load reply with modes +
 *                               configOptions state instead of an empty object
 *   MOCK_LOAD_STATE=1           session/load replies with modes + configOptions
 *                               state instead of an empty object (when resume is
 *                               unavailable)
 *   MOCK_QUOTA_JSON=<json>      attach <json> as the prompt response's
 *                               _meta.quota (engine-reported quota blob)
 *   MOCK_EMPTY_META=1           prompt response carries _meta:{} (a reporting
 *                               engine that reports no quota)
 *   MOCK_USAGE_PLAN=<json>      JSON array indexed by prompt ordinal (element 0
 *                               = first prompt of this fixture process): each
 *                               element is an ARRAY of raw usage_update payload
 *                               objects emitted in order before that prompt's
 *                               reply, so one turn can carry several reports.
 *                               Payloads go on the wire verbatim (e.g.
 *                               {"inputTokens":100} or a codex-shaped object).
 *                               An absent element emits no usage update.
 *   MOCK_PROMPT_META_PLAN=<json> JSON array indexed by prompt ordinal: element i
 *                               is the raw _meta object attached verbatim to
 *                               that prompt response; null or absent attaches
 *                               no _meta at all. Drives prompt_response_meta
 *                               resolution independently of MOCK_QUOTA_JSON,
 *                               which keeps precedence when both are set.
 *   MOCK_TERMINAL_RUN=<json>    during a prompt, run a command through the client's
 *                               terminal/* methods and report what came back.
 *                               <json> is {command, args?, env?, cwd?}; the result is
 *                               emitted as a tool_call_update rawOutput so a
 *                               test can assert on it
 *   MOCK_TERMINAL_KILL=1        with the above, wait for first output, then kill
 *                               the command and read what it printed
 *   MOCK_TERMINAL_LEAVE=1       with the above, create the terminal and leave it
 *                               running — never wait, never release (used to
 *                               prove the session cleans up after the agent)
 *   MOCK_REFUSAL=1              reply stopReason 'refusal'
 *   MOCK_MAX_TOKENS=1           reply stopReason 'max_tokens'
 */
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

if (process.env.MOCK_EXIT_BEFORE_INIT) process.exit(3);

const envDumpFile = process.env.MOCK_DUMP_ENV_FILE;
if (envDumpFile) writeFileSync(envDumpFile, JSON.stringify(process.env, null, 2));

const traceFile = process.env.MOCK_TRACE_FILE;
if (traceFile) appendFileSync(traceFile, 'spawn\n');

// Spawn-failure after the first N starts. The counter lives in the trace file
// because each start is a fresh process: in-memory state cannot span restarts.
const exitAfter = Number(process.env.MOCK_EXIT_BEFORE_INIT_AFTER ?? 0);
if (exitAfter && traceFile) {
  const starts = readFileSync(traceFile, 'utf8')
    .split('\n')
    .filter((line) => line === 'spawn').length;
  if (starts > exitAfter) process.exit(3);
}

const cwdTraceFile = process.env.MOCK_CWD_TRACE_FILE;
if (cwdTraceFile) appendFileSync(cwdTraceFile, `${process.cwd()}\n`);

const stubbornChildPidFile = process.env.MOCK_STUBBORN_CHILD_PID_FILE;
if (stubbornChildPidFile) {
  const stubborn = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { stdio: 'ignore' },
  );
  writeFileSync(stubbornChildPidFile, String(stubborn.pid));
}

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

let nextId = 1000;
const pendingByRequestId = new Map();

function request(method, params) {
  return new Promise((res, rej) => {
    const id = nextId++;
    // Both halves: a client that refuses a request answers with an error, and
    // a fixture that quietly resolved undefined would hide exactly the case
    // the terminal tests are about.
    pendingByRequestId.set(id, { res, rej });
    send({ id, method, params });
  });
}

function notify(method, params) {
  send({ method, params });
}

/**
 * Crash deterministically while a turn is in flight.
 *
 * A timed crash is measured from initialize, so whether it lands during a
 * prompt depends on how long setup took — which makes any test built on it
 * racy. Counting prompts instead pins the crash to the turn under test.
 */
function crashOnPromptIfDue(turn) {
  const due = Number(process.env.MOCK_CRASH_ON_PROMPT ?? 0);
  if (!due || turn !== due) return;
  const flag = process.env.MOCK_CRASH_FLAG_FILE;
  if (flag) {
    if (existsSync(flag)) return; // already crashed once
    writeFileSync(flag, 'crashed');
  }
  process.exit(7);
}

function scheduleCrash() {
  const ms = Number(process.env.MOCK_CRASH_AFTER_MS ?? 0);
  if (!ms) return;
  const flag = process.env.MOCK_CRASH_FLAG_FILE;
  if (flag) {
    if (existsSync(flag)) return; // already crashed once
    writeFileSync(flag, 'crashed');
  }
  setTimeout(() => process.exit(7), ms);
}

// ── session state ──────────────────────────────────────────────────────────

let sessionCounter = 0;
let promptCounter = 0;
let configWriteCount = 0;
/** Model the session currently runs on; session/set_model rewrites it. */
let currentModelId = 'fast';
/** Accepted session/set_config_option writes, for MOCK_CONFIG_FAIL_AFTER. */
let configWrites = 0;
let usageTotal = 0;
let failedFirstNew = false;
/** sessionId → cancel fn for the in-flight prompt. */
const activePrompts = new Map();
/** sessionId → mcpServers passed in session/new (SL-13). */
const sessionMcps = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modelConfigOptions(currentValue = 'm1') {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        { value: 'm1', name: 'Model One' },
        { value: 'm2', name: 'Model Two' },
      ],
    },
  ];
}

/** Config state a resume/load echoes back, for engines that report one. */
function restoredSessionState() {
  return {
    modes: {
      currentModeId: 'plan',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    configOptions: modelConfigOptions('m2'),
  };
}

function multiConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'm1',
      options: [
        { value: 'm1', name: 'Model One' },
        { value: 'm2', name: 'Model Two' },
      ],
    },
    {
      id: 'reasoning',
      name: 'Reasoning',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    },
    {
      id: 'fast-mode',
      name: 'Fast mode',
      category: 'model_config',
      type: 'boolean',
      currentValue: false,
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }],
    },
  ];
}

/** The config-option state emitted after a set_config_option (CF-09). */
function optionStateAfter(optionId, value) {
  if (optionId === 'model') return modelConfigOptions(value);
  if (optionId === 'thought_level' || optionId === 'reasoning')
    return [
      {
        id: 'reasoning',
        name: 'Reasoning',
        category: 'thought_level',
        type: 'select',
        currentValue: value,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
          { value: 'max', name: 'Max' },
        ],
      },
    ];
  if (optionId === 'fast-mode')
    return [
      {
        id: 'fast-mode',
        name: 'Fast mode',
        category: 'model_config',
        type: 'boolean',
        currentValue: value,
      },
    ];
  return [];
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  // A rejected agent→client request must not take the fixture down with it.
  // The client legitimately answers with an error — a closing connection
  // rejects whatever was in flight — and an unhandled rejection here would
  // kill this process, which every live session then sees as an engine crash.
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(`mock-agent: ${String(error?.message ?? error)}\n`);
  });
});
process.stdin.on('end', () => process.exit(0));

async function handle(msg) {
  // Response to one of our own agent→client requests.
  if (msg.id !== undefined && msg.method === undefined) {
    const pending = pendingByRequestId.get(msg.id);
    pendingByRequestId.delete(msg.id);
    if (msg.error) pending?.rej(new Error(msg.error.message ?? 'request failed'));
    else pending?.res(msg.result);
    return;
  }
  const { id, method, params } = msg;
  const reply = (result) => send({ id, result });
  const replyError = (code, message) => send({ id, error: { code, message } });

  switch (method) {
    case 'initialize': {
      const recordInit = process.env.MOCK_RECORD_INIT_FILE;
      if (recordInit) writeFileSync(recordInit, JSON.stringify({ method, params }));
      if (process.env.MOCK_STALL_INIT) return; // never answer → start-timeout path
      const refuseVar = process.env.MOCK_REFUSE_ENV;
      if (refuseVar && process.env[refuseVar] !== undefined) {
        replyError(-32000, `refusing to start: ${refuseVar} is set (active session)`);
        return;
      }
      reply({
        protocolVersion: 1,
        agentInfo: { name: 'mock-agent', version: '1.0.0' },
        agentCapabilities: {
          loadSession: !process.env.MOCK_NO_LOAD,
          sessionCapabilities: {
            ...(process.env.MOCK_NO_RESUME ? {} : { resume: true }),
            list: true,
            ...(process.env.MOCK_NO_FORK ? {} : { fork: true }),
            ...(process.env.MOCK_NO_CLOSE ? {} : { close: true }),
            ...(process.env.MOCK_DELETE ? { delete: true } : {}),
          },
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: !process.env.MOCK_NO_MCP_HTTP, sse: false },
          ...(process.env.MOCK_PROVIDERS ? { providers: {} } : {}),
        },
      });
      scheduleCrash();
      return;
    }
    case 'session/new': {
      if (process.env.MOCK_RECORD_NEW_FILE) {
        appendFileSync(process.env.MOCK_RECORD_NEW_FILE, JSON.stringify(params) + '\n');
      }
      const newDelay = Number(process.env.MOCK_NEW_DELAY_MS ?? 0);
      if (newDelay && (!process.env.MOCK_NEW_DELAY_AFTER_FIRST || sessionCounter > 0))
        await sleep(newDelay);
      // The ACP schema makes mcpServers required on session/new, and codex
      // enforces it: a request without the key comes back -32602 "Required
      // value is missing". Tolerating it here let runskein's rebuilt resume tier
      // ship a request no strict engine accepts, and no hermetic case noticed.
      if (!Array.isArray(params?.mcpServers)) {
        return replyError(-32602, 'Invalid params: mcpServers Required value is missing');
      }
      sessionCounter++;
      const sessionId = `mock-session-${sessionCounter}`;
      sessionMcps.set(sessionId, params.mcpServers);
      const expectedInstructions = process.env.MOCK_EXPECT_SYSTEM_INSTRUCTIONS;
      if (
        expectedInstructions !== undefined &&
        params?._meta?.['runskein.dev/systemInstructions'] !== expectedInstructions
      ) {
        replyError(-32602, 'missing or incorrect runskein.dev/systemInstructions');
        return;
      }
      if (process.env.MOCK_EARLY_UPDATE) {
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'session_info_update', title: 'early-title' },
        });
      }
      if (process.env.MOCK_FAIL_FIRST_NEW_AFTER_EARLY && !failedFirstNew) {
        failedFirstNew = true;
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'session_info_update', title: 'failed-early-title' },
        });
        sessionCounter--;
        replyError(-32000, 'first session/new failed after early update');
        return;
      }
      reply({
        sessionId,
        ...(process.env.MOCK_NO_MODES
          ? {}
          : {
              modes: {
                currentModeId: 'default',
                availableModes: [
                  { id: 'default', name: 'Default' },
                  { id: 'plan', name: 'Plan', description: 'plan first' },
                ],
              },
            }),
        configOptions: process.env.MOCK_NO_CONFIG
          ? []
          : process.env.MOCK_MULTI_CONFIG
            ? multiConfigOptions()
            : modelConfigOptions(),
        ...(process.env.MOCK_MODELS
          ? {
              models: {
                currentModelId,
                availableModels: [
                  { modelId: 'fast', name: 'Fast', description: 'quick replies' },
                  { modelId: 'deep', name: 'Deep' },
                ],
              },
            }
          : {}),
      });
      return;
    }
    case 'session/set_model': {
      if (process.env.MOCK_NO_SET_MODEL) {
        replyError(-32601, 'Method not found');
        return;
      }
      currentModelId = params.modelId;
      if (process.env.MOCK_RECORD_SET_MODEL_FILE) {
        appendFileSync(process.env.MOCK_RECORD_SET_MODEL_FILE, JSON.stringify(params) + '\n');
      }
      reply({});
      return;
    }
    case 'session/resume': {
      if (process.env.MOCK_NO_RESUME) {
        replyError(-32601, 'Method not found');
        return;
      }
      const resumeDelay = Number(process.env.MOCK_RESUME_DELAY_MS ?? 0);
      if (resumeDelay) await sleep(resumeDelay);
      // Native continuation: accept the prior engine-side id as-is. Engines
      // differ on whether resume echoes current config state; the knob covers
      // the reporting ones without changing the silent default.
      if (process.env.MOCK_RESUME_STATE) {
        reply(restoredSessionState());
        return;
      }
      reply({});
      return;
    }
    case 'session/load': {
      if (process.env.MOCK_NO_LOAD) {
        replyError(-32601, 'Method not found');
        return;
      }
      const resumeDelay = Number(process.env.MOCK_RESUME_DELAY_MS ?? 0);
      if (resumeDelay) await sleep(resumeDelay);
      // History replay: stream a couple of updates BEFORE the response.
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
      // Engines differ on whether a load reply echoes current config state;
      // the two knobs cover both native continuation and load-only engines.
      if (process.env.MOCK_RESUME_STATE || process.env.MOCK_LOAD_STATE) {
        reply(restoredSessionState());
        return;
      }
      reply({});
      return;
    }
    case 'session/fork': {
      if (process.env.MOCK_NO_FORK) {
        replyError(-32601, 'Method not found');
        return;
      }
      if (typeof params.cwd !== 'string' || !params.cwd.startsWith('/')) {
        replyError(-32602, 'session/fork requires an absolute cwd');
        return;
      }
      sessionCounter++;
      const sessionId = `mock-session-${sessionCounter}`;
      const forkDelay = Number(process.env.MOCK_FORK_DELAY_MS ?? 0);
      if (forkDelay) await sleep(forkDelay);
      if (process.env.MOCK_EARLY_FORK_UPDATE) {
        notify('session/update', {
          sessionId,
          update: { sessionUpdate: 'session_info_update', title: 'early-fork-title' },
        });
      }
      reply({ sessionId });
      return;
    }
    case 'session/set_mode': {
      if (params.modeId === 'default' || params.modeId === 'plan') reply(null);
      else replyError(-32602, `unknown mode '${params.modeId}'`);
      return;
    }
    case 'session/set_config_option': {
      configWriteCount++;
      if (configWriteCount === Number(process.env.MOCK_CONFIG_ERROR_ON_WRITE ?? 0)) {
        replyError(-32000, 'Authentication required');
        return;
      }
      const recordCfg = process.env.MOCK_RECORD_SET_CONFIG_FILE;
      if (recordCfg) {
        appendFileSync(
          recordCfg,
          JSON.stringify({
            sessionId: params.sessionId,
            configId: params.configId,
            value: params.value,
          }) + '\n',
        );
      }
      const valid = {
        model: (v) => v === 'm1' || v === 'm2',
        // MOCK_MULTI_CONFIG advertises this option under the id 'reasoning'
        // (category thought_level); accept both spellings for older callers.
        reasoning: (v) => v === 'low' || v === 'high' || v === 'max',
        thought_level: (v) => v === 'low' || v === 'high' || v === 'max',
        'fast-mode': (v) => v === true || v === 'true' || v === false || v === 'false',
      };
      const failAfter = Number(process.env.MOCK_CONFIG_FAIL_AFTER ?? 0);
      if (failAfter) {
        // Counted from the record file when one is set, so the budget spans
        // process restarts: a re-application after a reactivation runs in a
        // fresh process, where an in-memory counter would start over and the
        // write would wrongly succeed.
        configWrites = recordCfg
          ? readFileSync(recordCfg, 'utf8').split('\n').filter(Boolean).length
          : configWrites + 1;
        if (configWrites > failAfter) {
          replyError(-32000, 'config option write refused');
          return;
        }
      }
      const accept = valid[params.configId];
      if (accept && accept(params.value)) {
        const configDelay = Number(process.env.MOCK_CONFIG_DELAY_MS ?? 0);
        if (configDelay) await sleep(configDelay);
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'config_option_update',
            configOptions: optionStateAfter(params.configId, params.value),
          },
        });
        reply(null);
      } else {
        replyError(-32602, `unknown config option '${params.configId}'='${params.value}'`);
      }
      return;
    }
    case 'providers/list': {
      if (!process.env.MOCK_PROVIDERS) {
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
      const turn = ++promptCounter;
      // No reply, ever: the request stays outstanding on the wire so a caller
      // can observe what happens when nothing settles.
      if (process.env.MOCK_NEVER_REPLY_PROMPT && !(process.env.MOCK_NEVER_REPLY_ONCE && turn > 1)) {
        return;
      }
      const chunk = (text) =>
        notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        });
      const echoText = process.env.MOCK_ECHO_PROMPT
        ? Array.isArray(params.prompt)
          ? params.prompt
              .filter((block) => block?.type === 'text')
              .map((block) => block.text ?? '')
              .join('')
          : ''
        : undefined;

      let cancelled = false;
      let wake;
      activePrompts.set(params.sessionId, () => {
        cancelled = true;
        wake?.();
      });

      const promptError = process.env.MOCK_PROMPT_ERROR;
      if (promptError) {
        activePrompts.delete(params.sessionId);
        replyError(-32000, promptError);
        return;
      }

      if (echoText === undefined) chunk(`OK${turn}`);

      const recordPrompt = process.env.MOCK_RECORD_PROMPT_FILE;
      if (recordPrompt) {
        appendFileSync(recordPrompt, JSON.stringify(params.prompt) + '\n');
      }

      // After recording, so the wire record shows what the engine actually
      // received before dying — which is what tells a replay apart from a
      // first delivery.
      crashOnPromptIfDue(turn);

      if (process.env.MOCK_TERMINAL_CONTENT && !cancelled) {
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `term-${turn}`,
            title: 'run-in-terminal',
            kind: 'execute',
            status: 'in_progress',
            content: [{ type: 'terminal', terminalId: 'term-1' }],
          },
        });
      }

      if (process.env.MOCK_THOUGHT && !cancelled) {
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'pondering…' },
          },
        });
      }

      if (process.env.MOCK_PLAN && !cancelled) {
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'plan',
            entries: [{ content: 'step one', priority: 'high', status: 'pending' }],
          },
        });
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'plan_update',
            plan: { type: 'file', planId: 'plan-1', uri: 'file:///plan.md' },
          },
        });
        notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'plan_removed', planId: 'plan-1' },
        });
      }

      if (process.env.MOCK_TOOL_DIFF && !cancelled) {
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `diff-${turn}`,
            title: 'edit-file',
            kind: 'edit',
            status: 'completed',
            content: [{ type: 'diff', path: '/tmp/x.txt', oldText: 'old', newText: 'new' }],
          },
        });
      }

      if (process.env.MOCK_AVAILABLE_COMMANDS && !cancelled) {
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'run', description: 'run a command' }],
          },
        });
      }

      if (process.env.MOCK_LONG_TURN && !cancelled) {
        for (let i = 1; i <= 12; i++) chunk(`chunk${i}`);
      }

      if (process.env.MOCK_MCP_NONCE) {
        const servers = sessionMcps.get(params.sessionId) ?? [];
        const httpServer = servers.find((m) => m.type === 'http' && m.url);
        if (httpServer && !cancelled) {
          const nonce = process.env.MOCK_MCP_NONCE;
          const url = `${httpServer.url}/echo_nonce?nonce=${nonce}`;
          notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: `mcp-${turn}`,
              title: 'call_echo_nonce',
              kind: 'fetch',
              status: 'in_progress',
            },
          });
          let text = '';
          try {
            const res = await fetch(url);
            text = await res.text();
          } catch (e) {
            text = `mcp-error:${e.message}`;
          }
          notify('session/update', {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: `mcp-${turn}`,
              status: 'completed',
              rawOutput: text,
            },
          });
          chunk(`mcp-result:${text}`);
        }
      }

      if (process.env.MOCK_UNKNOWN_UPDATE && !cancelled) {
        // Variants absent from the SDK schema must still reach core intact.
        notify('session/update', {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'totally_unknown_kind', foo: 'bar' },
        });
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `future-${turn}`,
            content: [{ type: 'future_content', payload: { value: 1 } }],
          },
        });
      }

      const askPermission = async () => {
        const interactionDelay = Number(process.env.MOCK_INTERACTION_DELAY_MS ?? 0);
        if (interactionDelay) await sleep(interactionDelay);
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `tool-${turn}`,
            title: 'write-file',
            kind: 'edit',
            status: 'pending',
            locations: [{ path: '/tmp/root.txt' }],
          },
        });
        const res = await request('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: `tool-${turn}`,
            title: 'write-file',
            kind: 'edit',
            rawInput: { path: '/tmp/root.txt' },
            locations: [{ path: '/tmp/root.txt' }],
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
            toolCallId: `tool-${turn}`,
            status: denied ? 'failed' : 'completed',
          },
        });
      };

      const askQuestion = async () => {
        const interactionDelay = Number(process.env.MOCK_INTERACTION_DELAY_MS ?? 0);
        if (interactionDelay) await sleep(interactionDelay);
        const res = await request('elicitation/create', {
          sessionId: params.sessionId,
          message: 'Which flavor?',
          mode: 'form',
          requestedSchema: {
            type: 'object',
            properties: { flavor: { type: 'string', enum: ['vanilla', 'chocolate'] } },
          },
        });
        const flavor = res?.content?.flavor ?? `(${res?.action ?? 'no answer'})`;
        chunk(`answer:${flavor}`);
      };

      const runTerminal = process.env.MOCK_TERMINAL_RUN;
      if (runTerminal && !cancelled) {
        const spec = JSON.parse(runTerminal);
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: `term-run-${turn}`,
            title: 'run-command',
            kind: 'execute',
            status: 'in_progress',
          },
        });
        let report;
        try {
          const created = await request('terminal/create', {
            sessionId: params.sessionId,
            command: spec.command,
            ...(spec.args ? { args: spec.args } : {}),
            ...(spec.env ? { env: spec.env } : {}),
            ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
            ...(spec.outputByteLimit ? { outputByteLimit: spec.outputByteLimit } : {}),
          });
          const terminalId = created?.terminalId;
          if (terminalId === undefined) {
            report = { error: 'terminal/create returned no terminalId', raw: created };
          } else {
            if (process.env.MOCK_TERMINAL_LEAVE) {
              // Deliberately no wait, no release: the session must clean up
              // after an agent that walks away from what it started.
              report = { terminalId, left: true };
            } else if (process.env.MOCK_TERMINAL_KILL) {
              // Kill only once the command has actually produced something,
              // otherwise the test races the child's first write.
              let seen = '';
              for (let i = 0; i < 100 && seen === ''; i++) {
                const poll = await request('terminal/output', { sessionId: params.sessionId, terminalId });
                seen = poll?.output ?? '';
                if (seen === '') await sleep(20);
              }
              await request('terminal/kill', { sessionId: params.sessionId, terminalId });
              const out = await request('terminal/output', { sessionId: params.sessionId, terminalId });
              report = { terminalId, ...out };
              await request('terminal/release', { sessionId: params.sessionId, terminalId });
            } else {
              await request('terminal/wait_for_exit', { sessionId: params.sessionId, terminalId });
              const out = await request('terminal/output', { sessionId: params.sessionId, terminalId });
              report = { terminalId, ...out };
              await request('terminal/release', { sessionId: params.sessionId, terminalId });
            }
          }
        } catch (e) {
          // The client refused: an engine sees an error, which is exactly what
          // a denied permission or an escaping cwd must look like from here.
          report = { error: String(e?.message ?? e) };
        }
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: `term-run-${turn}`,
            status: report.error ? 'failed' : 'completed',
            rawOutput: report,
          },
        });
      }

      if (process.env.MOCK_ASK_PERMISSION && !cancelled) await askPermission();
      if (process.env.MOCK_ASK_QUESTION && !cancelled) await askQuestion();
      // Start both waits without serializing responses; the wire order remains
      // question then permission and the client must preserve that order.
      if (process.env.MOCK_Q_THEN_P && !cancelled) {
        const question = askQuestion();
        const permission = askPermission();
        await Promise.all([question, permission]);
      }

      const delayOnce = process.env.MOCK_PROMPT_DELAY_ONCE;
      const delay = delayOnce && turn > 1 ? 0 : Number(process.env.MOCK_PROMPT_DELAY_MS ?? 0);
      if (delay && !cancelled) {
        await Promise.race([sleep(delay), new Promise((r) => (wake = r))]);
      }

      // Delaying the echoed reply makes concurrent sessions overlap on the
      // same process, so the routing assertion exercises interleaved traffic.
      if (echoText !== undefined && !cancelled) chunk(echoText || `OK${turn}`);

      if (process.env.MOCK_PUSH_MODE) {
        // Engine decides on its own that the session is now in another mode;
        // nothing on the host asked for this.
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: process.env.MOCK_PUSH_MODE,
          },
        });
      }

      if (process.env.MOCK_EMIT_USAGE) {
        // ACP v1 stable shape: {used, size, cost} — no token breakdown.
        usageTotal += 10;
        notify('session/update', {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'usage_update',
            used: usageTotal * 100,
            size: 1_000_000,
            cost: {
              amount: usageTotal / 1000,
              currency: process.env.MOCK_USAGE_CURRENCY ?? 'USD',
            },
          },
        });
      }

      const usagePlan = process.env.MOCK_USAGE_PLAN ? JSON.parse(process.env.MOCK_USAGE_PLAN) : undefined;
      if (usagePlan && !cancelled) {
        const reports = usagePlan[turn - 1];
        if (Array.isArray(reports)) {
          for (const payload of reports) {
            notify('session/update', {
              sessionId: params.sessionId,
              update: { sessionUpdate: 'usage_update', ...payload },
            });
          }
        }
      }

      let stopReason = cancelled ? 'cancelled' : 'end_turn';
      if (!cancelled && process.env.MOCK_REFUSAL) stopReason = 'refusal';
      if (!cancelled && process.env.MOCK_MAX_TOKENS) stopReason = 'max_tokens';

      activePrompts.delete(params.sessionId);
      // Engines that report quota do it in the prompt response's _meta; an
      // empty _meta is a distinct case (reporting engine, nothing to report).
      let responseMeta;
      const quotaJson = process.env.MOCK_QUOTA_JSON;
      if (quotaJson) {
        responseMeta = { quota: JSON.parse(quotaJson) };
      } else if (process.env.MOCK_EMPTY_META) {
        responseMeta = {};
      } else {
        const metaPlan = process.env.MOCK_PROMPT_META_PLAN
          ? JSON.parse(process.env.MOCK_PROMPT_META_PLAN)
          : undefined;
        const planned = metaPlan?.[turn - 1];
        if (planned !== undefined && planned !== null) responseMeta = planned;
      }
      reply(responseMeta !== undefined ? { stopReason, _meta: responseMeta } : { stopReason });
      return;
    }
    case 'session/cancel':
      // An engine that acknowledges the cancellation but keeps working is the
      // case the late-settlement contract exists for: the caller is already
      // rejected, and the FIFO slot must stay occupied until the ORIGINAL
      // reply lands rather than until the cancel is sent.
      if (!process.env.MOCK_IGNORE_CANCEL) activePrompts.get(params.sessionId)?.();
      return; // notification, no reply
    case 'session/close':
      if (process.env.MOCK_NO_CLOSE) replyError(-32601, 'Method not found');
      else if (process.env.MOCK_CLOSE_ERROR) replyError(-32000, 'close exploded');
      else reply(null);
      return;
    case 'session/delete':
      if (!process.env.MOCK_DELETE) replyError(-32601, 'Method not found');
      else {
        if (process.env.MOCK_RECORD_DELETE_FILE) {
          appendFileSync(process.env.MOCK_RECORD_DELETE_FILE, JSON.stringify(params) + '\n');
        }
        if (process.env.MOCK_DELETE_ERROR) replyError(-32000, 'delete exploded');
        else reply(null);
      }
      return;
    default:
      if (id !== undefined) replyError(-32601, `Method not found: ${method}`);
  }
}
