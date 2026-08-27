/**
 * The chat REPL and its input state machine, at fixture level: basic turns,
 * the startup banner, queued prompts and actions, cancel semantics,
 * permission and question round-trips and their arrival ordering, :status,
 * :fork, --resume, unknown :-commands, EOF, and non-TTY operation.
 *
 * Test-plan cases: CH-01…16.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ChatDriver,
  check,
  noLingering,
  runCli,
  scratch,
  writeBrokenAdapter,
  writeMockAdapter,
  writeScriptedAdapter,
} from './helpers.js';

export async function chatSuite(): Promise<void> {
  const fixtures = scratch('runskein-cli-fixtures-ch-');
  writeMockAdapter(fixtures, 'mock');
  writeMockAdapter(fixtures, 'mock-slow', { MOCK_PROMPT_DELAY_MS: '500' });
  writeMockAdapter(fixtures, 'mock-ask', { MOCK_ASK_PERMISSION: '1' });
  writeMockAdapter(fixtures, 'mock-ask-slow', {
    MOCK_ASK_PERMISSION: '1',
    MOCK_PROMPT_DELAY_MS: '800',
  });
  writeMockAdapter(fixtures, 'mock-question', { MOCK_ASK_QUESTION: '1' });
  writeMockAdapter(fixtures, 'mock-config-slow', { MOCK_CONFIG_DELAY_MS: '250' });
  writeMockAdapter(fixtures, 'mock-fork-slow', { MOCK_FORK_DELAY_MS: '250' });
  writeMockAdapter(fixtures, 'mock-nofork', { MOCK_NO_FORK: '1' });
  writeMockAdapter(fixtures, 'mock-racy-permission', {
    MOCK_ASK_PERMISSION: '1',
    MOCK_INTERACTION_DELAY_MS: '150',
  });
  writeMockAdapter(fixtures, 'mock-racy-question', {
    MOCK_ASK_QUESTION: '1',
    MOCK_INTERACTION_DELAY_MS: '150',
  });
  // CH-09: one turn sends a question and a permission request on the wire in
  // the same turn so both are pending at once; the REPL must answer them
  // strictly in the order they were delivered to the CLI (FIFO).
  writeScriptedAdapter(fixtures, 'scripted-dual-pending', {
    capabilities: {},
    onPrompt: [
      { chunk: 'start' },
      { question: { message: 'Q-first?', options: ['red', 'blue'] }, await: false },
      {
        permission: { toolCall: { toolCallId: 'dual-1', title: 'dual-tool', kind: 'edit' } },
        await: false,
      },
      { awaitAll: true },
      { chunk: 'both-answered' },
    ],
  });
  const forkLifecycleLog = join(scratch('runskein-cli-fork-log-'), 'wire.jsonl');
  writeScriptedAdapter(
    fixtures,
    'scripted-fork-lifecycle',
    { capabilities: { fork: true, close: true } },
    { SCRIPTED_AGENT_LOG_FILE: forkLifecycleLog },
  );
  writeScriptedAdapter(fixtures, 'scripted-backpressure', {
    capabilities: {},
    turns: [[{ delayMs: 150 }], []],
  });
  writeScriptedAdapter(fixtures, 'scripted-epipe-close-error', {
    capabilities: { close: true },
    closeError: true,
  });

  const newCwd = () => scratch('runskein-cli-cwd-ch-');

  // ── CH-01/02/10: basic turn, banner, :status, clean :quit ──────────────────
  {
    const chat = new ChatDriver('mock', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      await chat.waitFor('[hub] spawning mock ...');
      await chat.waitFor('[hub] ready');
      await chat.waitFor('[session] id=');
      check(
        'CH-02 startup banner before first prompt',
        /\[session\] id=\S+ engine=mock status=idle/.test(chat.stdout),
        chat.stdout,
      );
      chat.write('hello');
      await chat.waitFor('⟪agent⟫ OK1');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CH-01 turn streams agent chunk + TurnResult', true);
      check('CH-01 cumulative usage printed', chat.combined.includes('[usage] session'), chat.combined);
      chat.write(':status');
      await chat.waitFor('[status] session=');
      await chat.waitFor('  mock: ');
      check(
        'CH-10 :status prints session + engine health',
        / {2}mock: (ready|stopped)/.test(chat.combined),
        chat.combined,
      );
      chat.write(':quit');
      const code = await chat.exit();
      check('CH-01 clean :quit exits 0', code === 0, `${code}\n${chat.combined}`);
    } catch (e) {
      check('CH-01 chat basic turn', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
    check('no lingering engine process after exit (CL-01)', noLingering());
  }

  // ── CH-10: :status works mid-turn without disturbing it ────────────────────
  {
    const chat = new ChatDriver('mock-slow', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('go');
      await chat.waitFor('⟪agent⟫ OK1');
      chat.write(':status');
      await chat.waitFor('[status] session=running');
      await chat.waitFor('[turn] stopReason=end_turn');
      check(
        'CH-10 :status mid-turn reports running and the turn completes',
        chat.combined.indexOf('[status] session=running') <
          chat.combined.indexOf('[turn] stopReason=end_turn'),
        chat.combined,
      );
      chat.write(':quit');
      check('CH-10 mid-turn :status chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-10 :status mid-turn', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── CH-03: mid-turn plain lines queue FIFO ─────────────────────────────────
  {
    const chat = new ChatDriver('mock-slow', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('one');
      await chat.waitFor('⟪agent⟫ OK1'); // chunk arrives before the delay
      chat.write('two');
      await chat.waitFor('[queued] two');
      await chat.waitFor('⟪agent⟫ OK2');
      await chat.waitForCount('[turn] stopReason=end_turn', 2);
      check('CH-03 queued prompt submitted FIFO after the turn', true);
      chat.write(':quit');
      check('CH-03 slow chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-03 queued prompt', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── CH-04: :config / :fork queue mid-turn, execute at idle ─────────────────
  {
    const chat = new ChatDriver('mock-slow', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('go');
      await chat.waitFor('⟪agent⟫ OK1');
      chat.write(':config model=m2');
      await chat.waitFor('[queued] :config model=m2');
      await chat.waitFor('[turn] stopReason=end_turn');
      await chat.waitFor('[config] applied');
      check(
        'CH-04 :config queued mid-turn executes at idle',
        chat.combined.indexOf('[turn] stopReason=end_turn') < chat.combined.indexOf('[config] applied'),
        chat.combined,
      );
      chat.write('again');
      await chat.waitFor('⟪agent⟫ OK2');
      chat.write(':fork');
      await chat.waitFor('[queued] :fork');
      await chat.waitForCount('[turn] stopReason=end_turn', 2);
      await chat.waitFor('[fork] now on session');
      check(
        'CH-04 :fork queued mid-turn executes at idle',
        chat.combined.lastIndexOf('[turn] stopReason=end_turn') <
          chat.combined.indexOf('[fork] now on session'),
        chat.combined,
      );
      chat.write(':quit');
      check('CH-04 mid-turn queue chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-04 :config/:fork queue mid-turn', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── :config serializes a following prompt (existing FIFO guarantee) ────────
  {
    const chat = new ChatDriver('mock-config-slow', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write(':config model=m2');
      chat.write('after-config');
      await chat.waitFor('[config] applied');
      await chat.waitFor('⟪agent⟫ OK1');
      check(
        ':config serializes a following prompt',
        chat.combined.indexOf('[config] applied') < chat.combined.indexOf('⟪agent⟫ OK1'),
        chat.combined,
      );
      chat.write(':quit');
      check('config FIFO chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check(':config FIFO', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── :fork serializes a following prompt ────────────────────────────────────
  {
    const chat = new ChatDriver('mock-fork-slow', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write(':fork');
      chat.write('after-fork');
      await chat.waitFor('[fork] now on session');
      await chat.waitFor('⟪agent⟫ OK1');
      check(
        ':fork serializes a following prompt',
        chat.combined.indexOf('[fork] now on session') < chat.combined.indexOf('⟪agent⟫ OK1'),
        chat.combined,
      );
      chat.write(':quit');
      check('fork FIFO chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check(':fork FIFO', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── CH-11: :fork success path and NotSupportedError path ───────────────────
  {
    const chat = new ChatDriver('mock', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('first');
      await chat.waitFor('[turn] stopReason=end_turn');
      chat.write(':fork');
      await chat.waitFor('[fork] now on session id=');
      const forked = /\[fork\] now on session id=(\S+)/.exec(chat.combined)?.[1];
      check(
        'CH-11 fork prints the new session id',
        forked !== undefined && forked.length > 0,
        chat.combined,
      );
      chat.write('second');
      await chat.waitForCount('[turn] stopReason=end_turn', 2);
      check('CH-11 prompts after :fork run on the fork', true);
      chat.write(':quit');
      check('CH-11 fork chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-11 :fork success', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  {
    const chat = new ChatDriver('scripted-fork-lifecycle', {
      adapterPaths: [fixtures],
      chatCwd: newCwd(),
    });
    try {
      await chat.waitFor('[session] id=');
      chat.write(':fork');
      await chat.waitForCount('[fork] now on session id=', 1);
      chat.write(':fork');
      await chat.waitForCount('[fork] now on session id=', 2);
      chat.write(':quit');
      check('consecutive fork chat exits 0', (await chat.exit()) === 0, chat.combined);
      const log = readFileSync(forkLifecycleLog, 'utf8');
      const closed = [...log.matchAll(/<< .*"method":"session\/close".*"sessionId":"([^"]+)"/g)].map(
        (match) => match[1],
      );
      check(
        'each superseded/current fork session closes exactly once',
        closed.length === 3 && new Set(closed).size === 3,
        log,
      );
    } catch (e) {
      check('consecutive fork releases parent sessions', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  {
    const chat = new ChatDriver('mock-nofork', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      await chat.waitFor('[session] id=');
      chat.write(':fork');
      await chat.waitFor('[error] NotSupportedError');
      check(
        'CH-11 :fork without capability → NotSupportedError via formatter',
        chat.stderr.includes('[error] NotSupportedError') && chat.stderr.includes('fork'),
        chat.stderr,
      );
      chat.write('still-alive');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CH-11 REPL survives a failed :fork', true);
      chat.write(':quit');
      // The recorded typed failure makes the exit code 1 ( aggregation).
      check('CH-11 failed :fork exits 1 after :quit', (await chat.exit()) === 1);
    } catch (e) {
      check('CH-11 :fork unsupported', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── CH-07: --permission ask round-trip ─────────────────────────────────────
  {
    const chat = new ChatDriver('mock-ask', {
      adapterPaths: [fixtures],
      chatCwd: newCwd(),
      extra: ['--permission', 'ask'],
    });
    try {
      chat.write('go');
      await chat.waitFor('pick <number|optionId>:');
      check(
        'CH-07 permission request printed with options',
        chat.combined.includes('1) allow'),
        chat.combined,
      );
      chat.write('9'); // invalid pick reprints the options
      await chat.waitFor('invalid pick');
      await chat.waitForCount('pick <number|optionId>:', 2);
      check('CH-07 invalid pick reprints options', true);
      chat.write('1');
      await chat.waitFor('[permission] → allow');
      // tool_call_update merged into the tool_call row; delta field marked.
      await chat.waitFor('status→completed');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CH-07 interactive permission resolved, turn completed', true);
      chat.write(':quit');
      check('CH-07 ask chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-07 permission ask', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── CH-06: :cancel settles a pending permission, turn ends cancelled ───────
  {
    const chat = new ChatDriver('mock-ask-slow', {
      adapterPaths: [fixtures],
      chatCwd: newCwd(),
      extra: ['--permission', 'ask'],
    });
    try {
      chat.write('go');
      await chat.waitFor('pick <number|optionId>:');
      chat.write(':cancel');
      // The policy is settled with the offered reject optionId → the fixture
      // marks the tool call failed; the turn itself resolves cancelled.
      await chat.waitFor('status→failed');
      await chat.waitFor('[turn] stopReason=cancelled');
      check('CH-06 :cancel settles the pending permission (reject optionId)', true);
      chat.write('after');
      // The next prompt asks again — answering it proves no request promise
      // from the cancelled turn was left hanging.
      await chat.waitFor('⟪agent⟫ OK2');
      await chat.waitFor('pick <number|optionId>:');
      chat.write('1');
      await chat.waitFor('[permission] → allow');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CH-06 no request promise left hanging — next prompt works', true);
      chat.write(':quit');
      check('CH-06 cancel-settles-permission chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-06 :cancel settles pending permission', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
    check('CH-06 no lingering engine after cancel', noLingering());
  }

  // ── CH-08: question round-trip ─────────────────────────────────────────────
  {
    const chat = new ChatDriver('mock-question', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('go');
      await chat.waitFor('[question] Which flavor?');
      chat.write('vanilla');
      await chat.waitFor('⟪agent⟫ answer:vanilla');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CH-08 question answered via respond(), turn continued', true);
      chat.write(':quit');
      check('CH-08 question chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-08 question', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── question response remains tracked through immediate EOF ────────────────
  {
    const chat = new ChatDriver('mock-question', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('go');
      await chat.waitFor('[question] Which flavor?');
      chat.write('vanilla');
      chat.endInput();
      check('question response is retained through immediate EOF', (await chat.exit()) === 0);
    } catch (e) {
      check('question response shutdown tracking', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('immediate EOF after question reaps the engine', noLingering());
  }

  // ── CH-09: permission + question pending → answered in arrival order ───────
  {
    // The agent sends question-then-permission on the wire; core preserves
    // that order, so the question is delivered to the CLI first and owns the
    // next input line, the permission is printed with its queue position,
    // and answers resolve strictly in that FIFO order.
    const chat = new ChatDriver('scripted-dual-pending', {
      adapterPaths: [fixtures],
      chatCwd: newCwd(),
      extra: ['--permission', 'ask'],
    });
    try {
      chat.write('go');
      await chat.waitFor('[question] Q-first?');
      await chat.waitFor('[permission] (queued #2) tool=dual-tool');
      check(
        'CH-09 second arrival printed with its queue position',
        chat.combined.indexOf('[question] Q-first?') < chat.combined.indexOf('[permission] (queued #2)'),
        chat.combined,
      );
      chat.write('blue'); // the question owns the line
      await chat.waitFor('[question] → blue');
      check('CH-09 head of the queue owns the next line (FIFO)', true);
      chat.write('bogus'); // permission now heads the queue: invalid pick reprints
      await chat.waitFor("[permission] invalid pick 'bogus'");
      chat.write('allow');
      await chat.waitFor('[permission] → allow');
      await chat.waitFor('⟪agent⟫ both-answered');
      await chat.waitFor('[turn] stopReason=end_turn');
      check(
        'CH-09 simultaneous pending requests answered in arrival order',
        chat.combined.indexOf('[question] → blue') < chat.combined.indexOf('[permission] → allow'),
        chat.combined,
      );
      chat.write(':quit');
      check('CH-09 dual-pending chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-09 dual pending order', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── CH-05: :cancel mid-turn; session survives ──────────────────────────────
  {
    const chat = new ChatDriver('mock-slow', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('go');
      await chat.waitFor('⟪agent⟫ OK1');
      chat.write(':cancel');
      await chat.waitFor('[turn] stopReason=cancelled');
      check('CH-05 :cancel resolves the active turn cancelled', true);
      chat.write('again');
      await chat.waitFor('⟪agent⟫ OK2');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CH-05 prompt after cancel still works', true);
      chat.write(':quit');
      check('CH-05 cancel chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-05 :cancel', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── late permission/question racing in after :cancel are gated ─────────────
  {
    const chat = new ChatDriver('mock-racy-permission', {
      adapterPaths: [fixtures],
      chatCwd: newCwd(),
      extra: ['--permission', 'ask'],
    });
    try {
      chat.write('go');
      await chat.waitFor('⟪agent⟫ OK1');
      chat.write(':cancel');
      await chat.waitFor('[turn] stopReason=cancelled');
      check('late permission after :cancel does not hang the turn', true);
      check(
        'late permission is gated instead of becoming interactive',
        !chat.combined.includes('pick <number|optionId>:'),
        chat.combined,
      );
      chat.write(':quit');
      check('racy permission chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('late permission after :cancel', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  {
    const chat = new ChatDriver('mock-racy-question', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      chat.write('go');
      await chat.waitFor('⟪agent⟫ OK1');
      chat.write(':cancel');
      await chat.waitFor('[turn] stopReason=cancelled');
      check('late question after :cancel does not hang the turn', true);
      check(
        'late question is gated instead of becoming interactive',
        !chat.combined.includes('[question] Which flavor?'),
        chat.combined,
      );
      chat.write(':quit');
      check('racy question chat exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('late question after :cancel', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // ── CH-13: --resume prints resumeTier; bogus id → NotFoundError ────────────
  {
    const chatCwd = newCwd();
    const chat = new ChatDriver('mock', { adapterPaths: [fixtures], chatCwd });
    let sessionId: string | undefined;
    try {
      await chat.waitFor('[session] id=');
      sessionId = /\[session\] id=(\S+)/.exec(chat.combined)?.[1];
      chat.write('remember me');
      await chat.waitFor('[turn] stopReason=end_turn');
      chat.write(':quit');
      check('CH-13 seed session exits 0', (await chat.exit()) === 0);
    } catch (e) {
      check('CH-13 seed session', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
    check('CH-13 seed session id captured', sessionId !== undefined, chat.combined);

    if (sessionId !== undefined) {
      const resumed = new ChatDriver('mock', {
        adapterPaths: [fixtures],
        chatCwd,
        extra: ['--resume', sessionId],
      });
      try {
        await resumed.waitFor('[session] id=');
        check(
          'CH-13 --resume banner carries resumeTier=native',
          new RegExp(`\\[session\\] id=${sessionId} engine=mock status=idle resumeTier=native`).test(
            resumed.combined,
          ),
          resumed.combined,
        );
        resumed.write(':quit');
        check('CH-13 resumed session exits 0', (await resumed.exit()) === 0);
      } catch (e) {
        check('CH-13 --resume', false, String(e));
        resumed.write(':quit');
        await resumed.exit();
      }
    }
  }

  {
    // A bogus resume id fails before any engine process is spawned (RS-04).
    const traceDir = scratch('runskein-cli-trace-ch13-');
    const trace = join(traceDir, 'spawns.log');
    const traceFixtures = scratch('runskein-cli-fixtures-ch13-');
    writeMockAdapter(traceFixtures, 'mock-traced', { MOCK_TRACE_FILE: trace });
    const r = runCli(
      [
        '--adapter-path',
        traceFixtures,
        'chat',
        'mock-traced',
        '--cwd',
        newCwd(),
        '--resume',
        'no-such-session',
      ],
      '',
    );
    check('CH-13 bogus --resume → exit 1', r.status === 1, `${r.status}\n${r.stderr}`);
    check(
      'CH-13 bogus --resume → NotFoundError {resource: session}',
      r.stderr.includes('[error] NotFoundError:') &&
        r.stderr.includes('resource: "session"') &&
        r.stderr.includes('no-such-session'),
      r.stderr,
    );
    check('CH-13 bogus --resume spawns no engine', !existsSync(trace));
  }

  // ── CH-14: unknown :-command errors locally, state unchanged ───────────────
  {
    const chat = new ChatDriver('mock', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      await chat.waitFor('[session] id=');
      chat.write(':bogus');
      await chat.waitFor("[error] unknown command ':bogus'");
      check(
        'CH-14 unknown :-command lists valid commands on stderr',
        chat.stderr.includes("[error] unknown command ':bogus'") &&
          chat.stderr.includes(':cancel :config :fork :status :quit'),
        chat.stderr,
      );
      chat.write('still works');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CH-14 REPL state unchanged after unknown command', true);
      chat.write(':quit');
      check('CH-14 unknown-command chat exits 2', (await chat.exit()) === 2);
    } catch (e) {
      check('CH-14 unknown :-command', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  {
    const chat = new ChatDriver('mock', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      await chat.waitFor('[session] id=');
      chat.write(':config missing-separator');
      await chat.waitFor('[error] usage: :config key=value');
      chat.write(':fork extra');
      await chat.waitFor('[error] usage: :fork');
      chat.write('still works');
      await chat.waitFor('[turn] stopReason=end_turn');
      chat.write(':quit');
      check('malformed REPL commands keep running and exit 2', (await chat.exit()) === 2);
    } catch (e) {
      check('malformed REPL command exit aggregation', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // A slow first turn lets rapid input cross both queue watermarks. The rest
  // drain FIFO without per-turn delay while stdin remains open.
  {
    const prompts = Array.from({ length: 130 }, (_, i) => `queued-${i}`);
    const chat = new ChatDriver('scripted-backpressure', {
      adapterPaths: [fixtures],
      chatCwd: newCwd(),
    });
    try {
      await chat.waitFor('[session] id=');
      for (const prompt of prompts) chat.write(prompt);
      await chat.waitForCount('[turn] stopReason=end_turn', prompts.length);
      check(
        'bounded action queue preserves FIFO endpoints',
        chat.stdout.indexOf('[queued] queued-1') < chat.stdout.indexOf('[queued] queued-129'),
        chat.stdout,
      );
      chat.write(':quit');
      check('bounded action queue drains all rapid prompts', (await chat.exit()) === 0);
    } catch (e) {
      check('bounded action queue pressure', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }

  // Closing the consumer side of stdout must trigger cleanup rather than an
  // unhandled EPIPE stack trace.
  {
    const chat = new ChatDriver('mock', { adapterPaths: [fixtures], chatCwd: newCwd() });
    try {
      await chat.waitFor('[session] id=');
      chat.closeStdout();
      chat.write(':status');
      const code = await chat.exit();
      check('closed stdout exits cleanly', code === 0, `${code}\n${chat.stderr}`);
      check('closed stdout never prints an EPIPE stack', !chat.stderr.includes('EPIPE'), chat.stderr);
    } catch (e) {
      check('closed stdout cleanup', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('closed stdout reaps the engine', noLingering());
  }

  {
    const chat = new ChatDriver('scripted-epipe-close-error', {
      adapterPaths: [fixtures],
      chatCwd: newCwd(),
    });
    try {
      await chat.waitFor('[session] id=');
      chat.closeStdout();
      chat.write(':status');
      const code = await chat.exit();
      check('cleanup failure after EPIPE still exits 1', code === 1, `${code}\n${chat.stderr}`);
      check(
        'cleanup failure after EPIPE remains visible on stderr',
        chat.stderr.includes('[error] EngineOperationError:') &&
          chat.stderr.includes('scripted close failure'),
        chat.stderr,
      );
    } catch (e) {
      check('cleanup failure visibility after EPIPE', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('EPIPE plus cleanup failure still reaps the engine', noLingering());
  }

  // ── CH-15/16: EOF at idle + non-TTY operation ─────────────────────────────
  {
    const r = runCli(['--adapter-path', fixtures, 'chat', 'mock', '--cwd', newCwd()], '');
    check('CH-15 EOF at idle exits 0', r.status === 0, `${r.status}\n${r.stderr}`);
    check('CH-15 no lingering engine process after EOF', noLingering());
    check(
      'CH-16 piped stdin: no prompt glyphs, banner + behaviour intact',
      !r.stdout.includes('mock>') && r.stdout.includes('[session] id='),
      r.stdout,
    );
  }

  // ── DI-04 tail: hub stays usable for chat despite the broken adapter ───────
  {
    const mixed = scratch('runskein-cli-fixtures-mixed-');
    writeMockAdapter(mixed, 'mock');
    writeBrokenAdapter(mixed);
    const chat = new ChatDriver('mock', { adapterPaths: [mixed], chatCwd: newCwd() });
    try {
      chat.write('hi');
      await chat.waitFor('⟪agent⟫ OK1');
      await chat.waitFor('[turn] stopReason=end_turn');
      chat.write(':quit');
      const code = await chat.exit();
      check(
        'DI-04 broken adapter does not break a subsequent chat',
        code === 0,
        `code=${code}\n${chat.combined}`,
      );
    } catch (e) {
      check('DI-04 broken adapter does not break a subsequent chat', false, String(e));
      chat.write(':quit');
      await chat.exit();
    }
  }
}
