/**
 * Contract tests for @runskein/fold: table-driven `FoldInput[]` fixtures,
 * no process or ACP dependency. Covers the folding semantics contract:
 * message streams, tool rows, plan state, usage state, raw pass-through,
 * and envelope discipline.
 */
import { describe, expect, it } from 'vitest';
import { syntheticUsageUpdate } from '@runskein/core/internal';
import {
  collectToolRows,
  createDiffCoverageJudge,
  createFolder,
  toolCallText,
  type FoldedEvent,
  type FoldInput,
  type ToolRow,
} from '../src/index.js';

/** Build a fold input envelope. */
function seqInput(seq: number, update: unknown, extra: Partial<FoldInput> = {}): FoldInput {
  return { seq, ts: 1_700_000_000_000 + seq, sessionId: 's1', engineId: 'mock', update, ...extra };
}

/** Fold one input through a fresh folder. */
function foldOne(input: FoldInput): FoldedEvent[] {
  return createFolder().push(input);
}

/** The emitted event types, compacted for sequence assertions. */
function types(events: FoldedEvent[]): string {
  return events.map((e) => e.event.type).join(',');
}

/** Extract the single toolRow event from a fold output. */
function onlyToolRow(events: FoldedEvent[]): { row: ToolRow; changed: readonly string[] } {
  const hit = events.filter((e) => e.event.type === 'toolRow');
  expect(hit).toHaveLength(1);
  const event = hit[0]!.event;
  if (event.type !== 'toolRow') throw new Error('unreachable');
  return { row: event.row, changed: event.changed };
}

const text = (t: string, messageId?: string | null) => ({
  sessionUpdate: 'agent_message_chunk',
  ...(messageId !== undefined ? { messageId } : {}),
  content: { type: 'text', text: t },
});

describe('message streams', () => {
  it('first text chunk emits messageStart + messageAppend; same key appends', () => {
    const folder = createFolder();
    const first = folder.push(seqInput(1, text('hello')));
    expect(types(first)).toBe('messageStart,messageAppend');
    const firstStart = first[0]!.event;
    if (firstStart.type !== 'messageStart') throw new Error('unreachable');
    expect(firstStart.kind).toBe('agent');
    expect(firstStart.messageId).toBeUndefined();

    const same = folder.push(seqInput(2, text(' world')));
    expect(types(same)).toBe('messageAppend');
    const append = same[0]!.event;
    if (append.type !== 'messageAppend') throw new Error('unreachable');
    expect(append.block.text).toBe(' world');
  });

  it('kind switch ends the old stream then starts a new one', () => {
    const folder = createFolder();
    folder.push(seqInput(1, text('a')));
    folder.push(seqInput(2, text('b')));
    const thought = folder.push(
      seqInput(3, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }),
    );
    expect(types(thought)).toBe('messageEnd,messageStart,messageAppend');
    // messageEnd provenance is the last chunk of the OLD stream.
    expect(thought[0]!.source.seq).toBe(2);
    const start = thought[1]!.event;
    if (start.type !== 'messageStart') throw new Error('unreachable');
    expect(start.kind).toBe('thought');
  });

  it('messageId transitions: same id appends; new id and null id start new streams', () => {
    const folder = createFolder();
    folder.push(seqInput(1, text('a', 'm1')));
    expect(types(folder.push(seqInput(2, text('b', 'm1'))))).toBe('messageAppend');
    expect(types(folder.push(seqInput(3, text('c', 'm2'))))).toBe('messageEnd,messageStart,messageAppend');
    // messageId: null normalizes to absent — a new key.
    expect(types(folder.push(seqInput(4, text('d', null))))).toBe('messageEnd,messageStart,messageAppend');
  });

  it('non-text block closes the stream and emits a content event carrying role and id', () => {
    const folder = createFolder();
    folder.push(seqInput(1, text('before', 'm1')));
    const image = folder.push(
      seqInput(2, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'image', mimeType: 'image/png', data: 'QUJD' },
      }),
    );
    expect(types(image)).toBe('messageEnd,content');
    const content = image[1]!.event;
    if (content.type !== 'content') throw new Error('unreachable');
    expect(content.kind).toBe('agent');
    expect(content.messageId).toBe('m1');
  });

  it('any non-chunk update closes the open stream before its own output', () => {
    const folder = createFolder();
    folder.push(seqInput(1, text('x')));
    const mode = folder.push(seqInput(2, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }));
    expect(types(mode)).toBe('messageEnd,notice');
  });

  it('flush ends the open message once and is idempotent', () => {
    const folder = createFolder();
    expect(folder.flush()).toHaveLength(0);
    folder.push(seqInput(1, text('x')));
    const flushed = folder.flush();
    expect(types(flushed)).toBe('messageEnd');
    expect(flushed[0]!.source.seq).toBe(1);
    expect(folder.flush()).toHaveLength(0);
  });

  it('live input and transcript replay with the same flush schedule emit identical events', () => {
    const inputs = [
      seqInput(1, text('a')),
      seqInput(2, text('b')),
      seqInput(3, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }),
      seqInput(4, text('c')),
    ];
    const run = (): string => {
      const folder = createFolder();
      const out: FoldedEvent[] = [];
      for (const input of inputs.slice(0, 2)) out.push(...folder.push(input));
      out.push(...folder.flush()); // explicit turn boundary, caller-supplied
      for (const input of inputs.slice(2)) out.push(...folder.push(input));
      out.push(...folder.flush());
      return JSON.stringify(out);
    };
    expect(run()).toBe(run());
  });
});

