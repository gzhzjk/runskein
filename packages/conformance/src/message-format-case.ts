/** Shared real-engine message-format exercise for engines with ACP tool sessions. */
import { existsSync, readFileSync } from 'node:fs';
import type { EngineDescriptor, PermissionRequest, Session, TranscriptEvent } from 'runskein';
import { ConfigError } from 'runskein';
import { withLiveTimeout } from './liveSupport.js';

/** Markers used to correlate requested file and terminal actions with ACP updates. */
const ADD_MARKER = 'RUNSKEIN_FORMAT_ADD_MARKER';
const EDIT_MARKER = 'RUNSKEIN_FORMAT_EDIT_MARKER';
const TERMINAL_MARKER = 'RUNSKEIN_FORMAT_TERMINAL_MARKER';

const TOOL_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);
const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);
const CONTENT_BLOCK_TYPES = new Set(['text', 'image', 'audio', 'resource_link', 'resource']);
const PERMISSION_OPTION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/** Inputs for the one-session engine message-format exercise. */
export interface AgentMessageCaseOptions {
  session: Session;
  cwd: string;
  descriptor: EngineDescriptor;
  permissionRequests: PermissionRequest[];
  engineId: string;
  planMode: string;
  buildMode: string;
  requiredUpdateKinds: readonly string[];
  requireDiffs: boolean;
  requireTerminalContent: boolean;
  requirePermissionRequest: boolean;
}

/** Observations and capability warnings produced by the exercise. */
export interface AgentMessageCaseResult {
  log: string[];
  warnings: string[];
}

