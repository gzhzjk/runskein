# 037 - rate-limit is declared before auth, and both are measured first

Date: 2026-08-25 · Status: **accepted** · Cases: `ST-ERR-03` in
`packages/core/test/failureTaxonomy.test.ts` · Rests on: decision 025 ·
Informs: api §10

> Accepted in the change that landed the patterns, the anchored cases and the
> contract-document update together — the requirement
> `docs/decisions/README.md` sets for flipping a record out of _proposed_.

## Context

Decision 025 made `auth` classification a **teardown**, not a label: it
invalidates the cached detect result until `hub.rescan()`, emits
`engine:unauthenticated`, marks every live session on that engine crashed, and
retires the engine process. That is right for a dead credential and wrong for
everything else.

Every bundled adapter declared exactly one pattern, `auth`, and none declared
`rate-limit`. Measured on 2026-08-25, with valid logins:

- **kimi**, quota spent: `Authentication required: 403 You've reached your usage
limit for this billing cycle. Your quota will be refreshed in the next
cycle. …` — kimi prefixes an upstream refusal with `Authentication
required:` whatever its cause, so the auth pattern claimed it and a spent
  quota tore the engine down as if the account had been logged out.
- **pi**, throttled after its own retries: `Internal error: pi ended the turn
with an error: 429 status code (no body)` — an ordinary error on the cause
  chain, which matched nothing and left `EngineOperationError.kind` absent, so
  a consumer could not tell "wait and retry" from an engine fault. This
  disproves the assumption that pi's throttling is only visible as a
  `session_info_update` notification the classifier cannot reach.

## Decision

- **`rate-limit` is declared ahead of `auth`** in every adapter that classifies
  both, and the rule is stated in the contract document rather than left to
  the accident that today's auth patterns are literals. Classification is
  first-match-wins, so with the order reversed a rate-limit pattern is
  unreachable for exactly the engines that need it.
- **A pattern is written from a measured payload, never from a guess.** kimi's
  and pi's are taken from the wording each engine actually returned, and the
  contract document records both strings and the date. Neither is the whole
  string: kimi states its condition twice and either statement identifies it,
  while pi's is `429` together with the words around it, because the digits
  alone also occur in token counts, ports and paths, and word boundaries do not
  separate those. Each fragment is kept long enough to name the condition —
  `usage limit` on its own also appears in sentences about a configured limit,
  and `429` on its own in token counts. codex, opencode and claude-code declare no `rate-limit`
  pattern: their throttled payloads have not been observed, and a plausible
  regex that never fires — or fires on the wrong message — is worse than an
  absent `kind`.
- **The auth teardown itself is unchanged.** What was wrong is who was classed
  as `auth`, not what `auth` does.

## Consequences

- A kimi request on a spent quota now raises `EngineOperationError` with
  `kind: 'rate-limit'`. The session stays alive, no `engine:unauthenticated`
  is emitted, the cached login stands, and the engine process is not retired —
  verified against the live engine, including that a second prompt on the same
  session reaches the engine and fails the same way.
- A throttled pi turn now carries `kind: 'rate-limit'` instead of no kind. That
  one is anchored to the payload captured while pi was throttled, not
  re-verified end to end: by the time the pattern existed the account was
  serving turns again, and a live check would have proved nothing. The kimi
  path stands in for both — the classification code is shared, only the
  wording differs.
- The cases replay both recorded payloads and pair each with messages the
  pattern must **not** claim, so a declaration is pinned from both sides:
  dropping a pattern turns the replay red, and loosening one toward the general
  — `usage limit`, a bare `429` — turns a negative red. They do **not** detect
  an engine rewording its message: a rewording that keeps a matched fragment
  still classifies, and one that drops it sends the failure back to the auth
  path (kimi) or to no kind (pi), with the suite still green either way. That is
  a field report by construction, and the honest bound on what a hermetic case
  can prove about someone else's wording.
- Consumers can finally distinguish "logged out" from "out of quota" — the
  prerequisite the downstream projection of `cause` was waiting on.
