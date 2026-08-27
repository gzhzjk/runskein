/**
 * ST-QUOTA-01 — engine quota-reporting survey (AC-5.2).
 *
 * codex was found (by accident, during the session/delete probe) to report
 * per-model quota in the prompt response's `_meta`. Budget gating is L2
 * policy, but the signal only exists on the wire L1 owns, and runskein currently
 * drops it. Before any type firmer than "unknown passthrough" ships, the
 * survey has to say who reports what, and where.
 *
 * Deliberately measured at the CONNECTION level rather than through the Hub:
 * `TurnResult` has no `_meta` or `quota` field today, so the Hub cannot
 * surface what this case exists to find. Reading the raw JSON-RPC result is
 * also the honest oracle for AC-5.1's later "verbatim" claim — it is the wire,
 * not runskein's parsed copy of it.
 *
 * Captured per engine: `_meta` on the initialize result, on the session/new
 * result, on the prompt result, and on every streamed update (usage_update in
 * particular), plus which of them look quota-shaped.
 *
 * Usage: pnpm --filter @runskein/conformance st:quota [engineId ...]
 * Output: docs/conformance/st-quota-01.json (+ a console summary).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ProcessManager,
  autoAllowPermission,
  withTimeout,
  type SessionUpdateNotification,
} from '@runskein/core/internal';
import { builtinAdapters } from 'runskein';

const PROMPT_TEXT = 'Reply with exactly the word OK and nothing else. Do not use any tools.';

/** Keys that suggest a quota/limit signal rather than plain token accounting. */
const QUOTA_HINT = /quota|limit|remaining|reset|credit|balance|allowance|window/i;

interface EngineSurvey {
  engine: string;
  ok: boolean;
  error?: string;
  /** The model the engine chose on its own (no pin at connection level). */
  model?: string;
  initializeMeta?: unknown;
  sessionNewMeta?: unknown;
  promptMeta?: unknown;
  /** `_meta` blobs seen on streamed updates, keyed by update kind. */
  updateMeta: Record<string, unknown[]>;
  /** usage_update payloads, verbatim — runskein's Usage is derived from these. */
  usageUpdates: unknown[];
  /** Where a quota-shaped key was found. */
  quotaFoundAt: string[];
  reportsQuota: boolean;
}

/**
 * Collect the dotted paths of quota-looking keys inside a value.
 * @param value - the blob to scan.
 * @param prefix - the path prefix for recursion.
 * @param out - accumulator.
 * @returns the accumulated paths.
 */
function findQuotaKeys(value: unknown, prefix: string, out: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => findQuotaKeys(item, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (QUOTA_HINT.test(key)) out.push(path);
    findQuotaKeys(child, path, out);
  }
  return out;
}

/**
 * Run one engine through a single cheap turn and record every `_meta` seen.
 * @param engineId - the engine id.
 * @returns the engine's survey row.
 */
