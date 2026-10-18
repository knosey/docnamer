# Holes — manual checks the suite cannot cover

## mac-ocr manual smoke (R5)

`mac-ocr` is a project dependency (`bun add mac-ocr`), resolved by the CLI from
`node_modules` and never from a global install. The compiled binary carries the
embedded copy, pinned by sha256
(`1817fff474a88706104167f8f47983ecea93a3b41cd10fa6b8585c026ffd7668`, `--version` → `1.2.1`).

Manual smoke (recorded, not automated — a first-run `bun add mac-ocr` hits the
network, which no test may do):

1. `bun add mac-ocr`
2. `shasum -a 256 node_modules/mac-ocr/bin/mac-ocr` → the pin above.
3. `node_modules/mac-ocr/bin/mac-ocr --version` → `1.2.1`.
4. `node_modules/mac-ocr/bin/mac-ocr tests/fixtures/acme-statement-scan.pdf --format json`
   exits 0 and prints per-page observations with confidence.

## Machine-dependent behaviours

- Finder tag/comment round-trips and `mdls` attribute reads depend on
  Spotlight indexing state of the test folder; they are verified in
  `tests/spotlight.test.ts` against `tests/fixtures` and otherwise observed by
  hand on a real folder.
