/**
 * Terminal presenter for folded presentation events, plus terminal-safe
 * output primitives.
 *
 * The presenter consumes the Folder's PresentationEvent stream: message
 * chunks share one line per stream (prefix written once at messageStart,
 * text appended inline, line terminated at messageEnd); tool rows repaint
 * only on visible change (status/title/kind/name/locations or a terminal
 * state), with pure content/rawInput growth coalesced until the terminal
 * repaint. Every level falls back to raw JSON so nothing is silently
 * dropped.
 *
 * Every string originating outside the CLI passes through `sanitize()`
 * before being written — including inline stream appends; the CLI's own
 * ANSI (dimming) is applied only after sanitization.
 */
import type {
  CapabilityMatrix,
  ConfigOption,
  EngineDescriptor,
  EngineInfo,
  SelectGroup,
  SelectOption,
} from '@runskein/core';

type OutputError = Error & { code?: string };

let stdoutUnavailable = false;
let stderrUnavailable = false;
let outputClosedSignalled = false;
let unexpectedOutputFailure: unknown;
let resolveOutputClosed!: () => void;

/** Resolves once stdout/stderr closes early, allowing chat to run normal cleanup. */
export const outputClosed = new Promise<void>((resolve) => {
  resolveOutputClosed = resolve;
});

function recordOutputError(error: OutputError): void {
  if (error.code !== 'EPIPE') unexpectedOutputFailure = error;
  if (!outputClosedSignalled) {
    outputClosedSignalled = true;
    resolveOutputClosed();
  }
}

process.stdout.on('error', (error: OutputError) => {
  stdoutUnavailable = true;
  recordOutputError(error);
});
process.stderr.on('error', (error: OutputError) => {
  stderrUnavailable = true;
  recordOutputError(error);
});

/**
 * The first non-EPIPE output write failure, if any. A closed pipe is a normal
 * way for a CLI to end, but any other stream failure must still reach the
 * process exit code.
 * @returns the stored error, or undefined when output never failed.
 */
export function getOutputFailure(): unknown {
  return unexpectedOutputFailure;
}
import type { ContentBlock, ToolCallContent, Usage } from '@runskein/core';
import type {
  FoldedEvent,
  FoldedToolCallContent,
  KeyedPlanState,
  MessageKind,
  NoticeUpdate,
  ToolRow,
  ToolRowField,
  UnknownContentBlock,
  UsageState,
} from '@runskein/fold';

// ── terminal sanitizer ──────────────────────────────────────────────

/**
 * Make engine-supplied text safe to write to a terminal by stripping escape
 * sequences and control characters. Newline, tab, and printable Unicode
 * survive; everything that could move the cursor or reprogram the terminal
 * does not.
 * @param input - the raw string.
 * @returns the terminal-safe string.
 */
export function sanitize(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '') // OSC … BEL | ST
    .replace(/\x1b[PX^_][\s\S]*?(?:\x1b\\|$)/g, '') // DCS/SOS/PM/APC … ST
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '') // remaining ESC Fe/Fs sequences
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '') // C0 except \t \n (incl. stray ESC), DEL
    .replace(/[\u0080-\u009f]/g, ''); // C1
}

/**
 * Wrap text in the CLI's own dimming escape codes. Sanitization runs first, so
 * these are the only escapes that survive to the terminal.
 * @param text - the text to dim.
 * @returns the dimmed text.
 */
function dim(text: string): string {
  return `\u001b[2m${sanitize(text)}\u001b[0m`;
}

// ── shared streaming line ─────────────────────────────────────────────

// One open message stream owns the current stdout line: its prefix is
// written once, chunk text appended inline, and the line terminated when
// the stream ends. Any other output flushes the line first so labels never
// land mid-stream. A flush only breaks the VISUAL line — the fold stream
// may still be open (CLI-local output is invisible to the folder), so the
// next append re-opens the line with a fresh prefix instead of stranding
// text prefix-less on a new line.
let streamLineOpen = false;
let streamDimmed = false;
let streamKind: MessageKind | undefined;

/**
 * Write already-formatted text to stdout without a newline, honoring the
 * EPIPE guard.
 * @param text - the text to write.
 */
function writeOut(text: string): void {
  if (stdoutUnavailable) return;
  process.stdout.write(text);
}

/** Open the visual line for a stream: dimming (thought only), then prefix. */
function openStreamLine(): void {
  if (streamKind === undefined) return;
  streamLineOpen = true;
  streamDimmed = streamKind === 'thought';
  if (streamDimmed) writeOut('\u001b[2m');
  writeOut(`⟪${streamKind}⟫ `);
}

