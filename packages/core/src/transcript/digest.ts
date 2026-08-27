/**
 * Transcript digest extraction, rendering, and bounding.
 *
 * Resume keeps the original text/tail call shape. Handoff callers can request
 * structured segments or a different truncation policy from the same extracted
 * source, so text and structured output cannot drift apart.
 */
import type {
  DigestSegment,
  DigestRole,
  StructuredDigest,
  TranscriptDigest,
  TranscriptEvent,
} from './event.js';

/** Controls the representation and bounds applied to a transcript digest. */
export interface DigestOptions {
  /** Text is the backward-compatible default; structured returns segment data. */
  format?: 'text' | 'structured';
  /** Maximum UTF-8 bytes in new bounded modes. Defaults to 32,000. */
  maxChars?: number;
  /** Maximum estimated tokens, using ceil(UTF-8 bytes / 4). */
  maxTokens?: number;
  /** Which transcript end survives bounding. Defaults to tail for resume compatibility. */
  truncation?: 'tail' | 'head' | 'head-tail';
}

/** Select structured handoff output. */
export interface StructuredDigestOptions extends DigestOptions {
  format: 'structured';
}

/** Select text output while opting into a new bound or truncation strategy. */
export interface TextDigestOptions extends DigestOptions {
  format?: 'text';
}

export type DigestResult = TranscriptDigest | StructuredDigest;

const DEFAULT_MAX_CHARS = 32_000;
/** Per-tool-result cap, so one huge output cannot evict the whole dialogue. */
const TOOL_OUTPUT_MAX_CHARS = 400;
export const DIGEST_TRUNCATION_MARKER = '[...earlier context truncated...]\n';
const LATER_TRUNCATION_MARKER = '[...later context truncated...]';
const MIDDLE_TRUNCATION_MARKER = '[...middle context truncated...]';
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

interface ExtractedDigest {
  throughSeq: number;
  segments: DigestSegment[];
}

interface BoundedSegments {
  segments: DigestSegment[];
  truncatedRanges: StructuredDigest['truncatedRanges'];
  markerIndex: number;
}

interface SegmentExtractor {
  add(event: TranscriptEvent): void;
  finish(): ExtractedDigest;
}

/** A streaming facade retained for stores that read their events incrementally. */
export interface DigestBuilder {
  /** Feed one transcript event into the digest. */
  add(event: TranscriptEvent): void;
  /** Finalize the selected digest representation. */
  finish(): DigestResult;
}

/**
 * Build a digest incrementally from an event stream.
 * @param sessionId - session whose events are being consumed.
 * @param opts - output representation and bounding options.
 * @returns a builder that accepts events in sequence order.
 */
export function createDigestBuilder(sessionId: string, opts?: DigestOptions): DigestBuilder {
  if (usesLegacyTextPath(opts))
    return createLegacyDigestBuilder(sessionId, normalizeMaxChars(opts?.maxChars));
  const extractor = createSegmentExtractor();
  return {
    add(event): void {
      extractor.add(event);
    },
    finish(): DigestResult {
      return buildDigestFromExtracted(sessionId, extractor.finish(), opts);
    },
  };
}

