# 044 - an error pattern is anchored on what repeated payloads share

Date: 2026-08-31 · Status: **accepted** · Cases: `ST-ERR-03` in
`packages/core/test/failureTaxonomy.test.ts` · Evidence: two spent-quota
refusals from the same kimi account, 2026-08-25 and 2026-08-31 ·
Rests on: decisions 025, 037 · Amends: 037's second bullet

## Context

Decision 037 made `rate-limit` classification work by writing each adapter
pattern from a payload the engine had actually returned. It was right, and it
lasted six days.

kimi reworded its spent-quota message. Both of the fragments 037 had taken from
the single payload it had available broke in the same edit:

```
2026-08-25  ...403 You've reached your usage limit for this billing cycle.
            Your quota will be refreshed in the next cycle. To continue now,
            purchase extra usage or upgrade your plan: https://www.kimi.com/…?tab=quota

2026-08-31  ...403 You've reached your weekly (7-day) usage limit. Your quota
            will reset when the current 7-day window ends. To continue now,
            purchase extra usage or upgrade your plan: https://www.kimi.com/…?tab=quota
```

A qualifier moved between `your` and `usage limit`; `refreshed` became `reset`.
With `rate-limit` unreachable, first-match-wins handed the message to the `auth`
literal, and by decision 025 `auth` is a teardown. Measured on a **valid,
logged-in account** whose only fault was a spent quota:

|             | before                               | after this change      |
| ----------- | ------------------------------------ | ---------------------- |
| error       | `UnauthenticatedError`               | `EngineOperationError` |
| `kind`      | —                                    | `rate-limit`           |
| advice      | `kimi acp --login`                   | none                   |
| session     | `failed`                             | `idle`                 |
| hub event   | `engine:unauthenticated`             | none                   |
| `engines()` | `health: dead, authenticated: false` | `health: ready`        |

Two facts make this more than a wording accident.

**The suite knew.** `failureTaxonomy.test.ts` already carried a case named
_"falls back to auth when a rewording drops both fragments"_, documenting this
exact branch as something no hermetic suite could notice. It was accepted as a
field report waiting to happen, and then it happened.

**And the fallback is the worst one available.** When a pattern stops matching,
the failure does not become unclassified — it falls to whichever later pattern
does match, and for an engine that prefixes every refusal with
`Authentication required:` that is always the teardown. Pattern rot fails
toward maximum damage.

## Decision

**1. A pattern is anchored on what repeated measurements share.** 037's rule
was "written from a measured payload"; with one payload in hand that could only
mean fragments of one sentence. Where a second measurement exists, the
declaration is anchored on their intersection, and the payloads are kept in the
suite as a dated table so the next one is a line rather than a rewrite.

For kimi the intersection is informative: the vendor rewrote the description of
the window and left the remediation untouched, so the durable anchors are the
half of the message nobody thinks of as the error text.

```js
match: 'reached your [^.]{0,40}usage limit|quota will (be refreshed|reset)|purchase extra usage|subscription\\?tab=quota';
```

Four anchors, spread across description and remediation. A rewording must break
all four. `[^.]{0,40}` admits a qualifier without letting a match run past the
end of a sentence.

**2. 037's width rule stands and is still enforced.** `usage limit` is never
matched alone, because it also names a _configured_ limit. The case that pins
this — `failed to parse the 'usage limit' setting` must classify as nothing —
was kept, and widening the declaration toward the general still turns it red.

**3. Each anchor gets its own case.** One message per anchor, carrying that
anchor and no other, so a declaration that quietly loses one turns exactly one
case red instead of hiding behind the three that still match.

**4. The teardown _not_ happening is asserted, not just the classification.**
037 promised the session survives, the login stands, no `engine:unauthenticated`
is emitted and the process is not retired. Nothing checked any of it — only that
`classifyEngineFailure` returned the right string. The mirror of the auth
teardown case now runs the whole path through the scripted agent, and it is what
turns red when the pre-fix declaration is restored.

**5. One anchor may not be structural, and that is recorded rather than fixed.**
An engine that reported the HTTP status as data would give a durable oracle.
kimi does not: the frame is `code: -32000` with the `403` inside the prose and no
`data` member. Prose is all there is to match on for this engine, so the
treadmill is mitigated, not escaped.

## Rationale

The alternative was to widen the literal and move on, which is what the fix
looks like from a distance. That would have restored today's behaviour and left
the mechanism exactly as fragile — one vendor edit from the same outcome, still
with no test able to notice, still failing toward a teardown.

Widening toward the general was the other alternative and 037 already rejected
it for a reason that still holds: `usage limit` alone reads a sentence about a
configured limit as a refusal. Misclassifying a dead credential as rate-limit is
not the safe direction either — the user waits for a quota that is not the
problem while a stale login stands.

Multiplying independent anchors is neither. It buys margin proportional to how
much of the message the vendor rewrites at once, and it costs nothing in
precision because every anchor is taken from a payload that was measured.

## Consequences

- A spent kimi quota raises `EngineOperationError` with `kind: 'rate-limit'`,
  and the six behaviours in the table above hold. Verified end to end against a
  genuinely throttled account, not only against a replayed string.
- pi is unchanged. Its `429` pattern has one measured payload and no second one
  to intersect, so widening it would be the guesswork 037 forbids. When a second
  pi throttling is captured, this decision says what to do with it.
- The other three adapters still declare no `rate-limit` pattern. 037's reason
  holds: a plausible regex that never fires, or fires on the wrong message, is
  worse than an absent `kind`.
- The dated payload table is now the place a field report lands. A report that
  arrives with no payload attached cannot be acted on under this decision — the
  wording is the evidence.
