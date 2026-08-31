# runskein — API Specification (v1, frozen)

> Status: **frozen** for v1. Changes require a decision note in `docs/decisions/`.
>
> runskein is a unified engine adapter: one TypeScript API to manage
> coding-agent engines (start / quit / resume / fork), one transcript format,
> engine integration via self-contained, auto-discovered adapters. The Agent Client Protocol (ACP) is the
> internal spine — every engine is wrapped as an ACP agent process — but the
> ACP transport and SDK are **never exposed** to the consumer. Public runskein
> types structurally mirror the selected ACP v1 vocabulary where useful.

---

## 1. Design principles

1. **Two objects, two concerns.** `Hub` manages engines/processes; `Session`
   manages one conversation. Consumers spend ~90% of their time on `Session`.
2. **Three capability tiers** (see §8):
   - **Core** — guaranteed by the library; conformance-enforced. An engine
     that fails Core is not registrable.
   - **Negotiated** — passed through when the engine supports it; otherwise a
     typed `NotSupportedError`. Never silently ignored.
   - **Emulated** — the library fills the gap itself (e.g. resume via
     transcript digest). Always available to the consumer.
3. **ACP is internal.** The consumer sees a TS API and the runskein transcript
   envelope. `ContentBlock`, `SessionUpdate`, `ToolKind`, and related public
   names are runskein-owned structural mirrors of selected ACP v1 vocabulary,
   not SDK re-exports. ACP breaking changes are absorbed by runskein's mapping
   and versioning rather than leaking through an SDK dependency.
4. **Explicit engine selection.** No `auto` routing. Routing/policy is the
   consumer's business.
5. **One permission mechanism.** A single `PermissionPolicy` function.
   "bypass" and "ask" are just policies, not modes.
6. **Adapters are discoverable data, not code.** An adapter describes _how to
   obtain an ACP-speaking process_, lives in its own directory following the
   adapter spec, and is auto-discovered. New engines require zero core or
   client changes — capability negotiation absorbs the differences.

---

## 2. Hub

```ts
import { createHub, jsonlStore, sqliteStore, policies } from 'runskein';

const hub = createHub({
  adapters?: EngineAdapter[],       // explicit — highest priority (tests, embedding)
  adapterPaths?: string[],          // extra directories to scan
  discovery?: boolean,              // default false — opt in to executable discovery (§9)
  store?: TranscriptStore,          // default: jsonlStore('.transcripts')
  defaults?: {
    permissionPolicy?: PermissionPolicy,   // default: policies.allowAll
    idleTimeoutMs?: number,                // process reap, after the last reference
    sessionIdleTimeoutMs?: number,         // session lets go of its engine; off when absent
    reactivationAttempts?: number,         // retries per reactivation episode; default 3
    requestTimeoutMs?: number,             // session setup, resume, fork, and cleanup; default 30_000
    turnTimeoutMs?: number,                // prompt only; unbounded when absent
  },
});
```

### 2.1 Engine inventory & discovery

```ts
hub.engines(): Promise<EngineInfo[]>;
```

Cheap and **never spawns**, but asynchronous because it lazily runs each
adapter's `detect()` hook. Results are cached until `hub.rescan()`.

```ts
type EngineInfo = RegisteredEngineInfo | InvalidEngineInfo;

interface RegisteredEngineInfo {
  id: string; // 'opencode' | 'kimi' | 'claude-code' | 'codex' | ...
  installed: boolean;
  version?: string;
  authenticated?: boolean; // from detect(); undefined = unknown
  health: Exclude<Health, 'invalid'>;
  error?: never;
  configHints?: ConfigSchema; // static fallback from the adapter
}

interface InvalidEngineInfo {
  id?: string; // absent when it cannot be recovered from the candidate
  installed?: false;
  health: 'invalid';
  error: string;
}

type Health =
  'stopped' | 'ready' | 'starting' | 'degraded' | 'dead' | 'invalid' | 'not-installed' | 'unauthenticated';
```

`stopped` means the adapter is usable but has no child process, including
before first use and after idle reaping. `invalid` covers candidates that failed
discovery/schema validation and registered adapters whose `detect()` probe
failed. Targeting the latter rejects `EngineOperationError` with operation
`adapter/detect`; it is never returned as a healthy `RegisteredEngineInfo`
claiming the engine is simply absent.

```ts
hub.describe(engineId: string): Promise<EngineDescriptor>;
```

Expensive probe: spawn → `initialize` → `session/new` → collect → close.
Cached; cache key = `engineId + engine version`.

```ts
interface EngineDescriptor {
  capabilities: CapabilityMatrix; // resume/load/fork/list/... booleans
  providers?: ProviderInfo[]; // when the agent supports providers/list
  modes?: SessionMode[]; // e.g. fast / plan / auto
  models?: SessionModel[]; // when the agent advertises models at session/new
  currentModel?: string; // model a fresh session starts on, as probed (advisory)
  configOptions: ConfigOption[]; // thought levels, toggles, and models on
  // engines that expose them as config options
  source: 'probe' | 'hints'; // live truth vs adapter configHints fallback
}
```

`ConfigOption` is runskein's stable structural mirror of the ACP
`SessionConfigOption` shape, plus `settable`, which is runskein's own — it says
**when** an option can be written, not what it holds:

```ts
interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: 'mode' | 'model' | 'model_config' | 'thought_level' | (string & {});
  type: 'select' | 'boolean';
  options?: SelectOption[] | SelectGroup[]; // for type: 'select'
  currentValue?: string | boolean;
  settable?: 'session' | 'creation'; // absent = 'session'
}

type ConfigSchema = ConfigOption[];

interface SelectOption {
  value: string;
  name: string;
  description?: string;
}

interface SelectGroup {
  name: string;
  options: SelectOption[];
}

interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

interface SessionModel {
  id: string;
  name: string;
  description?: string;
}

interface ProviderInfo {
  id: string;
  protocols: string[];
  required: boolean;
  current?: { apiType: string; baseUrl: string };
  metadata?: Record<string, unknown>;
}

interface CapabilityMatrix {
  loadSession: boolean;
  session: Record<string, boolean>; // resume/fork/list/close/... normalized to booleans
  prompt: Record<string, boolean>; // image/audio/embeddedContext/...
  mcp: Record<string, boolean>; // http/sse/...
  providers: boolean;
}
```

Truth priority: **live probe > adapter configHints**. When the engine reports
nothing (e.g. no `configOptions` support), `describe()` degrades to the
adapter's `configHints` with `source: 'hints'`.