describe('tool rows', () => {
  it('update-before-create yields a partial row; a full tool_call replaces it', () => {
    const folder = createFolder();
    const { row: partial } = onlyToolRow(
      folder.push(
        seqInput(1, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' }),
      ),
    );
    expect(partial.toolCallId).toBe('t1');
    expect(partial.status).toBe('in_progress');
    expect(partial.title).toBeUndefined();

    const { row: full, changed } = onlyToolRow(
      folder.push(
        seqInput(2, {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'write-file',
          rawInput: { path: '/tmp/input' },
        }),
      ),
    );
    expect(full.title).toBe('write-file');
    expect(full.status).toBeUndefined(); // replaced, not merged
    // `args` follows rawInput: derived after the supplied fields, reported
    // because the row went from stating nothing to stating a path.
    expect(changed.join(',')).toBe('title,rawInput,args');
    expect(full.args).toEqual({ text: '/tmp/input', value: { path: '/tmp/input' }, from: 'rawInput' });
  });

  it('nullable patch fields: omission and null mean no change', () => {
    const folder = createFolder();
    folder.push(seqInput(1, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 't', kind: 'edit' }));
    const { row, changed } = onlyToolRow(
      folder.push(
        seqInput(2, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: null, kind: null }),
      ),
    );
    expect(changed).toHaveLength(0);
    expect(row.title).toBe('t');
    expect(row.kind).toBe('edit');
  });

  it('rawInput/rawOutput: own-key presence patches, null is data', () => {
    const folder = createFolder();
    folder.push(
      seqInput(1, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 't', rawInput: { a: 1 } }),
    );
    const { row, changed } = onlyToolRow(
      folder.push(seqInput(2, { sessionUpdate: 'tool_call_update', toolCallId: 't1', rawInput: null })),
    );
    // rawInput went from {a:1} to null, so the derived args went away too.
    expect(changed.join(',')).toBe('rawInput,args');
    expect(row.args).toBeUndefined();
    expect(Object.hasOwn(row, 'rawInput')).toBe(true);
    expect(row.rawInput).toBeNull();
  });

  it('content/locations are whole-array replacements and old snapshots stay immutable', () => {
    const folder = createFolder();
    const { row: first } = onlyToolRow(
      folder.push(
        seqInput(1, {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 't',
          content: [{ type: 'diff', path: '/a', newText: 'x' }],
        }),
      ),
    );
    const { row: second, changed } = onlyToolRow(
      folder.push(
        seqInput(2, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          content: [{ type: 'diff', path: '/b', newText: 'y' }],
        }),
      ),
    );
    // The derived diff coverage moved with the content: a different path.
    expect(changed.join(',')).toBe('content,diffs');
    expect(second.content).toHaveLength(1);
    expect((first.content?.[0] as { path: string }).path).toBe('/a');
  });

  it('terminal status evicts the row; the terminal snapshot is complete', () => {
    const folder = createFolder();
    folder.push(
      seqInput(1, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 't', rawOutput: { ok: true } }),
    );
    const { row: terminal } = onlyToolRow(
      folder.push(
        seqInput(2, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
      ),
    );
    expect(terminal.status).toBe('completed');
    expect(terminal.title).toBe('t');
    expect(terminal.rawOutput).toEqual({ ok: true });

    const { row: restarted } = onlyToolRow(
      folder.push(seqInput(3, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'new-run' })),
    );
    expect(restarted.title).toBe('new-run');
    expect(restarted.status).toBeUndefined();
    expect(restarted.rawOutput).toBeUndefined();
  });

  it('unknown tool-call content stays in the row snapshot', () => {
    const { row } = onlyToolRow(
      foldOne(
        seqInput(1, {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 't',
          content: [{ type: 'weird-tool', y: 2 }],
        }),
      ),
    );
    expect(row.content?.[0]).toEqual({ type: 'weird-tool', y: 2 });
  });
});

