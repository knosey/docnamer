/**
 * The installed artifacts, in one place. `bun run build` (scripts/build-app.ts)
 * installs both: the app bundle, which carries the TCC identity and the compiled
 * binary inside it, and `~/bin/docnamer`, the shell wrapper a person runs.
 *
 * Every flow that is not on a real terminal drives the binary directly. The
 * wrapper resolves its tty with `tty` and refuses without one, so it can only be
 * driven from a pty — tests/wrapper-pty.test.ts is the file that does.
 */
const home = Bun.env.HOME ?? ''

export const appDir = `${home}/Applications/docnamer.app`
export const appBin = `${appDir}/Contents/MacOS/docnamer`
export const appPlist = `${appDir}/Contents/Info.plist`
export const wrapper = `${home}/bin/docnamer`
