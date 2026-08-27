#!/usr/bin/env node
/**
 * Render the generated tables of `docs/capability-matrix.md` from the probe
 * data in `docs/conformance/matrix.public.json`, so the published capability
 * tables cannot silently drift from measured reality (the kimi `session/close`
 * cell rotted for two releases before anyone noticed).
 *
 * The input is the publishable projection rather than the probe's full
 * `matrix.json`, which carries the operator's own machine configuration and so
 * never leaves this repository. Reading the projection is what lets this script
 * run unchanged in the release repository — see
 * `scripts/project-conformance-matrix.mjs`, which keeps the two in step.
 *
 * Ownership boundaries:
 * - In the lifecycle and conversation blocks the script owns the Measured cells
 *   of the rows listed in LIFECYCLE_ROWS / CONVERSATION_ROWS, plus the engine
 *   list in each block's header cell. Cells carry only measured facts: labels,
 *   symbol sequences, and aggregates read from the matrix — no design prose,
 *   which would rot just as surely here as in the document (it lives in
 *   footnotes below the tables instead). Tier and API columns are design
 *   judgement and stay human-edited; rows without a measurable oracle (Cancel
 *   active turn, Attach) are not spec'd and never touched.
 * - The built-in support block is generated whole — every cell of it is read
 *   from the matrix, so there is nothing in it for a human to own. It used to
 *   be hand-maintained in `docs/engine-support.md`, which is precisely how it
 *   came to disagree with the matrix it claimed to summarize.
 *
 * Usage:
 *   node scripts/generate-capability-tables.mjs          # rewrite in place
 *   node scripts/generate-capability-tables.mjs --check  # exit 1 on drift
 *   node scripts/generate-capability-tables.mjs --check --matrix=<path>
 *
 * `--matrix` exists for one caller: the projection check, which renders from the
 * full matrix to prove the projection loses nothing this script reads.
 */
import { readFileSync, writeFileSync } from 'node:fs';

// Both language peers of the same page. The generated blocks are written
// identically into each: they are measurement output, not prose — the same
// reason `matrix.public.json` is not translated and a code block is not. The
// legend above them is translated, so a reader of either page can read the
// symbols. Writing both here is what stops the Chinese peer from silently
// holding last month's measurements.
//
// What this does not synchronise: the hand-maintained Capability, Tier and API
// columns live inside the markers and are preserved per document, so an edit to
// them in one page does not reach the other. An edit on the English side is
// caught — the published-document hash gate fails until the peer is revisited.
// An edit made only in the peer is caught by nothing here, which is the honest
// limit of this arrangement.
const DOC_PATHS = ['docs/capability-matrix.md', 'docs/capability-matrix.zh-CN.md'];
const DEFAULT_MATRIX_PATH = 'docs/conformance/matrix.public.json';
const CHECK = process.argv.includes('--check');
const MATRIX_PATH =
  process.argv.find((arg) => arg.startsWith('--matrix='))?.slice('--matrix='.length) ?? DEFAULT_MATRIX_PATH;

const CODES = { opencode: 'oc', kimi: 'ki', 'claude-code': 'cl', codex: 'cx', pi: 'pi' };

// Display names for the built-in support table. Deliberately not
// `agentInfo.name` from the matrix: that is what the engine called itself on
// the probe run, so it carries transient decoration (pi reports its shim, and
// the recorded value still names the pre-rename product) into a published
// table whose first column should just identify the engine.
const NAMES = {
  opencode: 'OpenCode',
  kimi: 'Kimi Code',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  pi: 'pi',
};

/**
 * @param {boolean | string | undefined} value - matrix value for one engine
 * @returns {'✓' | '✗' | '—'} supported / probed and explicitly unsupported / wire capability not advertised
 */
function symbol(value) {
  if (value === true) return '✓';
  if (value === false) return '✗';
  return '—'; // 'not-supported' or absent from the probe result
}

const matrix = JSON.parse(readFileSync(MATRIX_PATH, 'utf8'));
const engines = matrix.map((entry) => entry.id);
// Loud failure on an unlisted engine: a silent empty abbreviation in the
// header would hide exactly the drift this script exists to catch.
const codes = engines.map((id) => {
  const code = CODES[id];
  if (!code) {
    console.error(
      `generate-capability-tables: engine "${id}" has no abbreviation in CODES — add it or update the spec`,
    );
    process.exit(1);
  }
  if (!NAMES[id]) {
    console.error(`generate-capability-tables: engine "${id}" has no display name in NAMES — add it`);
    process.exit(1);
  }
  return code;
});

/** Read a dot-path value from one matrix entry. */
function capOf(entry, path) {
  let value = entry;
  for (const key of path.split('.')) {
    value = value?.[key];
    if (value === undefined) return undefined;
  }
  return value;
}

/** Symbols for one capability across all engines, joined by `joiner`. */
function symbolsFor(path, joiner) {
  return engines.map((_, i) => symbol(capOf(matrix[i], path))).join(joiner);
}

/** All-engines ✅ row: every bundled engine passes the same conformance gate. */
function coreSymbols() {
  return Array(engines.length).fill('✅').join(' ');
}

