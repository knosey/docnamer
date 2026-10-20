/**
 * The installed artifacts, in one place. `bun run build` (scripts/build-app.ts)
 * installs both: the app bundle, which carries the TCC identity and the compiled
 * binary inside it, and `~/bin/docnamer`, the shell wrapper a person runs.
 *
 * Every flow that is not on a real terminal drives the binary directly. The
 * wrapper resolves its tty with `tty` and refuses without one, so it can only be
 * driven from a pty — tests/wrapper-pty.test.ts is the file that does.
 *
 * `artifactsAt` is here so a test that RUNS a build installs into a folder of its
 * own, by handing `bun run build` a DOCNAMER_APP_HOME of its choosing. Without
 * that, `bun test` would install a build of whatever branch it ran on over the
 * operator's own ~/Applications/docnamer.app, and a test run would be a way to
 * publish unmerged code as the tool on the machine.
 */
export type Artifacts = {
  appDir: string
  appBin: string
  appPlist: string
  wrapper: string
}

/** The four paths scripts/build-app.ts writes under one install root. */
export function artifactsAt(root: string): Artifacts {
  const appDir = `${root}/Applications/docnamer.app`
  return {
    appDir,
    appBin: `${appDir}/Contents/MacOS/docnamer`,
    appPlist: `${appDir}/Contents/Info.plist`,
    wrapper: `${root}/bin/docnamer`
  }
}

/** The install `bun run build` last wrote, which is what a person runs. A
 *  missing HOME throws: defaulting to '' would turn these into /Applications/...
 *  and /bin/docnamer, so a test could pass against a system artifact while the
 *  operator's own install was broken. */
const home = Bun.env.HOME
if (!home) throw new Error('HOME is not set; the installed docnamer cannot be located')
const installed = artifactsAt(home)

export const appBin = installed.appBin
export const appPlist = installed.appPlist
export const wrapper = installed.wrapper
