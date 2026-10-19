import { expect, test } from 'bun:test'
import { closedFolder, reopen, resolveCli, shell } from './doc-renamer-apply-harness.ts'

/**
 * What a folder docnamer may not read reports.
 *
 * `docnamer plan .` in a fresh macOS `~/Downloads` is the first thing a person
 * hits: Downloads, Desktop and Documents are protected, the terminal running
 * the program is not on the list, and the listing comes back EPERM. docnamer
 * cannot lift that and must not try — but it is the only party in the exchange
 * that knows what it was doing and what the reader can do about it, so the
 * failure has to say both. A bare errno says neither:
 *
 *   docnamer: EACCES: permission denied, open '/tmp/dn-perm/closed'
 *
 * `plan` is the one command that lists the folder itself, so it is the one that
 * meets this refusal; `review`, `apply` and `undo` fail earlier on a missing
 * plan or undo file, and a file inside a readable folder that cannot be read is
 * a flagged row, not a failed run. This test drives the installed binary, so
 * what it asserts is what a person gets.
 *
 * The terminal's half — a spinner frame the error was glued onto, because `stop`
 * ran only when the work returned — is tests/pty.test.ts's, since a pipe has no
 * line to return to and never shows it.
 */
test('a folder that cannot be read is named, with a way forward', async () => {
  const cli = await resolveCli()
  if (cli === null) {
    throw new Error('no docnamer CLI to drive — build it or set DOCNAMER_BIN')
  }
  const closed = await closedFolder()
  try {
    const r = await shell([...cli, 'plan', closed])
    expect(r.code, 'a refused read is a failed run: 1, not the refusal code 2').toBe(1)
    expect(r.stderr, 'the failure must name the folder it could not read').toContain(closed)
    expect(
      r.stderr,
      'the failure must offer a way forward; a bare errno leaves the reader with nothing to do'
    ).toContain('help:')
    expect(r.stdout, 'nothing was planned, so no plan is announced').not.toContain('plan written')
  } finally {
    await reopen(closed)
  }
})