Model selection is reported separately from `configOptions` because engines
expose it on its own protocol surface. Where `models` is present,
`setConfig({model})` writes through it; where it is absent and the engine lists
the model as a config option instead, the config path is used. Consumers pass
`config: { model }` either way.

### 2.2 Sessions

```ts
hub.session(opts: SessionOpts): Promise<Session>;   // main entry; spawns on demand
hub.attach(sessionId: string): Promise<Session>;    // re-attach from transcript store
hub.sessions(filter?: SessionFilter): Promise<SessionMeta[]>;
```

```ts
interface SessionFilter {
  engineId?: string;
  status?: Session['status'];
  cwd?: string;
  since?: number; // epoch ms, inclusive
  until?: number; // epoch ms, inclusive
}

interface SessionMeta {
  sessionId: string;
  engineId: string;
  cwd: string;
  status: Session['status'];
  createdAt: number;
  updatedAt: number;
}

interface SessionOpts {
  engine: string; // required, explicit; never 'auto'
  cwd: string;
  mcpServers?: McpServerConfig[];
  systemInstructions?: string;
  resume?: string;
  permissionPolicy?: PermissionPolicy;
  config?: Record<string, string | boolean>;
  sessionIdleTimeoutMs?: number;
  reactivationAttempts?: number;
  requestTimeoutMs?: number;
  turnTimeoutMs?: number;
}
```

`hub.sessions()` is answered by the **local transcript store** (authoritative);
the engine's `session/list` is used only as a cross-check when available.
`requestTimeoutMs` rejects setup operations as `EngineOperationError` with
`kind: 'timeout'`; a session-creating request that succeeds after its timeout
is closed and deleted where the engine advertises deletion.

### 2.3 Process control

```ts
hub.quit(engineId?: string, opts?: { timeoutMs?: number }): Promise<void>;
hub.health(): Promise<Record<string, Health>>;
hub.rescan(): Promise<void>;
hub.on('engine:crash' | 'engine:restarted' | 'engine:unauthenticated' | 'engine:cleanup-failed', cb): Unsubscribe;
```

Like `engines()`, `health()` awaits lazy detection and does not spawn. Its
record contains candidates with a known `id`; an invalid candidate whose id
cannot be recovered remains visible only through `engines()`.

- `quit` degradation chain: `session/close` for all live sessions → close
  stdin → `SIGTERM` → `SIGKILL`. No argument = all engines.
- `engine:cleanup-failed` carries `EngineCleanupFailure` with the engine,
  optional runskein/native session ids, cleanup operation, and original error;
  cleanup is never reported as successful when a step failed.
- **No public spawn/restart.** `session()` spawns on demand (reference-counted
  process sharing per engine); crashes auto-restart with backoff and emit
  `engine:crash` / `engine:restarted`. Idle processes are reaped after
  `idleTimeoutMs`.

---

## 3. Session

```ts
const s = await hub.session({
  engine: string,                    // required, explicit — no 'auto'
  cwd: string,
  mcpServers?: McpServerConfig[],
  systemInstructions?: string,
  resume?: string,                   // prior sessionId; see §7 degradation chain
  permissionPolicy?: PermissionPolicy,
  config?: Record<string, string | boolean>,  // keys validated against describe()
});
```

`config` keys are resolved against `describe()`, and the surface a key lands on
depends on what the engine advertises:

| key           | surface                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `mode`        | `describe().modes` → `session/set_mode`, else a `mode`-category config option                             |
| `model`       | a `model`-category config option where the engine has one, else `describe().models` → `session/set_model` |
| `reasoning`   | the `thought_level`-category config option                                                                |
| anything else | a config option with that id, else that category                                                          |

An engine may publish a model both ways — codex lists `models` with
reasoning-effort suffixes while its config option takes the bare id. The config
option wins there, because it is the stable surface and its ids are the ones
callers already use.

An unknown key or value fails fast with the list of valid values — never
silently ignored, and never sent to the engine first.

### 3.1 Surface

```ts
s.id: string;
s.engine: string;
s.status: 'idle' | 'running' | 'awaiting-input' | 'closed' | 'failed';
s.resumeTier?: 'native' | 'load' | 'rebuilt';

s.prompt(input: string | ContentBlock[]): Promise<TurnResult>;
s.cancel(): Promise<void>;           // interrupt current turn; session survives
s.close(opts?: CloseOptions): Promise<void>;
s.fork(): Promise<Session>;          // [Negotiated]
s.setConfig(patch: Record<string, string | boolean>): Promise<void>;  // [Negotiated]
                                     // refuses a settable:'creation' key with
                                     // NotSupportedError('config:<key>@runtime')
s.configState(): SessionConfigState;  // what runskein wrote vs what the engine reports
s.respond(requestId: string, answer: Answer): Promise<void>;  // question replies (HITL)

s.on('update', (e: TranscriptEvent) => void): Unsubscribe;
s.on('permission', (req: PermissionRequest) => void): Unsubscribe;  // read-only notification
s.on('question', (q: QuestionRequest) => void): Unsubscribe;
s.on('status', (st: Session['status']) => void): Unsubscribe;
s.on('reactivated', (info: { tier: 'native' | 'load' | 'rebuilt' }) => void): Unsubscribe;

s.transcript(opts?: { fromSeq?: number }): AsyncIterable<TranscriptEvent>;
s.usage(): UsageSummary;             // cumulative tokens/cost for this session
```

```ts
interface CloseOptions {
  discard?: boolean;
}
```

### 3.2 Turn semantics

`prompt()` is a **turn-level promise**: it resolves when the turn ends.

```ts
interface TurnResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
  usage?: Usage;
  durationMs: number;
  quota?: { engineId: string; payload: unknown }; // engine-reported, opaque
}
```

`quota` is whatever the engine put under `_meta.quota` on the prompt response,
passed through untouched, and **absent** when it reported nothing — an engine
that sends an empty `_meta` does not acquire the field. It is deliberately
opaque and engine-scoped: of the built-in engines only codex reports anything, and
its shape is its own, so runskein does not build a cross-engine vocabulary from a
single example. Read `payload` against the engine named in `engineId`.

It is **not a remaining allowance.** What codex labels quota is a per-turn
token count, so this field does not enable budget gating, and runskein never
back-fills it from `usage_update` — presenting token counts as headroom would
give an unattended host a confidently wrong budget signal.