describe('diff coverage', () => {
  /** One `tool_call` carrying the given content blocks. */
  function withContent(seq: number, toolCallId: string, content: unknown[]): FoldInput {
    return seqInput(seq, { sessionUpdate: 'tool_call', toolCallId, title: 'edit', content });
  }

  it('a diff without oldText created the file, so it covers all of it', () => {
    const { row } = onlyToolRow(
      foldOne(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 'one\ntwo\n' }])),
    );
    expect(row.diffs).toEqual([
      { index: 0, path: '/a.ts', scope: 'wholeFile', startLine: 1, from: 'created' },
    ]);
  });

  it('a fragment stays unknown: the transcript cannot prove where it sits', () => {
    const { row } = onlyToolRow(
      foldOne(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', oldText: 'two\n', newText: 'TWO\n' }])),
    );
    expect(row.diffs).toEqual([{ index: 0, path: '/a.ts', scope: 'unknown' }]);
  });

  it('a diff replacing what a whole-file diff wrote is whole-file too', () => {
    const folder = createFolder();
    folder.push(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 'one\ntwo\n' }]));
    const { row } = onlyToolRow(
      folder.push(
        withContent(2, 't2', [
          { type: 'diff', path: '/a.ts', oldText: 'one\ntwo\n', newText: 'one\nTWO\n' },
        ]),
      ),
    );
    expect(row.diffs).toEqual([
      { index: 0, path: '/a.ts', scope: 'wholeFile', startLine: 1, from: 'chained' },
    ]);
  });

  it('a fragment breaks the chain for its path', () => {
    const folder = createFolder();
    folder.push(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 'one\ntwo\n' }]));
    // Replaces something other than the whole file, so what the file holds
    // afterwards is no longer known.
    folder.push(
      withContent(2, 't2', [{ type: 'diff', path: '/a.ts', oldText: 'two\n', newText: 'TWO\n' }]),
    );
    const { row } = onlyToolRow(
      folder.push(
        withContent(3, 't3', [{ type: 'diff', path: '/a.ts', oldText: 'one\nTWO\n', newText: 'done\n' }]),
      ),
    );
    expect(row.diffs).toEqual([{ index: 0, path: '/a.ts', scope: 'unknown' }]);
  });

  it('chains are per path', () => {
    const folder = createFolder();
    folder.push(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 'body\n' }]));
    const { row } = onlyToolRow(
      folder.push(
        withContent(2, 't2', [{ type: 'diff', path: '/b.ts', oldText: 'body\n', newText: 'other\n' }]),
      ),
    );
    expect(row.diffs).toEqual([{ index: 0, path: '/b.ts', scope: 'unknown' }]);
  });

  it('a resent diff keeps its verdict instead of chaining onto itself', () => {
    const folder = createFolder();
    const blocks = [{ type: 'diff', path: '/a.ts', oldText: 'one\n', newText: 'two\n' }];
    folder.push(withContent(1, 't1', blocks));
    // Engines resend the whole content array as a call progresses. Re-deriving
    // must not read the earlier pass as proof about the file.
    const { row } = onlyToolRow(
      folder.push(seqInput(2, { sessionUpdate: 'tool_call_update', toolCallId: 't1', content: blocks })),
    );
    expect(row.diffs).toEqual([{ index: 0, path: '/a.ts', scope: 'unknown' }]);
  });

  it('a repeat of an earlier edit is judged against the chain as it stands now', () => {
    const folder = createFolder();
    folder.push(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 'one\n' }]));
    folder.push(
      withContent(2, 't2', [{ type: 'diff', path: '/a.ts', oldText: 'one\n', newText: 'two\n' }]),
    );
    // A fragment edit lands in between and ends the chain.
    folder.push(withContent(3, 't3', [{ type: 'diff', path: '/a.ts', oldText: 'wo\n', newText: 'WO\n' }]));
    // The same old->new pair as t2, but nothing now proves what the file holds.
    const { row } = onlyToolRow(
      folder.push(
        withContent(4, 't4', [{ type: 'diff', path: '/a.ts', oldText: 'one\n', newText: 'two\n' }]),
      ),
    );
    expect(row.diffs).toEqual([{ index: 0, path: '/a.ts', scope: 'unknown' }]);
  });

  it('a resent block keeps its verdict even as siblings arrive around it', () => {
    const folder = createFolder();
    folder.push(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 'one\n' }]));
    const edit = { type: 'diff', path: '/a.ts', oldText: 'one\n', newText: 'two\n' };
    folder.push(withContent(2, 't2', [edit]));
    // The engine resends the block with a new sibling ahead of it: re-judging
    // it would test its oldText against what its own first pass recorded.
    const { row } = onlyToolRow(
      folder.push(
        seqInput(3, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't2',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }, edit],
        }),
      ),
    );
    expect(row.diffs).toEqual([
      { index: 1, path: '/a.ts', scope: 'wholeFile', startLine: 1, from: 'chained' },
    ]);
  });

  it('two identical blocks on one row keep their own verdicts across a resend', () => {
    const folder = createFolder();
    folder.push(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 'one\n' }]));
    const edit = { type: 'diff', path: '/a.ts', oldText: 'one\n', newText: 'two\n' };
    // The second copy was judged against what the first one left behind, so the
    // two blocks hold different verdicts and must keep them apart on a resend.
    const first = onlyToolRow(folder.push(withContent(2, 't2', [edit, edit])));
    expect(first.row.diffs).toEqual([
      { index: 0, path: '/a.ts', scope: 'wholeFile', startLine: 1, from: 'chained' },
      { index: 1, path: '/a.ts', scope: 'unknown' },
    ]);
    const resent = onlyToolRow(
      folder.push(
        seqInput(3, { sessionUpdate: 'tool_call_update', toolCallId: 't2', content: [edit, edit] }),
      ),
    );
    expect(resent.row.diffs).toEqual(first.row.diffs);
    expect(resent.changed).not.toContain('diffs');
  });

  it('coverage is indexed by position, and non-diff blocks carry none', () => {
    const { row } = onlyToolRow(
      foldOne(
        withContent(1, 't1', [
          { type: 'content', content: { type: 'text', text: 'writing' } },
          { type: 'diff', path: '/a.ts', newText: 'x\n' },
          { type: 'terminal', terminalId: 'term-1' },
          { type: 'diff', path: '/b.ts', oldText: 'y\n', newText: 'z\n' },
        ]),
      ),
    );
    expect(row.diffs).toEqual([
      { index: 1, path: '/a.ts', scope: 'wholeFile', startLine: 1, from: 'created' },
      { index: 3, path: '/b.ts', scope: 'unknown' },
    ]);
  });

  it('a row without diffs carries no coverage and never reports one changed', () => {
    const events = foldOne(
      withContent(1, 't1', [{ type: 'content', content: { type: 'text', text: 'hi' } }]),
    );
    const { row, changed } = onlyToolRow(events);
    expect(row.diffs).toBeUndefined();
    expect(changed).not.toContain('diffs');
  });

  it('a null content entry is skipped rather than thrown on', () => {
    const { row } = onlyToolRow(
      foldOne(
        seqInput(1, {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'edit',
          // A terminal status is what sends args looking through content.
          status: 'completed',
          content: [null, { type: 'diff', path: '/a.ts', newText: 'x\n' }],
        }),
      ),
    );
    expect(row.diffs).toEqual([
      { index: 1, path: '/a.ts', scope: 'wholeFile', startLine: 1, from: 'created' },
    ]);
    expect(row.args).toBeUndefined();
  });

  it('a malformed diff block is left alone rather than guessed at', () => {
    const { row } = onlyToolRow(
      foldOne(withContent(1, 't1', [{ type: 'diff', path: '/a.ts', newText: 42 }])),
    );
    expect(row.diffs).toBeUndefined();
    expect(row.content).toHaveLength(1);
  });
});

