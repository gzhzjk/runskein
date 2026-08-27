# Transcript folding — `@runskein/fold`

`Session.on('update')` delivers the engine's `SessionUpdate` stream verbatim,
and the transcript stores it that way. That is deliberate: ACP owns the update
vocabulary, runskein invents no second one, and the transcript stays the
lossless audit truth. It is also not what a user interface wants to consume.

`@runskein/fold` is the layer between the two. It is optional — nothing in
core depends on it — and it is where the presentation semantics live so that a
terminal, a web UI and a log reader agree about what a tool row _is_ instead of
each re-deriving it.

This document is the behaviour contract. The exported types are in §5; the
executable specification is `packages/fold/test/contract.test.ts`.

---

## 1. What it is for

Interactive consumers need derived, **presentation-oriented** state:

- text chunks grouped into logical message streams without losing content
  metadata,
- `tool_call` plus sparse `tool_call_update` patches merged by `toolCallId`,
- legacy `plan` and keyed `plan_update` / `plan_removed` state kept distinct,
- ACP context-window snapshots and runskein token accounting presented without
  double-counting,
- unknown or malformed future variants surfaced as raw data, never dropped.

## 2. Position in the architecture

```
@runskein/core     TranscriptEvent stream — verbatim, frozen (untouched)
@runskein/fold  →  FoldInput → FoldedEvent[]            (this package)
packages/cli       terminal presenter (ANSI/shared streaming line)
your own UI        your own presenter (DOM/bubbles/components)
```

Hard rules:

1. **Consumer-side, always.** fold imports only core's public types. Core never
   imports fold; stores, digests, resume, exports, and the frozen API remain
   unchanged.
2. **Not a wire or persistence vocabulary.** `PresentationEvent` is a renderer
   model. It is never written to a `TranscriptStore` and never substituted for
   `SessionUpdate`.
3. **Deterministic and side-effect-free outside one instance.** No IO, timers,
   engine branches, callbacks, or dependency beyond core types. The folder may
   mutate its private state, but never mutates an input or a previously emitted
   snapshot.
4. **Runtime-total at the open ingress boundary.** `FoldInput.update` is
   `unknown`, because core intentionally lets future raw update objects reach
   consumers before generated TypeScript catches up. Known variants receive
   minimum runtime shape checks; an unknown or malformed known variant emits
   `raw` instead of throwing or disappearing.

## 3. Input ordering and lifecycle

One `Folder` instance binds to the `sessionId` and `engineId` of its first
accepted input. Valid core streams have strictly increasing `seq` per session;
fold processes arrival order and never invents a reorder buffer.

“Accepted” refers to the envelope: an identity/order-valid input binds the
folder even if its update later becomes `raw`.

- A gap is valid: consumers may start from `transcript({fromSeq})`.
- A repeated/decreasing `seq`, different `sessionId`, or changed `engineId`
  emits `raw { reason: 'invalid-envelope' }` and does not mutate fold state.
- Unknown/malformed updates still close an open message stream, because they
  are observable non-chunk boundaries.
- Live callers invoke `flush()` after `prompt()` settles and at session close.
  Replay callers invoke it at end-of-input. Transcript events do not contain a
  general turn-end marker, so fold must not infer one.
- `flush()` is idempotent. It only ends an open message; tool, plan, and usage
  state remain available. A new Folder is required for another session.

Because the frozen transcript has no general turn-end marker, an EOF-only
replay cannot reconstruct a live-only flush boundary when two turns contain
adjacent chunks with the same derived key and no intervening event.
Live/replay message-boundary parity is guaranteed only when callers supply the
same explicit flush schedule. A plain replay otherwise preserves event order
and payloads but may coalesce that degenerate case until EOF.

## 4. Folding semantics

### 4.1 Message streams

`agent_message_chunk`, `agent_thought_chunk`, and `user_message_chunk` map to
`kind: 'agent' | 'thought' | 'user'`. `messageId: null` is normalized to absent.
The open stream key is `(kind, messageId)`; when the id is absent, kind alone is
the key.

For a valid text block:

1. If the key differs from the open stream, emit `messageEnd` for the old
   stream (using its last chunk as source), then `messageStart` for the new one.
2. Emit `messageAppend` for **every** text block, including the first. The event
   carries the complete text block, not only its string, so annotations and
   `_meta` remain available to presenters.

