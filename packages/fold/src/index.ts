/**
 * @runskein/fold — transcript folding: the verbatim `TranscriptEvent`
 * stream folded into presentation-oriented events for renderers.
 *
 * The folder derives logical message streams keyed by `(kind, messageId)`,
 * merges `tool_call` + sparse `tool_call_update` patches into per-id rows,
 * derives what each call acted on and how much of a file each diff covers,
 * keeps legacy/keyed plan snapshots, and tracks usage (ACP context-window
 * values and runskein token accounting as separate channels). Unknown or
 * malformed updates surface as `raw` events — never thrown, never dropped.
 *
 * One instance binds to the session/engine identity of its first accepted
 * input. The folder is deterministic and side-effect-free: no IO, no
 * timers, no engine branches; it mutates only its private state and never
 * an input or a previously emitted snapshot. Terminal sanitization,
 * coalescing policy, and IO stay with the presenter.
 */
import type {
  ContentBlock,
  PlanEntry,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  TranscriptEvent,
  Usage,
} from '@runskein/core';

type TextBlock = Extract<ContentBlock, { type: 'text' }>;
type NonTextBlock = Exclude<ContentBlock, { type: 'text' }>;

/** Content block from a future ACP version: object with an unknown string `type`. */
export type UnknownContentBlock = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

/** Tool-call content from a future ACP version, kept inside row snapshots. */
export type UnknownToolCallContent = Readonly<Record<string, unknown>> & {
  readonly type: string;
};

export type FoldedToolCallContent = Readonly<ToolCallContent> | UnknownToolCallContent;

export type MessageKind = 'agent' | 'thought' | 'user';

export type NoticeUpdate = Extract<
  SessionUpdate,
  {
    sessionUpdate:
      'available_commands_update' | 'current_mode_update' | 'config_option_update' | 'session_info_update';
  }
>;

/**
 * One transcript input. `update` is intentionally `unknown`: core lets
 * future raw update objects reach consumers before generated TypeScript
 * catches up, so the ingress boundary validates at runtime.
 */
export type FoldInput = Omit<TranscriptEvent, 'update'> & { update: unknown };

/** Provenance of the transcript event that caused a presentation event. */
export type SourceRef = Readonly<Pick<TranscriptEvent, 'seq' | 'ts' | 'sessionId' | 'engineId'>>;

export interface FoldedEvent {
  readonly source: SourceRef;
  readonly event: PresentationEvent;
}

export type PresentationEvent = Readonly<
  | { type: 'messageStart'; kind: MessageKind; messageId?: string }
  | { type: 'messageAppend'; block: Readonly<TextBlock> }
  | { type: 'messageEnd' }
  | {
      type: 'content';
      kind: MessageKind;
      messageId?: string;
      block: Readonly<NonTextBlock> | UnknownContentBlock;
    }
  | {
      type: 'toolRow';
      row: Readonly<ToolRow>;
      changed: readonly ToolRowField[];
    }
  | {
      type: 'planState';
      state: Readonly<PlanSnapshot>;
      changedPlanId?: string;
      removedPlanId?: string;
    }
  | { type: 'usageState'; usage: Readonly<UsageState> }
  | { type: 'notice'; update: Readonly<NoticeUpdate> }
  | {
      type: 'raw';
      update: unknown;
      reason: 'unknown-update' | 'malformed-known-update' | 'invalid-envelope';
    }
>;

export interface PlanSnapshot {
  readonly legacy?: readonly Readonly<PlanEntry>[];
  readonly keyed: readonly Readonly<KeyedPlanState>[];
}

export type KeyedPlanState =
  | {
      readonly type: 'items';
      readonly planId: string;
      readonly entries: readonly Readonly<PlanEntry>[];
    }
  | { readonly type: 'file'; readonly planId: string; readonly uri: string }
  | { readonly type: 'markdown'; readonly planId: string; readonly content: string };

/**
 * Usage channels, never summed: ACP context-window values (latest wins),
 * the last reported cumulative session cost, and runskein's cumulative token
 * snapshot from the transcript envelope.
 */
export interface UsageState {
  readonly context?: Readonly<{ used: number; size: number }>;
  readonly cost?: Readonly<{ amount: number; currency: string }>;
  readonly tokens?: Readonly<Usage>;
}

/**
 * What one tool call acted on, derived by fold from whichever field the
 * engine happened to use. ACP makes `rawInput`, `locations` and `content` all
 * optional, so engines report the same fact in different places; a presenter
 * that branched on engine id would miss the next engine.
 */
export interface ToolCallArgs {
  /** One human-readable line: the path, the command, else compact JSON. */
  readonly text: string;
  /** The structured arguments, when the source carried them. */
  readonly value?: unknown;
  /** Which row field this was read from — never hidden from the consumer. */
  readonly from: 'rawInput' | 'locations' | 'content';
}

/**
 * What one `diff` content block covers, derived by fold from the transcript
 * alone. The wire carries no such field: ACP's diff is `{path, oldText?,
 * newText}` and nothing in it says whether that text is the whole file or a
 * fragment of it, so a renderer cannot tell whether numbering the block from 1
 * happens to match the file's own line numbers.
 *
 * Fold answers only where the transcript proves the answer, and says `unknown`
 * otherwise — it reads no files (a replayed transcript's files have moved on,
 * and the folder does no IO at all) and never branches on the engine. A
 * fragment therefore stays `unknown`: without the file's content the coverage
 * is genuinely unknowable, and a wrong line number is worse than none.
 */