function createLegacyDigestBuilder(sessionId: string, maxChars: number): DigestBuilder {
  const tailLimit = Math.max(0, maxChars - DIGEST_TRUNCATION_MARKER.length);
  let throughSeq = 0;
  let text = '';
  let lastRole: string | undefined;
  let truncated = false;

  const append = (value: string): void => {
    text += value;
    if ((!truncated && text.length > maxChars) || (truncated && text.length > tailLimit)) {
      text = tailLimit === 0 ? '' : takeSuffixSafe(text, tailLimit);
      truncated = true;
    }
  };
  const push = (role: string, value: string): void => {
    if (role === lastRole && text.length > 0) append(value);
    else {
      append((text.length > 0 ? '\n' : '') + role + ': ' + value);
      lastRole = role;
    }
  };

  return {
    add(event): void {
      throughSeq = Math.max(throughSeq, event.seq);
      const update = event.update;
      switch (update.sessionUpdate) {
        case 'user_message_chunk':
          if (update.content.type === 'text') push('User', update.content.text);
          break;
        case 'agent_message_chunk':
          if (update.content.type === 'text') push('Assistant', update.content.text);
          break;
        case 'tool_call':
          append(
            (text.length > 0 ? '\n' : '') +
              'Tool: ' +
              (update.title ?? update.toolCallId) +
              ' (' +
              (update.kind ?? 'other') +
              ')',
          );
          lastRole = undefined;
          break;
        case 'tool_call_update': {
          if (update.status !== 'completed' && update.status !== 'failed') break;
          const parts: string[] = [];
          for (const item of update.content ?? []) {
            if (item.type === 'content' && item.content.type === 'text') parts.push(item.content.text);
          }
          if (parts.length === 0 && typeof update.rawOutput === 'string') parts.push(update.rawOutput);
          const output = takePrefixSafe(parts.join(' ').replace(/\s+/g, ' ').trim(), TOOL_OUTPUT_MAX_CHARS);
          append(
            (text.length > 0 ? '\n' : '') +
              'Tool result (' +
              update.toolCallId +
              '): ' +
              update.status +
              (output.length > 0 ? ' \u2014 ' + output : ''),
          );
          lastRole = undefined;
          break;
        }
        default:
          break;
      }
    },
    finish(): TranscriptDigest {
      const marker = truncated ? takePrefixSafe(DIGEST_TRUNCATION_MARKER, maxChars) : '';
      return { sessionId, throughSeq, text: marker + text };
    },
  };
}

/**
 * Build a digest from a full event stream.
 * @param sessionId - the session the digest is for.
 * @param events - transcript events in sequence order.
 * @param opts - output representation and bounding options.
 * @returns text by default, or structured segments when requested.
 */
export function buildDigest(
  sessionId: string,
  events: Iterable<TranscriptEvent>,
  opts?: DigestOptions,
): DigestResult {
  return buildDigestFromExtracted(sessionId, extractSegments(events), opts);
}

function buildDigestFromExtracted(
  sessionId: string,
  extracted: ExtractedDigest,
  opts: DigestOptions | undefined,
): DigestResult {
  if (usesLegacyTextPath(opts)) {
    return {
      sessionId,
      throughSeq: extracted.throughSeq,
      text: renderLegacyText(extracted.segments, normalizeMaxChars(opts?.maxChars)),
    };
  }

  const bounded = boundSegments(extracted.segments, opts);
  const structured: StructuredDigest = {
    sessionId,
    throughSeq: extracted.throughSeq,
    segments: bounded.segments,
    truncatedRanges: bounded.truncatedRanges,
    estimatedTokens: estimateTokens(
      renderDigestSegments(bounded.segments, {
        truncation: opts?.truncation,
        truncated: bounded.truncatedRanges.length > 0,
        markerIndex: bounded.markerIndex,
        maxChars: opts?.maxChars,
        maxTokens: opts?.maxTokens,
      }),
    ),
  };
  if (opts?.format === 'structured') return structured;
  return {
    sessionId,
    throughSeq: extracted.throughSeq,
    text: renderDigestSegments(structured.segments, {
      truncation: opts?.truncation,
      truncated: structured.truncatedRanges.length > 0,
      markerIndex: bounded.markerIndex,
      maxChars: opts?.maxChars,
      maxTokens: opts?.maxTokens,
    }),
  };
}

/**
 * Render structured segments with the canonical role prefixes and marker.
 * @param segments - extracted chronological segment runs.
 * @param opts - whether a truncation marker is needed, where it belongs, and its bounds.
 * @returns the text representation used by text-format digests.
 */
