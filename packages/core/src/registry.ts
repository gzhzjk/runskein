/**
 * Adapter discovery + loading + spec validation.
 *
 * Resolution layers, later overriding earlier by id:
 *   1. trusted built-ins (always registered)
 *   2. discovery (explicit opt-in): workspace adapters/* and
 *      .runskein/adapters/* → installed runskein-adapter-* packages
 *   3. adapterPaths — explicitly trusted directories to scan
 *   4. explicit adapter objects — highest priority
 *
 * Failure isolation: a broken candidate becomes an InvalidEngineInfo entry
 * (`health: 'invalid'`, required `error`), never a hub crash.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  classifyEngineFailure,
  compileErrorPatterns,
  type AdapterErrorCause,
  type CompiledErrorPattern,
} from './errorTaxonomy.js';
import { EngineOperationError } from './errors.js';
import { missingRuntimeAsset } from './process/spawn.js';
import { USAGE_TOKEN_KEYS } from './transcript/event.js';
import type { DetectResult, EngineAdapter, EngineErrorPattern, InvalidEngineInfo } from './types.js';

export const ADAPTER_SPEC_VERSION = 1;
const INSTALLED_ADAPTER_PREFIX = 'runskein-adapter-';

// ── Adapter schema (zod-validated at load) ─────────────────────────────────

const selectOptionSchema = z.object({
  value: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

const configOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  category: z.string().optional(),
  type: z.enum(['select', 'boolean']),
  options: z
    .union([
      z.array(selectOptionSchema),
      z.array(z.object({ name: z.string(), options: z.array(selectOptionSchema) })),
    ])
    .optional(),
  currentValue: z.union([z.string(), z.boolean()]).optional(),
  settable: z.enum(['session', 'creation']).optional(),
});

/**
 * Config an adapter declares as creation-time only. Validated like everything
 * else an adapter ships: a malformed declaration must fail the adapter, not
 * surface later as a config key that silently writes nothing.
 */
const creationConfigSchema = z.record(
  z.string(),
  z.object({
    meta: z.array(z.string()).min(1),
    values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    description: z.string().optional(),
  }),
);

const errorPatternSchema = z
  .object({
    cause: z.enum(['auth', 'rate-limit', 'context', 'internal']),
    match: z.string().min(1),
    flags: z.string().optional(),
  })
  .superRefine((pattern, ctx) => {
    try {
      new RegExp(pattern.match, pattern.flags ?? 'i');
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['flags'],
        message: `invalid error pattern: ${(error as Error).message}`,
      });
    }
  });

/**
 * The usage mapping schema. Beyond shape, two rules are load-bearing:
 * - `usage_update` + `per-turn` is refused as a COMBINATION — both halves are
 *   individually legal, so the error must name the pairing, not one field.
 *   Replay stores engine-sent updates verbatim and replaces within a segment,
 *   which cannot represent per-turn numbers (three turns of 100/200/300 would
 *   resume as 300). An engine that reports per-turn through a notification can
 *   be adapted by its shim; lifting the refusal is a new decision.
 * - `tokens` keys must be runskein Usage keys. A key runskein does not own could
 *   never land anywhere, and silence here would ship an adapter that quietly
 *   drops the field it declared.
 */
const usageMappingSchema = z
  .object({
    source: z.union([
      z.object({ kind: z.literal('usage_update') }),
      z.object({
        kind: z.literal('prompt_response_meta'),
        path: z.array(z.string().min(1)).min(1),
      }),
    ]),
    tokens: z.record(z.string(), z.array(z.string().min(1)).min(1)).optional(),
    semantics: z.enum(['cumulative', 'per-turn']),
  })
  .superRefine((mapping, ctx) => {
    if (mapping.source.kind === 'usage_update' && mapping.semantics === 'per-turn') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'semantics'],
        message:
          'invalid combination usage_update + per-turn: engine-sent usage_update events are stored verbatim and replay replaces within a segment, so per-turn counts would resume as the last turn alone; adapt per-turn reports in a shim or declare prompt_response_meta',
      });
    }
    if (mapping.tokens !== undefined) {
      for (const key of Object.keys(mapping.tokens)) {
        if (!(USAGE_TOKEN_KEYS as readonly string[]).includes(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tokens', key],
            message: `unknown runskein Usage token key '${key}'`,
          });
        }
      }
    }
  });

