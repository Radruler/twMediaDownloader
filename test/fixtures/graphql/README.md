# GraphQL fixtures

One fixture per operation type / edge case; each carries a `__fixture` marker
(`op`, what it covers, synthetic-or-captured). `expected/` holds the locked
normalizer output for each fixture — regenerate deliberately with
`npm run update-expected` and review the diff; never regenerate to "make
tests pass" without checking the output is actually right.

`*.captured.json` are **real** payloads (owner-captured 2026-07-07, cursor
values redacted); `*.synthetic.json` are hand-written. New captures arrive
via the workflow in
[docs/CAPTURE_FIXTURES.md](../../../docs/CAPTURE_FIXTURES.md). A synthetic
fixture is deleted once real captures cover everything it covers — the ones
still here each guard a shape the real set lacks (tombstone-in-thread,
TweetWithVisibilityResults, sensitive flag, `timeline_v2` envelope,
TimelineAddToModule, SearchTimeline/HomeTimeline/TweetResultByRestId
envelopes); see each file's `__fixture.covers`.
