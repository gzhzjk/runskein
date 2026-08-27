# 007 — Multi-currency costs are not collapsed into one scalar

Date: 2026-08-06 · Status: accepted · Trigger: post-M5 review found that a
cross-engine rebuilt resume could add costs reported in different currencies
and label the result with whichever currency appeared last.

## Decision

- Costs from rebuilt session lives are added only when every reported
  currency agrees.
- If the transcript contains costs in more than one currency, the public
  `UsageSummary` leaves both `cost` and `currency` absent. Token accounting is
  unaffected and remains cumulative.
- The mixed-currency state is retained internally across subsequent
  native/load/rebuilt resumes and detached `attach()` views. A later report in
  one currency must never make the incompatible earlier costs disappear.
- Realm does not perform foreign-exchange conversion. A future API that
  exposes per-currency totals requires an explicit frozen-surface revision.

## Rationale

1. `UsageSummary` has one scalar `cost` and one `currency`; it cannot
   truthfully represent `USD 1 + EUR 1`.
2. Labelling a raw arithmetic sum with the latest currency fabricates money,
   violating D7's requirement that absent accounting fields remain absent.
3. Exchange-rate conversion would require a rate source and timestamp policy,
   neither of which belongs in the engine adapter.

## Consequences

- Same-currency resume chains retain cumulative cost exactly as before.
- Cross-currency chains expose token totals but omit scalar cost fields.
- Consumers needing monetary aggregation across currencies must use their own
  accounting source until a per-currency public representation exists.