const adapterSchema = z.object({
  specVersion: z.literal(ADAPTER_SPEC_VERSION),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase kebab-case id'),
  launch: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z
      .record(z.string())
      .optional()
      .superRefine((env, ctx) => {
        // Windows resolves variable names without case, so two spellings of one
        // name are two variables here and one there -- and which value the
        // engine ends up with is then decided by key order and the platform's
        // collapsing rather than by the adapter. Refused where the author can
        // still act on it, rather than passed on to mean different things on
        // different machines.
        const seen = new Map<string, string>();
        for (const name of Object.keys(env ?? {})) {
          const first = seen.get(name.toUpperCase());
          if (first !== undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [name],
              message: `launch.env sets '${first}' and '${name}', which are one variable on Windows`,
            });
            continue;
          }
          seen.set(name.toUpperCase(), name);
        }
      }),
    startTimeoutMs: z.number().int().positive().optional(),
  }),
  shim: z.string().optional(),
  supervise: z.boolean().optional(),
  detect: z
    .custom<() => Promise<DetectResult>>((v: unknown) => typeof v === 'function', {
      message: 'detect must be a function',
    })
    .optional(),
  configHints: z.array(configOptionSchema).optional(),
  creationConfig: creationConfigSchema.optional(),
  envScrubExtra: z
    .array(z.custom<RegExp>((v: unknown) => v instanceof RegExp, { message: 'expected RegExp' }))
    .optional(),
  errorPatterns: z.array(errorPatternSchema).optional(),
  usage: usageMappingSchema.optional(),
});

/** Validate an adapter object; throws ZodError on mismatch. */
export function validateAdapter(candidate: unknown): EngineAdapter {
  return adapterSchema.parse(candidate) as EngineAdapter;
}

/**
 * Turn an adapter's `shim` entry point into an absolute path, rejecting one
 * that does not exist or that reaches outside the adapter's own directory.
 *
 * The check happens at load, not at spawn: a shim is code this process will
 * execute, so a path that escapes the directory it was declared in — or that
 * is simply missing — must surface as an invalid adapter rather than as a
 * failed session much later. An adapter registered as a bare object has no
 * directory to anchor against and must therefore supply an absolute path.
 * @param adapter - the validated adapter.
 * @param dir - the directory the adapter was loaded from, if any.
 * @returns the adapter, with `shim` rewritten to an absolute path when present.
 * @throws `Error` when the shim is missing, relative without a directory, or outside it.
 */
function resolveShim(adapter: EngineAdapter, dir: string | undefined): EngineAdapter {
  if (adapter.shim === undefined) return adapter;
  if (!isAbsolute(adapter.shim) && dir === undefined) {
    throw new Error(`shim '${adapter.shim}' must be an absolute path for a directly registered adapter`);
  }
  const shim = resolve(dir ?? '', adapter.shim);
  if (dir !== undefined && relative(dir, shim).startsWith('..')) {
    throw new Error(`shim '${adapter.shim}' resolves outside the adapter directory`);
  }
  if (!existsSync(shim)) throw new Error(missingRuntimeAsset('shim entry point', shim));
  return { ...adapter, shim };
}

// ── Candidate discovery ────────────────────────────────────────────────────

interface Candidate {
  /** Directory containing package.json, or undefined for explicit objects. */
  dir?: string;
  /** Adapter object for explicit registration. */
  adapter?: EngineAdapter | unknown;
  /** Layer index; higher wins on id collision across layers. */
  layer: number;
  /** Human-readable origin for error messages. */
  origin: string;
}

interface MarkerPackageJson {
  name?: string;
  main?: string;
  exports?: unknown;
  runskein?: { adapter?: boolean; specVersion?: number };
}