/** ` · all \`X\`` when every probe turn ended with the same stop reason. */
function stopReasonSuffix() {
  const reasons = engines.map((_, i) => capOf(matrix[i], 'prompt.stopReason'));
  if (reasons.some((reason) => reason === undefined)) return '';
  if (new Set(reasons).size !== 1) return ` · mixed (${reasons.join('/')})`;
  return ` · all \`${reasons[0]}\``;
}

/** "`promptCapabilities.image`: true on oc·ki, false on cl" style cell. */
function boolGroupsCell(path, label) {
  const yes = engines.filter((_, i) => capOf(matrix[i], path) === true).map((id) => CODES[id]);
  const no = engines.filter((_, i) => capOf(matrix[i], path) === false).map((id) => CODES[id]);
  const parts = [`true on ${yes.length === engines.length ? 'all' : yes.join('·')}`];
  if (no.length > 0) parts.push(`false on ${no.join('·')}`);
  return `\`${label}\`: ${parts.join(', ')}`;
}

// Capability → Measured-cell template. Everything literal here is either a
// structural label or an aggregate computed from the matrix above.
const LIFECYCLE_ROWS = {
  'New session': () => coreSymbols(),
  'Prompt (turn promise)': () => `${coreSymbols()}${stopReasonSuffix()}`,
  'Streaming updates': () => coreSymbols(),
  'Close session': () => symbolsFor('capabilities.session.close', ' · '),
  '**Resume**': () => `native \`session/resume\`: ${symbolsFor('capabilities.session.resume', ' ')}`,
  'Load (history replay)': () => `\`loadSession\`: ${symbolsFor('capabilities.loadSession', ' ')}`,
  Fork: () => symbolsFor('capabilities.session.fork', ' · '),
  'List sessions': () => `wire \`session/list\`: ${symbolsFor('capabilities.session.list', ' ')}`,
};

const CONVERSATION_ROWS = {
  'Text out (chunks)': () => `✅×${engines.length}`,
  'Multimodal prompt': () => {
    const audioFalse = engines.filter((_, i) => capOf(matrix[i], 'capabilities.prompt.audio') === false);
    const base = boolGroupsCell('capabilities.prompt.image', 'promptCapabilities.image');
    const note =
      audioFalse.length > 0 && audioFalse.length < engines.length
        ? `; ${audioFalse.map((id) => CODES[id]).join('·')} additionally ${audioFalse.length > 1 ? 'report' : 'reports'} \`audio: false\``
        : '';
    return base + note;
  },
  'Available commands': () => {
    const missing = engines.filter(
      (_, i) => !(capOf(matrix[i], 'prompt.updateKinds.available_commands_update') > 0),
    );
    if (missing.length > 0) return `not observed on ${missing.map((id) => CODES[id]).join('·')}`;
    return `observed on all`;
  },
};

// One column of the built-in support table: a header label and the matrix path
// behind it. Adding a capability here is the whole edit — the rows follow.
const SUPPORT_COLUMNS = [
  ['Native resume', 'capabilities.session.resume'],
  ['Load', 'capabilities.loadSession'],
  ['Fork', 'capabilities.session.fork'],
  ['List', 'capabilities.session.list'],
  ['Delete', 'capabilities.session.delete'],
  ['Image input', 'capabilities.prompt.image'],
  ['MCP HTTP', 'capabilities.mcp.http'],
  ['MCP SSE', 'capabilities.mcp.sse'],
  ['Providers', 'capabilities.providers'],
];

/**
 * Whether the probe read real token numbers off this engine's wire.
 * @param {object} entry - one matrix entry.
 * @returns {'✓' | '✗' | '—'} `—` when the probe recorded no usage section at all.
 */
function usageSymbol(entry) {
  const fields = capOf(entry, 'usage.fields');
  if (fields === undefined) return '—';
  return fields.length > 0 ? '✓' : '✗';
}

/** Header and body of the built-in support table, every cell read from the matrix. */
function supportTable() {
  const header = ['Engine', 'Measured version', ...SUPPORT_COLUMNS.map(([label]) => label), 'Token usage'];
  const rows = matrix.map((entry) => [
    NAMES[entry.id],
    capOf(entry, 'agentInfo.version') ?? '—',
    ...SUPPORT_COLUMNS.map(([, path]) => symbol(capOf(entry, path))),
    usageSymbol(entry),
  ]);
  return { header, rows };
}

const BLOCKS = [
  {
    marker: 'lifecycle-capabilities',
    specs: LIFECYCLE_ROWS,
    // The engine list lives in this header and is rendered, never hand-typed,
    // so it cannot fall behind the actual column count.
    headerMeasured: () => `Measured (${codes.join('·')})`,
  },
  { marker: 'conversation-capabilities', specs: CONVERSATION_ROWS, headerMeasured: () => 'Measured' },
  { marker: 'builtin-support', table: supportTable },
];

