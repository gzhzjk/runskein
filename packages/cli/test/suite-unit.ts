/**
 * Unit-level checks with no process involved: the terminal sanitizer, pure
 * presenter renderers, config assignment parsing, concurrent callers of
 * shutdown, and the error formatter with its exit-code classification. Fold
 * semantics are contract-tested in @runskein/fold's own suite.
 */
import { ConfigError, EngineStartError, NotFoundError } from '@runskein/core';
import type { ToolRow } from '@runskein/fold';
import { check } from './helpers.js';
import { parseConfigAssignment } from '../src/config.js';
import { classifyThrowable, formatError, UsageError } from '../src/errors.js';
import { Fifo } from '../src/fifo.js';
import { renderContentBlock, renderRaw, renderToolRow, sanitize } from '../src/render.js';
import { Shutdown } from '../src/shutdown.js';

export async function unitSuite(): Promise<void> {
  // ── shared config parser + amortized-O(1) FIFO ─────────────────────────────
  {
    check(
      'config parser preserves strings and coerces booleans',
      parseConfigAssignment('model=gpt-5', 'bad').value === 'gpt-5' &&
        parseConfigAssignment('enabled=false', 'bad').value === false,
    );
    let usage: unknown;
    try {
      parseConfigAssignment('missing-separator', 'expected key=value');
    } catch (e) {
      usage = e;
    }
    check(
      'config parser throws a formatted UsageError',
      usage instanceof UsageError && formatError(usage) === '[error] expected key=value',
    );

    const fifo = new Fifo<number>();
    for (let i = 0; i < 10_000; i++) fifo.push(i);
    let ordered = true;
    for (let i = 0; i < 10_000; i++) ordered &&= fifo.shift() === i;
    check('head-index FIFO preserves 10k-item order', ordered && fifo.length === 0);
    fifo.push(1);
    fifo.clear();
    check('FIFO clear resets storage and length', fifo.length === 0 && fifo.shift() === undefined);
  }

  // ── terminal sanitizer ───────────────────────────────────────────────────
  {
    const dirty = '\x1b[31mred\x1b[0m \r\n\x1b]52;c;aGVsbG8=\x07 tab\t中文 ✓';
    const clean = sanitize(dirty);
    check('sanitizer strips CSI/OSC/CR/BEL', clean === 'red \n tab\t中文 ✓', JSON.stringify(clean));
    check('sanitizer strips DCS and C1', sanitize('a\x1bPsomerandomgarbage\x1b\\b\u0085\u009fz') === 'abz');
    check('sanitizer keeps plain text', sanitize('plain text 123') === 'plain text 123');
  }

  // ── presenter renderers (fold semantics live in @runskein/fold's tests) ──
  {
    const row: ToolRow = {
      toolCallId: 'tool-raw',
      title: 'raw payloads',
      rawInput: { path: '/tmp/input' },
      rawOutput: { ok: true },
    };
    check(
      'tool row renders rawInput/rawOutput JSON',
      renderToolRow(row).includes('rawInput: {"path":"/tmp/input"}') &&
        renderToolRow(row).includes('rawOutput: {"ok":true}'),
      renderToolRow(row),
    );
    check(
      'tool row marks changed scalar fields',
      renderToolRow({ toolCallId: 't', title: 'renamed', status: 'completed' }, [
        'title',
        'status',
      ]).includes('title→renamed') &&
        renderToolRow({ toolCallId: 't', title: 'renamed', status: 'completed' }, ['status']).includes(
          'status→completed',
        ),
    );
    check(
      'tool row missing fields never render as undefined',
      !renderToolRow({ toolCallId: 'sparse' }).includes('undefined'),
    );
    check(
      'unknown tool-call content falls back to raw JSON',
      renderToolRow({
        toolCallId: 'utc-1',
        title: 't',
        content: [{ type: 'weird-tool', y: 2 }],
      }).includes('[unknown tool content]'),
    );
    check(
      'unknown content block falls back to raw JSON',
      renderContentBlock({ type: 'weird', x: 1 }).includes('[unknown content block]'),
    );
    check(
      'raw fallback renders unknown update JSON (RN-06 unit)',
      renderRaw({ sessionUpdate: 'mystery_update', foo: 'bar' }, 'unknown-update') ===
        '⟪update⟫ {"sessionUpdate":"mystery_update","foo":"bar"}',
    );
    check(
      'raw fallback tags malformed known updates with the reason',
      renderRaw({ sessionUpdate: 'tool_call_update' }, 'malformed-known-update').includes(
        '⟪update⟫ [malformed-known-update]',
      ),
    );
  }

  // ── concurrent shutdown callers share completion ─────────────────────────
  {
    let releaseQuit!: () => void;
    const quitGate = new Promise<void>((resolveGate) => {
      releaseQuit = resolveGate;
    });
    const shutdown = new Shutdown({
      quit: async () => {
        await quitGate;
        throw new Error('late cleanup failure');
      },
    } as never);
    const first = shutdown.run();
    let secondSettled = false;
    const second = shutdown.run().then(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    check('concurrent shutdown caller waits for the in-flight cleanup', !secondSettled);
    releaseQuit();
    await Promise.all([first, second]);
    check(
      'concurrent shutdown caller observes captured cleanup errors',
      shutdown.errors.length === 1 && String(shutdown.errors[0]).includes('late cleanup failure'),
    );
  }

  // ── error formatter + exit-code classification ───────────────────────────
  {
    const cfg = new ConfigError({
      engineId: 'kimi',
      key: 'model',
      validValues: ['m1', 'm2'],
      message: "invalid value 'nope' for 'model'",
    });
    const out = formatError(cfg);
    check(
      'formatter prints class, message, own fields',
      out.includes('[error] ConfigError:') &&
        out.includes("invalid value 'nope'") &&
        out.includes('engineId: "kimi"') &&
        out.includes('validValues: ["m1","m2"]'),
      out,
    );
    check('typed error classifies 1', classifyThrowable(cfg) === 1);

    const start = new EngineStartError({
      engineId: 'kimi',
      stage: 'spawn',
      cause: new Error('ENOENT'),
    });
    const chained = formatError(start);
    check(
      'cause chain is recursed and indented',
      chained.includes('caused by:') && chained.includes('ENOENT'),
      chained,
    );

    const unknown = formatError(new TypeError('boom'));
    check(
      'unknown throwable prints unexpected + stack',
      unknown.includes('[error] unexpected: TypeError: boom') && unknown.includes('at '),
      unknown,
    );
    check('unknown throwable classifies 3', classifyThrowable(new TypeError('x')) === 3);

    const allTyped = new AggregateError(
      [cfg, new NotFoundError({ resource: 'session', resourceId: 's1' })],
      'shutdown',
    );
    check('aggregate all-typed → 1', classifyThrowable(allTyped) === 1);
    check(
      'aggregate with unknown leaf → 3',
      classifyThrowable(new AggregateError([cfg, new Error('x')])) === 3,
    );
    check(
      'aggregate nested unknown leaf → 3',
      classifyThrowable(new AggregateError([new AggregateError([new Error('x')])])) === 3,
    );
    check('empty aggregate → 3', classifyThrowable(new AggregateError([])) === 3);
    const aggOut = formatError(allTyped);
    check(
      'aggregate prints each inner error',
      aggOut.includes('ConfigError') && aggOut.includes('NotFoundError'),
      aggOut,
    );
    // A runskein typed error is a classification boundary: an ordinary cause does
    // not upgrade the code.
    check('typed error with unknown cause still 1', classifyThrowable(start) === 1);

    // cycle guard
    const cyclic: Error & { cause?: unknown } = new Error('cycle');
    cyclic.cause = cyclic;
    formatError(cyclic); // must terminate
    check('cause cycle guarded', formatError(cyclic).includes('<cycle>'));
  }
}