describe('tool-call arguments', () => {
  /** The final args of one call, folded from its updates. */
  const argsOf = (updates: unknown[]) => {
    const folder = createFolder();
    let row: ToolRow | undefined;
    updates.forEach((update, i) => {
      for (const e of folder.push(seqInput(i + 1, update))) {
        if (e.event.type === 'toolRow') row = e.event.row;
      }
    });
    return row?.args;
  };

  it('reads rawInput when the engine states it', () => {
    // pi's shape: rawInput and locations both present and populated.
    expect(
      argsOf([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'read',
          kind: 'read',
          rawInput: { path: '/w/knowledge.md' },
          locations: [{ path: '/w/knowledge.md' }],
        },
      ]),
    ).toEqual({ text: '/w/knowledge.md', value: { path: '/w/knowledge.md' }, from: 'rawInput' });
  });

  it('falls through an empty rawInput to locations', () => {
    // claude-code's shape: rawInput present but empty, the fact in locations.
    expect(
      argsOf([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'Read',
          rawInput: {},
          content: [],
          locations: [{ path: '/w/a.ts' }],
        },
      ]),
    ).toEqual({ text: '/w/a.ts', from: 'locations' });
  });

  it('skips location entries that name nothing', () => {
    expect(
      argsOf([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'grep',
          locations: ['not-a-location', null, { path: '' }, { path: '/w/b.ts' }],
        },
      ]),
    ).toEqual({ text: '/w/b.ts', from: 'locations' });
  });

  it('states nothing when every source is empty', () => {
    // opencode's shape on the calls that carry no arguments at all.
    expect(
      argsOf([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 'todowrite',
          status: 'pending',
          rawInput: {},
          locations: [],
        },
      ]),
    ).toBeUndefined();
  });

  it('reads streamed content only once the call is terminal', () => {
    // kimi's shape: no rawInput or locations; the arguments grow as text.
    const grow = (text: string, status?: string) => ({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      ...(status !== undefined ? { status } : {}),
      content: [{ type: 'content', content: { type: 'text', text } }],
    });
    const create = { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read', kind: 'read' };

    // Mid-stream the text is half a JSON document; reading it would be wrong.
    expect(argsOf([create, grow('{'), grow('{"path": "do')])).toBeUndefined();

    expect(argsOf([create, grow('{'), grow('{"path": "docs/x.md"}', 'completed')])).toEqual({
      text: 'docs/x.md',
      value: { path: 'docs/x.md' },
      from: 'content',
    });
  });

  it('never reports unparseable terminal content as arguments', () => {
    // Content that is not JSON is indistinguishable from a tool's result
    // text; labelling an output as an input is worse than saying nothing.
    expect(
      argsOf([
        { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash' },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 't1',
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'total 24\ndrwxr-xr-x' } }],
        },
      ]),
    ).toBeUndefined();
  });

  it('picks the readable line by shape, never by engine', () => {
    const text = (rawInput: unknown) =>
      argsOf([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 't', rawInput }])?.text;

    expect(text({ command: 'ls -la', cwd: '/w' })).toBe('ls -la'); // named key wins
    expect(text({ somethingNew: '/w/a.ts' })).toBe('/w/a.ts'); // lone string key
    expect(text({ a: 1, b: 2 })).toBe('{"a":1,"b":2}'); // nothing named: compact JSON
    expect(text('rm -rf /tmp/x')).toBe('rm -rf /tmp/x'); // a bare string is its own line
    expect(text([{ path: '/w/a.ts' }])).toBe('[{"path":"/w/a.ts"}]');
  });

  it('falls through a rawInput that cannot be serialized', () => {
    // Not reachable from the wire, but a folder is fed by whoever holds it.
    const circular: Record<string, unknown> = { self: undefined };
    circular['self'] = circular;
    expect(
      argsOf([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 't',
          rawInput: circular,
          locations: [{ path: '/w/a.ts' }],
        },
      ]),
    ).toEqual({ text: '/w/a.ts', from: 'locations' });
  });

  it('a bare string rawInput carries no structured value', () => {
    expect(argsOf([{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 't', rawInput: 'ls' }])).toEqual({
      text: 'ls',
      from: 'rawInput',
    });
  });

  it('is derived, never accepted from the wire', () => {
    // An engine that sends its own `args` does not get to set this field.
    expect(
      argsOf([
        {
          sessionUpdate: 'tool_call',
          toolCallId: 't1',
          title: 't',
          args: { text: 'spoofed', from: 'rawInput' },
        },
      ]),
    ).toBeUndefined();
  });

  it('collectToolRows carries the derived args', () => {
    const rows = collectToolRows([
      seqInput(1, {
        sessionUpdate: 'tool_call',
        toolCallId: 'sub-1',
        title: 'Task',
        rawInput: { prompt: 'audit the parser' },
      }),
    ]);
    expect(rows.get('sub-1')!.args).toEqual({
      text: 'audit the parser',
      value: { prompt: 'audit the parser' },
      from: 'rawInput',
    });
  });
});

