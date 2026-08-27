# Security

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability
reporting on this repository — the **Security** tab, then **Report a
vulnerability**. That opens a private thread visible only to the maintainers.

Say what you found, how to reproduce it, and what an attacker gets. A rough
report sent privately is worth more than a polished one sent publicly.

Expect an acknowledgement within a week. If a fix is warranted it ships in a
normal release, and the release note says what changed and credits you unless
you ask otherwise.

RunSkein is developed in a private repository and exported here, so a fix
appears in this repository as part of the next release rather than as an
individual commit. That is the normal shape of every change here, not something
done to obscure a security fix.

## What is in scope

RunSkein runs coding-agent engines as child processes and stores their
transcripts. The parts worth looking at:

- **Process handling** — argument and environment construction, the ownership
  registry, the orphan sweep. Anything that lets one session reach another's
  process, or that leaves a process running after its session ends.
- **Transcript storage** — the local SQLite store and the files beside it.
  Anything that lets a session read or overwrite another session's transcript.
- **Permission handling** — the policies a consumer sets are the only thing
  between an engine and the file system. A path by which a request is applied
  without the policy seeing it, or is reported as denied while it ran, is a
  vulnerability.
- **Adapter discovery** — adapters are loaded from `node_modules` by a marker
  in their `package.json`. Anything that loads code the consumer did not
  install.
- **Credential handling** — engine authentication is the engine's own, and
  runskein should never read, log, or persist it. Finding it in a transcript, a
  log line, or an error message is a vulnerability.

## What is out of scope

- **The engines themselves.** opencode, kimi, Claude Code, codex and pi are
  separate projects; report an engine's own defect to that project. What is in
  scope is runskein mishandling what an engine does.
- **What an engine is permitted to do.** An engine that edits a file the
  consumer's permission policy allowed is working as designed. Configure a
  narrower policy.
- **Anything requiring an attacker who already runs code as the same user.**
  runskein offers no protection there and does not claim to.

## What runskein does not defend against

Stated plainly, because a security policy that implies more than the software
delivers is worse than none:

- **Engine output is not sanitised.** A transcript holds whatever the engine
  emitted. A consumer that renders it is responsible for escaping it.
- **The transcript store is a local file with the file system's permissions.**
  It is not encrypted, and anything the engine saw may be in it.
- **Nothing is sandboxed.** An engine runs with the privileges of the process
  that started it.