interface RecordValue {
  [key: string]: unknown;
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as RecordValue;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be a string`);
  return value;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new Error(`${path} must be a string when present`);
  }
}

function optionalNumber(value: unknown, path: string): void {
  if (value !== undefined && value !== null && typeof value !== 'number') {
    throw new Error(`${path} must be a number when present`);
  }
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function oneOf(value: unknown, values: ReadonlySet<string>, path: string): void {
  if (typeof value !== 'string' || !values.has(value)) {
    throw new Error(`${path} has invalid value ${JSON.stringify(value)}`);
  }
}

function matchesTextVariant(value: unknown, variants: readonly string[]): boolean {
  return typeof value === 'string' && variants.includes(value);
}

function assertContentBlock(value: unknown, path: string): void {
  const content = record(value, path);
  const type = string(content['type'], `${path}.type`);
  oneOf(type, CONTENT_BLOCK_TYPES, `${path}.type`);
  switch (type) {
    case 'text':
      string(content['text'], `${path}.text`);
      break;
    case 'image':
    case 'audio':
      string(content['data'], `${path}.data`);
      string(content['mimeType'], `${path}.mimeType`);
      optionalString(content['uri'], `${path}.uri`);
      break;
    case 'resource_link':
      string(content['name'], `${path}.name`);
      string(content['uri'], `${path}.uri`);
      optionalString(content['description'], `${path}.description`);
      optionalString(content['mimeType'], `${path}.mimeType`);
      optionalString(content['title'], `${path}.title`);
      optionalNumber(content['size'], `${path}.size`);
      break;
    case 'resource': {
      const resource = record(content['resource'], `${path}.resource`);
      string(resource['uri'], `${path}.resource.uri`);
      optionalString(resource['mimeType'], `${path}.resource.mimeType`);
      if (typeof resource['text'] !== 'string' && typeof resource['blob'] !== 'string') {
        throw new Error(`${path}.resource must contain text or blob`);
      }
      break;
    }
  }
}

function assertToolContent(value: unknown, path: string): void {
  const content = record(value, path);
  const type = string(content['type'], `${path}.type`);
  switch (type) {
    case 'content':
      assertContentBlock(content['content'], `${path}.content`);
      break;
    case 'diff':
      string(content['path'], `${path}.path`);
      string(content['newText'], `${path}.newText`);
      if (content['oldText'] !== undefined && content['oldText'] !== null) {
        if (typeof content['oldText'] !== 'string')
          throw new Error(`${path}.oldText must be a string or null`);
      }
      break;
    case 'terminal':
      string(content['terminalId'], `${path}.terminalId`);
      break;
    default:
      throw new Error(`${path}.type has unknown tool content type ${JSON.stringify(type)}`);
  }
}

function assertToolCall(value: unknown, path: string, requireTitle: boolean): void {
  const tool = record(value, path);
  string(tool['toolCallId'], `${path}.toolCallId`);
  if (requireTitle) string(tool['title'], `${path}.title`);
  else if (tool['title'] !== undefined && tool['title'] !== null) string(tool['title'], `${path}.title`);
  optionalString(tool['name'], `${path}.name`);
  if (tool['kind'] !== undefined && tool['kind'] !== null) oneOf(tool['kind'], TOOL_KINDS, `${path}.kind`);
  if (tool['status'] !== undefined && tool['status'] !== null) {
    oneOf(tool['status'], TOOL_STATUSES, `${path}.status`);
  }
  if (tool['content'] !== undefined && tool['content'] !== null) {
    for (const [i, item] of array(tool['content'], `${path}.content`).entries()) {
      assertToolContent(item, `${path}.content[${i}]`);
    }
  }
  if (tool['locations'] !== undefined && tool['locations'] !== null) {
    for (const [i, locationValue] of array(tool['locations'], `${path}.locations`).entries()) {
      const location = record(locationValue, `${path}.locations[${i}]`);
      string(location['path'], `${path}.locations[${i}].path`);
      if (
        location['line'] !== undefined &&
        location['line'] !== null &&
        typeof location['line'] !== 'number'
      ) {
        throw new Error(`${path}.locations[${i}].line must be a number when present`);
      }
    }
  }
}

function assertPlanEntry(value: unknown, path: string): void {
  const entry = record(value, path);
  string(entry['content'], `${path}.content`);
  oneOf(entry['priority'], new Set(['high', 'medium', 'low']), `${path}.priority`);
  oneOf(entry['status'], new Set(['pending', 'in_progress', 'completed']), `${path}.status`);
}

function assertSelectOption(value: unknown, path: string): void {
  const option = record(value, path);
  string(option['value'], `${path}.value`);
  string(option['name'], `${path}.name`);
  optionalString(option['description'], `${path}.description`);
}

function assertConfigOptions(value: unknown, path: string): void {
  for (const [i, optionValue] of array(value, path).entries()) {
    const option = record(optionValue, `${path}[${i}]`);
    if ('options' in option) {
      string(option['group'], `${path}[${i}].group`);
      string(option['name'], `${path}[${i}].name`);
      assertConfigOptions(option['options'], `${path}[${i}].options`);
    } else {
      assertSelectOption(option, `${path}[${i}]`);
    }
  }
}

function assertConfigOption(value: unknown, path: string): void {
  const option = record(value, path);
  string(option['id'], `${path}.id`);
  string(option['name'], `${path}.name`);
  optionalString(option['description'], `${path}.description`);
  optionalString(option['category'], `${path}.category`);
  const type = string(option['type'], `${path}.type`);
  if (type === 'select') {
    string(option['currentValue'], `${path}.currentValue`);
    assertConfigOptions(option['options'], `${path}.options`);
  } else if (type === 'boolean') {
    if (typeof option['currentValue'] !== 'boolean')
      throw new Error(`${path}.currentValue must be boolean`);
  } else {
    throw new Error(`${path}.type has unknown config type ${JSON.stringify(type)}`);
  }
}

function assertUpdateFormat(updateValue: unknown, path: string): string {
  const update = record(updateValue, path);
  const kind = string(update['sessionUpdate'], `${path}.sessionUpdate`);
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      optionalString(update['messageId'], `${path}.messageId`);
      assertContentBlock(update['content'], `${path}.content`);
      break;
    case 'tool_call':
      assertToolCall(update, path, true);
      break;
    case 'tool_call_update':
      assertToolCall(update, path, false);
      break;
    case 'plan':
      for (const [i, entry] of array(update['entries'], `${path}.entries`).entries()) {
        assertPlanEntry(entry, `${path}.entries[${i}]`);
      }
      break;
    case 'plan_update': {
      const plan = record(update['plan'], `${path}.plan`);
      const planType = string(plan['type'], `${path}.plan.type`);
      string(plan['planId'], `${path}.plan.planId`);
      if (planType === 'items') {
        for (const [i, entry] of array(plan['entries'], `${path}.plan.entries`).entries()) {
          assertPlanEntry(entry, `${path}.plan.entries[${i}]`);
        }
      } else if (planType === 'file') {
        string(plan['uri'], `${path}.plan.uri`);
      } else if (planType === 'markdown') {
        string(plan['content'], `${path}.plan.content`);
      } else {
        throw new Error(`${path}.plan.type has unknown value ${JSON.stringify(planType)}`);
      }
      break;
    }
    case 'plan_removed':
      string(record(update, path)['planId'], `${path}.planId`);
      break;
    case 'available_commands_update':
      for (const [i, commandValue] of array(
        update['availableCommands'],
        `${path}.availableCommands`,
      ).entries()) {
        const command = record(commandValue, `${path}.availableCommands[${i}]`);
        string(command['name'], `${path}.availableCommands[${i}].name`);
        string(command['description'], `${path}.availableCommands[${i}].description`);
        if (command['input'] !== undefined && command['input'] !== null) {
          string(
            record(command['input'], `${path}.availableCommands[${i}].input`)['hint'],
            `${path}.availableCommands[${i}].input.hint`,
          );
        }
      }
      break;
    case 'current_mode_update':
      string(update['currentModeId'], `${path}.currentModeId`);
      break;
    case 'config_option_update':
      for (const [i, option] of array(update['configOptions'], `${path}.configOptions`).entries()) {
        assertConfigOption(option, `${path}.configOptions[${i}]`);
      }
      break;
    case 'session_info_update':
      optionalString(update['title'], `${path}.title`);
      optionalString(update['updatedAt'], `${path}.updatedAt`);
      break;
    case 'usage_update':
      if (typeof update['used'] !== 'number') throw new Error(`${path}.used must be a number`);
      if (typeof update['size'] !== 'number') throw new Error(`${path}.size must be a number`);
      if (update['cost'] !== undefined && update['cost'] !== null) {
        const cost = record(update['cost'], `${path}.cost`);
        if (typeof cost['amount'] !== 'number') throw new Error(`${path}.cost.amount must be a number`);
        string(cost['currency'], `${path}.cost.currency`);
      }
      break;
    default:
      throw new Error(`${path}.sessionUpdate has unknown value ${JSON.stringify(kind)}`);
  }
  return kind;
}

function assertEnvelope(event: TranscriptEvent, session: Session, engineId: string, index: number): void {
  if (!Number.isInteger(event.seq) || event.seq <= 0)
    throw new Error(`transcript[${index}].seq is invalid`);
  if (!Number.isInteger(event.ts) || event.ts <= 0) {
    throw new Error(`transcript[${index}].ts is invalid`);
  }
  if (event.sessionId !== session.id)
    throw new Error(`transcript[${index}].sessionId does not match the session`);
  if (event.engineId !== engineId) throw new Error(`transcript[${index}].engineId is not ${engineId}`);
  if (event.usage !== undefined) {
    const usage = record(event.usage, `transcript[${index}].usage`);
    for (const key of ['input', 'output', 'total', 'uncached', 'cacheRead', 'cacheCreation', 'thought']) {
      if (usage[key] !== undefined && typeof usage[key] !== 'number') {
        throw new Error(`transcript[${index}].usage.${key} must be a number when present`);
      }
    }
  }
}

function diffContents(events: TranscriptEvent[]): RecordValue[] {
  const diffs: RecordValue[] = [];
  for (const event of events) {
    const update = event.update as unknown as RecordValue;
    if (update['sessionUpdate'] !== 'tool_call' && update['sessionUpdate'] !== 'tool_call_update') continue;
    const contents = update['content'];
    if (!Array.isArray(contents)) continue;
    for (const content of contents) {
      const item = content as RecordValue;
      if (item['type'] === 'diff') diffs.push(item);
    }
  }
  return diffs;
}

function terminalContents(events: TranscriptEvent[]): RecordValue[] {
  const terminals: RecordValue[] = [];
  for (const event of events) {
    const update = event.update as unknown as RecordValue;
    if (update['sessionUpdate'] !== 'tool_call' && update['sessionUpdate'] !== 'tool_call_update') continue;
    const contents = update['content'];
    if (!Array.isArray(contents)) continue;
    for (const content of contents) {
      const item = content as RecordValue;
      if (item['type'] === 'terminal') terminals.push(item);
    }
  }
  return terminals;
}

function toolKinds(events: TranscriptEvent[]): Set<string> {
  const kinds = new Set<string>();
  for (const event of events) {
    const update = event.update as unknown as RecordValue;
    if (update['sessionUpdate'] === 'tool_call' || update['sessionUpdate'] === 'tool_call_update') {
      if (typeof update['kind'] === 'string') kinds.add(update['kind']);
    }
  }
  return kinds;
}

async function prompt(session: Session, engineId: string, label: string, text: string): Promise<void> {
  const result = await withLiveTimeout(session.prompt(text), 180_000, `${engineId} ${label}`);
  if (result.stopReason !== 'end_turn') {
    throw new Error(`${label} resolved with stopReason=${result.stopReason}`);
  }
}

/**
 * Exercise an engine's update union and tool-call content in one session.
 * @param options - The live session, workspace, descriptor, and permission log.
 * @returns Human-readable observations and non-gating capability warnings.
 * @throws When a required message or tool-call format is invalid or absent.
 */
export async function runAgentMessageCase(
  options: AgentMessageCaseOptions,
): Promise<AgentMessageCaseResult> {
  const {
    session,
    cwd,
    descriptor,
    permissionRequests,
    engineId,
    planMode,
    buildMode,
    requiredUpdateKinds,
    requireDiffs,
    requireTerminalContent,
    requirePermissionRequest,
  } = options;
  const addPath = `${cwd}/runskein-format-add.txt`;
  const initialText = `${ADD_MARKER}\nold line`;
  const editedText = `${EDIT_MARKER}\nnew line`;
  const initialTextVariants = [initialText, `${initialText}\n`];
  const editedTextVariants = [editedText, `${editedText}\n`];
  const log: string[] = [];
  const warnings: string[] = [];

  await session.setConfig({ mode: buildMode });
  const effortOption = descriptor.configOptions.find((option) => option.category === 'thought_level');
  if (effortOption !== undefined) {
    const values =
      effortOption.options?.flatMap((option) => ('options' in option ? option.options : [option])) ?? [];
    const high = values.find((option) => option.value === 'high')?.value;
    if (high !== undefined) {
      try {
        await session.setConfig({ reasoning: high });
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        warnings.push(`${engineId} forced model rejected reasoning=${high}: ${(error as Error).message}`);
      }
    }
  }

  const prompts: Array<[string, string]> = [
    ['baseline', 'Reply with exactly RUNSKEIN_FORMAT_BASELINE and do not call any tools.'],
    [
      'add',
      `Use your file editing tool to create ${addPath} with exactly these two lines:\n${initialText}Do not use a terminal and do not just describe the change. After the tool succeeds, reply with RUNSKEIN_FORMAT_ADD_DONE.`,
    ],
    [
      'edit',
      `Use your file editing tool to replace the complete contents of ${addPath}. The new contents must be exactly:\n${editedText}Do not use a terminal and do not just describe the change. After the tool succeeds, reply with RUNSKEIN_FORMAT_EDIT_DONE.`,
    ],
    [
      'read',
      `Use your file reading or search tool to inspect ${addPath}. Do not modify it and do not use a terminal. After reading it, reply with RUNSKEIN_FORMAT_READ_DONE.`,
    ],
    [
      'terminal',
      `Use your terminal or command tool to run exactly: printf '${TERMINAL_MARKER}\\n'. Do not read or modify files. After the command succeeds, reply with RUNSKEIN_FORMAT_TERMINAL_DONE.`,
    ],
  ];

  for (const [label, text] of prompts) await prompt(session, engineId, label, text);

  if (!existsSync(addPath)) throw new Error(`add step did not create ${addPath}`);
  if (!editedTextVariants.includes(readFileSync(addPath, 'utf8'))) {
    throw new Error(`edit step left unexpected file contents in ${addPath}`);
  }

  await session.setConfig({ mode: planMode });
  await prompt(
    session,
    engineId,
    'plan',
    `In plan mode, use your plan or todo tool to create a concise implementation plan for changing the first line of ${addPath}. Do not edit or execute anything. After the plan tool succeeds, reply with RUNSKEIN_FORMAT_PLAN_DONE.`,
  );
  await session.setConfig({ mode: buildMode });

  const persisted: TranscriptEvent[] = [];
  for await (const event of session.transcript()) persisted.push(event);
  const kinds = new Set<string>();
  let previousSeq = 0;
  for (const [index, event] of persisted.entries()) {
    assertEnvelope(event, session, engineId, index);
    if (event.seq <= previousSeq) throw new Error(`transcript[${index}].seq is not strictly increasing`);
    previousSeq = event.seq;
    kinds.add(assertUpdateFormat(event.update, `transcript[${index}].update`));
  }

  for (const kind of requiredUpdateKinds) {
    if (!kinds.has(kind)) throw new Error(`required update kind ${kind} was not observed`);
  }

  const diffs = diffContents(persisted);
  const addDiff = diffs.find(
    (diff) =>
      diff['path'] === addPath &&
      matchesTextVariant(diff['newText'], initialTextVariants) &&
      (diff['oldText'] === undefined || diff['oldText'] === null || diff['oldText'] === ''),
  );
  const editDiff = diffs.find(
    (diff) =>
      diff['path'] === addPath &&
      matchesTextVariant(diff['oldText'], initialTextVariants) &&
      matchesTextVariant(diff['newText'], editedTextVariants),
  );
  if (addDiff === undefined) {
    if (requireDiffs) throw new Error(`no add diff for ${addPath} with ${ADD_MARKER}`);
    warnings.push(`${engineId} did not emit an ACP add diff for ${addPath}`);
  }
  if (editDiff === undefined) {
    if (requireDiffs) throw new Error(`no edit diff for ${addPath} with oldText/newText replacement`);
    warnings.push(`${engineId} did not emit an ACP edit diff for ${addPath}`);
  }

  const observedToolKinds = toolKinds(persisted);
  if (!observedToolKinds.has('edit')) throw new Error('no edit-kind tool call was observed');
  if (![...observedToolKinds].some((kind) => kind === 'read' || kind === 'search')) {
    throw new Error('no read/search-kind tool call was observed');
  }
  if (!observedToolKinds.has('execute')) throw new Error('no execute-kind tool call was observed');
  const terminals = terminalContents(persisted);
  if (terminals.length === 0) {
    if (requireTerminalContent) throw new Error('no terminal tool-call content was observed');
    warnings.push(`${engineId} did not emit terminal tool-call content`);
  }

  const optionalKinds = [
    'agent_thought_chunk',
    'plan',
    'plan_update',
    'plan_removed',
    'current_mode_update',
    'config_option_update',
    'session_info_update',
    ...(requiredUpdateKinds.includes('usage_update') ? [] : ['usage_update']),
  ];
  for (const kind of optionalKinds) {
    if (kinds.has(kind)) log.push(`observed ${kind}`);
    else warnings.push(`${engineId} did not emit ${kind} in this session`);
  }

  for (const request of permissionRequests) {
    if (request.engineId !== engineId) throw new Error(`permission request engineId is not ${engineId}`);
    if (request.sessionId !== session.id)
      throw new Error('permission request sessionId does not match the session');
    string(request.tool, 'permission.tool');
    if (request.kind !== undefined) oneOf(request.kind, TOOL_KINDS, 'permission.kind');
    if (request.locations !== undefined) {
      for (const [i, locationValue] of request.locations.entries()) {
        const location = record(locationValue, `permission.locations[${i}]`);
        string(location['path'], `permission.locations[${i}].path`);
        if (
          location['line'] !== undefined &&
          location['line'] !== null &&
          typeof location['line'] !== 'number'
        ) {
          throw new Error(`permission.locations[${i}].line must be a number when present`);
        }
      }
    }
    if (!Array.isArray(request.options) || request.options.length === 0) {
      throw new Error('permission request contained no options');
    }
    for (const option of request.options) {
      string(option.optionId, 'permission.options[].optionId');
      string(option.name, 'permission.options[].name');
      oneOf(option.kind, PERMISSION_OPTION_KINDS, 'permission.options[].kind');
    }
  }
  if (permissionRequests.length === 0) {
    if (requirePermissionRequest) {
      throw new Error(`${engineId} did not emit a permission request under ask policy`);
    }
    warnings.push(`${engineId} did not emit a permission request under its configured mode`);
  }

  log.push(`validated ${persisted.length} transcript events in one session`);
  log.push(`update kinds: ${[...kinds].sort().join(', ')}`);
  log.push(`tool kinds: ${[...observedToolKinds].sort().join(', ')}`);
  log.push(
    `diffs: add=${addDiff?.['path'] ?? 'absent'} edit=${editDiff?.['path'] ?? 'absent'} terminalContents=${terminals.length}`,
  );
  log.push(`permission requests: ${permissionRequests.length}`);
  return { log, warnings };
}