Any non-chunk update closes the open stream before its own output. A non-text
chunk also closes the open stream and emits `content` with `kind`, normalized
`messageId`, and the block. The role/id must not be discarded: a web UI needs
to know whether an image or resource belongs to the user, agent, or thought
stream.

A known chunk envelope whose `content` is an object with an unknown string
`type` is forward-compatible and emits `content` with an
`UnknownContentBlock`. Missing, non-object, or discriminator-less `content` is
a malformed known update and follows §4.5. Unknown variants nested in tool
content remain part of the tool-row snapshot.

### 4.2 Tool rows

- `tool_call` creates or authoritatively replaces a row. Arrays are copied;
  input objects are never mutated.
- `tool_call_update` on an unseen id creates a partial row containing only
  `toolCallId`; this makes a partial transcript deterministic. A later full
  `tool_call` replaces that partial row.
- For the pinned ACP v1 nullable patch fields (`kind`, `status`, `title`,
  `name`, `content`, `locations`), omission and `null` mean no change; a
  concrete value replaces the old value. `content` and `locations` arrays are
  whole replacements, not append deltas. For `rawInput` / `rawOutput`, own-key
  presence is the patch signal and `null` is a legitimate replacement value.
- Every creation/update emits `toolRow { row, changed }`. `changed` lists the
  supplied row fields applied from this input, excluding identity and metadata,
  plus the derived `args` when recomputing it moved the value — a presenter
  repainting by `changed` must be told the derived line changed too. It does
  not mean deep value inequality. The row is a readonly snapshot and
  later patches cannot mutate an older event.
- After emitting `completed` or `failed`, evict the private row. A later update
  for that id starts a new partial row. This bounds retained state by active
  tool calls while preserving the complete terminal snapshot.
- Unknown `ToolCallContent.type` remains inside the row; presenters use their
  raw fallback.

#### 4.2.1 `args` — what the call acted on

ACP requires only `toolCallId` and `title`; `rawInput`, `locations` and `content` are all optional, so
engines state "which file, which command" in different places and none of them
is wrong. Counted by a downstream consumer over its stored transcripts on one
machine: pi states a non-empty `rawInput` on all 141 of its calls, claude-code
on 849 of 1659, opencode on 45 of 348, and kimi on none of its 920 — kimi
grows the arguments as `content` text instead. Passing that spread through means every presenter either branches on
engine id (and misses the next engine) or shows nothing, and `ToolRow` is
already a fold-owned presentation type, so the convergence belongs here.

`args` is `{ text, value?, from }`:

- `from` is always reported. A consumer must be able to tell what the engine
  stated from what fold assembled; fold reports the source, it does not
  smooth it over.
- Sources are tried most-explicit first: a non-empty `rawInput`, then the
  first `locations` entry naming a non-empty path, then the accumulated
  `content` text. Empty containers (`{}`, `[]`) and entries that name nothing
  state nothing and fall through.
- `from: 'content'` is bounded twice. It is read only at a terminal status,
  because an engine that streams arguments as text grows them character by
  character and every intermediate read is half a JSON document. It is then
  accepted only if that text parses as an object or array — unparseable
  content is indistinguishable from a tool's _result_ text, and labelling an
  output as an input is worse than reporting nothing.
- `text` is chosen by shape, never by engine: the first of `command`, `cmd`,
  `path`, `file_path`, `filePath`, `uri`, `url`, `pattern`, `query` that
  holds a non-empty string; else a lone string-valued key; else compact JSON.
  A bare string source is its own line and carries no `value`.
- `args` is derived, never read from the wire. An engine that sends its own
  `args` field does not set it.

Presenters may coalesce repainting, but fold emits every patch. A presenter that
hides intermediate content growth must still repaint the full row at a terminal
status.

#### 4.2.2 `diffs` — what a diff block covers

A `diff` content block is `{path, oldText?, newText}`. Nothing in it says
whether that text is the whole file or a fragment of it, so a renderer cannot
tell whether numbering the block from 1 matches the file's own lines, and the
coverage varies per tool inside one engine — a downstream survey of 556 diff
blocks found claude-code's `Write` sending whole files and its `Edit` sending
fragments, with `ToolCallLocation.line` filled zero times out of 545. Branching
on engine id is not a fallback here; it is wrong.