function readPackageJson(dir: string): MarkerPackageJson | undefined {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as MarkerPackageJson;
  } catch {
    return undefined;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Check that a candidate directory identifies its adapter, allowing the
 * publishing prefix used by installed packages.
 * @param dirName - the candidate directory's basename.
 * @param adapterId - the validated adapter id.
 * @returns whether the directory names the adapter directly or with the prefix.
 */
function matchesAdapterIdentity(dirName: string, adapterId: string): boolean {
  return dirName === adapterId || dirName === `${INSTALLED_ADAPTER_PREFIX}${adapterId}`;
}

/** Directories under `base` whose package.json carries the runskein.adapter marker. */
function markedSubdirs(base: string): string[] {
  if (!isDir(base)) return [];
  const out: string[] = [];
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    if (!isDir(dir)) continue;
    const pkg = readPackageJson(dir);
    if (pkg?.runskein?.adapter === true) out.push(dir);
  }
  return out;
}

// node_modules scan: runskein-adapter-* and scoped @scope/runskein-adapter-* with the marker.
function installedAdapterDirs(cwd: string): string[] {
  const nm = join(cwd, 'node_modules');
  if (!isDir(nm)) return [];
  const out: string[] = [];
  for (const name of readdirSync(nm)) {
    if (name.startsWith('@')) {
      const scope = join(nm, name);
      if (!isDir(scope)) continue;
      for (const sub of readdirSync(scope)) {
        if (sub.startsWith(INSTALLED_ADAPTER_PREFIX)) out.push(join(scope, sub));
      }
    } else if (name.startsWith(INSTALLED_ADAPTER_PREFIX)) {
      out.push(join(nm, name));
    }
  }
  return out.filter((dir) => readPackageJson(dir)?.runskein?.adapter === true);
}

// ── Registry ───────────────────────────────────────────────────────────────

export interface RegistryOptions {
  adapters?: EngineAdapter[];
  adapterPaths?: string[];
  discovery?: boolean; // default false; dynamic imports are explicit opt-in
  /** Adapters bundled by the runskein meta-package. */
  builtins?: EngineAdapter[];
  /** Base directory for workspace/node_modules scans. Default process.cwd(). */
  cwd?: string;
}

export class Registry {
  private readonly options: RegistryOptions;
  private loaded: Promise<void> | undefined;
  private registered = new Map<string, EngineAdapter>();
  private invalid: InvalidEngineInfo[] = [];
  private detectCache = new Map<string, Promise<DetectResult | undefined>>();
  private detected = new Map<string, DetectResult | undefined>();
  private unauthenticated = new Set<string>();
  private detectGeneration = 0;
  private compiledErrorPatterns = new WeakMap<EngineAdapter, readonly CompiledErrorPattern[]>();

  /**
   * Create a Registry with the given discovery/registration options.
   * @param options - builtins, discovery, adapterPaths, adapters, cwd.
   */
  constructor(options: RegistryOptions = {}) {
    this.options = options;
  }

  /**
   * All successfully registered adapters, keyed by id. Triggers the one-time
   * discovery pass on first call.
   * @returns the adapter map.
   */
  async adapters(): Promise<ReadonlyMap<string, EngineAdapter>> {
    await this.ensureLoaded();
    return this.registered;
  }

  /**
   * Candidates that failed discovery or validation. Kept separate so one
   * broken adapter cannot take the hub down with it.
   * @returns the invalid candidates.
   */
  async invalidCandidates(): Promise<readonly InvalidEngineInfo[]> {
    await this.ensureLoaded();
    return this.invalid;
  }

  /**
   * Look up one adapter by id.
   * @param id - the adapter id.
   * @returns the adapter or undefined.
   */
  async get(id: string): Promise<EngineAdapter | undefined> {
    await this.ensureLoaded();
    return this.registered.get(id);
  }

