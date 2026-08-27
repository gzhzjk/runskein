/**
 * Cleanup and signals — real SIGINT and SIGTERM delivered to the CLI process.
 * These run serially: they manage processes and send signals, which cannot be
 * interleaved safely with other suites.
 *
 * Test-plan cases: CL-04…07.
 */
import {
  ChatDriver,
  check,
  noLingering,
  scratch,
  writeMockAdapter,
  writeScriptedAdapter,
  SCRIPTED_AGENT_PATTERN,
} from './helpers.js';

export async function signalsSuite(): Promise<void> {
  const fixtures = scratch('runskein-cli-fixtures-cl-');
  writeMockAdapter(fixtures, 'mock');
  writeMockAdapter(fixtures, 'mock-slow', { MOCK_PROMPT_DELAY_MS: '1500' });
  writeMockAdapter(fixtures, 'mock-ask', { MOCK_ASK_PERMISSION: '1' });
  writeScriptedAdapter(fixtures, 'scripted-wedged', { capabilities: {}, wedged: true });

  // ── CL-04: SIGINT at idle → cleanup, exit 0, engine reaped ────────────────
  {
    const chat = new ChatDriver('mock', {
      adapterPaths: [fixtures],
      chatCwd: scratch('runskein-cli-cwd-cl-'),
    });
    try {
      await chat.waitFor('[session] id=');
      chat.signal('SIGINT');
      const code = await chat.exit();
      check('CL-04 SIGINT at idle exits 0', code === 0, `${code}\n${chat.combined}`);
    } catch (e) {
      check('CL-04 SIGINT at idle', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('CL-04 engine reaped after idle SIGINT', noLingering());
  }

  // ── CL-05: SIGINT mid-turn ≡ :cancel; the REPL does not exit ──────────────
  {
    const chat = new ChatDriver('mock-slow', {
      adapterPaths: [fixtures],
      chatCwd: scratch('runskein-cli-cwd-cl-'),
    });
    try {
      chat.write('go');
      await chat.waitFor('⟪agent⟫ OK1');
      chat.signal('SIGINT');
      await chat.waitFor('[turn] stopReason=cancelled');
      check('CL-05 SIGINT mid-turn resolves the turn cancelled', true);
      check('CL-05 SIGINT mid-turn does not exit the REPL', !chat.exited);
      chat.write('again');
      await chat.waitFor('⟪agent⟫ OK2');
      await chat.waitFor('[turn] stopReason=end_turn');
      check('CL-05 a following prompt still works', true);
      chat.write(':quit');
      check('CL-05 chat exits 0 after mid-turn SIGINT', (await chat.exit()) === 0);
    } catch (e) {
      check('CL-05 SIGINT mid-turn', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('CL-05 engine reaped after mid-turn SIGINT', noLingering());
  }

  // ── CL-06: SIGTERM from running and from awaiting-permission ───────────────
  {
    const chat = new ChatDriver('mock-slow', {
      adapterPaths: [fixtures],
      chatCwd: scratch('runskein-cli-cwd-cl-'),
    });
    try {
      chat.write('go');
      await chat.waitFor('⟪agent⟫ OK1');
      chat.signal('SIGTERM');
      const code = await chat.exit();
      check('CL-06 SIGTERM mid-turn exits promptly with code 0', code === 0, `${code}\n${chat.combined}`);
    } catch (e) {
      check('CL-06 SIGTERM mid-turn', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('CL-06 engine reaped after mid-turn SIGTERM', noLingering());
  }

  {
    const chat = new ChatDriver('mock-ask', {
      adapterPaths: [fixtures],
      chatCwd: scratch('runskein-cli-cwd-cl-'),
      extra: ['--permission', 'ask'],
    });
    try {
      chat.write('go');
      await chat.waitFor('pick <number|optionId>:');
      chat.signal('SIGTERM');
      const code = await chat.exit();
      // The pending interaction is settled, cleanup runs once, exit 0.
      check('CL-06 SIGTERM while awaiting permission exits 0', code === 0, `${code}\n${chat.combined}`);
    } catch (e) {
      check('CL-06 SIGTERM awaiting-permission', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('CL-06 engine reaped after awaiting-state SIGTERM', noLingering());
  }

  // ── CL-07: wedged engine → SIGKILL within timeoutMs; CLI exits promptly ────
  {
    const chat = new ChatDriver('scripted-wedged', {
      adapterPaths: [fixtures],
      chatCwd: scratch('runskein-cli-cwd-cl-'),
    });
    try {
      await chat.waitFor('[session] id=');
      const t0 = Date.now();
      chat.write(':quit');
      const code = await chat.exit(30_000);
      const elapsed = Date.now() - t0;
      // s.close() succeeds (the wedged agent still answers), then the bounded
      // quit escalates stdin → SIGTERM (ignored) → SIGKILL within timeoutMs.
      check(
        'CL-07 wedged engine SIGKILLed within the bounded quit; CLI exits',
        code === 0 && elapsed < 20_000,
        `code=${code} elapsed=${elapsed}ms\n${chat.combined}`,
      );
    } catch (e) {
      check('CL-07 wedged engine', false, String(e));
      chat.signal('SIGKILL');
      await chat.exit();
    }
    check('CL-07 wedged engine process gone', noLingering(SCRIPTED_AGENT_PATTERN));
  }
}
