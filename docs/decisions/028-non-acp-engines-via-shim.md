# 028 - Non-ACP engines are driven by a shim, which may import the ACP SDK

Date: 2026-08-18 · Status: **accepted**, implementation pending · Cases:
PI-SH-01…20, PI-AD-01, PI-AD-02 · Informs:
the pi shim's own design and test plan
§4, §5

## Context

`EngineAdapter.shim?: string` has been declared in `packages/core/src/types.ts`
and validated in `registry.ts` since M4, but never implemented: all four
bundled engines ship their own ACP server, so nothing exercised the adapter
spec's escape hatch for an engine that speaks no ACP. `pi` (`@earendil-works/pi-coding-agent`) does not speak ACP —
it exposes its own JSONL RPC protocol on stdio — and is the first engine that
requires it.

## Decision

**1. The shim mechanism becomes live.** `spawnEngine` honours
`adapter.shim`: it resolves the entry point against the adapter's own
directory (an absolute path that escapes it is a load error, surfacing as
`health: 'invalid'`, not a spawn-time surprise), spawns
`process.execPath <shimPath> <launch.command> <…launch.args>`, and applies the
unchanged env rules — core's scrub first, `adapter.launch.env` after, so the
shim and every engine child it spawns inherit a clean environment.

**2. The shim is the process realm owns.** The ownership-registry `argv0`
becomes `` `${shimPath} ${launch.command} ${(launch.args ?? []).join(' ')}` ``,
which stays a substring match against the real command line (decision 015) and
is specific enough not to match unrelated `node` processes. Engine children
are spawned by the shim without `detached`, so they remain in the shim's
process group and the existing sweep reaps them with no new mechanism.
`supervise` composes with `shim` by wrapping the shim, not the engine.

**3. Shim-declared capabilities are measured facts.** A shim answers
`initialize` as the agent, so the probe records what it declares exactly as it
records a vendor engine's declaration. A shim may not claim a capability it
does not implement; §5.5 of the pi design requires its `initialize` result to
be derived from a live probe of the underlying engine rather than hard-coded.

**4. The SDK-import rule is narrowed, not weakened.** It previously read:
_only `packages/core/src/acp/` may import `@agentclientprotocol/sdk`_. It now
reads:

> No code a consumer can reach may import `@agentclientprotocol/sdk` —
> `packages/core/src/**` outside `acp/`, `packages/cli`, and the public
> meta-package. Shim entry points (`adapters/*/shim.mjs`) may, because a shim
> is the far side of the wire, not consumer surface.

The merge check becomes a grep for SDK imports outside `core/src/acp/` **and**
`adapters/*/shim.mjs`, instead of outside `core/src/acp/` alone.

## Rationale

The rule exists to keep P1 honest: ACP is realm's internal spine and is never
exposed to consumers, whose public types are realm-owned structural mirrors.
A shim is not part of that surface. It plays exactly the role
`@zed-industries/claude-code-acp` and `@agentclientprotocol/codex-acp` play
for two of the bundled engines — a vendor-side translator that happens, in
pi's case, to be written by us because upstream ships none.

Forbidding the SDK there would not protect the boundary; it would only force a
hand-written JSON-RPC agent implementation inside the repo, re-deriving schema
details the SDK already tracks and drifting the day ACP moves. The SDK's
`AgentSideConnection` plus the `Agent` interface is precisely the shim's
required surface.

`shim.mjs` is spawned, never imported by discovery, so carrying a runtime
dependency does not violate the adapter rule that discovery-imported code is
plain, build-free ESM — that rule binds `index.mjs`. `adapters/pi` therefore
becomes the first adapter with a real (non-dev) dependency.

## Consequences

- Core gains one branch in `spawnEngine` and no engine-specific knowledge; a
  grep for `pi` in `packages/core` must stay empty.
- `hub.describe()` reports the shim's `agentInfo`, which must name both the
  engine version and the shim version so drift is attributable.
- A shim introduces a failure mode no bundled engine has: the engine process
  and the session's process can differ. Per-session child death must **not**
  be reported as `EngineCrashError` (which carries engine-restart semantics);
  see the pi shim's own design. Whether that deserves its own public error type is
  deferred until a second shim-based engine exists — inventing one for a
  single engine's process model is exactly the engine-specific leak the adapter
  spec forbids.
- CLAUDE.md and AGENTS.md carry the narrowed wording.