One engine has begun reporting more than that, and this field still does not
carry it. claude-code streams a rate-limit record on `usage_update`'s `_meta`,
under `_claude/rateLimit`, carrying a `status`, a `resetsAt` and a
`rateLimitType` (measured 2026-08-31) — a real reset, which no engine reported
when this field was designed. It stays unfolded for two reasons: `quota` reads
the prompt response and this arrives on a notification, and folding a key that
names one vendor would build the cross-engine vocabulary from a single example
that the paragraph above says runskein does not build. A host can read it
verbatim today, from `on('update')` or from the transcript — the envelope stores
`update` unchanged, `resetsAt` included. When a second engine reports a reset,
what the two have in common is what a vocabulary could be made of.

Streaming detail flows through `on('update')`. Both styles compose:
`await s.prompt(...)` for simple flows; subscribe to updates for streaming UIs
or stream-folding hosts.

`on('update')` carries **every** event the session writes to its transcript, in
the same order and with the same `seq` — the engine's notifications and the ones
runskein generates itself alike: the session-status reports, the prompt echoed back
so a transcript reads as a conversation, and the synthesized `usage_update` that
carries token counts for engines that report them on the prompt response
(decision 035). A subscriber that also replays the transcript therefore sees each
event twice and deduplicates on `seq`. Emission happens as the event is
recorded, before the store has it, so the parity is with a transcript that
persists — a store failure surfaces at the next API boundary as `StoreError`,
not as a silently missing live event. Events recorded before a caller can
subscribe — session creation and the resume that opened the session — reach no
listener and are read from the transcript; a later in-place reactivation records
its own event, which existing subscribers do see.

The prompt echo is the one a host usually wants to skip: it already drew the
input it submitted, and an engine replaying context can send a `user_message_chunk`
that looks exactly the same. `isPromptEcho(update)` tells them apart — true only
for the chunk runskein wrote.

Concurrent `prompt()` on the same session queues (FIFO). `cancel()`
semantics (clarified — see `docs/decisions/001-cancel-semantics.md`): the
**active** turn **resolves** normally with `stopReason: 'cancelled'` (ACP:
`session/cancel` followed by an ordinary prompt response); only prompts that
never ran — the queued ones, or all pending on `close()` — **reject** with
`CancelledError`.

`close()` rejects both the active and queued `prompt()` promises with
`CancelledError`, marks the session `closed`, and is idempotent. This differs
from `cancel()`: an active turn cancelled through `cancel()` ran and therefore
resolves with its orderly stop reason.

### 3.3 Session lifetime — idle release and crash recovery

A `Session` does not have to hold its engine for its whole life. Two triggers
release it, and one mechanism brings it back:

- **Idle.** With `sessionIdleTimeoutMs` set, a session that has been idle that
  long releases its engine reference. The countdown runs only while the session
  is genuinely idle — no running turn, no queued prompt, no unanswered
  permission or question — and any activity restarts it. Releasing the last
  reference is what lets `idleTimeoutMs` reap the process; the two clocks are
  separate deadlines.
- **Crash.** When the engine dies, affected sessions release what they hold.
  The in-flight `prompt()` rejects with `EngineCrashError`.

Either way the **next use revives the session in place**: `prompt()`,
`setConfig()`, and `fork()` re-acquire an engine, run the resume chain, and
re-apply every configuration runskein had acknowledged. There are **no new verbs**
— you keep the same `Session` object, its runskein id, and its transcript, and the
only way to notice is the event:

```ts
s.on('reactivated', ({ tier }) => {
  /* 'native' | 'load' | 'rebuilt' */
});
```

That event is not optional detail. The `rebuilt` tier replays the transcript
digest as fresh context, which **spends tokens** — recovery is allowed to
degrade, never to degrade silently.

**The interrupted turn is not replayed.** Its output is already in the
transcript but it has no `stopReason`, and re-sending it would spend tokens
again. Whether to retry is policy, so it belongs to the caller: the rejected
`prompt()` is the signal, and the next `prompt()` you send is your decision.

**Bounded.** One reactivation episode retries up to `reactivationAttempts`
(default 3) before failing with
`EngineOperationError { operation: 'session/reactivate' }`, whose `cause`
carries `{ attempts, cap, lastError }`. This is a different budget from the
process manager's restart attempts: one reactivation attempt performs at most
one engine acquire, and may reuse a healthy process and spawn nothing.

`close()` always wins. Closing during a reactivation is safe and idempotent,
and a revival that was in flight gives back everything it took rather than
publishing onto a closed session.

### 3.4 Discarding engine state

`close({ discard: true })` adds engine-side deletion to ordinary closure. It
is **Negotiated**: an engine that does not advertise `session/delete` rejects
with `NotSupportedError { capability: 'session.delete' }`, but the local
session is still irreversibly `closed`, its engine reference is released, and
its transcript remains available. Local transcript retention is separate: the
host calls `TranscriptStore.delete(sessionId)` on the store it constructed if
that is what it wants.

On a capable engine runskein attempts `session/close` where advertised, then
`session/delete` even when close fails. A delete failure rejects with
`EngineOperationError { operation: 'session/delete' }`; if close and delete
both fail, that error's `cause` is an `AggregateError` containing both
failures. All of those errors occur only after local closure is complete.

Concurrent and repeated compatible calls share the first close promise and
never issue another wire close/delete. A plain `close()` followed by
`close({ discard: true })` instead rejects with
`EngineOperationError { operation: 'session/delete' }`: reporting success
there would falsely claim an engine-side delete happened. A plain call after a
discarding close shares the discarding call's outcome.

### 3.5 Config state — desired vs observed

`setConfig()` reports only that a write was accepted on the wire. Whether the
engine is actually running on that model afterwards is a different question,
and most engines never answer it. `configState()` keeps the two apart:

```ts
interface SessionConfigState {
  desired: Readonly<Record<string, string | boolean>>;
  observed: Readonly<Record<string, ConfigObservation>>;
}

interface ConfigObservation {
  value: string | boolean;
  source:
    'session/new' | 'session/resume' | 'session/load' | 'current_mode_update' | 'config_option_update';
  observedAt: number; // epoch ms
  engineOptionId?: string; // the wire option id the report carried
}
```

- **`desired`** — values whose write the engine acknowledged, including config
  passed to `hub.session({config})` and anything runskein re-applies for you.
- **`observed`** — only what the engine reported on its own: state echoed by
  whichever call produced the session (`session/new`, `session/resume`, or
  `session/load`, each reported under its own name so restored state is
  distinguishable from fresh), or a pushed `current_mode_update` /
  `config_option_update`.

`desired` is **never** copied into `observed`. A key missing from `observed`
means the engine never reported it — not that it agrees with `desired`. Reading
either view issues no wire requests.