/** Terminate an open shared stream line (closing dimming first). */
function endStreamLine(): void {
  if (!streamLineOpen) return;
  writeOut(`${streamDimmed ? '\u001b[0m' : ''}\n`);
  streamLineOpen = false;
  streamDimmed = false;
}

/**
 * Write one sanitized line to stdout; a no-op once stdout has failed. Flushes
 * any open stream line first so the label never lands mid-stream.
 * @param line - the text to print.
 */
export function printLine(line: string): void {
  if (stdoutUnavailable) return;
  endStreamLine();
  process.stdout.write(`${sanitize(line)}\n`);
}

/**
 * Write one sanitized, dimmed line to stdout; a no-op once stdout has failed.
 * Flushes any open stream line first.
 * @param line - the text to print.
 */
export function printDim(line: string): void {
  if (stdoutUnavailable) return;
  endStreamLine();
  process.stdout.write(`${dim(line)}\n`);
}

/**
 * Write one sanitized line to stderr; a no-op once stderr has failed. Flushes
 * any open stdout stream line first so an error never lands mid-stream on a
 * shared terminal.
 * @param line - the text to print.
 */
export function printErr(line: string): void {
  endStreamLine();
  if (stderrUnavailable) return;
  process.stderr.write(`${sanitize(line)}\n`);
}