/** Parse one markdown table line into its trimmed cells. */
function parseRow(line) {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/**
 * Rewrite every generated block of one document.
 *
 * @param {string} docPath - the page to render into, repository-relative.
 * @returns {{ nextDoc: string, driftedBlocks: string[] }} the rendered document
 *   and the markers whose current content did not already match it.
 */
function renderDocument(docPath) {
  const driftedBlocks = [];
  let nextDoc;
  try {
    nextDoc = readFileSync(docPath, 'utf8');
  } catch (cause) {
    // Both peers are required. A raw ENOENT names the file but not the reason,
    // and the reason is the useful half: this page is generated into every
    // language peer, so a missing one is a page that would silently stop being
    // regenerated.
    throw new Error(
      `${docPath} is missing, and the capability tables are generated into every language peer of ` +
        `this page (${DOC_PATHS.join(', ')}). Restore it, or drop it from DOC_PATHS in this script.`,
      { cause },
    );
  }

  for (const { marker, specs, headerMeasured, table } of BLOCKS) {
    const open = `<!-- generated:${marker} -->`;
    const close = `<!-- /generated:${marker} -->`;
    const start = nextDoc.indexOf(open);
    const end = nextDoc.indexOf(close, start);
    if (start === -1 || end === -1) {
      console.error(`generate-capability-tables: markers for ${marker} missing in ${docPath}`);
      process.exit(1);
    }
    const inner = nextDoc.slice(start + open.length + 1, end - 1);

    // Two block shapes. A `table` block is generated whole, so whatever the
    // document currently holds between the markers is discarded rather than
    // parsed — there is no hand-owned cell in it to preserve. Every other block
    // keeps its hand-written rows and has only its Measured cell rewritten;
    // non-table lines inside it (e.g. <!-- prettier-ignore -->) are kept verbatim.
    let lines;
    if (table) {
      const { header, rows: bodyRows } = table();
      lines = [
        { line: '<!-- prettier-ignore -->', cells: null },
        { cells: header },
        { separator: true },
        ...bodyRows.map((cells) => ({ cells })),
        // Prettier wants a blank line between a table and the HTML comment that
        // follows it. Emitting it here is what keeps `trunk check --fix` and this
        // generator from undoing each other on every run; the hand-row blocks
        // carry the same blank line in the document, where it round-trips as an
        // ordinary non-table line.
        { line: '', cells: null },
      ];
    } else {
      lines = inner
        .split('\n')
        .map((line) => ({ line, cells: line.startsWith('|') ? parseRow(line) : null }));
    }
    const rows = lines.filter((entry) => entry.cells).map((entry) => entry.cells);
    const columnCount = Math.max(...rows.map((cells) => cells.length));

    if (!table) {
      for (const cells of rows) {
        if (cells[0] === 'Capability') cells[columnCount - 1] = headerMeasured();
        else {
          const render = specs[cells[0]];
          if (render) cells[columnCount - 1] = render();
        }
      }

      // A spec whose row vanished (renamed capability column, restructured table)
      // would silently stop being managed — surface it instead.
      const labels = new Set(rows.map((cells) => cells[0]));
      for (const label of Object.keys(specs)) {
        if (!labels.has(label)) {
          console.error(`generate-capability-tables: no row "${label}" in block ${marker}`);
          process.exit(1);
        }
      }
    }

    // Re-align every column of every line so the table stays readable after
    // regeneration; widths are block-wide, hence idempotent across runs.
    const widths = Array.from({ length: columnCount }, (_, col) =>
      Math.max(...rows.map((cells) => (cells[col] ?? '').length)),
    );
    const renderedLines = lines.map((entry) => {
      if (entry.separator) return `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
      return entry.cells
        ? `| ${entry.cells.map((cell, col) => (cell ?? '').padEnd(widths[col])).join(' | ')} |`
        : entry.line;
    });

    const rendered = renderedLines.join('\n');
    const current = `${open}\n${inner}\n${close}`;
    if (rendered !== inner) driftedBlocks.push(marker);
    // split/join instead of String.replace: replacement text containing `$&`
    // or `` $` `` would otherwise be interpreted as a replacement pattern.
    nextDoc = nextDoc.split(current).join(`${open}\n${rendered}\n${close}`);
  }

  return { nextDoc, driftedBlocks };
}

const renderedDocs = DOC_PATHS.map((docPath) => ({ docPath, ...renderDocument(docPath) }));
const stale = renderedDocs.filter((entry) => entry.driftedBlocks.length > 0);

if (CHECK) {
  if (stale.length > 0) {
    console.error(
      `${stale
        .map((entry) => `capability tables stale in ${entry.docPath}: ${entry.driftedBlocks.join(', ')}`)
        .join('\n')}\nRerun \`node scripts/generate-capability-tables.mjs\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    `capability tables match ${MATRIX_PATH} (${engines.length} engines) in ${DOC_PATHS.length} document(s)`,
  );
} else {
  for (const { docPath, nextDoc } of renderedDocs) writeFileSync(docPath, nextDoc);
  console.log(
    `capability tables regenerated (${engines.length} engines: ${codes.join('·')}) ` +
      `in ${DOC_PATHS.join(', ')}`,
  );
}