`ToolRow.diffs` holds one `DiffCoverage { index, path, scope, startLine?, from? }`
per diff block, in content order, and answers only where the transcript proves
the answer:

- `from: 'created'` — the block has no `oldText`, so it wrote the file into
  existence and `newText` is all of it: `wholeFile`, `startLine: 1`.
- `from: 'chained'` — the block's `oldText` is exactly the `newText` of an
  earlier whole-file block for the same path, so the replaced text is the whole
  file: `wholeFile`, `startLine: 1`. Any other diff for that path ends the
  chain, because what the file holds afterwards is no longer known.
- Everything else is `scope: 'unknown'` with no `startLine`. Locating a fragment
  needs the file's contents, and fold does no IO — a replayed transcript's files
  have moved on anyway, so a number read back from disk would describe now
  rather than the moment of the edit. A wrong line number is worse than none.

A consumer may claim file line numbers for `wholeFile` and must not for
`unknown`. Coverage is derived as events arrive, so a folder started mid-stream
has no chain to build on until a diff proves something.

A block a row was already judged on keeps its verdict, because engines resend
the whole `content` array as a call progresses and re-judging would test the
block's `oldText` against the text its own first pass recorded, turning a proven
chain into `unknown`. That reuse is scoped to the row: across rows the same edit
can genuinely happen twice with other edits in between, and the later one is
judged against the chain as it stands then. Within a row the verdicts are handed
back one for one, because a row can carry the same edit twice and the second
copy was judged against what the first left behind. The verdicts are kept per
row, so a completed tool call frees them with the row.

The judgement is a unit of its own, `createDiffCoverageJudge()`, and the folder
holds one like any other consumer — a consumer needing coverage on a path that
does not fold gets the same verdicts without carrying message, plan or usage
state, and there is no second implementation to drift (decision 036). It takes
whole updates rather than content blocks, because the row rules are part of the
judgement: a full `tool_call` starts a new run and inherits no verdict, and a
terminal status ends the row and frees its verdicts. It accepts exactly the row
patches the folder applies, and returns `undefined` for an update that judged
nothing — one carrying no `content`, or none of whose blocks is a judgeable
diff. Push every `tool_call` / `tool_call_update` of one session in seq order;
anything else is ignored.

The chain holds the file text itself, compared verbatim. A hash small enough to
be worth keeping would make `chained` a likelihood rather than a proof, and a
collision would surface as a confidently wrong line number. Retained size is
therefore one copy of the text of each file an engine last rewrote whole; a
path whose chain is broken is dropped from the map.

### 4.3 Plan state

ACP v1 has two distinct shapes and fold must not conflate them:

- `plan { entries }` replaces one unkeyed **legacy plan**.
- `plan_update { plan }` replaces the complete keyed value at `plan.planId`.
  `items`, `file`, and `markdown` are alternative current representations; a
  kind switch replaces the previous representation rather than retaining stale
  fields.
- `plan_removed { planId }` removes only that keyed plan. It does not remove the
  unkeyed legacy plan.

Each valid plan input emits the complete readonly `PlanSnapshot`, plus
`changedPlanId` or `removedPlanId` where applicable. Entry arrays are copied;
unchanged immutable plan values may be structurally shared. Snapshot creation
is O(number of active keyed plans); retained memory is O(active plan state).

### 4.4 Usage state

`usage_update.used` and `.size` are **current context-window values**, not
deltas. Each update replaces both values. `cost`, when concrete, is already a
cumulative session cost and replaces the prior cost; omitted or `null` leaves
the last reported cost unchanged. Fold never sums any of these fields and
never performs currency conversion.

RunSkein token accounting is separate: `TranscriptEvent.usage`, when present, is
the core-computed cumulative `Usage` snapshot and replaces the prior token
snapshot. `usageState` exposes both channels explicitly:

```ts
interface UsageState {
  readonly context?: Readonly<{ used: number; size: number }>;
  readonly cost?: Readonly<{ amount: number; currency: string }>;
  readonly tokens?: Readonly<Usage>;
}
```

A `usage_update` emits one `usageState` after applying both the ACP fields and
the envelope's optional runskein usage. If a future valid event carries
`TranscriptEvent.usage` on another update, fold emits the normal event followed
by the updated `usageState`. Missing data stays absent; zero stays zero.