/** Compact JSON rendering used by every unknown-shape fallback. */
function rawJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Truncate long text with an ellipsis so one blob cannot flood the terminal. */
function preview(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ── content blocks ────────────────────────────────

/**
 * Render a content block (text/image/audio/resource/diff/terminal);
 * unknown future blocks fall back to raw JSON.
 * @param block - the content block, or an unknown-variant block from fold.
 * @returns its text.
 */
export function renderContentBlock(block: ContentBlock | UnknownContentBlock): string {
  // Unknown future variants share the record shape; the default arm renders
  // them as raw JSON, so narrow optimistically to the known union here.
  const known = block as ContentBlock;
  switch (known.type) {
    case 'text':
      return known.text;
    case 'image':
      return `[image ${known.mimeType} ${known.uri ?? `${known.data.length}B`}]`;
    case 'audio':
      return `[audio ${known.mimeType} ${known.data.length}B]`;
    case 'resource_link': {
      let out = `[link ${known.name} ${known.uri}`;
      if (known.title != null) out += ` "${known.title}"`;
      if (known.size != null) out += ` ${known.size}B`;
      return `${out}]`;
    }
    case 'resource': {
      const res = known.resource;
      let out = `[resource ${res.uri}${res.mimeType != null ? ` ${res.mimeType}` : ''}]`;
      if ('text' in res) out += ` ${preview(res.text)}`;
      else out += ` ${res.blob.length}B`;
      return out;
    }
    default:
      return `[unknown content block] ${rawJson(block)}`;
  }
}

// ── tool rows ─────────────────────────────────────────────────────────

/**
 * Render one tool-call content item (nested content/diff/terminal);
 * unknown future items fall back to raw JSON.
 * @param content - the tool-call content item.
 * @returns its text.
 */
function renderToolCallContent(content: FoldedToolCallContent): string {
  // Same optimistic narrow-and-fallback pattern as renderContentBlock.
  const known = content as ToolCallContent;
  switch (known.type) {
    case 'content':
      return renderContentBlock(known.content);
    case 'diff': {
      let out = `diff ${known.path}\n      + ${preview(known.newText)}`;
      if (known.oldText != null) out += `\n      - ${preview(known.oldText)}`;
      return out;
    }
    case 'terminal':
      return `[terminal ${known.terminalId}]`;
    default:
      return `[unknown tool content] ${rawJson(content)}`;
  }
}

/**
 * Render one tool-call row; missing fields never render as `undefined`.
 * @param row - the folded row snapshot.
 * @param changed - optional field names applied by the latest patch, marked
 * inline (scalars show the new value; arrays/objects just mark the field).
 * @returns the rendered lines.
 */
export function renderToolRow(row: ToolRow, changed?: readonly ToolRowField[]): string {
  const parts = ['⟪tool⟫'];
  if (row.kind !== undefined) parts.push(row.kind);
  parts.push(row.title ?? row.name ?? row.toolCallId);
  if (row.status !== undefined) parts.push(`(${row.status})`);
  if (changed && changed.length > 0) {
    parts.push(
      `← ${changed
        .map((f) => {
          const value = (row as unknown as Record<string, unknown>)[f];
          return typeof value === 'string' ? `${f}→${value}` : f;
        })
        .join(' ')}`,
    );
  }
  const lines = [parts.join(' ')];
  for (const loc of row.locations ?? []) {
    lines.push(`    at ${loc.path}${loc.line != null ? `:${loc.line}` : ''}`);
  }
  for (const content of row.content ?? []) {
    lines.push(`    ${renderToolCallContent(content)}`);
  }
  if (row.rawInput !== undefined) lines.push(`    rawInput: ${rawJson(row.rawInput)}`);
  if (row.rawOutput !== undefined) lines.push(`    rawOutput: ${rawJson(row.rawOutput)}`);
  return lines.join('\n');
}

// ── plans ──────────────────────────────────────────────────────────────────

const PLAN_STATUS_ICON: Record<string, string> = {
  pending: '☐',
  in_progress: '◐',
  completed: '☑',
};

/**
 * Render plan entries grouped by status.
 * @param entries - the plan entries.
 * @param tag - optional planId shown in the header.
 * @returns the rendered lines.
 */
function renderPlanEntries(
  entries: ReadonlyArray<{ content: string; status: string; priority: string }>,
  tag?: string,
): string {
  const inProgress = entries.filter((e) => e.status === 'in_progress').length;
  const header = `⟪plan⟫${tag ? ` [${tag}]` : ''} ${entries.length} entries, ${inProgress} in_progress`;
  const lines = entries.map((e) => `  ${PLAN_STATUS_ICON[e.status] ?? '?'} ${e.content} (${e.priority})`);
  return [header, ...lines].join('\n');
}

/**
 * Render one keyed plan's current representation.
 * @param plan - the keyed plan state.
 * @returns the rendered lines (markdown bodies render dimmed by the caller).
 */
function renderKeyedPlan(plan: KeyedPlanState): { text: string; dimmed: boolean } {
  switch (plan.type) {
    case 'items':
      return { text: renderPlanEntries(plan.entries, plan.planId), dimmed: false };
    case 'file':
      return { text: `⟪plan⟫ [${plan.planId}] plan file: ${plan.uri}`, dimmed: false };
    case 'markdown':
      return { text: `⟪plan⟫ [${plan.planId}]\n${plan.content}`, dimmed: true };
  }
}

// ── notice / usage / raw lines ─────────────────────────────────────────────

/**
 * Render a notice update (commands/mode/config/session info) to one line set.
 * @param update - the notice update.
 * @returns the rendered lines.
 */
function renderNotice(update: NoticeUpdate): string {
  switch (update.sessionUpdate) {
    case 'available_commands_update': {
      const cmds = update.availableCommands.map(
        (c) => `${c.name}${c.input?.hint ? ` (${c.input.hint})` : ''} — ${c.description}`,
      );
      return ['⟪commands⟫', ...cmds.map((c) => `  ${c}`)].join('\n');
    }
    case 'current_mode_update':
      return `⟪mode⟫ ${update.currentModeId}`;
    case 'config_option_update':
      return update.configOptions
        .map((o) => `⟪config⟫ ${o.id} = ${rawJson(o.currentValue ?? null)}`)
        .join('\n');
    case 'session_info_update': {
      const parts: string[] = [];
      if (update.title != null) parts.push(`title=${update.title}`);
      if (update.updatedAt != null) parts.push(`updatedAt=${update.updatedAt}`);
      return `⟪info⟫ ${parts.join(' ') || rawJson(update)}`;
    }
  }
}

/**
 * Render the token fields of a runskein usage snapshot.
 * @param tokens - the runskein token snapshot.
 * @returns the space-joined token fields.
 */
function formatTokens(tokens: Usage): string {
  const fields: Array<keyof Usage> = [
    'input',
    'output',
    'total',
    'uncached',
    'cacheRead',
    'cacheCreation',
    'thought',
  ];
  return fields
    .filter((f) => tokens[f] !== undefined)
    .map((f) => `${f}=${tokens[f]}`)
    .join(' ');
}

/**
 * Render a usage state line: context-window values latest-wins, cumulative
 * cost only when present, runskein tokens appended when the envelope carried
 * them. Nothing is ever summed across channels.
 * @param usage - the folded usage state.
 * @returns the rendered line, or undefined when no channel has data.
 */
function renderUsage(usage: UsageState): string | undefined {
  const parts: string[] = [];
  if (usage.context !== undefined) {
    parts.push(`used=${usage.context.used} size=${usage.context.size}`);
  }
  if (usage.cost !== undefined) parts.push(`cost=${usage.cost.amount} ${usage.cost.currency}`);
  if (usage.tokens !== undefined) {
    const tokens = formatTokens(usage.tokens);
    if (tokens !== '') parts.push(tokens);
  }
  return parts.length > 0 ? `⟪usage⟫ ${parts.join(' ')}` : undefined;
}

/**
 * Render a raw fallback line for an unknown or rejected update.
 * @param update - the raw update payload.
 * @param reason - why the update was not folded.
 * @returns the rendered line.
 */
export function renderRaw(update: unknown, reason: string): string {
  const tag = reason === 'unknown-update' ? '' : ` [${reason}]`;
  return `⟪update⟫${tag} ${rawJson(update)}`;
}

// ── the terminal presenter ──────────────────────────────────────────────────

/** Tool-row fields whose change is visible in the rendered row header. */
const REPAINT_FIELDS: ReadonlySet<ToolRowField> = new Set(['status', 'title', 'kind', 'name', 'locations']);

/**
 * Stateful terminal presenter for one session's folded event stream.
 *
 * Message streams share one line; tool rows repaint only when the change is
 * visible (a creation, a status/title/kind/name/locations change, or any
 * terminal status) — pure content/rawInput growth is coalesced, so a row
 * repaints at most once per visible change with the terminal repaint
 * showing the complete row. One instance per session; reset on fork.
 */
export interface Presenter {
  consume(folded: FoldedEvent): void;
}

class TerminalPresenter implements Presenter {
  /** toolCallIds painted at least once; mirrors fold's terminal eviction. */
  private readonly paintedRows = new Set<string>();

  /**
   * Render one folded event to the terminal.
   * @param folded - the folded event (its source is not displayed).
   */
  consume(folded: FoldedEvent): void {
    const event = folded.event;
    switch (event.type) {
      case 'messageStart': {
        // Defensive: fold never nests streams, but never leave a line open.
        endStreamLine();
        streamKind = event.kind;
        openStreamLine();
        return;
      }
      case 'messageAppend':
        // The visual line may have been flushed by CLI-local output while
        // the fold stream is still open — re-open it with a fresh prefix.
        if (!streamLineOpen) openStreamLine();
        writeOut(sanitize(event.block.text));
        return;
      case 'messageEnd':
        endStreamLine();
        streamKind = undefined;
        return;
      case 'content': {
        const line = `⟪${event.kind}⟫ ${renderContentBlock(event.block)}`;
        if (event.kind === 'thought') printDim(line);
        else printLine(line);
        return;
      }
      case 'toolRow':
        this.consumeToolRow(event.row, event.changed);
        return;
      case 'planState': {
        if (event.removedPlanId !== undefined) {
          printLine(`⟪plan⟫ plan ${event.removedPlanId} removed`);
          return;
        }
        if (event.changedPlanId !== undefined) {
          const plan = event.state.keyed.find((p) => p.planId === event.changedPlanId);
          if (plan !== undefined) {
            const rendered = renderKeyedPlan(plan);
            if (rendered.dimmed) printDim(rendered.text);
            else printLine(rendered.text);
          }
          return;
        }
        if (event.state.legacy !== undefined) printLine(renderPlanEntries(event.state.legacy));
        return;
      }
      case 'usageState': {
        const line = renderUsage(event.usage);
        if (line !== undefined) printLine(line);
        return;
      }
      case 'notice':
        printLine(renderNotice(event.update));
        return;
      case 'raw':
        printLine(renderRaw(event.update, event.reason));
        return;
    }
  }

  /**
   * Repaint a tool row only on visible change; coalesce pure growth deltas.
   * @param row - the complete folded row snapshot.
   * @param changed - fields the latest patch applied.
   */
  private consumeToolRow(row: ToolRow, changed: readonly ToolRowField[]): void {
    const firstPaint = !this.paintedRows.has(row.toolCallId);
    const terminal = row.status === 'completed' || row.status === 'failed';
    if (!firstPaint && !terminal && !changed.some((f) => REPAINT_FIELDS.has(f))) return;
    // Changed-field marks only make sense against a previously shown row.
    printLine(firstPaint ? renderToolRow(row) : renderToolRow(row, changed));
    if (terminal) this.paintedRows.delete(row.toolCallId);
    else this.paintedRows.add(row.toolCallId);
  }
}

/**
 * Create the terminal presenter for one session.
 * @returns the presenter; a forked session gets a fresh instance.
 */
export function createPresenter(): Presenter {
  return new TerminalPresenter();
}

// ── command renderers ────────────────────────────────────────

/** Pad a value with trailing spaces to the given column width. */
function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}

