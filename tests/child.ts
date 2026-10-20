// One owner for spawning a command in a test. `p.exited` awaited bare has no
// bound: a hung model call hangs the file until bun's own ceiling, which names
// no cause, and the child outlives the test.

/** The budget a spawned command gets when its caller does not name one. */
const CHILD_TIMEOUT_MS = 120_000

/** How long a child that overran its budget is given to answer SIGTERM. */
const GRACE_MS = 5000

export type ChildRun = { code: number; stdout: string; stderr: string }

type ChildOptions = {
  cwd?: string
  env?: Record<string, string>
  /** Written to the child's stdin, which is then closed. */
  input?: string
  timeoutMs?: number
}

type Streams = [string, string, number]

type Spawned = Bun.Subprocess<'ignore' | 'pipe', 'pipe', 'pipe'>

async function feed(sink: Spawned['stdin'], input: string): Promise<void> {
  if (sink === undefined) throw new Error('runChild: the child gave no stdin sink')
  await sink.write(input)
  await sink.end()
}

/** The child's stdout, stderr and exit code — or a SIGTERM at the deadline.
 *  SIGTERM, never SIGKILL: the child must reach its own close. */
async function bounded(p: Spawned, ms: number, label: string): Promise<Streams> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>(resolve => {
    timer = setTimeout(() => resolve('deadline'), ms)
  })
  const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  const first = await Promise.race([done, deadline])
  if (first !== 'deadline') {
    clearTimeout(timer)
    return first
  }
  p.kill('SIGTERM')
  const grace = new Promise<'killed'>(resolve => setTimeout(() => resolve('killed'), GRACE_MS))
  const ended = await Promise.race([done, grace])
  if (ended === 'killed') {
    throw new Error(`runChild: ${label} ignored SIGTERM after ${ms}ms`)
  }
  const [, , code] = ended
  throw new Error(`runChild: ${label} overran ${ms}ms (exited ${code} on SIGTERM)`)
}

/** Run a command and read it whole, with a deadline. A child that outlives the
 *  deadline is SIGTERMed and the throw names the command and the budget it
 *  overran, instead of bun's generic test timeout. */
export async function runChild(argv: string[], opts: ChildOptions = {}): Promise<ChildRun> {
  const p = Bun.spawn(argv, {
    stdin: opts.input === undefined ? 'ignore' : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: opts.cwd,
    env: opts.env
  })
  if (opts.input !== undefined) await feed(p.stdin, opts.input)
  const [stdout, stderr, code] = await bounded(
    p,
    opts.timeoutMs ?? CHILD_TIMEOUT_MS,
    argv.join(' ')
  )
  return { code, stdout, stderr }
}