export interface DiffCoverage {
  /** Position of the diff block within the row's `content` array. */
  readonly index: number;
  readonly path: string;
  readonly scope: 'wholeFile' | 'unknown';
  /** 1-based line the block's text starts at. Present only when `wholeFile`. */
  readonly startLine?: number;
  /**
   * The proof: `created` — the diff has no `oldText`, so it wrote the file into
   * existence; `chained` — its `oldText` reproduces the `newText` of an earlier
   * whole-file diff for the same path. Absent when the scope is `unknown`.
   */
  readonly from?: 'created' | 'chained';
}

export interface ToolRow {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: ToolKind;
  readonly status?: ToolCallStatus;
  readonly content?: readonly FoldedToolCallContent[];
  readonly locations?: readonly Readonly<ToolCallLocation>[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  /** Fold-derived, never read from the wire. See {@link ToolCallArgs}. */
  readonly args?: Readonly<ToolCallArgs>;
  /**
   * One entry per `diff` block in `content`, in order. Fold-derived, never
   * read from the wire. See {@link DiffCoverage}.
   */
  readonly diffs?: readonly Readonly<DiffCoverage>[];
}

export type ToolRowField = Exclude<keyof ToolRow, 'toolCallId'>;

export interface Folder {
  push(input: FoldInput): FoldedEvent[];
  flush(): FoldedEvent[];
}

/**
 * The chain judgement behind {@link ToolRow.diffs}, holdable on its own.
 *
 * Deciding what a diff block covers is sequential state: `chained` is proved
 * by comparing a block's `oldText` against the text an earlier whole-file diff
 * for that path left behind, and the verdicts a row already got are reused so
 * a resent block is not judged against what its own first pass recorded. A
 * consumer that needs coverage on a path that does not fold — an index built
 * event by event, holding no message, plan or usage state — can hold this
 * instead of a whole folder, and gets the same verdicts because the folder
 * itself is built on it.
 *
 * It keeps one full file text per path currently on a whole-file chain, plus
 * the verdicts of the rows still open; both are dropped as the chain breaks
 * and as rows reach a terminal status.
 */
export interface DiffCoverageJudge {
  /**
   * Observe one session update and judge the diff blocks it carries.
   *
   * Every `tool_call` / `tool_call_update` must be pushed, not only those
   * carrying `content`: a full `tool_call` replaces the row and so clears the
   * verdicts of the run before it, and a terminal status ends the row. Any
   * other update, and any patch the folder would reject as malformed, is
   * ignored and leaves the chain untouched.
   * @param update - a session update, as it appears in `TranscriptEvent`.
   * @returns one entry per `diff` block in `content` order, or undefined when
   *   the update carried no content or its content held no judgeable diff.
   */
  push(update: unknown): readonly Readonly<DiffCoverage>[] | undefined;
}

const CHUNK_KINDS: Record<string, MessageKind> = {
  agent_message_chunk: 'agent',
  agent_thought_chunk: 'thought',
  user_message_chunk: 'user',
};

const NOTICE_KINDS = new Set([
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
]);

/**
 * `_meta` key runskein stamps on a `usage_update` it synthesized itself. RunSkein
 * omits the protocol's required window gauge on those events rather than
 * fabricating one from token counts (decision 024), so a window-less
 * usage_update is legitimate exactly when it carries this marker. Spelled out
 * here like every other wire name the folder matches: fold reads runskein's
 * envelope vocabulary already, and a shared constant would not make the wire
 * string any less of a contract.
 */
const RUNSKEIN_SYNTHETIC_USAGE_KEY = 'runskein.dev/syntheticUsage';

/** Tool-row fields a `tool_call` / `tool_call_update` patch can supply. */
const NULLABLE_ROW_FIELDS = ['kind', 'status', 'title', 'name'] as const;

/**
 * Patch fields that can move the derived `args`: its three sources, plus
 * `status`, because the `content` source is read only at a terminal status.
 */
const ARGS_SOURCE_FIELDS: ReadonlySet<ToolRowField> = new Set([
  'rawInput',
  'locations',
  'content',
  'status',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Whether an update carries runskein's synthetic-usage marker.
 * @param update - the update object being folded.
 * @returns true when `_meta` holds the marker key.
 */
function isSyntheticUsage(update: Record<string, unknown>): boolean {
  const meta = update['_meta'];
  return isRecord(meta) && RUNSKEIN_SYNTHETIC_USAGE_KEY in meta;
}

function isTerminalStatus(status: unknown): boolean {
  return status === 'completed' || status === 'failed';
}

/**
 * Whether a row patch is well formed: the pinned nullable fields are strings
 * when concrete, `content`/`locations` arrays when concrete. A malformed patch
 * emits raw instead of partially patching, so it must not reach any state —
 * neither the row nor the diff chain.
 * @param update - a `tool_call` / `tool_call_update` payload.
 * @returns true when every field present is of the shape the patch expects.
 */
function isValidRowPatch(update: Record<string, unknown>): boolean {
  for (const field of NULLABLE_ROW_FIELDS) {
    const value = update[field];
    if (value !== undefined && value !== null && typeof value !== 'string') return false;
  }
  for (const field of ['content', 'locations'] as const) {
    const value = update[field];
    if (value !== undefined && value !== null && !Array.isArray(value)) return false;
  }
  return true;
}

/**
 * Whether an update is a row patch the folder would apply. The diff chain
 * accepts exactly what the folder accepts — a standalone judge that read a
 * patch the folder rejects, or rejected one it applies, would hand out
 * coverage the rendered row disagrees with.
 * @param update - any session update.
 * @returns true when it is a well-formed `tool_call` / `tool_call_update`.
 */
function isRowPatchUpdate(update: unknown): update is Record<string, unknown> & { toolCallId: string } {
  if (!isRecord(update)) return false;
  const name = update['sessionUpdate'];
  if (name !== 'tool_call' && name !== 'tool_call_update') return false;
  if (typeof update['toolCallId'] !== 'string') return false;
  // A full tool_call without a title is malformed; an update needs none.
  if (name === 'tool_call' && typeof update['title'] !== 'string') return false;
  return isValidRowPatch(update);
}

/**
 * Whether two derived diff-coverage lists are the same, so an unchanged one is
 * not reported as a change.
 * @param a - the previously derived list, if any.
 * @param b - the freshly derived list, if any.
 * @returns true when both are absent or hold equal entries in the same order.
 */
function sameDiffs(
  a: readonly DiffCoverage[] | undefined,
  b: readonly DiffCoverage[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((left, i) => {
    const right = b[i]!;
    return (
      left.index === right.index &&
      left.path === right.path &&
      left.scope === right.scope &&
      left.startLine === right.startLine &&
      left.from === right.from
    );
  });
}

/** Mutable private row; emitted snapshots are copies built from it. */
interface MutableToolRow {
  toolCallId: string;
  title?: string;
  name?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: FoldedToolCallContent[];
  locations?: Readonly<ToolCallLocation>[];
  rawInput?: unknown;
  rawOutput?: unknown;
  args?: ToolCallArgs;
  diffs?: DiffCoverage[];
}

/** One diff block a row was judged on, kept so a resend keeps its verdict. */
interface JudgedDiff {
  path: string;
  oldText: string | undefined;
  newText: string;
  coverage: DiffCoverage;
}

interface OpenMessage {
  kind: MessageKind;
  messageId?: string;
  /** Source of the last chunk in this stream; provenance for `messageEnd`. */
  lastSource: SourceRef;
}

class TranscriptFolder implements Folder {
  private boundSessionId: string | undefined;
  private boundEngineId: string | undefined;
  private lastSeq = 0;
  private openMessage: OpenMessage | undefined;
  private readonly toolRows = new Map<string, MutableToolRow>();
  private legacyPlan: readonly Readonly<PlanEntry>[] | undefined;
  private readonly keyedPlans = new Map<string, KeyedPlanState>();
  /**
   * The one judge of what a diff covers. The folder holds it like any other
   * consumer does, so `ToolRow.diffs` and a standalone judge cannot drift.
   */
  private readonly diffChain: DiffCoverageJudge = new DiffChain();
  private usageContext: { used: number; size: number } | undefined;
  private usageCost: { amount: number; currency: string } | undefined;
  private tokenUsage: Usage | undefined;

  /**
   * Fold one transcript event into zero or more presentation events.
   * @param input - the transcript event; `update` is runtime-validated.
   * @returns presentation events in emission order; an invalid envelope
   * yields a single non-mutating `raw` event.
   */
  push(input: FoldInput): FoldedEvent[] {
    const out: FoldedEvent[] = [];
    // Total at the ingress boundary: even a non-object input is raw data.
    if (!isRecord(input)) {
      const fallback: SourceRef = { seq: -1, ts: 0, sessionId: '', engineId: '' };
      out.push({ source: fallback, event: { type: 'raw', update: input, reason: 'invalid-envelope' } });
      return out;
    }
    const source = sourceOf(input);
    if (!this.acceptEnvelope(input, source, out)) return out;

    const update = input.update;
    if (!isRecord(update) || typeof update['sessionUpdate'] !== 'string') {
      this.closeMessage(out);
      out.push({ source, event: { type: 'raw', update, reason: 'unknown-update' } });
      return out;
    }
    const name = update['sessionUpdate'];
    const kind = CHUNK_KINDS[name];
    let valid: boolean;
    if (kind !== undefined) {
      valid = this.foldChunk(update, kind, source, out);
    } else {
      // Every non-chunk update is a boundary: close the open message first.
      this.closeMessage(out);
      valid = this.foldNonChunk(input, update, source, out);
    }
    // RunSkein token accounting rides the envelope of any valid update. The
    // usage_update branch folds the envelope on every path it accepts and
    // emits the one usageState itself, so letting it through here would
    // duplicate that emission.
    if (valid && name !== 'usage_update' && isRecord(input.usage)) {
      this.tokenUsage = { ...(input.usage as Usage) };
      out.push({ source, event: { type: 'usageState', usage: this.usageSnapshot() } });
    }
    return out;
  }

  /**
   * End any open message stream. Idempotent; tool/plan/usage state is kept.
   * Live callers invoke this after a turn settles and at session close —
   * transcript events carry no general turn-end marker the folder could use.
   * @returns a single `messageEnd` when a message was open, else nothing.
   */
  flush(): FoldedEvent[] {
    const out: FoldedEvent[] = [];
    this.closeMessage(out);
    return out;
  }

  // ── envelope ─────────────────────────────────────────────────────────────

  /**
   * Bind identity/order on the first valid envelope; reject repeated or
   * decreasing seq and foreign session/engine ids without mutating state.
   * A sequence gap is valid (consumers may replay from a later seq).
   */
  private acceptEnvelope(input: FoldInput, source: SourceRef, out: FoldedEvent[]): boolean {
    const valid =
      // Finite, not merely `number`: `NaN` passes a typeof check, compares
      // false against everything, and would then be stored as `lastSeq` — after
      // which every later `seq <= lastSeq` is false too and the
      // repeated/decreasing rejection below is dead for the rest of this
      // folder's life. `Infinity` is the same hole facing the other way.
      Number.isFinite(input.seq) &&
      typeof input.sessionId === 'string' &&
      typeof input.engineId === 'string';
    const reject = (): boolean => {
      out.push({ source, event: { type: 'raw', update: input.update, reason: 'invalid-envelope' } });
      return false;
    };
    if (!valid) return reject();
    if (this.boundSessionId === undefined) {
      this.boundSessionId = input.sessionId;
      this.boundEngineId = input.engineId;
    } else if (
      input.sessionId !== this.boundSessionId ||
      input.engineId !== this.boundEngineId ||
      input.seq <= this.lastSeq
    ) {
      return reject();
    }
    this.lastSeq = input.seq;
    return true;
  }

  // ── message streams ──────────────────────────────────────────────────────

  private closeMessage(out: FoldedEvent[]): void {
    if (this.openMessage === undefined) return;
    out.push({ source: this.openMessage.lastSource, event: { type: 'messageEnd' } });
    this.openMessage = undefined;
  }

  private foldChunk(
    update: Record<string, unknown>,
    kind: MessageKind,
    source: SourceRef,
    out: FoldedEvent[],
  ): boolean {
    const content = update['content'];
    const messageId = typeof update['messageId'] === 'string' ? update['messageId'] : undefined;
    if (!isRecord(content) || typeof content['type'] !== 'string') {
      this.closeMessage(out);
      out.push({ source, event: { type: 'raw', update, reason: 'malformed-known-update' } });
      return false;
    }
    if (content['type'] === 'text') {
      if (typeof content['text'] !== 'string') {
        this.closeMessage(out);
        out.push({ source, event: { type: 'raw', update, reason: 'malformed-known-update' } });
        return false;
      }
      const open = this.openMessage;
      if (open !== undefined && (open.kind !== kind || open.messageId !== messageId)) {
        this.closeMessage(out);
      }
      if (this.openMessage === undefined) {
        out.push({
          source,
          event: {
            type: 'messageStart',
            kind,
            ...(messageId !== undefined ? { messageId } : {}),
          },
        });
        this.openMessage = { kind, lastSource: source, ...(messageId !== undefined ? { messageId } : {}) };
      }
      this.openMessage.lastSource = source;
      out.push({ source, event: { type: 'messageAppend', block: content as unknown as TextBlock } });
      return true;
    }
    // A non-text block ends the shared stream and carries role/id with it:
    // presenters need to know which stream an image or resource belongs to.
    this.closeMessage(out);
    out.push({
      source,
      event: {
        type: 'content',
        kind,
        block: content as unknown as NonTextBlock,
        ...(messageId !== undefined ? { messageId } : {}),
      },
    });
    return true;
  }

  // ── non-chunk variants ───────────────────────────────────────────────────

  private foldNonChunk(
    input: FoldInput,
    update: Record<string, unknown>,
    source: SourceRef,
    out: FoldedEvent[],
  ): boolean {
    const name = update['sessionUpdate'] as string;
    let valid = true;
    switch (name) {
      case 'tool_call':
        valid = this.foldToolCall(update, source, out);
        break;
      case 'tool_call_update':
        valid = this.foldToolCallUpdate(update, source, out);
        break;
      case 'plan':
        valid = this.foldPlan(update, source, out);
        break;
      case 'plan_update':
        valid = this.foldPlanUpdate(update, source, out);
        break;
      case 'plan_removed': {
        const planId = update['planId'];
        if (typeof planId !== 'string') {
          valid = false;
          break;
        }
        this.keyedPlans.delete(planId);
        out.push({
          source,
          event: { type: 'planState', state: this.planSnapshot(), removedPlanId: planId },
        });
        break;
      }
      case 'usage_update':
        valid = this.foldUsageUpdate(input, update, source, out);
        break;
      default:
        if (NOTICE_KINDS.has(name)) {
          valid = this.foldNotice(update, source, out);
        } else {
          out.push({ source, event: { type: 'raw', update, reason: 'unknown-update' } });
          return false;
        }
    }
    if (!valid) {
      out.push({ source, event: { type: 'raw', update, reason: 'malformed-known-update' } });
    }
    return valid;
  }

  private foldToolCall(update: Record<string, unknown>, source: SourceRef, out: FoldedEvent[]): boolean {
    if (typeof update['toolCallId'] !== 'string' || typeof update['title'] !== 'string') {
      return false;
    }
    if (!isValidRowPatch(update)) return false;
    const row: MutableToolRow = {
      toolCallId: update['toolCallId'],
      title: update['title'],
    };
    const changed: ToolRowField[] = [];
    this.applyRowPatch(row, update, changed);
    this.toolRows.set(row.toolCallId, row);
    out.push({ source, event: { type: 'toolRow', row: rowSnapshot(row), changed } });
    // Terminal rows are evicted so retained state is bounded by active calls;
    // the emitted snapshot keeps the complete terminal row.
    if (isTerminalStatus(row.status)) this.toolRows.delete(row.toolCallId);
    return true;
  }

  private foldToolCallUpdate(
    update: Record<string, unknown>,
    source: SourceRef,
    out: FoldedEvent[],
  ): boolean {
    if (typeof update['toolCallId'] !== 'string') return false;
    if (!isValidRowPatch(update)) return false;
    // An update for an unseen id creates a partial row so partial transcripts
    // stay deterministic; a later full tool_call replaces it authoritatively.
    let row = this.toolRows.get(update['toolCallId']);
    if (row === undefined) {
      row = { toolCallId: update['toolCallId'] };
      this.toolRows.set(row.toolCallId, row);
    }
    const changed: ToolRowField[] = [];
    this.applyRowPatch(row, update, changed);
    out.push({ source, event: { type: 'toolRow', row: rowSnapshot(row), changed } });
    if (isTerminalStatus(row.status)) this.toolRows.delete(row.toolCallId);
    return true;
  }

  /**
   * Apply a validated patch: omission and `null` mean no change for the
   * pinned nullable fields; `content`/`locations` are whole-array
   * replacements; for `rawInput`/`rawOutput` own-key presence is the patch
   * signal and `null` is a legitimate replacement value. Arrays are copied
   * so later caller-side mutation cannot reach stored state.
   */
  private applyRowPatch(
    row: MutableToolRow,
    update: Record<string, unknown>,
    changed: ToolRowField[],
  ): void {
    for (const field of NULLABLE_ROW_FIELDS) {
      const value = update[field];
      if (value === undefined || value === null) continue;
      (row as unknown as Record<string, unknown>)[field] = value;
      changed.push(field);
    }
    for (const field of ['content', 'locations'] as const) {
      const value = update[field];
      if (value === undefined || value === null) continue;
      (row as unknown as Record<string, unknown>)[field] = [...(value as unknown[])];
      changed.push(field);
    }
    for (const field of ['rawInput', 'rawOutput'] as const) {
      if (!Object.hasOwn(update, field)) continue;
      (row as unknown as Record<string, unknown>)[field] = update[field];
      changed.push(field);
    }
    // `args` is derived from the fields above, so it is recomputed after them,
    // and only when this patch could have moved it: deriving it costs a
    // serialization of `rawInput` in the unnamed-key case, and a row whose
    // arguments carry a file body would otherwise pay that on every unrelated
    // content or status delta. Reported as changed only when it really moved.
    if (changed.some((field) => ARGS_SOURCE_FIELDS.has(field))) {
      const args = deriveArgs(row);
      if (!sameArgs(row.args, args)) {
        if (args === undefined) delete row.args;
        else row.args = args;
        changed.push('args');
      }
    }
    // The chain sees every accepted patch, not only the ones carrying content:
    // a full `tool_call` clears the verdicts of the run before it and a
    // terminal status ends the row, both of which this patch may be. What it
    // returns is coverage for this patch's own `content`, and `content` is the
    // only thing coverage reads, so it is applied only when that moved.
    const diffs = this.diffChain.push(update);
    if (changed.includes('content') && !sameDiffs(row.diffs, diffs)) {
      if (diffs === undefined) delete row.diffs;
      else row.diffs = [...diffs];
      changed.push('diffs');
    }
  }

  private foldPlan(update: Record<string, unknown>, source: SourceRef, out: FoldedEvent[]): boolean {
    const entries = update['entries'];
    if (!Array.isArray(entries)) return false;
    // The unkeyed legacy plan is replaced wholesale and coexists with keyed plans.
    this.legacyPlan = [...entries] as readonly Readonly<PlanEntry>[];
    out.push({ source, event: { type: 'planState', state: this.planSnapshot() } });
    return true;
  }

  private foldPlanUpdate(update: Record<string, unknown>, source: SourceRef, out: FoldedEvent[]): boolean {
    const plan = update['plan'];
    if (!isRecord(plan) || typeof plan['planId'] !== 'string' || typeof plan['type'] !== 'string') {
      return false;
    }
    const planId = plan['planId'];
    // A kind switch replaces the previous representation at this planId
    // rather than merging stale fields across kinds.
    let state: KeyedPlanState;
    switch (plan['type']) {
      case 'items': {
        const entries = plan['entries'];
        if (!Array.isArray(entries)) return false;
        state = { type: 'items', planId, entries: [...entries] as readonly Readonly<PlanEntry>[] };
        break;
      }
      case 'file': {
        if (typeof plan['uri'] !== 'string') return false;
        state = { type: 'file', planId, uri: plan['uri'] };
        break;
      }
      case 'markdown': {
        if (typeof plan['content'] !== 'string') return false;
        state = { type: 'markdown', planId, content: plan['content'] };
        break;
      }
      default:
        return false;
    }
    this.keyedPlans.set(planId, state);
    out.push({
      source,
      event: { type: 'planState', state: this.planSnapshot(), changedPlanId: planId },
    });
    return true;
  }

  private foldUsageUpdate(
    input: FoldInput,
    update: Record<string, unknown>,
    source: SourceRef,
    out: FoldedEvent[],
  ): boolean {
    const used = update['used'];
    const size = update['size'];
    // The window gauge is optional here even though the protocol requires it:
    // runskein synthesizes token-only usage events without one. Half a gauge is
    // still a violation, and no other channel launders it — a number paired
    // with a string is a broken reading, not an absent one. An explicit null
    // reads as absent, the same way an omitted field does; NaN and Infinity
    // are not measurements, matching how core reads token fields.
    const hasWindow =
      typeof used === 'number' &&
      typeof size === 'number' &&
      Number.isFinite(used) &&
      Number.isFinite(size);
    const windowPresent = (used !== undefined && used !== null) || (size !== undefined && size !== null);
    if (windowPresent && !hasWindow) return false;
    const cost = update['cost'];
    const hasCost = cost !== undefined && cost !== null;
    if (hasCost) {
      if (!isRecord(cost) || typeof cost['amount'] !== 'number' || typeof cost['currency'] !== 'string') {
        return false;
      }
    }
    const hasTokens = isRecord(input.usage);
    if (!hasWindow && !hasCost && !hasTokens) {
      // Nothing reported at all. RunSkein's own marker says the window was
      // deliberately omitted, so the event is well-formed and simply has
      // nothing to fold; from anyone else the protocol's required gauge is
      // missing, and calling that malformed keeps the diagnostic honest.
      return isSyntheticUsage(update);
    }
    // Context-window values are current readings, not deltas: latest wins.
    if (hasWindow) this.usageContext = { used, size };
    if (isRecord(cost)) {
      this.usageCost = { amount: cost['amount'] as number, currency: cost['currency'] as string };
    }
    // Token counts reach fold on the envelope only. The runskein field names on
    // the update body are the transcript describing itself, and for an engine
    // whose tokens come from its prompt response core deliberately leaves them
    // off the envelope so they are counted once — reading the body here would
    // count them twice.
    if (hasTokens) this.tokenUsage = { ...(input.usage as Usage) };
    out.push({ source, event: { type: 'usageState', usage: this.usageSnapshot() } });
    return true;
  }

  private foldNotice(update: Record<string, unknown>, source: SourceRef, out: FoldedEvent[]): boolean {
    switch (update['sessionUpdate']) {
      case 'available_commands_update':
        if (!Array.isArray(update['availableCommands'])) return false;
        break;
      case 'current_mode_update':
        if (typeof update['currentModeId'] !== 'string') return false;
        break;
      case 'config_option_update':
        if (!Array.isArray(update['configOptions'])) return false;
        break;
      // session_info_update has no required fields.
    }
    out.push({ source, event: { type: 'notice', update: update as unknown as NoticeUpdate } });
    return true;
  }

  // ── snapshots ────────────────────────────────────────────────────────────

  private planSnapshot(): PlanSnapshot {
    return {
      ...(this.legacyPlan !== undefined ? { legacy: this.legacyPlan } : {}),
      keyed: [...this.keyedPlans.values()],
    };
  }

  private usageSnapshot(): UsageState {
    return {
      ...(this.usageContext !== undefined ? { context: this.usageContext } : {}),
      ...(this.usageCost !== undefined ? { cost: this.usageCost } : {}),
      ...(this.tokenUsage !== undefined ? { tokens: this.tokenUsage } : {}),
    };
  }
}

/**
 * Copy a stored row into an immutable event snapshot; later patches cannot
 * mutate an already emitted event.
 * @param row - the stored mutable row.
 * @returns the snapshot with its own array copies.
 */
function rowSnapshot(row: MutableToolRow): ToolRow {
  const snap: MutableToolRow = { toolCallId: row.toolCallId };
  if (row.title !== undefined) snap.title = row.title;
  if (row.name !== undefined) snap.name = row.name;
  if (row.kind !== undefined) snap.kind = row.kind;
  if (row.status !== undefined) snap.status = row.status;
  if (row.content !== undefined) snap.content = [...row.content];
  if (row.locations !== undefined) snap.locations = [...row.locations];
  // Own-key presence matters for rawInput/rawOutput: null is data.
  if (Object.hasOwn(row, 'rawInput')) snap.rawInput = row.rawInput;
  if (Object.hasOwn(row, 'rawOutput')) snap.rawOutput = row.rawOutput;
  // args is already an immutable derived object; `value` shares the raw value
  // by reference, like rawInput itself.
  if (row.args !== undefined) snap.args = row.args;
  if (row.diffs !== undefined) snap.diffs = [...row.diffs];
  return snap;
}

/**
 * Best-effort provenance for malformed envelopes; valid inputs pass through.
 * @param input - the transcript input.
 * @returns the source reference carried by every emitted event.
 */
function sourceOf(input: FoldInput): SourceRef {
  return {
    seq: typeof input.seq === 'number' ? input.seq : -1,
    ts: typeof input.ts === 'number' ? input.ts : 0,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
    engineId: typeof input.engineId === 'string' ? input.engineId : '',
  };
}

/**
 * The sequential state behind `DiffCoverage`, held by the folder and by any
 * consumer that needs coverage without folding.
 *
 * Two things are remembered. Per path, the exact text the last whole-file diff
 * left behind — compared verbatim rather than by hash: this is what makes
 * `chained` a proof and not a likelihood, and a hash cheap enough to be worth
 * keeping would be one a collision could quietly turn into a wrong line
 * number. Per open row, the verdicts its blocks already got.
 *
 * State is fed only by pushed updates and read only in the order they arrive,
 * so the same event stream judged twice gives the same verdicts field for
 * field — what lets an index built incrementally and one rebuilt by rescanning
 * agree.
 */
class DiffChain implements DiffCoverageJudge {
  private readonly wholeFileText = new Map<string, string>();
  private readonly rowVerdicts = new Map<string, JudgedDiff[]>();

  push(update: unknown): readonly Readonly<DiffCoverage>[] | undefined {
    if (!isRowPatchUpdate(update)) return undefined;
    const toolCallId = update.toolCallId;
    // A full `tool_call` replaces the row, so it starts with no history: an id
    // an engine re-uses is a second run, and its blocks are judged against the
    // chain as it stands now, not against what the earlier run found.
    if (update['sessionUpdate'] === 'tool_call') this.rowVerdicts.delete(toolCallId);
    const content = update['content'];
    const diffs = Array.isArray(content) ? this.judge(toolCallId, content) : undefined;
    // A terminal row takes no further blocks; dropping its verdicts bounds
    // what is retained to the calls still running, as the folder does with the
    // rows themselves.
    if (isTerminalStatus(update['status'])) this.rowVerdicts.delete(toolCallId);
    return diffs;
  }

  /**
   * Classify every `diff` block a row's content carries against what earlier
   * diffs proved about the same path.
   *
   * Engines resend the whole `content` array as a tool call progresses, so a
   * block arrives many times on the same row. A block this row was already
   * judged on keeps that verdict: re-running it would test its `oldText`
   * against the text its own first pass recorded, and turn a proven chain into
   * `unknown`. The reuse is deliberately scoped to the row — across rows the
   * same edit really can happen twice with other edits in between, and the
   * later one must be judged against the chain as it stands then, not against
   * what the earlier one found.
   * @param toolCallId - the row whose content was just replaced.
   * @param content - that content, whole-array as the patch supplied it.
   * @returns one entry per diff block in order, or undefined when it has none.
   */
  private judge(toolCallId: string, content: readonly unknown[]): DiffCoverage[] | undefined {
    const judged: JudgedDiff[] = [];
    const out: DiffCoverage[] = [];
    // Prior verdicts are handed out one for one. A row may carry the same edit
    // twice, and the second copy of it was judged against what the first one
    // left behind — letting both claim the first verdict would rewrite the
    // second block's history on a resend.
    const unclaimed = [...(this.rowVerdicts.get(toolCallId) ?? [])];
    content.forEach((item, index) => {
      if (!isRecord(item) || item['type'] !== 'diff') return;
      const path = item['path'];
      const newText = item['newText'];
      if (typeof path !== 'string' || typeof newText !== 'string') return;
      const rawOld = item['oldText'];
      const oldText = typeof rawOld === 'string' ? rawOld : undefined;
      const at = unclaimed.findIndex(
        (prior) => prior.path === path && prior.oldText === oldText && prior.newText === newText,
      );
      const seen = at === -1 ? undefined : unclaimed.splice(at, 1)[0];
      let coverage: DiffCoverage;
      if (seen !== undefined) {
        coverage = { ...seen.coverage, index };
      } else {
        if (oldText === undefined) {
          // No prior text means the file did not exist: newText is all of it.
          coverage = { index, path, scope: 'wholeFile', startLine: 1, from: 'created' };
        } else if (this.wholeFileText.get(path) === oldText) {
          // The text being replaced is exactly what an earlier whole-file diff
          // left behind, so it is the whole file too.
          coverage = { index, path, scope: 'wholeFile', startLine: 1, from: 'chained' };
        } else {
          coverage = { index, path, scope: 'unknown' };
        }
        // What this diff leaves behind is known only while it covered the whole
        // file; anything else ends the chain for that path.
        if (coverage.scope === 'wholeFile') this.wholeFileText.set(path, newText);
        else this.wholeFileText.delete(path);
      }
      judged.push({ path, oldText, newText, coverage });
      out.push(coverage);
    });
    this.rowVerdicts.set(toolCallId, judged);
    return out.length > 0 ? out : undefined;
  }
}

/**
 * Create a judge of what a `diff` block covers, without the rest of a folder.
 *
 * The folder is built on the same unit, so a consumer that pushes the same
 * updates in the same order gets exactly what `ToolRow.diffs` would hold.
 * Feed it every `tool_call` / `tool_call_update` of one session in seq order;
 * anything else it ignores.
 * @returns the judge; a new session requires a new instance.
 */
export function createDiffCoverageJudge(): DiffCoverageJudge {
  return new DiffChain();
}

/**
 * Create a folder bound to the session/engine of its first accepted input.
 * @returns the folder; a new session requires a new instance.
 */
export function createFolder(): Folder {
  return new TranscriptFolder();
}

/**
 * Keys whose value names what a call acted on, most specific first. Shape,
 * not engine: an engine nobody has integrated yet that calls its field
 * `path` is read correctly, and one that does not falls through to the
 * single-string-key rule or to compact JSON.
 */
const ARGS_TEXT_KEYS = [
  'command',
  'cmd',
  'path',
  'file_path',
  'filePath',
  'uri',
  'url',
  'pattern',
  'query',
] as const;

/** The text carried by a row's `content` blocks, in order, undecorated. */
function textBlocks(content: readonly FoldedToolCallContent[] | undefined): string[] {
  const parts: string[] = [];
  for (const item of content ?? []) {
    // `content` is a whole-array replacement the wire supplies, so an entry
    // can be anything — including null. Reading a field off it must not throw:
    // a malformed block is skipped, like a malformed known update emits raw.
    if (!isRecord(item) || item['type'] !== 'content') continue;
    const block = (item as { content?: unknown }).content;
    if (!isRecord(block) || block['type'] !== 'text') continue;
    if (typeof block['text'] === 'string') parts.push(block['text']);
  }
  return parts;
}

/**
 * One readable line for a structured argument value.
 * @param value - a record or array of arguments.
 * @returns a named field's value, else compact JSON; undefined when the value
 *   cannot be serialized (a hand-built input with a cycle or a BigInt).
 */
function argsText(value: Record<string, unknown> | unknown[]): string | undefined {
  if (isRecord(value)) {
    for (const key of ARGS_TEXT_KEYS) {
      const found = value[key];
      if (typeof found === 'string' && found !== '') return found;
    }
    // A single string field is unambiguous whatever the engine named it.
    const keys = Object.keys(value);
    if (keys.length === 1) {
      const only = value[keys[0]!];
      if (typeof only === 'string' && only !== '') return only;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Parse text as JSON without throwing. @returns the value, or undefined. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Derive what a tool call acted on from whichever field the engine used.
 *
 * `rawInput` first, then `locations[0].path`, then the accumulated `content`
 * text — the order runs from the most explicit statement of arguments to the
 * least. Empty containers (`{}`, `[]`) are not a statement and fall through.
 *
 * The `content` source is bounded twice. It is read only at a terminal
 * status, because an engine that streams its arguments as text grows them
 * character by character and every intermediate read would be half a JSON
 * document. It is then accepted only if that text parses as an object or
 * array: unparseable content is indistinguishable from a tool's *result*
 * text, and labelling an output as an input is worse than reporting nothing.
 *
 * @param row - the stored row, already patched by this update.
 * @returns the derived arguments, or undefined when no source stated any.
 */
function deriveArgs(row: MutableToolRow): ToolCallArgs | undefined {
  const raw = row.rawInput;
  if ((isRecord(raw) && Object.keys(raw).length > 0) || (Array.isArray(raw) && raw.length > 0)) {
    const text = argsText(raw as Record<string, unknown> | unknown[]);
    if (text !== undefined) return { text, value: raw, from: 'rawInput' };
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    return { text: raw, from: 'rawInput' };
  }

  // The first location that actually names something: an engine that reports
  // an empty leading entry has still stated the rest.
  for (const location of row.locations ?? []) {
    const path = (location as { path?: unknown } | null)?.path;
    if (typeof path === 'string' && path !== '') return { text: path, from: 'locations' };
  }

  if (!isTerminalStatus(row.status)) return undefined;
  const streamed = textBlocks(row.content).join('');
  if (streamed.trim() === '') return undefined;
  const parsed = parseJson(streamed);
  if (!isRecord(parsed) && !Array.isArray(parsed)) return undefined;
  const text = argsText(parsed as Record<string, unknown> | unknown[]);
  return text === undefined ? undefined : { text, value: parsed, from: 'content' };
}

/**
 * Compare two derived argument values.
 * @returns true when neither the source nor what it stated has moved;
 *   `value` is compared by identity, matching how `rawInput` is stored.
 */
function sameArgs(a: ToolCallArgs | undefined, b: ToolCallArgs | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return a.from === b.from && a.text === b.text && a.value === b.value;
}

/**
 * Fold a whole transcript into the final state of every tool call, keyed by
 * `toolCallId`.
 *
 * The streaming `Folder` is the right shape for a live renderer, but an
 * after-the-fact reader wants the settled row, not the delta stream that
 * produced it. This runs one folder over the events and keeps the last
 * snapshot each id reached, so the merge rules stay in one place.
 *
 * This is also as far as a transcript can answer "what did the sub-agent
 * do?". An engine that spawns a sub-agent does not open a second session:
 * the whole sub-run is reported on the parent session as one tool call, so
 * everything recorded about it is in that one row — and whatever the engine
 * chose not to report is not recoverable here.
 *
 * @param events - transcript events for one session, in append order.
 * @returns settled rows by `toolCallId`, in first-seen order; empty if the
 *   transcript holds no tool calls. An id an engine re-uses after a terminal
 *   status is a second run to the folder, and the later run's row is the one
 *   kept.
 */
export function collectToolRows(events: Iterable<FoldInput>): Map<string, Readonly<ToolRow>> {
  const folder = createFolder();
  const rows = new Map<string, Readonly<ToolRow>>();
  const absorb = (folded: FoldedEvent[]): void => {
    for (const { event } of folded) {
      if (event.type === 'toolRow') rows.set(event.row.toolCallId, event.row);
    }
  };
  for (const input of events) absorb(folder.push(input));
  // flush() closes open message runs today and emits no row, but draining it
  // is what keeps this correct if it ever carries trailing state.
  absorb(folder.flush());
  return rows;
}

/**
 * Concatenate the text a tool call reported — for a sub-agent row, its
 * report back to the parent.
 *
 * Only `content` blocks carrying text are joined. Diffs, terminals, images
 * and future block types are structured payloads a caller must handle
 * itself, and flattening them here would invent a rendering; read `content`
 * directly for those.
 *
 * A row with no text blocks falls back to `rawOutput` when it is a string:
 * some engines report a tool's whole result there and never as content, and
 * core's transcript digest already reads it that way.
 *
 * @param row - a folded tool row.
 * @returns the text blocks joined by a blank line, else a string `rawOutput`;
 *   empty if the row reported neither.
 */
export function toolCallText(row: ToolRow): string {
  const parts = textBlocks(row.content);
  if (parts.length === 0 && typeof row.rawOutput === 'string') return row.rawOutput;
  return parts.join('\n\n');
}
