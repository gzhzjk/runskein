/**
 * `runskein/fold` — the transcript folding layer, on its own subpath.
 *
 * Folding turns the verbatim `TranscriptEvent` stream into per-session
 * presentation state: message runs instead of chunks, one row per tool call
 * instead of a delta stream, plan and usage snapshots.
 *
 * It lives on a subpath rather than the main entry point because it is a
 * different layer with different guarantees. `runskein` is the frozen
 * engine-adapter contract; folding is presentation policy over the transcript,
 * it never touches Hub or Session, and a consumer that wants raw events simply
 * does not import it. Shipping it here rather than as a separate dependency
 * keeps one install and one version, so the envelope a folder expects can
 * never drift from the one core emits.
 */
export { createFolder, createDiffCoverageJudge, collectToolRows, toolCallText } from '@runskein/fold';
export type {
  Folder,
  FoldInput,
  FoldedEvent,
  SourceRef,
  PresentationEvent,
  MessageKind,
  NoticeUpdate,
  ToolRow,
  ToolCallArgs,
  DiffCoverage,
  DiffCoverageJudge,
  ToolRowField,
  FoldedToolCallContent,
  UnknownContentBlock,
  UnknownToolCallContent,
  PlanSnapshot,
  KeyedPlanState,
  UsageState,
} from '@runskein/fold';