describe('standalone diff coverage judge', () => {
  /**
   * Push a stream through a lone judge and through a folder, asserting after
   * every update that the two agree: whenever the folder judged the patch —
   * it carried content — the judge's verdicts equal `ToolRow.diffs` field for
   * field, and whenever it did not, the judge handed out nothing.
   * @returns the judge's verdict per update, in order.
   */
  function run(stream: readonly unknown[]): (readonly unknown[] | undefined)[] {
    const judge = createDiffCoverageJudge();
    const folder = createFolder();
    return stream.map((update, i) => {
      const judged = judge.push(update);
      const rows = folder.push(seqInput(i + 1, update)).filter((e) => e.event.type === 'toolRow');
      const event =
        rows.length === 1 ? (rows[0]!.event as { row: ToolRow; changed: readonly string[] }) : undefined;
      if (event?.changed.includes('content') !== true) expect(judged).toBeUndefined();
      else expect(judged).toEqual(event.row.diffs);
      return judged;
    });
  }

  /** One `tool_call` / `tool_call_update` carrying one diff block. */
  function edit(
    toolCallId: string,
    path: string,
    oldText: string | undefined,
    newText: string,
    extra: Record<string, unknown> = {},
  ): unknown {
    return {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      content: [{ type: 'diff', path, ...(oldText === undefined ? {} : { oldText }), newText }],
      ...extra,
    };
  }

  const created = (path: string) => ({
    index: 0,
    path,
    scope: 'wholeFile',
    startLine: 1,
    from: 'created',
  });
  const chained = (path: string) => ({
    index: 0,
    path,
    scope: 'wholeFile',
    startLine: 1,
    from: 'chained',
  });
  const unknown = (path: string) => ({ index: 0, path, scope: 'unknown' });

  it('created, chained and a break replay to the same verdicts', () => {
    const stream: unknown[] = [
      edit('t1', '/a.ts', undefined, 'one\n', { sessionUpdate: 'tool_call', title: 'write' }),
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'editing' } },
      edit('t2', '/a.ts', 'one\n', 'two\n'),
      // A fragment proves nothing and ends the chain for the path.
      edit('t3', '/a.ts', 'wo\n', 'WO\n'),
      // So the edit that would have chained onto it can no longer.
      edit('t4', '/a.ts', 'two\n', 'three\n'),
    ];
    const verdicts = run(stream);
    expect(verdicts).toEqual([
      [created('/a.ts')],
      undefined,
      [chained('/a.ts')],
      [unknown('/a.ts')],
      [unknown('/a.ts')],
    ]);
    expect(run(stream)).toEqual(verdicts);
  });

  it('a resent block keeps its verdict, and a new one is judged after it', () => {
    const resent = { type: 'diff', path: '/a.ts', oldText: 'one\n', newText: 'two\n' };
    const verdicts = run([
      edit('t1', '/a.ts', undefined, 'one\n', { sessionUpdate: 'tool_call', title: 'write' }),
      edit('t2', '/a.ts', 'one\n', 'two\n'),
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't2',
        content: [resent, { type: 'diff', path: '/a.ts', oldText: 'two\n', newText: 'three\n' }],
      },
    ]);
    expect(verdicts[2]).toEqual([chained('/a.ts'), { ...chained('/a.ts'), index: 1 }]);
  });

  it('a terminal status ends the row, so a later resend is judged afresh', () => {
    const verdicts = run([
      edit('t1', '/a.ts', undefined, 'one\n', { sessionUpdate: 'tool_call', title: 'write' }),
      edit('t2', '/a.ts', 'one\n', 'two\n', { status: 'completed' }),
      // The same block again on the same id: its verdict did not survive the
      // terminal status, and the chain has moved past `one\n`.
      edit('t2', '/a.ts', 'one\n', 'two\n'),
    ]);
    expect(verdicts).toEqual([[created('/a.ts')], [chained('/a.ts')], [unknown('/a.ts')]]);
  });

  it('a full tool_call is a new run, so it inherits no verdict', () => {
    const verdicts = run([
      edit('t1', '/a.ts', undefined, 'one\n', { sessionUpdate: 'tool_call', title: 'write' }),
      edit('t2', '/a.ts', 'one\n', 'two\n'),
      edit('t2', '/a.ts', 'one\n', 'two\n', { sessionUpdate: 'tool_call', title: 'edit again' }),
    ]);
    expect(verdicts).toEqual([[created('/a.ts')], [chained('/a.ts')], [unknown('/a.ts')]]);
  });

  it('ignores what the folder would not apply, leaving the chain intact', () => {
    const judge = createDiffCoverageJudge();
    expect(
      judge.push({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'write',
        content: [{ type: 'diff', path: '/a.ts', newText: 'one\n' }],
      }),
    ).toEqual([created('/a.ts')]);
    const break_ = [{ type: 'diff', path: '/a.ts', oldText: 'one\n', newText: 'x\n' }];
    for (const noise of [
      undefined,
      null,
      'tool_call',
      { sessionUpdate: 'plan', entries: [] },
      syntheticUsageUpdate({ inputTokens: 1, outputTokens: 1 }),
      // Row patches the folder rejects: no toolCallId, a non-array content, a
      // full tool_call without a title, a non-string title.
      { sessionUpdate: 'tool_call_update', content: break_ },
      { sessionUpdate: 'tool_call_update', toolCallId: 't9', content: 'one\n' },
      { sessionUpdate: 'tool_call', toolCallId: 't9', content: break_ },
      { sessionUpdate: 'tool_call', toolCallId: 't9', title: 42, content: break_ },
    ]) {
      expect(judge.push(noise)).toBeUndefined();
    }
    // The chain still holds exactly what the created diff left behind.
    expect(judge.push(edit('t2', '/a.ts', 'one\n', 'two\n'))).toEqual([chained('/a.ts')]);
  });
});

describe('plan state', () => {
  const entry = { content: 'step', priority: 'high', status: 'pending' };

  it('legacy plan and keyed plans coexist; removal keeps the legacy plan', () => {
    const folder = createFolder();
    const legacy = folder.push(seqInput(1, { sessionUpdate: 'plan', entries: [entry] }));
    const keyed = folder.push(
      seqInput(2, {
        sessionUpdate: 'plan_update',
        plan: { type: 'file', planId: 'p1', uri: 'file:///plan.md' },
      }),
    );
    const removed = folder.push(seqInput(3, { sessionUpdate: 'plan_removed', planId: 'p1' }));

    const legacyEvent = legacy[0]!.event;
    if (legacyEvent.type !== 'planState') throw new Error('unreachable');
    expect(legacyEvent.state.legacy).toHaveLength(1);
    expect(legacyEvent.state.keyed).toHaveLength(0);
    expect(legacyEvent.changedPlanId).toBeUndefined();

    const keyedEvent = keyed[0]!.event;
    if (keyedEvent.type !== 'planState') throw new Error('unreachable');
    expect(keyedEvent.changedPlanId).toBe('p1');
    expect(keyedEvent.state.keyed).toHaveLength(1);

    const removedEvent = removed[0]!.event;
    if (removedEvent.type !== 'planState') throw new Error('unreachable');
    expect(removedEvent.removedPlanId).toBe('p1');
    expect(removedEvent.state.keyed).toHaveLength(0);
    expect(removedEvent.state.legacy).toHaveLength(1);
  });

  it('a kind switch replaces the previous representation at the same planId', () => {
    const folder = createFolder();
    folder.push(
      seqInput(1, {
        sessionUpdate: 'plan_update',
        plan: { type: 'items', planId: 'p1', entries: [entry] },
      }),
    );
    const switched = folder.push(
      seqInput(2, {
        sessionUpdate: 'plan_update',
        plan: { type: 'markdown', planId: 'p1', content: '# P' },
      }),
    );
    const event = switched[0]!.event;
    if (event.type !== 'planState') throw new Error('unreachable');
    expect(event.state.keyed).toHaveLength(1);
    expect(event.state.keyed[0]).toEqual({ type: 'markdown', planId: 'p1', content: '# P' });
  });

  it('plan_removed does not remove the unkeyed legacy plan', () => {
    const folder = createFolder();
    folder.push(seqInput(1, { sessionUpdate: 'plan', entries: [entry] }));
    const removed = folder.push(seqInput(2, { sessionUpdate: 'plan_removed', planId: 'never-seen' }));
    const event = removed[0]!.event;
    if (event.type !== 'planState') throw new Error('unreachable');
    expect(event.state.legacy).toHaveLength(1);
  });
});