export function renderDigestSegments(
  segments: readonly DigestSegment[],
  opts: {
    truncation?: DigestOptions['truncation'];
    truncated?: boolean;
    markerIndex?: number | undefined;
    maxChars?: number | undefined;
    maxTokens?: number | undefined;
  } = {},
): string {
  const rendered = segments.map(renderSegment);
  if (!opts.truncated) return rendered.join('\n');
  const marker = boundedMarker(
    markerFor(opts.truncation ?? 'tail'),
    normalizeMaxChars(opts.maxChars),
    byteBudget(opts.maxChars, opts.maxTokens),
  );
  switch (opts.truncation ?? 'tail') {
    case 'head':
      return [...rendered, marker].filter((part) => part.length > 0).join('\n');
    case 'head-tail':
      return [...rendered.slice(0, opts.markerIndex ?? 0), marker, ...rendered.slice(opts.markerIndex ?? 0)]
        .filter((part) => part.length > 0)
        .join('\n');
    case 'tail':
      return marker + rendered.join('\n');
  }
}

/**
 * Render a StructuredDigest through the same canonical presentation as text.
 * @param digest - structured digest returned by the store or hub.
 * @param opts - the same truncation policy and bounds used to create the digest.
 * @returns text equivalent to the corresponding text-format digest.
 */
export function renderStructuredDigest(
  digest: StructuredDigest,
  opts?: Pick<DigestOptions, 'truncation' | 'maxChars' | 'maxTokens'>,
): string {
  const markerIndex =
    opts?.truncation === 'head-tail'
      ? markerIndexForRanges(digest.segments, digest.truncatedRanges)
      : undefined;
  return renderDigestSegments(digest.segments, {
    truncation: opts?.truncation,
    truncated: digest.truncatedRanges.length > 0,
    markerIndex,
    maxChars: opts?.maxChars,
    maxTokens: opts?.maxTokens,
  });
}