The two channels are independent, and a `usage_update` may carry either one.
The protocol requires `used`/`size`, but runskein synthesizes a token-only
`usage_update` — no window gauge, because fabricating one from token counts
would be invention — marked with a `runskein.dev/syntheticUsage` `_meta` key. Fold
therefore accepts a window-less usage_update: it applies whichever of the three
channels (window, cost, envelope tokens) the event actually carries and emits
one `usageState` for the result.

Fold reads token counts from the envelope only, never from runskein's field names
on the update body. The body names make a transcript self-describing on replay;
for an engine whose tokens are declared to come from its prompt response, core
deliberately leaves them off the envelope so they are counted once, and reading
the body here would count them twice.

### 4.5 Pass-through and malformed input

- `available_commands_update`, `current_mode_update`,
  `config_option_update`, and `session_info_update` emit `notice { update }`
  after minimum validation.
- An unknown `sessionUpdate`, a primitive/non-object update, or a known
  discriminant with a malformed payload emits `raw { update, reason }`.
- “Minimum validation” checks the discriminant and every required
  primitive/container field that fold reads for identity or state. Opaque
  metadata and unknown nested content discriminants remain forward-compatible.
- For `usage_update` that means: a field that is present must be well formed —
  half a window gauge, or a gauge whose halves are not both finite numbers, is
  malformed however much the other channels carry. An explicit `null` counts as
  absent there, exactly as an omitted field does. An event carrying no channel
  at all is malformed too, since the protocol requires the gauge, unless it
  carries runskein's synthetic-usage marker: that one is well formed with nothing
  to fold, and emits neither `raw` nor `usageState`.
- Validation happens before variant-specific mutation. An unknown or malformed
  update may close the open message as the documented boundary rule, but it
  cannot partially patch tool, plan, or usage state. An invalid envelope does
  not even close the message because §3 requires no state mutation.

### 4.6 Whole-transcript readers

The streaming `Folder` is the right shape for a live renderer. A reader
working over a finished transcript wants the settled result instead, so two
helpers sit on top of the same folder — the merge rules stay in one place:

- `collectToolRows(events)` folds an ordered event stream and returns the last
  snapshot each `toolCallId` reached, in first-seen order. An id an engine
  re-uses after a terminal status is a second run (§4.2 eviction), and the
  later run's row is the one kept.
- `toolCallText(row)` joins the text a tool call reported, blank-line
  separated, falling back to a string `rawOutput` when the row carries no text
  block — some engines report a whole tool result there, as core's transcript
  digest already accounts for. Diff, terminal, image and future block types
  are structured payloads the caller reads from `content` itself; flattening
  them here would invent a rendering fold does not own (§6).

This is also as far as a transcript can answer **"what did the sub-agent
do?"**. An engine that spawns a sub-agent does not open a second session: the
whole sub-run is reported on the parent session as one tool call, so
everything recorded about it is in that one row. What the engine chose not to
report is not recoverable at this layer — surfacing more would need the
engine to emit it and runskein to model a parent/child relation, neither of which
fold can do on its own.

## 5. Type surface

Every presentation event carries the transcript source that caused it. For an
implicit/explicit `messageEnd`, source is the last chunk in that message, not
the following boundary event. Replay parity is subject to the explicit-boundary
rule in §3.