describe('usage state', () => {
  it('context values are latest-wins (never summed); omitted cost is retained', () => {
    const folder = createFolder();
    folder.push(
      seqInput(1, {
        sessionUpdate: 'usage_update',
        used: 10,
        size: 100,
        cost: { amount: 1, currency: 'USD' },
      }),
    );
    const second = folder.push(seqInput(2, { sessionUpdate: 'usage_update', used: 20, size: 200 }));
    const event = second[0]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.context).toEqual({ used: 20, size: 200 });
    expect(event.usage.cost).toEqual({ amount: 1, currency: 'USD' });
  });

  it('zero stays zero; currency change replaces without conversion', () => {
    const folder = createFolder();
    folder.push(
      seqInput(1, {
        sessionUpdate: 'usage_update',
        used: 10,
        size: 100,
        cost: { amount: 1, currency: 'USD' },
      }),
    );
    const zero = folder.push(
      seqInput(2, {
        sessionUpdate: 'usage_update',
        used: 0,
        size: 0,
        cost: { amount: 2, currency: 'EUR' },
      }),
    );
    const event = zero[0]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.context).toEqual({ used: 0, size: 0 });
    expect(event.usage.cost).toEqual({ amount: 2, currency: 'EUR' });
  });

  it('runskein envelope usage folds into the same usageState for usage_update', () => {
    const events = foldOne(
      seqInput(1, { sessionUpdate: 'usage_update', used: 1, size: 2 }, { usage: { input: 5, output: 7 } }),
    );
    expect(types(events)).toBe('usageState');
    const event = events[0]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.tokens).toEqual({ input: 5, output: 7 });
  });

  it('a runskein-synthesized token report folds through the ordinary path', () => {
    // The cross-package anchor: core's own synthesized update, not a
    // hand-written stand-in, so a change to either side breaks this test
    // rather than only the consumer.
    const update = syntheticUsageUpdate({ input: 1005, output: 2119, total: 3124 });
    const events = foldOne(seqInput(1, update, { usage: { input: 1005, output: 2119, total: 3124 } }));
    expect(types(events)).toBe('usageState');
    const event = events[0]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.tokens).toEqual({ input: 1005, output: 2119, total: 3124 });
    expect(event.usage.context).toBeUndefined();
  });

  it('window and token channels coexist without overwriting each other', () => {
    const folder = createFolder();
    folder.push(
      seqInput(1, syntheticUsageUpdate({ input: 5, output: 7, total: 12 }), {
        usage: { input: 5, output: 7, total: 12 },
      }),
    );
    const windowed = folder.push(seqInput(2, { sessionUpdate: 'usage_update', used: 20, size: 200 }));
    const event = windowed[0]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.context).toEqual({ used: 20, size: 200 });
    expect(event.usage.tokens).toEqual({ input: 5, output: 7, total: 12 });
  });

  // Also the pin on the marker string itself: were core to rename it, this
  // event would arrive unmarked and fold would call it malformed.
  it('a marked usage_update with nothing to report is accepted silently', () => {
    const events = foldOne(seqInput(1, syntheticUsageUpdate({})));
    expect(events).toEqual([]);
  });

  it('an unmarked usage_update carrying only body token fields stays raw', () => {
    // Body token names are the transcript describing itself; for a
    // prompt-response-sourced engine core keeps them off the envelope so they
    // are counted once. Reading them here would count them twice.
    const folder = createFolder();
    folder.push(seqInput(1, { sessionUpdate: 'usage_update', used: 1, size: 2 }, { usage: { input: 3 } }));
    const events = folder.push(
      seqInput(2, { sessionUpdate: 'usage_update', inputTokens: 999, outputTokens: 888 }),
    );
    expect(types(events)).toBe('raw');
    const raw = events[0]!.event;
    if (raw.type !== 'raw') throw new Error('unreachable');
    expect(raw.reason).toBe('malformed-known-update');
    const after = folder.push(seqInput(3, { sessionUpdate: 'usage_update', used: 4, size: 5 }));
    const state = after[0]!.event;
    if (state.type !== 'usageState') throw new Error('unreachable');
    expect(state.usage.tokens).toEqual({ input: 3 });
  });

  it('a cost-only usage_update folds without a window gauge', () => {
    const events = foldOne(
      seqInput(1, { sessionUpdate: 'usage_update', cost: { amount: 3, currency: 'USD' } }),
    );
    expect(types(events)).toBe('usageState');
    const event = events[0]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.cost).toEqual({ amount: 3, currency: 'USD' });
    expect(event.usage.context).toBeUndefined();
  });

  it('an explicit null window half reads as absent, not as a broken gauge', () => {
    const nulls = foldOne(
      seqInput(1, { sessionUpdate: 'usage_update', used: null, size: null }, { usage: { input: 9 } }),
    );
    expect(types(nulls)).toBe('usageState');
    const event = nulls[0]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.tokens).toEqual({ input: 9 });
    expect(event.usage.context).toBeUndefined();
    // One half present is still half a gauge, whatever the other half is.
    expect(types(foldOne(seqInput(2, { sessionUpdate: 'usage_update', used: null, size: 200 })))).toBe(
      'raw',
    );
  });

  it('a malformed window never pollutes the token channel', () => {
    const folder = createFolder();
    folder.push(seqInput(1, { sessionUpdate: 'usage_update', used: 1, size: 2 }, { usage: { input: 3 } }));
    const events = folder.push(
      seqInput(2, { sessionUpdate: 'usage_update', used: 'x', size: 1 }, { usage: { input: 42 } }),
    );
    expect(types(events)).toBe('raw');
    const after = folder.push(seqInput(3, { sessionUpdate: 'usage_update', used: 4, size: 5 }));
    const state = after[0]!.event;
    if (state.type !== 'usageState') throw new Error('unreachable');
    expect(state.usage.tokens).toEqual({ input: 3 });
    expect(state.usage.context).toEqual({ used: 4, size: 5 });
  });

  it('envelope usage on another valid update emits a trailing usageState', () => {
    const events = foldOne(
      seqInput(1, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }, { usage: { input: 5 } }),
    );
    expect(types(events)).toBe('notice,usageState');
    const event = events[1]!.event;
    if (event.type !== 'usageState') throw new Error('unreachable');
    expect(event.usage.tokens).toEqual({ input: 5 });
  });

  it('envelope usage on an unknown update is NOT folded (validation first)', () => {
    const events = foldOne(seqInput(1, { sessionUpdate: 'mystery_update' }, { usage: { input: 5 } }));
    expect(types(events)).toBe('raw');
  });
});

