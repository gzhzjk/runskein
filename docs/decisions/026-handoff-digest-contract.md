# 026 - Handoff digest contract

Date: 2026-08-14 · Status: **accepted** · Cases: ST-DIG-01, ST-DIG-02,
ST-DIG-03, ST-DIG-04, ST-DIG-06

## Decision

1. `digest(sessionId, opts?)` adds `format`, `maxTokens`, and `truncation`
   without changing the no-options text/tail return type used by resume.
   `format: 'structured'` returns `StructuredDigest`; it contains chronological
   same-role `DigestSegment`s, their inclusive sequence ranges, every dropped
   sequence range, and the final text's deterministic token estimate.
2. `renderStructuredDigest()` is the canonical presentation bridge. Given the
   same truncation options, it adds role prefixes, tool labels, separators, and
   one marker to reproduce text-format output. Segment text deliberately has no
   role prefix, so raw concatenation is not an equivalent renderer.
3. The estimator is exactly `ceil(UTF-8 byte length / 4)`. New bounded paths
   use `min(maxChars, maxTokens * 4)` as one UTF-8 byte budget. `head-tail`
   reserves the marker first, divides the remaining capacity evenly, and gives
   the odd byte to the tail.
4. New bounded paths select whole extracted content runs, preserving valid text
   and grapheme boundaries. A marker is truncated to the largest valid prefix
   when it alone cannot fit. Tail uses the historical `earlier context` marker;
   head and head-tail identify later and middle omissions respectively.
5. The compatibility path is the no-new-options text digest, including an
   existing `maxChars` call; its legacy character-count interpretation is
   retained for resume compatibility. It preserves the frozen corpus
   byte-for-byte except two corrected defects: a too-small marker no longer
   overflows its budget, and cuts no longer leave lone UTF-16 surrogates. The
   default remains tail-biased so resume behavior is unchanged.

## Consequences

Structured handoff is faithful extraction, not model-authored summarization.
It costs no model tokens and leaves selection/composition policy to the caller.
The frozen golden corpus is a regression oracle and must never be regenerated
from the implementation under test.
