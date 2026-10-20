/**
 * Device IO: the one place the app touches a terminal it did not inherit.
 *
 * A LaunchServices-launched binary has no controlling tty, so the wrapper hands
 * the app a device path, a size and a file for its exit code. All device bytes
 * move through `Bun.file(path).writer()` and `Bun.file(path).stream()` — never
 * a node: stream, because the compiled binary carries no node: built-ins.
 */

export type DeviceArgs = {
  tty: string | null
  cols: number | null
  rows: number | null
  exitFile: string | null
  /**
   * The directory the person was standing in when they typed the command. A
   * LaunchServices launch starts the app in "/", so a relative folder argument
   * (`.` , `sub`) means the root volume unless the shell that ran the wrapper
   * says otherwise. Absolute arguments are unaffected either way.
   */
  cwd: string | null
}

/** Read --tty, --cols, --rows, --exit-file and --cwd out of argv. */
export const parseDeviceArgs = (argv: string[]): DeviceArgs => {
  const args: DeviceArgs = { tty: null, cols: null, rows: null, exitFile: null, cwd: null }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1]
    if (value === undefined) continue
    if (argv[i] === '--tty') args.tty = value
    else if (argv[i] === '--cols') args.cols = Number(value)
    else if (argv[i] === '--rows') args.rows = Number(value)
    else if (argv[i] === '--exit-file') args.exitFile = value
    else if (argv[i] === '--cwd') args.cwd = value
  }
  return args
}

/** The byte sink for everything the app writes to the terminal. */
export const deviceWriter = (path: string) => Bun.file(path).writer()

/** The byte source for everything the app reads from the terminal. */
export const deviceReader = (path: string): ReadableStream<Uint8Array> =>
  Bun.file(path).stream() as ReadableStream<Uint8Array>