describe('raw pass-through and malformed input', () => {
  it('unknown sessionUpdate emits raw unknown-update and closes the open stream', () => {
    const folder = createFolder();
    folder.push(seqInput(1, text('x')));
    const events = folder.push(seqInput(2, { sessionUpdate: 'mystery_update', foo: 'bar' }));
    expect(types(events)).toBe('messageEnd,raw');
    const raw = events[1]!.event;
    if (raw.type !== 'raw') throw new Error('unreachable');
    expect(raw.reason).toBe('unknown-update');
    expect(raw.update).toEqual({ sessionUpdate: 'mystery_update', foo: 'bar' });
  });

  it('a primitive/non-object update emits raw unknown-update', () => {
    for (const update of ['nope', 42, null]) {
      const events = foldOne(seqInput(1, update));
      expect(types(events)).toBe('raw');
      const raw = events[0]!.event;
      if (raw.type !== 'raw') throw new Error('unreachable');
      expect(raw.reason).toBe('unknown-update');
    }
  });

  it('a non-object INPUT emits raw invalid-envelope without throwing', () => {
    const events = createFolder().push(null as unknown as FoldInput);
    expect(types(events)).toBe('raw');
    const raw = events[0]!.event;
    if (raw.type !== 'raw') throw new Error('unreachable');
    expect(raw.reason).toBe('invalid-envelope');
  });

  it('unknown content block type folds to a forward-compatible content event', () => {
    const events = foldOne(
      seqInput(1, { sessionUpdate: 'agent_message_chunk', content: { type: 'weird', x: 1 } }),
    );
    expect(types(events)).toBe('content');
  });

  it.each([
    ['tool_call without title', { sessionUpdate: 'tool_call', toolCallId: 't1' }],
    ['tool_call_update without toolCallId', { sessionUpdate: 'tool_call_update', status: 'completed' }],
    ['plan without entries', { sessionUpdate: 'plan' }],
    [
      'plan_update with unknown plan type',
      { sessionUpdate: 'plan_update', plan: { type: 'weird', planId: 'p' } },
    ],
    ['plan_removed without planId', { sessionUpdate: 'plan_removed' }],
    ['usage_update with non-number used', { sessionUpdate: 'usage_update', used: 'x', size: 1 }],
    ['usage_update without the required window gauge', { sessionUpdate: 'usage_update' }],
    ['usage_update with half a window gauge', { sessionUpdate: 'usage_update', used: 1 }],
    ['usage_update with a NaN window half', { sessionUpdate: 'usage_update', used: Number.NaN, size: 1 }],
    [
      'usage_update with malformed cost',
      { sessionUpdate: 'usage_update', used: 1, size: 1, cost: { amount: 'x' } },
    ],
    ['available_commands_update without array', { sessionUpdate: 'available_commands_update' }],
    ['chunk with missing content', { sessionUpdate: 'agent_message_chunk' }],
    [
      'chunk with non-string text',
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 1 } },
    ],
  ])('malformed known variant (%s) emits raw malformed-known-update', (_name, update) => {
    const events = foldOne(seqInput(1, update));
    expect(types(events)).toBe('raw');
    const raw = events[0]!.event;
    if (raw.type !== 'raw') throw new Error('unreachable');
    expect(raw.reason).toBe('malformed-known-update');
  });

  it('a malformed patch never partially mutates tool state', () => {
    const folder = createFolder();
    folder.push(seqInput(1, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 't' }));
    const malformed = folder.push(
      seqInput(2, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: 'not-an-array',
      }),
    );
    expect(types(malformed)).toBe('raw');
    // The row survived unpatched: status was NOT applied, so no eviction.
    const { row } = onlyToolRow(
      folder.push(seqInput(3, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 't2' })),
    );
    expect(row.status).toBeUndefined();
    expect(row.title).toBe('t2');
  });
});