```ts
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
type UnknownContentBlock = Readonly<Record<string, unknown>> & {
  readonly type: string;
};
type UnknownToolCallContent = Readonly<Record<string, unknown>> & {
  readonly type: string;
};
type FoldedToolCallContent = Readonly<ToolCallContent> | Readonly<UnknownToolCallContent>;
type MessageKind = 'agent' | 'thought' | 'user';
type NoticeUpdate = Extract<
  SessionUpdate,
  {
    sessionUpdate:
      'available_commands_update' | 'current_mode_update' | 'config_option_update' | 'session_info_update';
  }
>;

type FoldInput = Omit<TranscriptEvent, 'update'> & { update: unknown };
type SourceRef = Readonly<Pick<TranscriptEvent, 'seq' | 'ts' | 'sessionId' | 'engineId'>>;

interface FoldedEvent {
  readonly source: SourceRef;
  readonly event: PresentationEvent;
}

type PresentationEvent = Readonly<
  | { type: 'messageStart'; kind: MessageKind; messageId?: string }
  | { type: 'messageAppend'; block: Readonly<TextBlock> }
  | { type: 'messageEnd' }
  | {
      type: 'content';
      kind: MessageKind;
      messageId?: string;
      block: Readonly<NonTextBlock> | Readonly<UnknownContentBlock>;
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

interface PlanSnapshot {
  readonly legacy?: readonly Readonly<PlanEntry>[];
  readonly keyed: readonly Readonly<KeyedPlanState>[];
}

interface ToolRow {
  readonly toolCallId: string;
  readonly title?: string;
  readonly name?: string;
  readonly kind?: ToolKind;
  readonly status?: ToolCallStatus;
  readonly content?: readonly FoldedToolCallContent[];
  readonly locations?: readonly Readonly<ToolCallLocation>[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  /** Fold-derived (see 4.2.1), never read from the wire. */
  readonly args?: Readonly<ToolCallArgs>;
  /** Fold-derived (see 4.2.2), never read from the wire. */
  readonly diffs?: readonly Readonly<DiffCoverage>[];
}

interface ToolCallArgs {
  readonly text: string;
  readonly value?: unknown;
  readonly from: 'rawInput' | 'locations' | 'content';
}

interface DiffCoverage {
  readonly index: number;
  readonly path: string;
  readonly scope: 'wholeFile' | 'unknown';
  readonly startLine?: number;
  readonly from?: 'created' | 'chained';
}

type ToolRowField = Exclude<keyof ToolRow, 'toolCallId'>;

type KeyedPlanState =
  | {
      readonly type: 'items';
      readonly planId: string;
      readonly entries: readonly Readonly<PlanEntry>[];
    }
  | { readonly type: 'file'; readonly planId: string; readonly uri: string }
  | {
      readonly type: 'markdown';
      readonly planId: string;
      readonly content: string;
    };

declare function createFolder(): Folder;

interface Folder {
  push(input: FoldInput): FoldedEvent[];
  flush(): FoldedEvent[];
}

interface DiffCoverageJudge {
  push(update: unknown): readonly Readonly<DiffCoverage>[] | undefined;
}

declare function createDiffCoverageJudge(): DiffCoverageJudge;
declare function collectToolRows(events: Iterable<FoldInput>): Map<string, Readonly<ToolRow>>;
declare function toolCallText(row: ToolRow): string;
```

`ToolRow`, `ToolCallArgs`, `KeyedPlanState`, and `UsageState` are package-owned readonly
presentation types derived from core's public vocabulary. They must not import
or re-export ACP SDK declarations.

Large payload rule: fold does not decode base64 or copy strings into extra
buffers. JavaScript strings are immutable and may be shared. Arrays/row shells
are copied for snapshot stability; inputs and outputs are documented readonly.
Fold does not sanitize, truncate, serialize, or deep-clone arbitrary
`rawInput`/`rawOutput` values.

## 6. What stays per UI

fold deliberately does **not** own:

- **Rendering/coalescing policy.** A terminal appends to one line; a web UI
  patches a bubble; a log consumer may print every patch.
- **Output safety.** Terminal control stripping stays in the CLI
  ([`cli.md`](cli.md) §4.1); a web presenter performs context-appropriate HTML/URL
  escaping. Fold carries data, never markup.
- **IO and interaction.** Permission prompts, questions, input state machines,
  cancellation, and shutdown remain consumer territory.
- **Persistence or replay scheduling.** The host supplies ordered events and
  decides when live-turn/end-of-input flushes occur.

## 7. Where the rest lives

- **The executable specification** is `packages/fold/test/contract.test.ts`:
  table-driven, plain `FoldInput[]` fixtures, no process or ACP dependency.
  Every rule above has cases there — message boundaries and flush idempotence,
  envelope rejection, the derived `args` sources, the coverage judge's verdicts
  against the folder's own, tool-row eviction, and the memory bounds. When this
  document and that suite disagree, the suite is what ships.
- [`engine-adapter-api.md`](engine-adapter-api.md) — the frozen v1 surface fold
  reads from. It is untouched by this layer: fold accepts a wider _runtime_
  input shape only to honour core's documented raw-update fallback, and
  transcript persistence, resume and export stay verbatim.
- [`cli.md`](cli.md) — the first presenter, and a worked example of the
  rendering and coalescing policy §6 leaves to the consumer.
