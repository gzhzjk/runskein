# Versioning and releases

What a version number here means, what ships under it, and where to look for
what changed.

## One version line

Nine packages are published, and a release is the **same version across all
nine**:

| Package                         |                                              |
| ------------------------------- | -------------------------------------------- |
| `runskein`                      | the meta-package, bundling the five adapters |
| `@runskein/core`                | `Hub`, `Session`, transcripts, the registry  |
| `@runskein/fold`                | turning transcripts into UI state            |
| `@runskein/testkit`             | the scripted agent, for your own tests       |
| `@runskein/adapter-claude-code` | one per engine                               |
| `@runskein/adapter-codex`       |                                              |
| `@runskein/adapter-kimi`        |                                              |
| `@runskein/adapter-opencode`    |                                              |
| `@runskein/adapter-pi`          |                                              |

There is deliberately no compatibility matrix between them. `@runskein/core`
0.1.0 goes with `@runskein/fold` 0.1.0 and nothing else — mixing versions is
neither tested nor supported, and the meta-package pins its adapters to its own
version so that the common case cannot get it wrong.

`packages/cli` and `packages/conformance` are development tools and are not
published. Clone the repository if you want them.

## What the number means

Versions look like `0.1.0`, and both halves carry meaning:

- **`0.x` — pre-1.0.** The v1 _surface_ is frozen and specified in
  [the API specification](engine-adapter-api.md); the implementation of it is a
  preview. While the version stays `0.x`, a release may change behaviour a
  consumer depends on.
- **The last number is the release counter.** It increments by one per release.
  There is no parallel patch line and there are no backports: **the newest
  release is the only supported version.** A fix ships in the next one.

Every version before `0.1.0` was a prerelease — `0.1.0-alpha.25`,
`0.1.0-beta.1` — reachable only under a tag of its own. Those tags still
resolve, and nothing behind them is maintained.

## Installing

`npm install runskein`. No tag: `0.1.1` is published under `latest` on all nine
packages.

Node.js 22 or newer, ESM only.

## Where to see what changed

- **Per release** — the GitHub Release attached to that version's tag. Tags are
  the bare version string, no `v` prefix: `0.1.0`.
- **Changes to the specified surface** — [`docs/decisions/`](decisions/). Every
  change to the frozen v1 surface carries a numbered record saying what was
  decided and why. A release note names the records it ships.
- **What each engine can actually do, as measured** —
  [the capability matrix](capability-matrix.md), regenerated from a probe run
  against real engines. It is a snapshot of the machine that probed; for your
  own machine, `hub.engines()` and `hub.describe()` are the runtime facts.

A tag can appear slightly before its release page: the repository is tagged
before promotion, and the page is attached once the packages are actually on
npmjs.

## How a release reaches this repository

RunSkein is developed in a private repository and exported here, one commit per
release. So the history in this repository is **release-granular, not
change-granular**: you will not find the individual commit that fixed a bug, and
a security fix arrives the same way every other change does — see
[SECURITY.md](../SECURITY.md).

What that means in practice: the tree you see at a tag is exactly what that
release's packages were built from, and `git log` here is a list of releases.