describe('envelope discipline', () => {
  it('duplicate/decreasing seq and foreign session/engine emit non-mutating invalid-envelope raw', () => {
    const folder = createFolder();
    folder.push(seqInput(1, text('x')));

    const dup = folder.push(seqInput(1, text('y')));
    expect(types(dup)).toBe('raw');
    const dupRaw = dup[0]!.event;
    if (dupRaw.type !== 'raw') throw new Error('unreachable');
    expect(dupRaw.reason).toBe('invalid-envelope');

    const foreignSession = folder.push({ ...seqInput(2, text('y')), sessionId: 'other' });
    const foreignEngine = folder.push({ ...seqInput(2, text('y')), engineId: 'other' });
    expect(types(foreignSession)).toBe('raw');
    expect(types(foreignEngine)).toBe('raw');

    // Rejected inputs did not close the still-open message stream.
    expect(types(folder.push(seqInput(2, text('z'))))).toBe('messageAppend');
  });

  it('a non-finite seq is rejected, and does not disarm the ordering check', () => {
    const folder = createFolder();
    folder.push(seqInput(1, text('x')));

    // NaN passes `typeof === 'number'` and compares false against everything,
    // so accepting it would store NaN as the high-water mark and every later
    // comparison would be false too — silently ending order enforcement.
    const nan = folder.push({ ...seqInput(2, text('y')), seq: Number.NaN });
    const nanRaw = nan[0]!.event;
    if (nanRaw.type !== 'raw') throw new Error('unreachable');
    expect(nanRaw.reason).toBe('invalid-envelope');

    const infinite = folder.push({ ...seqInput(2, text('y')), seq: Number.POSITIVE_INFINITY });
    expect(types(infinite)).toBe('raw');

    // The proof that the high-water mark was left alone: seq 1 is still a
    // repeat and seq 2 is still the next valid input.
    expect(types(folder.push(seqInput(1, text('z'))))).toBe('raw');
    expect(types(folder.push(seqInput(2, text('z'))))).toBe('messageAppend');
  });

  it('a from-seq gap is accepted and binds the folder', () => {
    const events = foldOne(seqInput(41, text('late start')));
    expect(types(events)).toBe('messageStart,messageAppend');
    expect(events[0]!.source.seq).toBe(41);
  });

  it('an identity-valid envelope binds even when its update becomes raw', () => {
    const folder = createFolder();
    folder.push(seqInput(5, { sessionUpdate: 'mystery_update' }));
    // seq 4 is now a decrease → rejected, proving the raw input still bound.
    const decreasing = folder.push(seqInput(4, text('y')));
    const raw = decreasing[0]!.event;
    if (raw.type !== 'raw') throw new Error('unreachable');
    expect(raw.reason).toBe('invalid-envelope');
  });
});

describe('whole-transcript tool-call collection', () => {
  const subAgentRun: FoldInput[] = [
    seqInput(1, text('starting')),
    seqInput(2, {
      sessionUpdate: 'tool_call',
      toolCallId: 'task-1',
      title: 'Task',
      kind: 'other',
      status: 'pending',
    }),
    seqInput(3, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'task-1',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text: 'partial' } }],
    }),
    seqInput(4, {
      sessionUpdate: 'tool_call',
      toolCallId: 'other-1',
      title: 'Read',
      kind: 'read',
    }),
    seqInput(5, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'task-1',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'report line one' } },
        { type: 'diff', path: '/tmp/x', newText: 'x' },
        { type: 'content', content: { type: 'text', text: 'report line two' } },
      ],
    }),
  ];

  it('keeps the settled row per id, in first-seen order', () => {
    const rows = collectToolRows(subAgentRun);
    expect([...rows.keys()]).toEqual(['task-1', 'other-1']);
    const task = rows.get('task-1')!;
    expect(task.status).toBe('completed');
    expect(task.title).toBe('Task');
    expect(task.content).toHaveLength(3);
  });

  it('joins only the text a tool call reported', () => {
    const rows = collectToolRows(subAgentRun);
    expect(toolCallText(rows.get('task-1')!)).toBe('report line one\n\nreport line two');
    expect(toolCallText(rows.get('other-1')!)).toBe('');
  });

  it('ignores unknown and malformed tool content instead of throwing', () => {
    const rows = collectToolRows([
      seqInput(1, {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 't',
        content: [
          { type: 'weird-tool', y: 2 },
          { type: 'content', content: { type: 'text', text: 'kept' } },
          { type: 'content', content: null },
          { type: 'content', content: { type: 'text' } },
        ],
      }),
    ]);
    expect(toolCallText(rows.get('t1')!)).toBe('kept');
  });

  it('falls back to a string rawOutput only when no text block was reported', () => {
    const rows = collectToolRows([
      seqInput(1, {
        sessionUpdate: 'tool_call',
        toolCallId: 'raw-only',
        title: 't',
        rawOutput: 'the whole result',
      }),
      seqInput(2, {
        sessionUpdate: 'tool_call',
        toolCallId: 'both',
        title: 't',
        content: [{ type: 'content', content: { type: 'text', text: 'from content' } }],
        rawOutput: 'ignored',
      }),
      seqInput(3, {
        sessionUpdate: 'tool_call',
        toolCallId: 'object-raw',
        title: 't',
        rawOutput: { ok: true },
      }),
    ]);
    expect(toolCallText(rows.get('raw-only')!)).toBe('the whole result');
    expect(toolCallText(rows.get('both')!)).toBe('from content');
    expect(toolCallText(rows.get('object-raw')!)).toBe('');
  });

  it('an id re-used after a terminal status keeps the later run', () => {
    const rows = collectToolRows([
      seqInput(1, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'first' }),
      seqInput(2, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
      seqInput(3, { sessionUpdate: 'tool_call_update', toolCallId: 't1', title: 'second' }),
    ]);
    expect(rows.size).toBe(1);
    expect(rows.get('t1')!.title).toBe('second');
    expect(rows.get('t1')!.status).toBeUndefined();
  });

  it('a transcript without tool calls collects nothing', () => {
    expect(collectToolRows([seqInput(1, text('hi'))]).size).toBe(0);
  });
});
