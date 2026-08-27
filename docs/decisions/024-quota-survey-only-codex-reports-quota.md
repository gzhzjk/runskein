# 024 — Quota survey: only codex reports quota; keep `TurnResult.quota` an opaque passthrough

Date: 2026-08-08 · Status: **accepted** · Case: ST-QUOTA-01 (AC-5.2) ·
Evidence: `docs/conformance/st-quota-01.json`

## What was measured

One cheap turn per engine, captured at the **connection** level rather than
through the Hub: `TurnResult` has no `quota` or `_meta` field today, so the
public surface cannot show what this survey exists to find, and the raw
JSON-RPC result is also the honest oracle for AC-5.1's later "verbatim" claim.
`_meta` was captured on the initialize result, the `session/new` result, the
`session/prompt` result, and every streamed update.

| engine      | prompt `_meta`   | quota reported         | other headroom signal                                |
| ----------- | ---------------- | ---------------------- | ---------------------------------------------------- |
| codex       | `{ quota: {…} }` | **yes** — the only one | `usage_update` `{used, size}` (context window)       |
| opencode    | `{}` (empty)     | no                     | `usage_update` `{used, size, cost{amount,currency}}` |
| kimi        | absent           | no                     | none                                                 |
| claude-code | absent           | no                     | none                                                 |

codex's shape, verbatim:

```json
{ "quota": { "token_count": { "totalTokens": 18438, "inputTokens": 7425,
    "cachedInputTokens": 11008, "outputTokens": 5, "reasoningOutputTokens": 0 },
  "model_usage": [ { "model": "gpt-5.6-sol", "token_count": { … } } ] } }
```

codex also carries `_meta` on `session_info_update` and `agent_message_chunk`
updates, and both codex and opencode emit `usage_update`.

## Decision

1. **`TurnResult.quota?: { engineId, payload: unknown }` ships as designed —
   opaque passthrough, no cross-engine vocabulary.** One reporter out of four
   is nowhere near enough to generalize from, and codex's own shape is
   demonstrably codex-flavoured (`model_usage[]`, `cachedInputTokens`,
   `reasoningOutputTokens`). Typing realm's field to codex's structure would
   bake one engine's accounting into the API and break the moment a second
   engine reports something differently shaped.
2. **The field stays absent on the three non-reporters — never synthesized.**
   In particular it must **not** be back-filled from `usage_update`: that is
   context-window and cost accounting, which realm already owns as `Usage`.
   Conflating "how full is this conversation" with "how much account allowance
   is left" would produce a confidently wrong budget signal, which is worse for
   an unattended host than an absent one.
3. **Naming is deliberate.** What codex reports under `quota` is a _token
   count for this turn_, not a remaining allowance: no reset time, no ceiling,
   no balance. Passing it through under an engine-scoped key is honest; naming
   any realm-level concept "remaining quota" on this evidence would not be.
   L2 may derive a budget from it; L1 states only who said what.

## What this does not settle

No engine reported a **limit, reset window, or balance** — the signals an L2
budget gate would actually throttle on. If ACP later standardizes a quota
notification, or codex starts reporting headroom rather than consumption, the
survey should be rerun before any firmer type is considered. Until then the
passthrough is the whole of §2.5.

## Re-run

`pnpm --filter @runskein/conformance st:quota [engineId ...]` — cheap (one
short turn per engine); rerun on engine version bumps.