Both maps are keyed by runskein keys (`model`, `mode`, `reasoning`, or an engine
option id used directly), the same keys `setConfig` accepts. When an engine
reports an option runskein cannot map to a runskein key, the observation is recorded
under the raw engine option id rather than dropped, and `engineOptionId` tells
you which wire identifier produced any entry.

---

## 4. Transcript

The library's differentiating asset: **one format, every engine, persistent**.

```ts
interface TranscriptEvent {
  seq: number; // monotonic per session (runskein-assigned)
  ts: number; // epoch ms (runskein-assigned)
  sessionId: string;
  engineId: string; // provenance (ACP has none of these three)
  update: SessionUpdate; // ACP vocabulary, verbatim
  usage?: Usage; // runskein-owned field; not ACP's UNSTABLE Usage
}
```

- The envelope (`seq`/`ts`/`sessionId`/`engineId`) is runskein's; the vocabulary
  (`update`) is ACP's (`agent_message_chunk`, `tool_call`, `plan`, …). No
  second vocabulary is invented.
- Engine-private oddities ride in `_meta` (ACP's official extension point).
- Writes are internal and automatic; the consumer only reads.

```ts
hub.transcripts.get(sessionId): AsyncIterable<TranscriptEvent>;
hub.transcripts.export(sessionId, format: 'jsonl' | 'markdown'): Promise<string>;
hub.transcripts.digest(sessionId): Promise<TranscriptDigest>;
hub.transcripts.digest(sessionId, opts: { format: 'structured', ... }): Promise<StructuredDigest>;
```

### 4.1 Usage

```ts
interface Usage {
  input?: number;
  output?: number;
  total?: number;
  uncached?: number;
  cacheRead?: number;
  cacheCreation?: number;
  thought?: number;
}

interface UsageSummary extends Usage {
  cost?: number;
  currency?: string;
}

interface TranscriptDigest {
  sessionId: string;
  throughSeq: number;
  text: string;
}

type DigestRole = 'user' | 'assistant' | 'tool';

interface DigestSegment {
  role: DigestRole;
  text: string;
  fromSeq: number;
  toSeq: number;
}

interface StructuredDigest {
  sessionId: string;
  throughSeq: number;
  segments: DigestSegment[];
  truncatedRanges: Array<{ fromSeq: number; toSeq: number }>;
  estimatedTokens: number; // ceil(UTF-8 bytes / 4)
}

interface DigestOptions {
  format?: 'text' | 'structured'; // default text
  maxChars?: number; // default 32_000 characters
  maxTokens?: number;
  truncation?: 'tail' | 'head' | 'head-tail'; // default tail
}

interface StructuredDigestOptions extends DigestOptions {
  format: 'structured'; // narrows digest() to Promise<StructuredDigest>
}

interface TextDigestOptions extends DigestOptions {
  format?: 'text'; // narrows digest() to Promise<TranscriptDigest>
}
```

Costs remain cumulative across rebuilt resume lives only while their currency
agrees. If a cross-engine chain reports multiple currencies, both scalar cost
fields stay absent rather than fabricating a converted total (decision 007).

RunSkein-owned (ACP's `Usage` is marked UNSTABLE; we do not depend on it).
Filled from whatever the engine reports; absent fields stay absent — never
fabricated. Population runs through one interpreter driven by the engine
adapter's optional `usage` declaration (decision
[033](decisions/033-usage-mapping-adapter-declared.md)): a token-bearing
`usage_update` notification, or an object addressed by the declared path on
the prompt response's result. A report is either the running session total
(`cumulative`) or only its own turn (`per-turn`), and **`TurnResult.usage`
always means _this turn_** — on a cumulative reporter it is the per-field
difference against the turn-open snapshot, clamped at zero. A
`_meta`-sourced report is persisted as a synthesized `usage_update`
transcript event in runskein's own field names — carrying the session-cumulative
value and marked via a runskein `_meta` entry — so resume replays identically
without the adapter.

**That declaration governs tokens; cost is not part of it.** Three of the five
bundled engines report cost today — opencode, claude-code and pi, all in the one
shape `{amount, currency}` — and `session.usage().cost` is populated for them
whether or not their adapter declares a token mapping at all. It is on
`UsageSummary` rather than on `Usage` because those engines report a running
session total, not a per-turn charge, so there is no honest per-turn figure for
`TurnResult.usage` to carry.

### 4.2 Folding — consumer-side presentation state

The transcript is deliberately verbatim: one enveloped event per engine
notification, chunk by chunk. Rendering it needs the opposite shape — message
runs rather than chunks, one row per tool call rather than a delta stream. That
transformation is `@runskein/fold`, reached through the `runskein/fold`
subpath:

```ts
import { createFolder } from 'runskein/fold';

const folder = createFolder();
for await (const e of s.transcript()) {
  for (const folded of folder.push(e)) render(folded); // PresentationEvent
}
for (const folded of folder.flush()) render(folded); // trailing open state
```

`createFolder()` returns a `Folder`; `push()` accepts a `FoldInput` (a
`TranscriptEvent` whose `update` is unvalidated, so unknown variants survive)
and yields `FoldedEvent`s carrying a `PresentationEvent` plus the `SourceRef`s
it came from. `MessageKind`, `ToolRow`, `PlanSnapshot` and `UsageState` describe
the folded shapes.

One row field is fold's own rather than the engine's. ACP makes `rawInput`,
`locations` and `content` optional, so "which file, which command" lands in a
different place per engine — and on kimi it arrives as `content` text that
grows character by character. `ToolRow.args` converges that into
`{ text, value?, from }`, where `from` names the field it was read from so a
consumer can always tell the engine's statement from fold's assembly. It is
chosen by shape, never by engine id, and it never claims a tool's result text
as its input. The rules are in
[transcript-fold.md](transcript-fold.md) §4.2.1.

`ToolRow.diffs` is fold's own in the same way. A `diff` content block is
`{path, oldText?, newText}`, which says nothing about whether that text is the
whole file or a fragment of it — so a renderer cannot tell whether numbering
the block from 1 matches the file's own lines, and no engine fills the
`line` that `ToolCallLocation` offers. Fold answers where the transcript
proves the answer: a block with no `oldText` created the file, and a block
whose `oldText` is what an earlier whole-file block wrote is whole-file too.
Those get `scope: 'wholeFile'` with `startLine: 1` and a `from` naming the
proof; everything else is `scope: 'unknown'` with no line, because locating a
fragment needs the file's contents and reading them back would date the answer
to now rather than to when the edit happened (decision 034).

That judgement is stateful — `chained` is proved against what an earlier
whole-file block for the same path wrote — so it is also available on its own as
`createDiffCoverageJudge()`, for a consumer that needs coverage on a path that
does not fold. Push every `tool_call` / `tool_call_update` of one session into
it in seq order and it returns the same `DiffCoverage` list `ToolRow.diffs`
would hold, without carrying message, plan or usage state; the folder is built
on the same unit, so the two cannot disagree (decision 036).

For a finished transcript rather than a live stream, `collectToolRows(events)`
returns the settled `ToolRow` for every `toolCallId`, and `toolCallText(row)`
joins the text one of them reported. This is also the answer to "what did the
sub-agent do?": an engine that spawns a sub-agent does not open a second
session — the sub-run is reported on the parent session as a single tool call,
so that one row holds everything the engine chose to report about it.

**Folding is not part of the frozen contract, and its subpath says so.** It is
presentation policy over the transcript: it never touches `Hub` or `Session`,
and a consumer that wants raw events simply does not import it. Keeping it on
`runskein/fold` rather than the main entry point means the frozen surface
stays engine-adapter only, while shipping it in the same package keeps one
install and one version — the envelope a folder expects cannot drift from the
one core emits. `@runskein/core/internal` uses the same subpath device to
separate a surface with different guarantees. The design is in
[transcript-fold.md](transcript-fold.md).

---

## 5. Permissions — one policy mechanism

```ts
type PermissionPolicy = (req: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

interface PermissionRequest {
  sessionId: string;
  engineId: string;
  tool: string;
  kind?: ToolKind; // read|edit|delete|move|search|execute|think|fetch|...
  input: unknown;
  locations?: ToolCallLocation[];
  options: PermissionOption[]; // the agent's offered choices
}

type PermissionDecision =
  | { optionId: string } // pick an offered option directly
  | { outcome: 'allow' | 'deny' }; // runskein maps to the closest optionId
```

```ts
interface QuestionRequest {
  requestId: string;
  sessionId: string;
  engineId: string;
  question: string;
  options?: Array<{ id: string; label: string }>;
}

type Answer = { text: string } | { optionId: string };

type Unsubscribe = () => void;
```

Built-ins are just prefab policies:

```ts
policies.allowAll; // default (headless)
policies.denyAll;
policies.rules([{ tool, pattern, action: 'allow' | 'deny' }]); // declarative table
```

Interactive "ask" = a consumer-written policy that forwards `req` to a human
and awaits the reply. No separate mode exists.

**Commands runskein runs for the engine arrive here too.** Some engines execute in
their own process; others delegate to the client over ACP's `terminal/*`
methods, and runskein implements them (decision 029). Because runskein is then the
one spawning the process, each `terminal/create` is a permission request with
`tool: 'terminal'`, `kind: 'execute'`, `input: { command, args, cwd, env }`, and
the resolved working directory as its location — so a rules table written for
`execute` already covers it. `env` is the environment the agent asked to add,
layered at spawn time over the host's scrubbed environment, and it reaches the
policy already checked. Entries must be well-formed `{ name, value }` pairs with
a valid variable name and no NUL byte, and no name may be set twice, compared
without case on every platform. A request naming one variable twice has no
single meaning — an exact repeat collapses at spawn to the last value, and a
case variant is one variable on Windows and two on POSIX — so it is refused
rather than resolved behind the policy's back. An override displaces the host
variable the host itself would resolve it to, so what a policy reads for a
variable is what the command runs with, wherever the session is hosted. Every
one of these checks reads a name without regard to case, for the same reason:
Windows spells one variable `Path` and `PATH` alike, and a guard that saw only
the spelling it expected would be a boundary on one host and an opening on
another. A name on the host's deny list
is refused too, before the policy is asked at all. That list holds the variables
that decide which program a command name turns out to be or what it loads —
`PATH`, `LD_*`/`DYLD_*`, `NODE_OPTIONS`, `GIT_SSH_COMMAND` and the like — plus
the session markers the host scrubs, which are the ones the session's own engine
declared in `envScrubExtra` and so differ between engines (decision 045). It is
a fixed list, not a proof that no remaining variable can influence a command: it
removes the questions a rule table cannot usefully answer, such as "may I run
this under a `PATH` I chose", and leaves the rest to be judged. What survives it is visible to a rule, which
matches its glob over the stringified input, so env names and values are text a
rule can match on. A denial means the process is never started, and the
working directory can be narrowed within the session's `cwd` but never moved
outside it.

`s.on('permission')` is a **read-only notification** (observability). The
policy is the single answer path — no race between event handlers and policy.

---

## 6. TranscriptStore — pluggable, three built-ins

```ts
interface TranscriptStore {
  append(e: TranscriptEvent): Promise<void>;
  read(sessionId: string, opts?: { fromSeq?: number; toSeq?: number }):
    AsyncIterable<TranscriptEvent>;
  sessions(filter?: SessionFilter): Promise<SessionMeta[]>;
  digest(sessionId: string): Promise<TranscriptDigest>;
  digest(sessionId: string, opts: StructuredDigestOptions): Promise<StructuredDigest>;
  digest(sessionId: string, opts: TextDigestOptions): Promise<TranscriptDigest>;
  digest(sessionId: string, opts: DigestOptions): Promise<TranscriptDigest | StructuredDigest>;
  delete(sessionId: string): Promise<void>;
}

jsonlStore(dir: string)              // default; one JSONL + derived metadata sidecar per session
sqliteStore(path: string)            // node:sqlite (Node ≥22, zero external deps)
memoryStore()                        // in-process only; nothing written to disk
```

`format: 'structured'` returns chronological same-role runs. Use
`renderStructuredDigest(digest, opts)` with the same bounds and truncation
strategy to reproduce the equivalent canonical text (role prefixes, tool
labels, and at most one truncation marker). `maxTokens` uses
`ceil(UTF-8 bytes / 4)`; the new bounded paths use the smaller of `maxChars`
and `maxTokens * 4` bytes. The default `digest(sessionId)` remains text/tail
for resume compatibility. Exact marker and compatibility semantics are frozen by
[decision 026](decisions/026-handoff-digest-contract.md).

Three exports form one digest toolkit: `estimateTokens(text)` counts tokens as
`ceil(UTF-8 bytes / 4)` — the same measure `maxTokens` uses, so hosts should
budget against it rather than reimplementing their own estimate;
`renderDigestSegments(segments, opts)` renders any segment sequence; and
`renderStructuredDigest(digest, opts)` is the complete reproduction of
canonical text with bounds and truncation markers on top of it.

Division of labour:

- **jsonl = interchange/audit format.** Transcript reads are streaming and
  inventory uses a size-checked, automatically repaired metadata sidecar;
  the `.jsonl` file remains authoritative. `export` always emits jsonl; store
  migration goes through it. Tailable, git-friendly, zero deps.
- **sqlite = query format.** Cross-session search, usage aggregation,
  `sessions(filter)` without directory scans. `digest()` may be incrementally
  materialized.
- **memory = no durability, by choice.** Persistence cannot be switched off —
  the store is authoritative for `sessions()` and resume, so omitting `store`
  means "write JSONL into the cwd", not "keep nothing". `memoryStore()` is the
  explicit way to keep nothing: tests, embedded hosts, and short-lived bridges
  get the full contract without touching the filesystem. It is unbounded and
  never evicts (a store that silently dropped events would break resume), it
  dies with the process, and `sessions()` costs one pass over everything it
  holds. Resume works within the run that created the transcript, not after
  it.

Same behaviour, different performance. All three pass the same store
conformance suite. A missing session/transcript rejects with `NotFoundError`; any other
backend failure rejects with `StoreError{operation,cause}`. Built-ins wrap
their native failures, and custom stores must follow the same typed-error
contract. Core also defensively wraps an unknown custom-store error when it
crosses a Hub or Session API boundary.

### 6.1 Retention — there is none, deliberately

No built-in store expires, rotates, compacts, or caps anything, and none ever
will by default. Transcripts are what `hub.sessions()` lists and what the
resume chain rebuilds from, so any automatic expiry would silently amputate
resume for exactly the long-lived sessions that need it most — the failure
would surface as an engine "forgetting" a conversation, far from its cause.

Retention is therefore the host's job, and deletion is always explicit. The
consequence a long-running host must plan for: **storage grows without bound
for as long as the host keeps appending.** A 1–24 h task fleet writing to
jsonl or sqlite fills a disk; the same fleet on `memoryStore()` fills the heap
and takes the process down with it.

Deleting is reached through the store, not the Hub: `hub.transcripts` is
read-only by design (§4), so a host that wants to expire transcripts
constructs its own store, keeps the reference, and calls
`TranscriptStore.delete(sessionId)` on it. Pick a policy — by age, by session
count, by completed status — and drive it from `hub.sessions(filter)`, whose
`SessionMeta` carries `status`, `createdAt`, and `updatedAt` for exactly this.
The library will not guess one for you.

---

## 7. Resume — emulated, three-tier degradation

`hub.session({ engine, cwd, resume: id })` resolves in order (`engine` and
`cwd` remain required by `SessionOpts`):

1. `session/resume` (engine capability) — native continuation.
2. `session/load` (engine capability) — history replay.
3. **Transcript digest rebuild** — runskein compresses the stored transcript
   (`store.digest()`) and injects it as the opening context of a fresh
   session.

The consumer cannot tell which tier ran except via
`session.resumeTier: 'native' | 'load' | 'rebuilt'` (observability). Tier 3
means **every engine can resume**, including ones with zero persistence.
Session identity survives rebuilds: the runskein `sessionId` is stable; native
engine session ids are internal bookkeeping.

---

## 8. Capability matrix (v1)

| Capability                                      | Tier                                | Notes                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| spawn / quit / health / crash-restart           | **Core** (library)                  | ACP doesn't cover process lifecycle; runskein does; inventory and health reads are async                                                                                                                                                         |
| session new / prompt / cancel                   | **Core** (engine)                   | conformance gate — fail = not registrable                                                                                                                                                                                                        |
| session close                                   | **Core** (API) / Negotiated (wire)  | `s.close()` is guaranteed; missing `session/close` degrades to local release + normal process reaping                                                                                                                                            |
| session discard                                 | Negotiated                          | `s.close({discard:true})` requires `session/delete`; unsupported deletion fails explicitly after local closure                                                                                                                                   |
| streaming updates (text / thinking / tool_call) | **Core**                            | conformance gate                                                                                                                                                                                                                                 |
| permission forwarding                           | **Core**                            | `allowAll` auto-answers by default                                                                                                                                                                                                               |
| **resume**                                      | **Emulated**                        | 3-tier chain (§7); always available                                                                                                                                                                                                              |
| **usage accounting**                            | **Emulated**                        | pass-through when reported; absent fields never fabricated; the engine's adapter declares where its accounting lives (decision 033); a turn value means this turn on every engine                                                                |
| session list                                    | **Emulated**                        | local store authoritative; engine `session/list` cross-check                                                                                                                                                                                     |
| describe (models / modes / thought levels)      | **Emulated**                        | live probe > adapter configHints; `source` marks trust; models come from `models` and/or configOptions                                                                                                                                           |
| fork                                            | Negotiated                          | `NotSupportedError` when absent (emulation deferred to v2)                                                                                                                                                                                       |
| setConfig / runtime model switch                | Negotiated                          | `session/set_config_option`, `session/set_mode`, or `session/set_model` depending on the surface (§3)                                                                                                                                            |
| question / elicitation                          | Negotiated                          | engines without it simply never emit                                                                                                                                                                                                             |
| plan / todo stream                              | Negotiated (read-only pass-through) |                                                                                                                                                                                                                                                  |
| multimodal prompt (image)                       | Negotiated                          | probed via `promptCapabilities`                                                                                                                                                                                                                  |
| terminal stream                                 | Negotiated (read-only pass-through) | agent-side terminals appear as tool_call content                                                                                                                                                                                                 |
| running commands for the engine                 | **Core** (library)                  | client-side `terminal/*` implemented (decision 029): permission-gated as `tool: 'terminal'`, contained to the session cwd, released on close. kimi requires it; claude-code uses it when offered; opencode/codex/pi execute in their own process |
| fs/read_text_file, fs/write_text_file           | **Out of scope (v1)**               | headless agents read disk themselves; avoids sandbox semantics                                                                                                                                                                                   |
| auto engine routing                             | **Out of scope (v1)**               | explicit selection only                                                                                                                                                                                                                          |

---

## 9. Adapters

Each engine adapter lives in **its own directory** and is **auto-discovered**;
core and consumers never change when an engine is added. The discovery layers,
their precedence, and the trust boundary they draw are in
[adapter-guide.md](adapter-guide.md).

```ts
interface EngineAdapter {
  specVersion: 1; // adapter-spec version; gate for loading
  id: string; // === directory basename after an optional runskein-adapter- prefix; unique
  launch: {
    command: string; // e.g. 'kimi'
    args?: string[]; // e.g. ['acp']
    env?: Record<string, string>; // applied AFTER core's env scrub; one entry
    // per name, compared without case (decision 042)
    startTimeoutMs?: number; // npx wrappers need generous budgets
  };
  supervise?: boolean; // launch behind a parent-death watchdog (default false)
  shim?: string; // entry point for engines that don't speak ACP; absolute, or
  // relative to the adapter directory it may not escape (see decision 028)
  detect?: () => Promise<DetectResult>; // installed? version? authenticated?
  configHints?: ConfigSchema; // static fallback for describe()
  /** Config the engine accepts only while the session is being created. */
  creationConfig?: Record<
    string,
    { meta: string[]; values: Record<string, string | number | boolean>; description?: string }
  >;
  envScrubExtra?: RegExp[]; // this engine's own session markers; core declares none
  errorPatterns?: Array<{
    cause: 'auth' | 'rate-limit' | 'context' | 'internal';
    match: string; // RegExp source; compiled case-insensitively by default
    flags?: string;
  }>;
  usage?: UsageMapping; // where this engine's usage accounting lives; absent = the default below
}

interface UsageMapping {
  source:
    | { kind: 'usage_update' } // token-bearing usage_update notification
    | { kind: 'prompt_response_meta'; path: string[] }; // object keys into the prompt response, e.g. ['_meta','quota','token_count']
  tokens?: Partial<
    Record<'input' | 'output' | 'total' | 'uncached' | 'cacheRead' | 'cacheCreation' | 'thought', string[]>
  >; // extra engine field names, tried BEFORE the built-in aliases; additive only
  semantics: 'cumulative' | 'per-turn';
}

interface DetectResult {
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  loginHint?: string;
}
```

`creationConfig` (introduced by decision
[032](decisions/032-config-uniform-at-creation-described-at-runtime.md);
reported by `describe()` as `settable: 'creation'`) declares settings an
engine takes only on its session-creation request. Its keys are **runskein config
keys** (`reasoning`, `model`, …), never engine-native names; each `meta` is the
path inside the creation request's `_meta` object where the value is delivered;
and `values` maps runskein's levels onto whatever the engine expects, because
"what high means" is the adapter's knowledge, not core's.

`usage` (decision [033](decisions/033-usage-mapping-adapter-declared.md)) is
pure data beside `errorPatterns`: core runs one interpreter over it and never
branches on an engine id. Declaring nothing is exactly the pre-declaration
behaviour, `{ source: { kind: 'usage_update' }, semantics: 'cumulative' }`.
The declared alias names extend — never replace — the built-in token table,
first match wins. `{ kind: 'usage_update' }` combined with
`semantics: 'per-turn'` is refused at load (replay stores engine-sent updates
verbatim and cannot represent per-turn numbers); adapt such an engine in a
shim. A declared `prompt_response_meta` source is **exclusive** for tokens —
`usage_update` token folding is disabled for that engine, while cost is still
read from every `usage_update`. A malformed declaration fails schema
validation at load (`health: 'invalid'`).

Statically imported built-ins bundled with the `runskein` meta-package are
always registered. With `discovery: true`, resolution then scans workspace
`adapters/*` and `.runskein/adapters/*`, followed by installed
`runskein-adapter-*` packages carrying the `runskein.adapter` marker. Every
directory-backed candidate uses one identity rule (decision
[040](decisions/040-installed-adapter-identity-accepts-the-publishing-prefix.md)):
its `id` must equal the directory basename, either directly or after the exact
`runskein-adapter-` prefix is stripped. Candidates are schema-validated and
failure-isolated (a broken adapter surfaces as
`health: 'invalid'` plus `error`, never crashes the hub). Dynamic discovery is
off by default because importing an adapter executes code with host privileges;
enable it only for trusted locations. Explicit `adapters` override lower layers
by `id`.

Built-in adapters (the `runskein` meta-package also exports this set as the
read-only array `builtinAdapters`, for hosts that prefer explicit assembly via
`createHub({ adapters: [...] })` — its contents are exactly the table below):

| id            | launch                                      | ACP source                             |
| ------------- | ------------------------------------------- | -------------------------------------- |
| `opencode`    | `opencode acp`                              | native, built-in                       |
| `kimi`        | `kimi acp`                                  | native, built-in                       |
| `claude-code` | `npx @agentclientprotocol/claude-agent-acp` | ACP org wrapper                        |
| `codex`       | `npx @agentclientprotocol/codex-acp`        | ACP org wrapper                        |
| `pi`          | `pi --mode rpc`, behind a shim              | runskein shim (`adapters/pi/shim.mjs`) |

The first four are shim-free. `pi` speaks no ACP at all, and is the engine the
shim mechanism exists for: a separate small process speaking ACP on stdio and
the engine's private protocol on the other side, so core keeps exactly one code
path and never learns an engine's name. See
[decision 028](decisions/028-non-acp-engines-via-shim.md) for why the boundary
sits there, and `adapters/pi/` for the worked example.

### 9.1 Registration gate

An adapter is registrable iff it passes the **conformance suite**
(`packages/conformance`): initialize → session/new → prompt → update stream →
cancel → `s.close()` semantics, plus the Core rows of §8. Wire-level
`session/close` is optional and tested as a negotiated capability, not a Core
registration requirement. Enforcement by test, not by review.

A candidate is validated before any of that runs, and one whose declaration
cannot mean one thing does not load: `hub.engines()` reports it as an
`InvalidEngineInfo` carrying the reason, instead of it registering and behaving
differently per host. `launch.env` naming one variable twice — `PATH_EXTRA`
beside `Path_Extra`, which Windows resolves as one — is refused that way, on
every platform, because it is the host-dependence being rejected rather than
one host's reading of it. See
[decision 042](decisions/042-a-launch-environment-names-each-variable-once.md).

---

## 10. Errors

```ts
class NotSupportedError    // Negotiated capability absent; carries { engineId, capability }
class NotInstalledError    // detect() failed
class UnauthenticatedError // carries the engine's login hint and optional raw/aggregate cause
class NotFoundError        // local session/transcript absent; carries { resource, resourceId }
class EngineStartError     // failed before ready; carries { stage: spawn|initialize|timeout, cause? }
class StoreError           // transcript backend failed; carries { operation, cause }
class EngineCrashError     // process died mid-turn; carries restart info + last seq
class CancelledError       // prompt never completed: queued cancellation or active/queued close
class ConfigError          // invalid config key/value; carries valid options
class EngineOperationError // post-ready ACP operation failed; carries { operation, kind?, cause? }
```

All engine-scoped errors carry `engineId` and, where relevant, `sessionId`.
Store-only `NotFoundError`s and `StoreError`s carry those fields when known
and never fabricate them. No error is ever swallowed into a silent no-op.
`NotFoundError.resource` is `'session'` or `'transcript'`; an unknown engine id
remains `NotInstalledError`.

For a post-ready failure, core tests only the selected adapter's declared
`errorPatterns`, in declared order, against the engine message and its cause
chain. **Declare `rate-limit` ahead of `auth`.** First match wins, and an
engine is free to word a throttled request as an authentication problem —
kimi prefixes an upstream refusal with `Authentication required:` whatever
its cause, so a spent quota arrives as `Authentication required: 403 You've
reached your weekly (7-day) usage limit…` (measured 2026-08-31) and an auth
pattern declared first claims it. That is not a mislabel a consumer can work
around: the auth path invalidates the cached login, crashes every live session
on the engine and retires its process, for a failure that clears itself. pi
surfaces the same condition as its own turn error — `Internal error: pi ended
the turn with an error: 429 status code (no body)` (measured 2026-08-25) —
which is an ordinary error on the cause chain, not a notification. Every
pattern is taken from measured wording, kept long enough not to claim a
sentence merely mentioning a limit or a number. **Where the same condition has
been measured more than once, the pattern is anchored on what those payloads
share** rather than on fragments of any one of them (decision 044): kimi
reworded its message six days after the first declaration landed, breaking both
of its fragments in one edit and sending a spent quota back down the auth path,
so kimi now declares four anchors spread across the description and the
remediation. pi has one measured payload and stays a single fragment until a
second is captured. A rewording that breaks every anchor still sends the
failure back to the path it had before, and which happened surfaces in the
field, not in a test. Where that lands depends on how broad the `auth` pattern
behind it is, which is the argument for keeping that one narrow: kimi's is the
blanket `Authentication required` its engine prefixes everything with, so a
lapsed `rate-limit` pattern hands a spent quota straight to the teardown, while
pi's is the specific token `credentials_not_configured`, so the same lapse
leaves `kind` merely absent. An adapter that has not had its
throttled payload measured — codex, opencode, claude-code today — declares no
`rate-limit` pattern at all, because an absent `kind` is honest and a guessed
one is not. `auth` becomes `UnauthenticatedError`; `rate-limit`, `context`, and
`internal` set `EngineOperationError.kind` to `'rate-limit'`,
`'context-exceeded'`, and `'internal'`. A runskein-owned request timeout sets it
to `'timeout'`, independently of adapter patterns. No match leaves `kind` absent. A
matched mid-run auth failure emits `engine:unauthenticated`, invalidates the
cached detect result until `hub.rescan()`, and retires the current engine
process so recovery after re-login starts fresh. Exact details are frozen in
[decision 025](decisions/025-failure-taxonomy-and-auth-recovery.md).

---

## Appendix A — decisions log

| #   | Decision                                                                                                                                                           | Rationale                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | ACP as internal spine, never exposed                                                                                                                               | absorb protocol churn; reuse vocabulary (ToolKind/plan/ContentBlock/locations) without inventing a second one                                                                                              |
| D2  | Envelope (`seq`/`ts`/`engineId`) is runskein's own                                                                                                                 | ACP notifications lack provenance/ordering; audit streams need them (learned on an audit-stream consumer)                                                                                                  |
| D3  | No `auto` engine selection                                                                                                                                         | routing is consumer policy                                                                                                                                                                                 |
| D4  | Single `PermissionPolicy` fn; bypass/ask are instances                                                                                                             | one answer path, no mode split, no event/policy race                                                                                                                                                       |
| D5  | `TranscriptStore` interface + jsonl & sqlite built-ins                                                                                                             | jsonl = interchange, sqlite = query; format is the API                                                                                                                                                     |
| D6  | Resume is Emulated with 3-tier degradation                                                                                                                         | biggest unification win across uneven engine capabilities                                                                                                                                                  |
| D7  | RunSkein-owned `Usage`; ignore ACP's UNSTABLE one                                                                                                                  | cost accounting is critical, do not build on experimental types                                                                                                                                            |
| D8  | Adapters are discoverable per-directory packages; conformance is the gate                                                                                          | new engines: zero core/client change, enforced by test                                                                                                                                                     |
| D9  | v1 skips client-side fs methods; terminal methods were added later                                                                                                 | headless-first, and fs still avoids sandbox semantics. The terminal half was reversed by decision 029: kimi delegates command execution to the client, so declining it cost that engine every command tool |
| D10 | Engine inventory and health reads are async and include `stopped`/invalid variants                                                                                 | `detect()` is async; process absence is not failure; malformed candidates cannot satisfy registered-engine fields (decision 003)                                                                           |
| D11 | Missing local state, store failures, and pre-ready startup failures have distinct typed errors                                                                     | avoid generic errors and keep recovery decisions unambiguous (decision 004)                                                                                                                                |
| D12 | Post-ready ACP failures use `EngineOperationError`; usage token fields are optional                                                                                | keep every error typed and distinguish unreported accounting from measured zero (decision 006)                                                                                                             |
| D13 | Model choice is its own surface: `describe().models` written with `session/set_model`, with a model config option taking precedence where an engine publishes both | engines publish model choice separately from configOptions; reading only configOptions made a settable model look unsupported (decision 009)                                                               |
| D14 | `memoryStore()` is a third public built-in; no store retains or caps by default                                                                                    | persistence could not be turned off, and automatic expiry would silently break resume (decision 011)                                                                                                       |
| D15 | `ConfigOption.settable` says WHEN a key can be written; `session({config})` carries creation-only keys on the creation request and `setConfig()` refuses them      | some engines take a setting only while building the session; uniform interface with the difference described rather than hidden (decision 032)                                                             |

---

## Appendix B — protocol vocabulary types

`ContentBlock`, `SessionUpdate`, `ToolKind`, `ToolCallLocation`,
`PermissionOption`, and `McpServerConfig` are exported by `runskein` as
runskein-owned declarations generated from the pinned ACP v1 schema. The same
generation also emits `ToolCallUpdate`, `ToolCallContent`, `ToolCallStatus`,
`PlanEntry`, `PermissionOptionKind`, and `Annotations`, which follow the same
rules. They retain ACP's discriminants and `_meta` extension point so consumers
can render the vocabulary without conversion, but they do not import or
re-export types from `@agentclientprotocol/sdk`. Their generated declarations
are the exhaustive source of truth; changing them is a runskein API change even
when caused by an ACP upgrade.
