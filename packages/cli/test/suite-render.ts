/**
 * Update rendering. One scripted-agent turn emits every update shape the CLI
 * can receive; assertions match stable markers in the rendered stdout,
 * checked against the ANSI-stripped text so styling never fakes a match.
 *
 * The shared-line cases pin stream aggregation: chunks of one logical message
 * behind a single prefix, and token-granularity chunks as one continuous
 * line. The tool-row cases pin the repaint discipline: pure content/rawInput
 * growth is coalesced; visible changes and terminal states repaint the
 * complete row.
 *
 * Test-plan cases: RN-01…09.
 */
import {
  ChatDriver,
  check,
  noLingering,
  scratch,
  writeScriptedAdapter,
  SCRIPTED_AGENT_PATTERN,
} from './helpers.js';

const BASE64 = 'QUJDREVGR0hJSg=='; // must never appear in rendered output

/** Strip the CLI's own ANSI styling so assertions see plain text. */
function plain(text: string): string {
  return text.replace(/\[[0-9;]*m/g, '');
}

/** Count non-overlapping occurrences of a literal needle. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const RENDER_SCRIPT = {
  capabilities: {},
  onPrompt: [
    // RN-01 message streams: thought → agent switch and multi-chunk aggregation
    { thought: 'pondering…' },
    { chunk: 'first chunk' },
    { chunk: ' second' },
    { chunk: ' third' },
    // RN-01 messageId switch: same id appends, a new id starts a new line
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'msg-one' },
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: ' more' },
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm2',
        content: { type: 'text', text: 'msg-two' },
      },
    },
    // RN-01 a non-text block truncates the shared line
    { chunk: 'pre-image' },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: BASE64 },
      },
    },
    { chunk: 'post-image' },
    // RN-02 full tool_call rows
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'full-1',
        title: 'write-file',
        kind: 'edit',
        status: 'in_progress',
        locations: [{ path: '/tmp/a.txt', line: 3 }],
      },
    },
    // RN-03 repaint discipline: visible changes repaint, pure growth coalesces
    { update: { sessionUpdate: 'tool_call', toolCallId: 'sparse-1', title: 'sparse-tool' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'sparse-1', title: 'renamed-tool' } },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sparse-1',
        content: [{ type: 'diff', path: '/tmp/sparse-growth.txt', newText: 'growth line' }],
      },
    },
    {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'sparse-1',
        rawOutput: { marker: 'sparse-raw' },
      },
    },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'sparse-1', status: 'completed' } },
    // RN-04 plan variants
    {
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'step one', priority: 'high', status: 'pending' },
          { content: 'step two', priority: 'medium', status: 'in_progress' },
          { content: 'step three', priority: 'low', status: 'completed' },
        ],
      },
    },
    {
      update: {
        sessionUpdate: 'plan_update',
        plan: {
          type: 'items',
          planId: 'p1',
          entries: [{ content: 'revised step', priority: 'high', status: 'pending' }],
        },
      },
    },
    {
      update: {
        sessionUpdate: 'plan_update',
        plan: { type: 'file', planId: 'p1', uri: 'file:///plan.md' },
      },
    },
    {
      update: {
        sessionUpdate: 'plan_update',
        plan: { type: 'markdown', planId: 'p1', content: '# The Plan\n- do things' },
      },
    },
    { update: { sessionUpdate: 'plan_removed', planId: 'p1' } },
    // RN-05 remaining update types
    {
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'run', description: 'run a command', input: { hint: '<cmd>' } }],
      },
    },
    { update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } },
    {
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            currentValue: 'a2',
            options: [
              { value: 'a1', name: 'A One' },
              { value: 'a2', name: 'A Two' },
            ],
          },
        ],
      },
    },
    {
      update: {
        sessionUpdate: 'session_info_update',
        title: 'Render session',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    {
      update: {
        sessionUpdate: 'usage_update',
        used: 1200,
        size: 1_000_000,
        cost: { amount: 0.02, currency: 'USD' },
      },
    },
    { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo me' } } },
    // RN-06 unknown update: passes through core to the raw-JSON fallback
    // (also unit-tested in suite-unit).
    { update: { sessionUpdate: 'mystery_update', foo: 'bar', n: 1 } },
    // RN-06 malformed known variant: never partially applied, rendered raw
    { update: { sessionUpdate: 'tool_call_update', status: 'completed' } },
    // RN-07 non-text content blocks
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', mimeType: 'image/png', data: BASE64 },
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'audio', mimeType: 'audio/wav', data: 'QUJD' },
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'resource_link',
          name: 'doc',
          uri: 'file:///doc.pdf',
          title: 'Doc',
          size: 4096,
        },
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'resource',
          resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'short text body' },
        },
      },
    },
    {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'resource', resource: { uri: 'file:///blob.bin', blob: BASE64 } },
      },
    },
    // RN-08 tool-call content types: diff, terminal, nested content
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'content-1',
        title: 'with-content',
        kind: 'edit',
        status: 'completed',
        content: [
          { type: 'diff', path: '/tmp/x.txt', oldText: 'old line', newText: 'new line' },
          { type: 'terminal', terminalId: 'term-9' },
          { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'QUJD' } },
        ],
      },
    },
    { chunk: 'render done' },
  ],
};

// RN-09: token-granularity streaming. 50 characters delivered as 1–2 char
// chunks must land as ONE continuous line; coarse fixture chunks once hid
// the per-chunk prefix/newline bug, so this case pins the granularity.
const TOKEN_TEXT = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345'.slice(0, 50);
const TOKEN_CHUNKS: string[] = [];
for (let i = 0, n = 0; i < TOKEN_TEXT.length; n++) {
  const len = (n % 2) + 1; // alternate 1, 2, 1, 2 …
  TOKEN_CHUNKS.push(TOKEN_TEXT.slice(i, i + len));
  i += len;
}
const TOKEN_SCRIPT = {
  capabilities: {},
  onPrompt: TOKEN_CHUNKS.map((c) => ({ chunk: c })),
};

export async function renderSuite(): Promise<void> {
  const fixtures = scratch('runskein-cli-fixtures-rn-');
  writeScriptedAdapter(fixtures, 'scripted-render', RENDER_SCRIPT);
  writeScriptedAdapter(fixtures, 'scripted-tokens', TOKEN_SCRIPT);

  const chat = new ChatDriver('scripted-render', {
    adapterPaths: [fixtures],
    chatCwd: scratch('runskein-cli-cwd-rn-'),
  });
  try {
    chat.write('render everything');
    await chat.waitFor('⟪agent⟫ render done');
    await chat.waitFor('[turn] stopReason=end_turn');
    const out = chat.stdout;
    const text = plain(out);
    const lines = text.split('\n');

    // RN-01: shared streaming line
    check(
      'RN-01 multi-chunk agent stream aggregates behind one prefix',
      lines.includes('⟪agent⟫ first chunk second third') && count(text, '⟪agent⟫ first chunk') === 1,
      text,
    );
    const thoughtLine = lines.findIndex((l) => l.includes('pondering…'));
    const agentLine = lines.findIndex((l) => l.includes('first chunk second third'));
    check(
      'RN-01 thought → agent switch ends the line and changes the prefix',
      thoughtLine !== -1 && agentLine === thoughtLine + 1 && lines[thoughtLine] === '⟪thought⟫ pondering…',
      `${thoughtLine}: ${lines[thoughtLine]}`,
    );
    check(
      'RN-01 same messageId appends, a new messageId starts a new line',
      lines.includes('⟪agent⟫ msg-one more') && lines.includes('⟪agent⟫ msg-two'),
      text,
    );
    const preLine = lines.findIndex((l) => l.includes('pre-image'));
    check(
      'RN-01 non-text content truncates the shared line',
      preLine !== -1 &&
        lines[preLine] === '⟪agent⟫ pre-image' &&
        lines[preLine + 1] === '⟪agent⟫ [image image/png 16B]' &&
        lines[preLine + 2] === '⟪agent⟫ post-image',
      lines.slice(preLine, preLine + 3).join('\n'),
    );
    check('RN-01 turn end flushes the open stream line', lines.includes('⟪agent⟫ render done'), text);

    // RN-02
    check(
      'RN-02 full tool_call row with kind/title/status + location',
      text.includes('⟪tool⟫ edit write-file (in_progress)') && text.includes('at /tmp/a.txt:3'),
      text,
    );
    check('RN-02 missing optional fields never render as undefined', !text.includes('undefined'), text);

    // RN-03: repaint discipline
    const sparseLines = lines.filter(
      (l) => l.startsWith('⟪tool⟫') && (l.includes('sparse-tool') || l.includes('renamed-tool')),
    );
    check(
      'RN-03 pure growth deltas produce no intermediate repaint',
      sparseLines.length === 3 &&
        sparseLines[0] === '⟪tool⟫ sparse-tool' &&
        count(text, 'sparse-growth.txt') === 1 &&
        count(text, 'sparse-raw') === 1,
      sparseLines.join('\n'),
    );
    check(
      'RN-03 visible change repaints with changed-field marks',
      sparseLines[1] === '⟪tool⟫ renamed-tool ← title→renamed-tool',
      sparseLines.join('\n'),
    );
    check(
      'RN-03 terminal repaint shows the complete merged row',
      sparseLines[2] === '⟪tool⟫ renamed-tool (completed) ← status→completed' &&
        text.includes('diff /tmp/sparse-growth.txt') &&
        text.includes('rawOutput: {"marker":"sparse-raw"}'),
      sparseLines.join('\n'),
    );

    // RN-04
    check(
      'RN-04 plan entries with status icons',
      text.includes('⟪plan⟫ 3 entries, 1 in_progress') &&
        text.includes('☐ step one (high)') &&
        text.includes('◐ step two (medium)') &&
        text.includes('☑ step three (low)'),
      text,
    );
    check(
      'RN-04 plan_update items tagged with planId',
      text.includes('⟪plan⟫ [p1] 1 entries') && text.includes('revised step'),
      text,
    );
    check('RN-04 plan_update file renders the uri', text.includes('plan file: file:///plan.md'), text);
    check('RN-04 plan_update markdown renders the body', text.includes('# The Plan'), text);
    check('RN-04 plan_removed shows planId only', text.includes('⟪plan⟫ plan p1 removed'), text);

    // RN-05
    check(
      'RN-05 available_commands_update renders the command list',
      text.includes('⟪commands⟫') && text.includes('run (<cmd>) — run a command'),
      text,
    );
    check('RN-05 current_mode_update', text.includes('⟪mode⟫ plan'), text);
    check('RN-05 config_option_update', text.includes('⟪config⟫ model = "a2"'), text);
    check(
      'RN-05 session_info_update',
      text.includes('⟪info⟫ title=Render session updatedAt=2026-01-01T00:00:00Z'),
      text,
    );
    check(
      'RN-05 usage_update with cost',
      text.includes('⟪usage⟫ used=1200 size=1000000 cost=0.02 USD'),
      text,
    );
    check('RN-05 user_message_chunk echoed', lines.includes('⟪user⟫ echo me'), text);

    // RN-06: an unknown sessionUpdate reaches the CLI intact (core absorbs
    // SDK-side validation) and renders through the raw-JSON fallback — the
    // spec "never dropped" promise honoured on the wire. A malformed known
    // variant takes the same raw path and is never partially applied.
    check(
      'RN-06 unknown sessionUpdate rendered via raw-JSON fallback',
      text.includes('⟪update⟫') && text.includes('mystery_update'),
      `stdout:\n${text}\nstderr:\n${chat.stderr}`,
    );
    check(
      'RN-06 malformed known update rendered raw with its reason',
      text.includes('⟪update⟫ [malformed-known-update]') && text.includes('tool_call_update'),
      text,
    );
    check(
      'RN-06 no SDK validation error on stderr',
      !chat.stderr.includes('Error handling notification'),
      chat.stderr,
    );
    check(
      'RN-06 CLI survives an unknown update and completes the turn',
      text.includes('[turn] stopReason=end_turn'),
      text,
    );

    // RN-07
    check('RN-07 image placeholder', text.includes('[image image/png 16B]'), text);
    check('RN-07 audio placeholder', text.includes('[audio audio/wav 4B]'), text);
    check(
      'RN-07 resource_link with title and size',
      text.includes('[link doc file:///doc.pdf "Doc" 4096B]'),
      text,
    );
    check(
      'RN-07 text resource preview',
      text.includes('[resource file:///notes.txt text/plain] short text body'),
      text,
    );
    check('RN-07 blob resource byte count', text.includes('[resource file:///blob.bin] 16B'), text);
    check('RN-07 base64 data never dumped', !text.includes(BASE64), text);

    // RN-08
    check(
      'RN-08 diff content shows path + previews',
      text.includes('diff /tmp/x.txt') && text.includes('+ new line') && text.includes('- old line'),
      text,
    );
    check('RN-08 terminal content shows id read-only', text.includes('[terminal term-9]'), text);
    check('RN-08 nested content block rendered', text.includes('[image image/png 4B]'), text);

    chat.write(':quit');
    check('RN chat exits 0', (await chat.exit()) === 0);
  } catch (e) {
    check('RN rendering turn', false, String(e));
    chat.write(':quit');
    await chat.exit();
  }

  // RN-09: token-granularity streaming in its own turn
  const tokens = new ChatDriver('scripted-tokens', {
    adapterPaths: [fixtures],
    chatCwd: scratch('runskein-cli-cwd-rn-'),
  });
  try {
    tokens.write('stream tokens');
    await tokens.waitFor('[turn] stopReason=end_turn');
    const tokenLines = plain(tokens.stdout)
      .split('\n')
      .filter((l) => l.startsWith('⟪agent⟫'));
    check(
      'RN-09 50 chars in 1–2 char chunks render as one continuous line',
      tokenLines.length === 1 && tokenLines[0] === `⟪agent⟫ ${TOKEN_TEXT}`,
      tokenLines.join('\n'),
    );
    tokens.write(':quit');
    check('RN-09 chat exits 0', (await tokens.exit()) === 0);
  } catch (e) {
    check('RN-09 token streaming turn', false, String(e));
    tokens.write(':quit');
    await tokens.exit();
  }
  check('RN no lingering engine process', noLingering(SCRIPTED_AGENT_PATTERN));
}
