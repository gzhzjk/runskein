# Decision records

Numbered, append-only records of contract-level decisions. Rules:

- Numbers are three digits, assigned sequentially, never reused.
- A record lands when the decision is accepted; the code and the frozen
  contract (`docs/engine-adapter-api.md`) must agree with it in the same
  change.
- Filenames are `<number>-<short-kebab-title>.md`; the title inside must match.

## The one edit an accepted record accepts

Append-only means the _decision_ is append-only: a decision that turns out
wrong is corrected by writing the next record, never by editing the one that
was made. It does not mean the file's bytes are frozen, and treating it that
way has a cost — a record whose only pointer to its own context is a path that
no longer resolves has lost the context, not preserved it.

So exactly one class of edit is allowed on an accepted record:
**keeping a reference reachable, and removing external context that no longer
is.** A moved document may be re-pointed; a reference to a document a reader
cannot open may be replaced by a self-contained statement of what it said.

What that permission does not cover, ever: the decision, its rationale, its
consequences, its status, or its date. If an edit changes what was decided or
why, it is a new record — no matter how small it looks.

This exists because some documents these records were written against are not
part of this repository. Rather than send a reader to a file that is not there,
those references were made self-contained. Durable identifiers were kept —
acceptance-criteria ids like `AC-2.1` and case ids like `ST-DIG-03` appear in
the test suite, so they still resolve to something.

## Gaps in the numbering

Some numbers are absent. That is expected, and none of them will be reused:

- **010, 038 and 041** are not part of this repository: they record internal
  project matters — how this project is run rather than what it promises.
  Nothing here cites any of them.
- **017–021** were reserved for work that never landed under those numbers.
  Nothing references them. Do not reassign them.

## Records written before the rename

Eight records — 002, 011, 012, 013, 015, 027, 029 and 036 — name the product
`realm-node` and its packages `@realm-node/*`. Those are the earlier names of
what is published today as `runskein` and `@runskein/*`; 039 states the rename
and is what the shipped migration code cites.

They are left exactly as written. A record is append-only, and rewriting one to
match today's names would falsify the record of what was decided when.