  /**
   * Run the adapter's detect() hook once and cache the result. A throwing
   * detect() surfaces as a typed failure rather than being turned into a
   * fabricated "not installed" answer; hub inventory isolates it as an invalid
   * entry.
   * @param id - the adapter id.
   * @returns the detect result, or undefined when the adapter has no hook.
   * @throws EngineOperationError when the adapter's detect() threw.
   */
  detect(id: string): Promise<DetectResult | undefined> {
    const cached = this.detectCache.get(id);
    const generation = this.detectGeneration;
    const p =
      cached ??
      (async (): Promise<DetectResult | undefined> => {
        const adapter = await this.get(id);
        if (!adapter?.detect) return undefined;
        try {
          const result = await adapter.detect();
          // A rescan starts a new detect generation. An older in-flight probe
          // may still resolve for its original caller, but must not overwrite
          // the new generation's login hint used for later auth recovery.
          if (this.detectGeneration === generation) this.detected.set(id, result);
          return result;
        } catch (cause) {
          throw new EngineOperationError({ engineId: id, operation: 'adapter/detect', cause });
        }
      })();
    if (!cached) this.detectCache.set(id, p);
    return p.then((result) => {
      if (!this.unauthenticated.has(id)) return result;
      // This override is only set from a live engine failure, so installed is
      // known even for an adapter that has no detect hook of its own.
      return { ...(result ?? { installed: true }), authenticated: false };
    });
  }

  /**
   * Classify a raw engine failure using the patterns compiled for its adapter.
   * @param adapter - the registered adapter that owned the failed operation.
   * @param failure - the raw ACP failure.
   * @returns the adapter cause, or undefined for the plain fallback.
   */
  classifyFailure(adapter: EngineAdapter, failure: unknown): AdapterErrorCause | undefined {
    return classifyEngineFailure(this.compiledErrorPatterns.get(adapter) ?? [], failure);
  }

  /**
   * Mark cached detection as unauthenticated until an explicit rescan.
   * @param id - the engine whose live request reported an auth failure.
   * @returns whether this is the first invalidation and the last known login hint.
   */
  markUnauthenticated(id: string): { changed: boolean; loginHint?: string } {
    const changed = !this.unauthenticated.has(id);
    this.unauthenticated.add(id);
    const loginHint = this.detected.get(id)?.loginHint;
    return loginHint === undefined ? { changed } : { changed, loginHint };
  }

  /**
   * Invalidate the discovery and detect caches; the next read re-walks
   * everything.
   */
  rescan(): void {
    this.loaded = undefined;
    this.registered = new Map();
    this.invalid = [];
    this.detectCache = new Map();
    this.detected = new Map();
    this.unauthenticated = new Set();
    this.detectGeneration++;
    // Existing live sessions retain their registered adapter object across a
    // rescan. Keeping this weak cache lets those sessions classify a later
    // failure correctly; obsolete keys remain collectible on their own.
  }

  // ── loading pipeline ─────────────────────────────────────────────────────

  /**
   * Lazily run the one-time discovery/load pass.
   * @returns a promise that resolves once discovery completes.
   */
  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    const cwd = this.options.cwd ?? process.cwd();
    const candidates: Candidate[] = [];

    // Statically imported built-ins are trusted application code, not dynamic
    // workspace discovery, and remain available when discovery is disabled.
    for (const adapter of this.options.builtins ?? []) {
      candidates.push({ adapter, layer: 10, origin: 'builtin' });
    }

    if (this.options.discovery === true) {
      // Dynamic discovery executes adapter modules and is therefore opt-in.
      for (const base of [join(cwd, 'adapters'), join(cwd, '.runskein', 'adapters')]) {
        for (const dir of markedSubdirs(base)) {
          candidates.push({ dir, layer: 11, origin: dir });
        }
      }
      for (const dir of installedAdapterDirs(cwd)) {
        candidates.push({ dir, layer: 12, origin: dir });
      }
    }

    // Explicitly trusted directories, which outrank anything discovered.
    for (const base of this.options.adapterPaths ?? []) {
      for (const dir of markedSubdirs(resolve(cwd, base))) {
        candidates.push({ dir, layer: 20, origin: dir });
      }
    }

    // Adapter objects passed in by the embedder — highest priority of all.
    for (const adapter of this.options.adapters ?? []) {
      candidates.push({ adapter, layer: 30, origin: 'explicit adapters option' });
    }