/**
 * Estimate digest tokens with the documented transport-neutral rule.
 * @param text - digest text to estimate.
 * @returns ceil(UTF-8 byte length / 4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function usesLegacyTextPath(opts: DigestOptions | undefined): boolean {
  return opts?.format === undefined && opts?.maxTokens === undefined && opts?.truncation === undefined;
}

function extractSegments(events: Iterable<TranscriptEvent>): ExtractedDigest {
  const extractor = createSegmentExtractor();
  for (const event of events) extractor.add(event);
  return extractor.finish();
}

function createSegmentExtractor(): SegmentExtractor {
  const segments: DigestSegment[] = [];
  let throughSeq = 0;
  let lastRole: DigestRole | undefined;

  const push = (role: DigestRole, text: string, seq: number): void => {
    const previous = segments.at(-1);
    if ((role === 'user' || role === 'assistant') && previous?.role === role && lastRole === role) {
      previous.text += text;
      previous.toSeq = seq;
    } else {
      segments.push({ role, text, fromSeq: seq, toSeq: seq });
    }
    lastRole = role;
  };

  return {
    add(event): void {
      throughSeq = Math.max(throughSeq, event.seq);
      const update = event.update;
      switch (update.sessionUpdate) {
        case 'user_message_chunk':
          if (update.content.type === 'text') push('user', update.content.text, event.seq);
          break;
        case 'agent_message_chunk':
          if (update.content.type === 'text') push('assistant', update.content.text, event.seq);
          break;
        case 'tool_call':
          segments.push({
            role: 'tool',
            text: `${update.title ?? update.toolCallId} (${update.kind ?? 'other'})`,
            fromSeq: event.seq,
            toSeq: event.seq,
          });
          lastRole = undefined;
          break;
        case 'tool_call_update': {
          if (update.status !== 'completed' && update.status !== 'failed') break;
          const parts: string[] = [];
          for (const item of update.content ?? []) {
            if (item.type === 'content' && item.content.type === 'text') parts.push(item.content.text);
          }
          if (parts.length === 0 && typeof update.rawOutput === 'string') parts.push(update.rawOutput);
          const output = takePrefixSafe(parts.join(' ').replace(/\s+/g, ' ').trim(), TOOL_OUTPUT_MAX_CHARS);
          segments.push({
            role: 'tool',
            text: `result (${update.toolCallId}): ${update.status}${output.length > 0 ? ` — ${output}` : ''}`,
            fromSeq: event.seq,
            toSeq: event.seq,
          });
          lastRole = undefined;
          break;
        }
        default:
          break;
      }
    },
    finish(): ExtractedDigest {
      return { throughSeq, segments };
    },
  };
}

function renderSegment(segment: DigestSegment): string {
  switch (segment.role) {
    case 'user':
      return `User: ${segment.text}`;
    case 'assistant':
      return `Assistant: ${segment.text}`;
    case 'tool':
      return segment.text.startsWith('result (') ? `Tool ${segment.text}` : `Tool: ${segment.text}`;
  }
}

function renderLegacyText(segments: readonly DigestSegment[], maxChars: number): string {
  const full = renderDigestSegments(segments);
  if (full.length <= maxChars) return full;
  const marker = takePrefixSafe(DIGEST_TRUNCATION_MARKER, maxChars);
  return marker + takeSuffixSafe(full, Math.max(0, maxChars - marker.length));
}

function boundSegments(
  segments: readonly DigestSegment[],
  opts: DigestOptions | undefined,
): BoundedSegments {
  const maxChars = normalizeMaxChars(opts?.maxChars);
  const maxBytes = byteBudget(opts?.maxChars, opts?.maxTokens);
  const full = renderDigestSegments(segments);
  if (fits(full, maxChars, maxBytes))
    return { segments: [...segments], truncatedRanges: [], markerIndex: 0 };

  const truncation = opts?.truncation ?? 'tail';
  if (truncation === 'head-tail') return boundHeadTail(segments, maxChars, maxBytes);
  const marker = boundedMarker(markerFor(truncation), maxChars, maxBytes);
  // Head rendering adds one separator before its marker. Tail's historical
  // marker carries its own newline, so it needs no extra reservation.
  const contentBudget = subtractMarkerBudget(
    maxChars,
    maxBytes,
    truncation === 'head' ? `\n${marker}` : marker,
  );
  const selected =
    truncation === 'head'
      ? takeFittingPrefix(segments, contentBudget.maxChars, contentBudget.maxBytes)
      : takeFittingSuffix(segments, contentBudget.maxChars, contentBudget.maxBytes);
  return {
    segments: selected,
    truncatedRanges: droppedRanges(segments, selected),
    markerIndex: truncation === 'head' ? selected.length : 0,
  };
}

function boundHeadTail(
  segments: readonly DigestSegment[],
  maxChars: number,
  maxBytes: number | undefined,
): BoundedSegments {
  const marker = boundedMarker(MIDDLE_TRUNCATION_MARKER, maxChars, maxBytes);
  // A middle marker can have a newline on both sides when both halves survive.
  const markerBudget = subtractMarkerBudget(maxChars, maxBytes, `\n${marker}\n`);
  const headChars = Math.floor(markerBudget.maxChars / 2);
  const tailChars = markerBudget.maxChars - headChars;
  const headBytes = markerBudget.maxBytes === undefined ? undefined : Math.floor(markerBudget.maxBytes / 2);
  const tailBytes =
    markerBudget.maxBytes === undefined ? undefined : markerBudget.maxBytes - (headBytes ?? 0);
  const head = takeFittingPrefix(segments, headChars, headBytes);
  const tail = takeFittingSuffix(segments.slice(head.length), tailChars, tailBytes);
  const selected = [...head, ...tail];
  return {
    segments: selected,
    truncatedRanges: droppedRanges(segments, selected),
    markerIndex: head.length,
  };
}

function subtractMarkerBudget(
  maxChars: number,
  maxBytes: number | undefined,
  marker: string,
): { maxChars: number; maxBytes: number | undefined } {
  return {
    maxChars: Math.max(0, maxChars - marker.length),
    maxBytes:
      maxBytes === undefined ? undefined : Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8')),
  };
}

function takeFittingPrefix(
  segments: readonly DigestSegment[],
  maxChars: number,
  maxBytes: number | undefined,
): DigestSegment[] {
  const selected: DigestSegment[] = [];
  for (const segment of segments) {
    const candidate = [...selected, segment];
    if (!fits(renderDigestSegments(candidate), maxChars, maxBytes)) break;
    selected.push(segment);
  }
  return selected;
}

function takeFittingSuffix(
  segments: readonly DigestSegment[],
  maxChars: number,
  maxBytes: number | undefined,
): DigestSegment[] {
  const selected: DigestSegment[] = [];
  for (let index = segments.length - 1; index >= 0; index--) {
    const segment = segments[index];
    if (segment === undefined) continue;
    const candidate = [segment, ...selected];
    if (!fits(renderDigestSegments(candidate), maxChars, maxBytes)) break;
    selected.unshift(segment);
  }
  return selected;
}

function droppedRanges(
  source: readonly DigestSegment[],
  selected: readonly DigestSegment[],
): StructuredDigest['truncatedRanges'] {
  const selectedSet = new Set(selected);
  const dropped = source.filter((segment) => !selectedSet.has(segment));
  if (dropped.length === 0) return [];
  const ranges: StructuredDigest['truncatedRanges'] = [];
  for (const segment of dropped) {
    const previous = ranges.at(-1);
    if (previous && segment.fromSeq <= previous.toSeq + 1)
      previous.toSeq = Math.max(previous.toSeq, segment.toSeq);
    else ranges.push({ fromSeq: segment.fromSeq, toSeq: segment.toSeq });
  }
  return ranges;
}

function fits(text: string, maxChars: number, maxBytes: number | undefined): boolean {
  return text.length <= maxChars && (maxBytes === undefined || Buffer.byteLength(text, 'utf8') <= maxBytes);
}

function markerFor(truncation: NonNullable<DigestOptions['truncation']>): string {
  switch (truncation) {
    case 'head':
      return LATER_TRUNCATION_MARKER;
    case 'head-tail':
      return MIDDLE_TRUNCATION_MARKER;
    case 'tail':
      return DIGEST_TRUNCATION_MARKER;
  }
}

function boundedMarker(marker: string, maxChars: number, maxBytes: number | undefined): string {
  const byChars = takePrefixSafe(marker, maxChars);
  if (maxBytes === undefined || Buffer.byteLength(byChars, 'utf8') <= maxBytes) return byChars;
  let output = '';
  for (const { segment } of graphemes.segment(byChars)) {
    if (Buffer.byteLength(output + segment, 'utf8') > maxBytes) break;
    output += segment;
  }
  return output;
}

function markerIndexForRanges(
  segments: readonly DigestSegment[],
  ranges: readonly { fromSeq: number; toSeq: number }[],
): number {
  const lastRange = ranges.at(-1);
  if (!lastRange) return 0;
  const index = segments.findIndex((segment) => segment.fromSeq > lastRange.toSeq);
  return index < 0 ? segments.length : index;
}

function normalizeMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CHARS;
  if (!Number.isFinite(value)) return value === Infinity ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(value));
}

function normalizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return value === Infinity ? Number.MAX_SAFE_INTEGER : 0;
  return Math.max(0, Math.floor(value));
}

function byteBudget(maxChars: number | undefined, maxTokens: number | undefined): number {
  const charBudget = normalizeMaxChars(maxChars);
  const tokenBudget = maxTokens === undefined ? Number.MAX_SAFE_INTEGER : normalizeMaxTokens(maxTokens) * 4;
  return Math.min(charBudget, tokenBudget);
}

function takePrefixSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let output = '';
  for (const { segment } of graphemes.segment(text)) {
    if (output.length + segment.length > maxChars) break;
    output += segment;
  }
  return output;
}

function takeSuffixSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const starts = [...graphemes.segment(text)].map(({ index }) => index);
  for (const start of starts) {
    if (text.length - start <= maxChars) return text.slice(start);
  }
  return '';
}
