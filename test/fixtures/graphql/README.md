# GraphQL fixtures

One fixture per operation type / edge case; each carries a `__fixture` marker
(`op`, what it covers, synthetic-or-captured). `expected/` holds the locked
normalizer output for each fixture — regenerate deliberately with
`npm run update-expected` and review the diff; never regenerate to "make
tests pass" without checking the output is actually right.

Everything here is currently **synthetic** (`*.synthetic.json`). Real,
redacted captures replace them via the workflow in
[docs/CAPTURE_FIXTURES.md](../../../docs/CAPTURE_FIXTURES.md); name those
`*.captured.json` and delete the synthetic file they supersede in the same
commit.
