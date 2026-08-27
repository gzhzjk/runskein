/**
 * Permissions — one policy mechanism. A PermissionPolicy is
 * the single answer path; "bypass" and "ask" are just policies. The
 * `s.on('permission')` event is read-only observability.
 */
import type { PermissionOption, ToolCallLocation, ToolKind } from '../vocabulary.js';

export interface PermissionRequest {
  sessionId: string;
  engineId: string;
  tool: string;
  kind?: ToolKind;
  input: unknown;
  locations?: ToolCallLocation[];
  options: PermissionOption[]; // the agent's offered choices
}

export type PermissionDecision =
  | { optionId: string } // pick an offered option directly
  | { outcome: 'allow' | 'deny' }; // runskein maps to the closest optionId

export type PermissionPolicy = (req: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;

export interface PermissionRule {
  /** Tool name or ToolKind to match; '*' matches any. */
  tool: string;
  /** Substring/glob (`*` wildcard) tested against locations and stringified input; '*' matches any. */
  pattern: string;
  action: 'allow' | 'deny';
}

/** Always-allow policy: grants every permission request (fail open). */
const allowAll: PermissionPolicy = () => ({ outcome: 'allow' });
/** Always-deny policy: refuses every permission request (fail closed). */
const denyAll: PermissionPolicy = () => ({ outcome: 'deny' });

/**
 * Compile a glob (substring with '*' wildcards) into a RegExp.
 * @param glob - The glob pattern to compile.
 * @returns A RegExp matching strings against the glob.
 */
function globToRegExp(glob: string): RegExp {
  // '?' must stay literal — the doc contract is "only '*' is a wildcard", and
  // an unescaped '?' would turn a deny rule like 'exec?cmd=*' into a regex
  // optional-quantifier that matches the wrong requests.
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped);
}

/**
 * Whether a rule matches a request: tool name/kind equality plus a glob test
 * over the locations' paths, the stringified input, and the tool name.
 * @param rule - The rule to test.
 * @param req - The permission request to match.
 * @returns true when the rule applies to the request.
 */
function ruleMatches(rule: PermissionRule, req: PermissionRequest): boolean {
  if (rule.tool !== '*' && rule.tool !== req.tool && rule.tool !== req.kind) return false;
  if (rule.pattern === '*') return true;
  const re = globToRegExp(rule.pattern);
  const haystacks = [
    ...(req.locations ?? []).map((l) => l.path),
    typeof req.input === 'string' ? req.input : JSON.stringify(req.input ?? ''),
    req.tool,
  ];
  return haystacks.some((h) => re.test(h));
}

/**
 * Declarative table: first matching rule wins; no match ⇒ deny (fail closed).
 * @param table - Ordered rules, evaluated top-down.
 * @returns A policy returning the first matching rule's action, or 'deny'.
 */
function rules(table: PermissionRule[]): PermissionPolicy {
  return (req) => {
    for (const rule of table) {
      if (ruleMatches(rule, req)) return { outcome: rule.action };
    }
    return { outcome: 'deny' };
  };
}

export const policies = { allowAll, denyAll, rules };

/**
 * Map a PermissionDecision onto the engine's offered options: a bare
 * outcome picks the closest optionId by kind, falling back to the first
 * option of the right polarity; a denied request with no reject option is
 * answered 'cancelled'.
 * @param decision - The policy's decision to map.
 * @param options - The agent's offered options for the request.
 * @returns A 'selected' outcome with the mapped optionId, or 'cancelled'.
 */
export function decisionToOutcome(
  decision: PermissionDecision,
  options: PermissionOption[],
): { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } {
  // A buggy user policy can return anything; malformed input must answer
  // 'cancelled' rather than throw an untyped TypeError out of the wire handler.
  if (typeof decision !== 'object' || decision === null) return { outcome: 'cancelled' };
  if ('optionId' in decision) return { outcome: 'selected', optionId: decision.optionId };
  const wantAllow = decision.outcome === 'allow';
  const kinds = wantAllow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of kinds) {
    const opt = options.find((o) => o.kind === kind);
    if (opt) return { outcome: 'selected', optionId: opt.optionId };
  }
  // No kind hints: heuristically fall back to first/last, else cancel.
  const fallback = wantAllow ? options[0] : undefined;
  return fallback ? { outcome: 'selected', optionId: fallback.optionId } : { outcome: 'cancelled' };
}
