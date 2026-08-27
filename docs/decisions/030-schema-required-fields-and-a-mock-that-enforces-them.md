# 030 - schema-required fields are unconditional, and the mock enforces what engines enforce

Date: 2026-08-21 · Status: **accepted** · Cases: resume.test.ts tier-3 (3
cases), RS-06 live on codex and claude-code · Informs: the
configuration-discovery capability table

## Context

RS-06 failed live on codex 0.148.0 and claude-code 2.1.238 with
`session/resume failed: Invalid params`. The message named the chain rather
than the request — realm's resume chain tries three tiers and reports only the
last one's error — so the case now captures the wire on failure. The frames
were unambiguous:

```
out session/resume  → -32603 no rollout found for thread id …   (degrade)
out session/load    → -32603 no rollout found for thread id …   (degrade)
out session/new     {"cwd":"…"}                                  ← no mcpServers
in                  ← -32602 mcpServers: "Required value is missing"
```

Both engines were right to refuse. The ACP schema makes `mcpServers` required
on `session/new`. realm's normal creation path sent `mcpServers: opts.mcpServers
?? []`; the rebuilt resume tier spread it conditionally and omitted the key
whenever a session had no MCP servers, which is most sessions.
`AcpConnection.newSession` defaults the field, but this path goes through
`Hub.createNativeSession`, which issues a rawRequest and passes params through
untouched.

So the tier whose entire promise is "every engine resumes" was the one shipping
a request strict engines reject — and only after a crash, the exact case where
native and load are unavailable and the rebuild is all that is left.

## Decision

**1. A field the schema marks required is sent unconditionally.** Not spread on
a truthiness check, not left to a lower layer's default. Where a request is
built by hand for `rawRequest`, the caller owns completeness.

**2. The mock agent enforces what a strict engine enforces.** It accepted
`params.mcpServers ?? []`, which is why no hermetic case caught this. It now
answers -32602 for a `session/new` without the key, in the same shape codex
sends. That change alone failed three tier-3 cases before the fix.

## Rationale

The defect survived because two forgiving layers lined up: a connection helper
that defaults the field for callers that use it, and a fixture that tolerates
its absence. Neither is wrong alone. Together they meant realm could only
discover the problem from an engine that enforces the schema, on the one path
that runs after a crash.

A mock that is more permissive than the engines it stands in for does not
merely miss defects — it certifies them. Making the fixture strict costs
nothing per run and converts a class of protocol drift from a live-only
discovery into a hermetic failure.

## Consequences

- Tier-3 resume works against strict engines. Verified live: codex 6/6 and
  claude-code 6/6, both previously failing RS-06.
- RS-06 logs the wire frames when a resume fails, so the next failure of this
  kind names the request instead of the chain.
- The hermetic gate now catches a missing `mcpServers` on `session/new`. Other
  schema-required fields are not yet enforced by the fixture; adding one is
  cheap and belongs with whatever defect motivates it.
