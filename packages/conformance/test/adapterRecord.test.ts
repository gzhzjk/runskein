/**
 * The committed adapter conformance records, against the rule that produces
 * them.
 *
 * `adapters/<id>/conformance.json` is exported to the release repository, and
 * `docs/conformance/matrix.json` — which holds the same measurement, whole — is
 * not. The record is the projection of its own matrix row, so that is checkable
 * from two committed files with no engine and no probe, which is what makes it
 * a test rather than a promise.
 *
 * It is a test and not a step in `pnpm quality` because the release repository
 * has to run it too: its CI runs `pnpm quality` and `pnpm test`, and this rule
 * is the one keeping a leak out of that repository, so it belongs in the half
 * that runs in both.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectAdapterRecord, type ProbeSummaryLike } from '../src/adapterRecord.js';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');
const SOURCE = 'docs/conformance/matrix.json';

// The source of truth is the file the export withholds, so these cases can only
// run where the leak could be introduced — here. In the release repository the
// records have already been projected and `matrix.json` is absent by design, so
// the suite skips rather than reading a file that is not there. The two cases
// that need no source of truth stay live in both.
const haveSource = existsSync(resolve(root, SOURCE));
const matrix: (ProbeSummaryLike & { id: string })[] = haveSource ? JSON.parse(read(SOURCE)) : [];

describe.skipIf(!haveSource)('committed adapter conformance records', () => {
  it('covers every engine the matrix measured', () => {
    // Guards the fixture: rows the matrix stopped carrying would otherwise let
    // the cases below pass by having nothing to check.
    expect(matrix.map((row) => row.id).sort()).toEqual(['claude-code', 'codex', 'kimi', 'opencode', 'pi']);
  });

  it.each(matrix.map((row) => row.id))('%s is the projection of its matrix row', (id) => {
    const row = matrix.find((entry) => entry.id === id);
    expect(row).toBeDefined();
    // Byte-for-byte, not deep-equal: the file is committed, and the probe
    // writes it with this exact serialisation. A record that only *parses* the
    // same would still arrive as a whole-file reformat on the next probe.
    expect(read(`adapters/${id}/conformance.json`)).toBe(
      `${JSON.stringify(projectAdapterRecord(row!), null, 2)}\n`,
    );
  });

  // The two cuts, named rather than left to the equality above: those are what
  // the file is exported under, and a reader of a failure should be told which
  // one broke.
  it.each(matrix.map((row) => row.id))('%s publishes no free text and no option values', (id) => {
    const record = JSON.parse(read(`adapters/${id}/conformance.json`)) as ProbeSummaryLike;
    expect(record.prompt).not.toHaveProperty('replyText');
    for (const option of record.configOptions ?? []) {
      expect(option).not.toHaveProperty('options');
      expect(option).toHaveProperty('optionCount');
    }
  });
});

describe('projectAdapterRecord', () => {
  it('keeps the input key order, so a refresh diffs as a measurement', () => {
    const projected = projectAdapterRecord({
      id: 'x',
      configOptions: [{ id: 'model', name: 'Model', type: 'select', options: [{ value: 'a' }] }],
      prompt: { stopReason: 'end_turn', replyText: 'hello' },
      close: 'closed',
    });
    expect(Object.keys(projected)).toEqual(['id', 'configOptions', 'prompt', 'close']);
  });

  it('counts a grouped option by its leaf settings', () => {
    // No engine has published groups yet, but the shape is legal and the live
    // suite's own reader flattens it. Counting a group as one setting would
    // report three providers as one.
    const projected = projectAdapterRecord({
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          options: [{ options: [{ value: 'a' }, { value: 'b' }] }, { value: 'c' }],
        },
      ],
    });
    expect(projected.configOptions?.[0]?.optionCount).toBe(3);
  });

  it('records an unreadable option list rather than failing the probe write', () => {
    // The probe records what the engine put on the wire, not something core has
    // normalised. An entry in neither known shape counts as one setting: the
    // count is then wrong by however much the engine surprised us, and the
    // write still happens, which is the trade this file's comment argues for.
    const projected = projectAdapterRecord({
      configOptions: [
        { id: 'x', name: 'X', type: 'select', options: ['bare', 42] },
        { id: 'y', name: 'Y', type: 'string', options: undefined },
      ],
    });
    expect(projected.configOptions?.map((option) => option.optionCount)).toEqual([2, 0]);
  });

  it('leaves the input alone', () => {
    const input = {
      configOptions: [{ id: 'm', name: 'M', type: 'select', options: [{ value: 'a' }] }],
      prompt: { replyText: 'secret' },
    };
    projectAdapterRecord(input);
    expect(input.configOptions[0]?.options).toEqual([{ value: 'a' }]);
    expect(input.prompt.replyText).toBe('secret');
  });
});