async function survey(engineId: string): Promise<EngineSurvey> {
  const adapter = builtinAdapters.find((a) => a.id === engineId)!;
  const row: EngineSurvey = {
    engine: engineId,
    ok: false,
    updateMeta: {},
    usageUpdates: [],
    quotaFoundAt: [],
    reportsQuota: false,
  };
  const cwd = mkdtempSync(join(tmpdir(), `runskein-stquota-${engineId}-`));
  const updates: SessionUpdateNotification[] = [];
  const manager = new ProcessManager({
    handlers: {
      onUpdate: (n) => updates.push(n),
      onPermissionRequest: (params) => autoAllowPermission(params),
    },
  });
  try {
    const acquired = await manager.acquire(adapter, { cwd });
    const { connection } = acquired;
    try {
      const init = connection.initializeResult as Record<string, unknown> | undefined;
      if (init?.['_meta'] !== undefined) row.initializeMeta = init['_meta'];

      const sessionRaw = (await withTimeout(
        connection.rawRequest('session/new', { cwd, mcpServers: [] }),
        60_000,
        'session/new',
      )) as Record<string, unknown>;
      if (sessionRaw['_meta'] !== undefined) row.sessionNewMeta = sessionRaw['_meta'];
      const models = sessionRaw['models'] as { currentModelId?: string } | undefined;
      if (models?.currentModelId !== undefined) row.model = models.currentModelId;
      const sessionId = String(sessionRaw['sessionId']);

      // rawRequest, not connection.prompt(): the typed wrapper is shaped for
      // stopReason and would hide exactly the engine-private fields sought.
      const promptRaw = (await withTimeout(
        connection.rawRequest('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: PROMPT_TEXT }],
        }),
        180_000,
        'session/prompt',
      )) as Record<string, unknown>;
      if (promptRaw['_meta'] !== undefined) row.promptMeta = promptRaw['_meta'];

      for (const notification of updates) {
        const update = notification.update as Record<string, unknown>;
        const kind = String(update['sessionUpdate']);
        if (update['_meta'] !== undefined) {
          (row.updateMeta[kind] ??= []).push(update['_meta']);
        }
        if (kind === 'usage_update') row.usageUpdates.push(update);
      }

      row.quotaFoundAt = [
        ...findQuotaKeys(row.initializeMeta, 'initialize._meta'),
        ...findQuotaKeys(row.sessionNewMeta, 'session/new._meta'),
        ...findQuotaKeys(row.promptMeta, 'session/prompt._meta'),
        ...findQuotaKeys(row.updateMeta, 'update._meta'),
        ...findQuotaKeys(row.usageUpdates, 'usage_update'),
      ];
      row.reportsQuota = row.quotaFoundAt.length > 0;
      row.ok = true;

      try {
        await connection.closeSession(sessionId, { timeoutMs: 10_000 });
      } catch {
        /* close is Negotiated; its absence is already measured elsewhere */
      }
      // Engine-side hygiene where the verb exists (kimi, codex).
      if (connection.capabilities.session['delete'] === true) {
        try {
          await withTimeout(
            connection.rawRequest('session/delete', { sessionId }),
            10_000,
            'session/delete',
          );
        } catch {
          /* cleanup is hygiene, never a gate */
        }
      }
    } finally {
      acquired.release();
    }
  } catch (error) {
    row.error = String(error).split('\n')[0] ?? '';
  } finally {
    await manager.quit().catch(() => undefined);
  }
  return row;
}

const wanted = process.argv.slice(2);
const targets = (
  wanted.length ? builtinAdapters.filter((a) => wanted.includes(a.id)) : builtinAdapters
).map((a) => a.id);
if (targets.length === 0) {
  console.error(`unknown engine(s): ${wanted.join(', ')}`);
  process.exitCode = 2;
  throw new Error('no known engine selected');
}

const rows: EngineSurvey[] = [];
for (const engine of targets) {
  console.log(`\n━━━ ST-QUOTA-01 ${engine} ━━━`);
  const row = await survey(engine);
  rows.push(row);
  console.log(
    `  ok=${row.ok} model=${row.model ?? '—'} reportsQuota=${row.reportsQuota}` +
      `${row.error !== undefined ? ` error=${row.error}` : ''}`,
  );
  console.log(
    `  prompt._meta: ${row.promptMeta === undefined ? 'absent' : JSON.stringify(row.promptMeta).slice(0, 400)}`,
  );
  if (row.quotaFoundAt.length > 0) console.log(`  quota keys: ${row.quotaFoundAt.slice(0, 12).join(', ')}`);
  const updateKinds = Object.keys(row.updateMeta);
  if (updateKinds.length > 0) console.log(`  update _meta on: ${updateKinds.join(', ')}`);
  if (row.usageUpdates.length > 0)
    console.log(`  usage_update: ${JSON.stringify(row.usageUpdates[0]).slice(0, 300)}`);
}

const out = resolve(import.meta.dirname, '../../../docs/conformance/st-quota-01.json');
writeFileSync(
  out,
  JSON.stringify({ case: 'ST-QUOTA-01', measuredAt: new Date().toISOString(), engines: rows }, null, 2) +
    '\n',
);
console.log(`\nwrote ${out}`);
