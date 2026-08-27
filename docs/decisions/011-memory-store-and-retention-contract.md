# 011 — `memoryStore()` becomes public surface; retention stays the host's job

Date: 2026-08-08 · Status: **accepted** · Trigger: stabilization
requirements AC-10.1 / AC-10.2 / AC-10.3. Two related gaps: persistence could not be
switched off without writing a store by hand, and the deliberate absence of
retention was discoverable only from disk usage.

## Decision

- `memoryStore()` is added to the public surface of `@realm-node/core` and
  re-exported from `realm-node`, alongside `jsonlStore` and `sqliteStore`. It
  takes no arguments and returns an ordinary `TranscriptStore`; each call owns
  an independent set of events. It is also exported from
  `@realm-node/core/internal`, like its two siblings, so the conformance suites
  can hold all three to the same `storeSuite`.
- Its semantics are fixed as: unbounded (no cap, no eviction, no compaction),
  lost on process exit, and `sessions()` costing one pass over everything the
  instance holds. `TranscriptStore` gains no new members and no other store
  changes behaviour.
- **No store retains, expires, rotates, or caps anything, and none will by
  default.** `docs/engine-adapter-api.md` §6.1 states this as a contract along
  with its consequence (unbounded growth for a long-running host) and how a
  host implements retention itself.

## Rationale

Persistence is not optional in the way consumers assume. The local store is
authoritative for `hub.sessions()` and for the resume chain, so omitting
`store` does not mean "keep nothing" — it means `jsonlStore('.transcripts')`
writing into the current working directory. Hosts that genuinely want no
durable transcript (tests, embedded hosts, short-lived bridges) were therefore
pushed into hand-writing the contract, even though a correct implementation had
existed for some time as the conformance suite's third-party fixture. Promoting
that fixture costs nothing and removes the footgun.

The default stays unbounded on purpose. A silent cap is the same class of
defect as automatic retention: both drop events that the resume chain later
needs, and the damage surfaces as an engine appearing to forget a conversation,
arbitrarily far from the eviction that caused it. Given the choice between
losing resume silently and growing until the host notices, growth is the
failure a host can see and act on. That makes retention a policy decision with
a token and correctness cost, which puts it above this layer — the same
boundary that keeps budgets and arbitration out.

## Consequences

- **Promotion must not cannibalise the third-party-store check.** That fixture
  existed to prove the contract is implementable from _outside_ the package, and
  a store shipped _inside_ core cannot prove that. Pointing the store suite at
  the exported `memoryStore()` in place of the fixture would therefore trade one
  guarantee for another rather than adding one. The suite must run both: the
  exported store, for the three-way parity this note's AC asks for, and a
  distinct minimal store defined in test code, for the external-implementability
  guarantee that predates it.
- `memoryStore()` is public and therefore subject to this document's freeze
  rules; changing its semantics (adding a bound, adding eviction) needs a new
  note. A bounded variant, if ever wanted, is a _separate_ named export, never
  a default that quietly starts dropping events.
- A host on `memoryStore()` cannot resume a session in a later process. This is
  the point of the store, not a limitation to work around, and it is stated in
  the API doc rather than left to be discovered.
- **Deletion is reachable only through the store object.** `hub.transcripts` is
  documented and implemented as read-only (`get` / `digest` / `export`), so a
  host that wants to expire transcripts must construct its own store and keep
  the reference; there is no `hub.transcripts.delete`. The stabilization chapter
  §2.9 and §2.10 both refer to "`transcript.delete()`" as though it were a Hub
  method — it is not, and this note does not add one. Whether the Hub should
  gain an explicit deletion verb is a surface question left open here
  deliberately; it would need its own note, and §2.9's discard design (which
  relies on local transcript deletion staying separate from engine-side delete)
  should be settled together with it rather than piecemeal.
