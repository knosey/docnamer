// The guard the I4 flow's `score` step rests on: every metric is read off its own
// line and the accuracy the report prints is recomputed from the misses it prints
// beside it. The report below is the real renderer's shape (src/eval.ts) over the
// real tests/testset truth, so this pins the parser without paying for a run.

import { test, expect } from 'bun:test'
import { Session, repo, score } from './doc-renamer-apply-harness.ts'

/** One report, exactly as formatEvalReport renders it: 8 graded files, one miss. */
const REPORT = [
  'eval report: 8 file(s)',
  'type accuracy:   87.5%',
  'full name match: 87.5%',
  'vision share:    25.0%',
  'time per file:   1.23s',
  'cost per file:   $0.0000',
  'field exact match:',
  '  date: 100.0%',
  '  bank: 100.0%',
  'misses (1):',
  '  letter.docx',
  '    expected: receipt | 2024-01-21 Initech letter Letter of engagement.docx',
  '    got:      letter | 2024-01-21 Initech letter Letter of engagement.docx',
  '    evidence: type: expected receipt, got letter — evidence: date=2024-01-21'
].join('\n')

function session(report: string): Session {
  const s = new Session()
  s.testset = `${repo}/tests/testset`
  s.last = { code: 0, stdout: report, stderr: '' }
  return s
}

test('score accepts a report whose numbers agree with the misses it prints', async () => {
  await expect(score(session(REPORT))).resolves.toBeInstanceOf(Session)
})

test('score refuses an accuracy that contradicts the miss block beside it', async () => {
  const lie = REPORT.replace('type accuracy:   87.5%', 'type accuracy:   100.0%')
  expect(lie).not.toBe(REPORT)
  await expect(score(session(lie))).rejects.toThrow(/100% type accuracy, but 1 of 8 typed/)
})

test('score refuses a miss count that is not the number of misses shown', async () => {
  const miscounted = REPORT.replace('misses (1):', 'misses (2):')
  await expect(score(session(miscounted))).rejects.toThrow(/announces 2 miss\(es\) and shows 1/)
})

test('score refuses a file count that is not the set it grades', async () => {
  const wrong = REPORT.replace('eval report: 8 file(s)', 'eval report: 7 file(s)')
  await expect(score(session(wrong))).rejects.toThrow(/scored 7 file\(s\); .* grades 8/)
})

test('score refuses a metric line that is missing, and names it', async () => {
  const missing = REPORT.replace('cost per file:   $0.0000\n', '')
  await expect(score(session(missing))).rejects.toThrow(/"cost per file:" line/)
  await expect(score(session(''))).rejects.toThrow(/"eval report:" line/)
})

test('score refuses a duration that is no measurement and a cost nothing computes', async () => {
  const stalled = REPORT.replace('time per file:   1.23s', 'time per file:   0.00s')
  await expect(score(session(stalled))).rejects.toThrow(/time per file is 0s/)
  const priced = REPORT.replace('$0.0000', '$0.1234')
  await expect(score(session(priced))).rejects.toThrow(/cost per file is \$0.1234/)
})