    const byId = new Map<string, { adapter: EngineAdapter; layer: number }>();
    const collidedAtLayer = new Map<string, number>();
    const collisionEntries = new Map<string, InvalidEngineInfo>();
    for (const candidate of candidates) {
      const loadedAdapter = await this.loadCandidate(candidate);
      if (!loadedAdapter) continue;
      if (collidedAtLayer.get(loadedAdapter.id) === candidate.layer) continue;
      const existing = byId.get(loadedAdapter.id);
      if (existing && existing.layer === candidate.layer) {
        byId.delete(loadedAdapter.id);
        collidedAtLayer.set(loadedAdapter.id, candidate.layer);
        const entry: InvalidEngineInfo = {
          id: loadedAdapter.id,
          health: 'invalid',
          error: `duplicate adapter id '${loadedAdapter.id}' in the same layer (${candidate.origin})`,
        };
        this.invalid.push(entry);
        collisionEntries.set(loadedAdapter.id, entry);
        continue;
      }
      if (!existing || candidate.layer > existing.layer) {
        byId.set(loadedAdapter.id, { adapter: loadedAdapter, layer: candidate.layer });
        if ((collidedAtLayer.get(loadedAdapter.id) ?? -1) < candidate.layer) {
          collidedAtLayer.delete(loadedAdapter.id);
          const resolved = collisionEntries.get(loadedAdapter.id);
          if (resolved) {
            const index = this.invalid.indexOf(resolved);
            if (index >= 0) this.invalid.splice(index, 1);
            collisionEntries.delete(loadedAdapter.id);
          }
        }
      }
    }
    this.registered = new Map([...byId.entries()].map(([id, { adapter }]) => [id, adapter]));
  }

  /** Load + validate one candidate; on failure record InvalidEngineInfo. */
  private async loadCandidate(candidate: Candidate): Promise<EngineAdapter | undefined> {
    let recoveredId: string | undefined;
    try {
      let raw: unknown;
      if (candidate.dir !== undefined) {
        const pkg = readPackageJson(candidate.dir);
        if (!pkg) throw new Error('unreadable package.json');
        const spec = pkg.runskein?.specVersion;
        if (spec !== undefined && spec !== ADAPTER_SPEC_VERSION) {
          console.error(
            `[runskein] skipping adapter at ${candidate.origin}: unsupported specVersion ${spec}`,
          );
          return undefined; // skipped with a warning, never a crash
        }
        const entry = this.resolveEntry(candidate.dir, pkg);
        const mod = (await import(pathToFileURL(entry).href)) as { default?: unknown };
        raw = mod.default;
        if (raw === undefined) throw new Error(`no default export in ${entry}`);
      } else {
        raw = candidate.adapter;
      }
      recoveredId =
        typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : undefined;
      const validated = validateAdapter(raw);
      if (candidate.dir !== undefined) {
        const dirName = basename(candidate.dir);
        if (!matchesAdapterIdentity(dirName, validated.id)) {
          throw new Error(
            `adapter id '${validated.id}' must match directory name '${dirName}' directly or after stripping prefix '${INSTALLED_ADAPTER_PREFIX}'`,
          );
        }
      }
      const adapter = resolveShim(validated, candidate.dir);
      this.compiledErrorPatterns.set(
        adapter,
        compileErrorPatterns(adapter.errorPatterns as readonly EngineErrorPattern[] | undefined),
      );
      return adapter;
    } catch (e) {
      const entry: InvalidEngineInfo = {
        health: 'invalid',
        error: `${candidate.origin}: ${(e as Error).message}`,
      };
      if (recoveredId !== undefined) entry.id = recoveredId;
      this.invalid.push(entry);
      return undefined;
    }
  }

  /**
   * Resolve an adapter's entry module from its package manifest.
   * @param dir - the adapter directory.
   * @param pkg - its parsed package.json.
   * @returns the entry file path.
   */
  private resolveEntry(dir: string, pkg: MarkerPackageJson): string {
    // Respect "exports" string / { ".": ... } forms, then "main", then index.js.
    const exp = pkg.exports;
    if (typeof exp === 'string') return join(dir, exp);
    if (typeof exp === 'object' && exp !== null) {
      const dot = (exp as Record<string, unknown>)['.'];
      if (typeof dot === 'string') return join(dir, dot);
      if (typeof dot === 'object' && dot !== null) {
        const imp =
          (dot as Record<string, unknown>)['import'] ?? (dot as Record<string, unknown>)['default'];
        if (typeof imp === 'string') return join(dir, imp);
      }
    }
    return join(dir, pkg.main ?? 'index.js');
  }
}
