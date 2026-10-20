/**
 * Build docnamer as its own macOS app: compile the binary into
 * <root>/Applications/docnamer.app, write its Info.plist (the TCC identity and
 * the folder-usage descriptions), sign it, and install <root>/bin/docnamer as the
 * shell wrapper a person actually runs. <root> is DOCNAMER_APP_HOME when a test
 * sets it, HOME otherwise.
 */

/**
 * The install root: `DOCNAMER_APP_HOME` when a test isolates its build, the real
 * HOME otherwise. tests/app-binary.ts reads the same variable through
 * `artifactsAt`, so a build and the assertions about that build agree on one
 * folder. Without it, `bun test` would install a build of whatever branch it ran
 * on over the operator's own ~/Applications/docnamer.app.
 */
const home = Bun.env.DOCNAMER_APP_HOME ? Bun.env.DOCNAMER_APP_HOME : Bun.env.HOME
if (!home)
  throw new Error('neither DOCNAMER_APP_HOME nor HOME is set; cannot locate the install root')

const app = `${home}/Applications/docnamer.app`
const macos = `${app}/Contents/MacOS`
const wrapper = `${home}/bin/docnamer`

/** Run `cmd`, throwing its output when it fails. */
const run = (cmd: string[]): void => {
  const p = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) {
    throw new Error(`\`${cmd.join(' ')}\` exited ${p.exitCode}:\n${p.stderr.toString()}`)
  }
}

// 1. Compile the binary into the bundle.
run(['mkdir', '-p', macos, `${home}/bin`])
run(['bun', 'build', '--compile', '--outfile', `${macos}/docnamer`, 'src/cli.ts'])

// 2. The Info.plist is the TCC identity: folder prompts name this bundle.
await Bun.write(
  `${app}/Contents/Info.plist`,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>com.tom.docnamer</string>
	<key>CFBundleName</key>
	<string>docnamer</string>
	<key>CFBundleExecutable</key>
	<string>docnamer</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>LSUIElement</key>
	<true/>
	<key>NSDesktopFolderUsageDescription</key>
	<string>docnamer renames files in your Desktop folder.</string>
	<key>NSDocumentsFolderUsageDescription</key>
	<string>docnamer renames files in your Documents folder.</string>
	<key>NSDownloadsFolderUsageDescription</key>
	<string>docnamer renames files in your Downloads folder.</string>
	<key>NSRemovableVolumesUsageDescription</key>
	<string>docnamer renames files on removable volumes.</string>
</dict>
</plist>
`
)

// 3. Sign: a real identity when the keychain has one, ad-hoc otherwise.
const identities = Bun.spawnSync(['security', 'find-identity', '-v', '-p', 'codesigning'], {
  stdout: 'pipe',
  stderr: 'pipe'
})
const identity = identities.stdout.toString().match(/\)\s+[0-9A-F]{40}\s+"([^"]+)"/)?.[1]
run(
  identity
    ? ['codesign', '--force', '--sign', identity, app]
    : ['codesign', '--force', '--sign', '-', app]
)

// 4. The wrapper, which exists because `open -n -W` always exits 0 and because
//    the app's real code has to come back some other way: the exit file. Raw mode
//    is the shell's job — /dev/tty needs a controlling terminal and the wrapper
//    has none, so stty runs on stdin, which `tty` has already resolved to the
//    device the app is handed. LaunchServices starts the app in "/", so the
//    caller's directory is carried across as `$PWD` (measured: `open -n`ing a
//    probe app prints "/" whatever the shell's cwd is).
//    The exit file decides the exit code, and `open`'s own code is only the
//    fallback for when the app never wrote one: `open -W` also fails when it
//    loses the race to block on an app that has already exited — measured, run 7
//    of 12 of `--version` — and taking its 1 there reported a finished run as
//    failed. 1 means "accepted, then failed"; only a missing file means that.
await Bun.write(
  wrapper,
  `#!/bin/sh
APP="${app}"
TTY=$(tty) || exit 1
EXIT_FILE=$(mktemp /tmp/docnamer-exit.XXXXXX)
SAVED=$(stty -g)
stty raw -echo
COLS=$(tput cols); ROWS=$(tput lines)
/usr/bin/open -n -W "$APP" --args --tty "$TTY" --cols "$COLS" --rows "$ROWS" --exit-file "$EXIT_FILE" --cwd "$PWD" "$@"
OPEN_CODE=$?
stty "$SAVED"
CODE=$(cat "$EXIT_FILE" 2>/dev/null)
rm -f "$EXIT_FILE"
if [ -n "$CODE" ]; then exit "$CODE"; fi
if [ $OPEN_CODE -ne 0 ]; then exit $OPEN_CODE; fi
exit 1
`
)
run(['chmod', '+x', wrapper])

console.log(`built ${app} (${identity ?? 'ad-hoc'}) and installed ${wrapper}`)