/**
 * Render the engines table.
 * @param infos - the engine inventory.
 * @returns the table text.
 */
export function renderEngines(infos: EngineInfo[]): string {
  const rows = infos.map((info) => {
    if (info.health === 'invalid') {
      return [info.id ?? '<broken>', '-', '-', '-', `invalid: ${info.error}`];
    }
    return [
      info.id,
      info.installed ? 'yes' : 'no',
      info.version ?? '-',
      info.authenticated === undefined ? '-' : info.authenticated ? 'yes' : 'no',
      info.health,
    ];
  });
  const header = ['ID', 'INSTALLED', 'VERSION', 'AUTH', 'HEALTH'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const fmt = (cols: string[]): string =>
    cols
      .map((c, i) => pad(c, widths[i] ?? c.length))
      .join('  ')
      .trimEnd();
  return [fmt(header), ...rows.map(fmt)].join('\n');
}

/**
 * List a select option's values, qualifying grouped ones as `group/value` so
 * the same value under two groups stays distinguishable.
 * @param option - the config option.
 * @returns the displayable values.
 */
function flattenSelectValues(option: ConfigOption): string[] {
  return (option.options ?? []).flatMap((entry) =>
    'options' in entry
      ? (entry as SelectGroup).options.map((o) => `${entry.name}/${o.value}`)
      : [(entry as SelectOption).value],
  );
}

/**
 * List the capabilities an engine actually advertises.
 * @param caps - the capability matrix.
 * @returns the space-joined names, or '(none)'.
 */
function capabilityList(caps: CapabilityMatrix): string {
  const out: string[] = [];
  if (caps.loadSession) out.push('loadSession');
  for (const [k, v] of Object.entries(caps.session)) if (v) out.push(k);
  for (const [k, v] of Object.entries(caps.prompt)) if (v) out.push(`prompt:${k}`);
  for (const [k, v] of Object.entries(caps.mcp)) if (v) out.push(`mcp:${k}`);
  if (caps.providers) out.push('providers');
  return out.join(' ') || '(none)';
}

/**
 * Render an engine descriptor.
 * @param engineId - the engine id.
 * @param d - the descriptor.
 * @returns the rendered text.
 */
export function renderDescribe(engineId: string, d: EngineDescriptor): string {
  const lines: string[] = [`engine: ${engineId}   source: ${d.source}`];
  lines.push('config options:');
  if (d.configOptions.length === 0) lines.push('  (none reported)');
  const idWidth = Math.max(1, ...d.configOptions.map((o) => o.id.length));
  for (const o of d.configOptions) {
    const meta = `(${o.category ?? '-'}, ${o.type})`;
    const current = o.currentValue !== undefined ? `current=${String(o.currentValue)}` : '';
    // An option this engine only takes at session creation is listed with the
    // rest, but a reader following it to `:config` would get a typed refusal.
    // Saying so here is cheaper than letting them find out that way.
    const when = o.settable === 'creation' ? 'creation only' : '';
    lines.push(
      `  ${pad(o.id, idWidth)}  ${pad(meta, 24)} ${[current, when].filter(Boolean).join('  ')}`.trimEnd(),
    );
    if (o.type === 'select') {
      lines.push(`  ${pad('', idWidth)}  values: ${flattenSelectValues(o).join(', ')}`);
    }
  }
  if (d.models && d.models.length > 0) {
    lines.push('models:');
    for (const m of d.models) {
      const current = m.id === d.currentModel ? ' (current)' : '';
      const description = m.description !== undefined ? ` — ${m.description}` : '';
      lines.push(`  ${m.id} (${m.name})${current}${description}`);
    }
  }
  if (d.modes && d.modes.length > 0) {
    lines.push('modes:');
    for (const m of d.modes) {
      lines.push(`  ${m.id} (${m.name})${m.description !== undefined ? ` — ${m.description}` : ''}`);
    }
  }
  if (d.providers && d.providers.length > 0) {
    lines.push('providers:');
    for (const p of d.providers) {
      const current = p.current ? ` current=${p.current.apiType}@${p.current.baseUrl}` : '';
      lines.push(`  ${p.id} [${p.protocols.join(', ')}]${p.required ? ' required' : ''}${current}`);
    }
  }
  lines.push(`capabilities: ${capabilityList(d.capabilities)}`);
  return lines.join('\n');
}
