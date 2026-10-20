/**
 * Build docnamer as its own macOS app: compile the binary into
 * ~/Applications/docnamer.app, write its Info.plist (the TCC identity and the
 * folder-usage descriptions), sign it — ad-hoc, or with a real codesigning
 * identity when one exists — and install ~/bin/docnamer as the shell wrapper a
 * person actually runs.
 */

const home = Bun.env.HOME
if (!home) throw new Error('HOME is not set; cannot locate ~/Applications and ~/bin')

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

// 4. The wrapper: `open -n -W` always exits 0, so the tty is set raw by the
//    shell, restored after, and the app's real exit code comes back through
//    the exit file (default 1 when the app never wrote one). stty runs on
//    stdin, which `tty` has already resolved to the device the app is handed:
//    /dev/tty needs a controlling terminal and the wrapper has none.
await Bun.write(
  wrapper,
  `#!/bin/sh
APP="${app}"
TTY=$(tty) || exit 1
EXIT_FILE=$(mktemp /tmp/docnamer-exit.XXXXXX)
SAVED=$(stty -g)
stty raw -echo
COLS=$(tput cols); ROWS=$(tput lines)
/usr/bin/open -n -W "$APP" --args --tty "$TTY" --cols "$COLS" --rows "$ROWS" --exit-file "$EXIT_FILE" "$@"
OPEN_CODE=$?
stty "$SAVED"
if [ $OPEN_CODE -ne 0 ]; then rm -f "$EXIT_FILE"; exit $OPEN_CODE; fi
CODE=$(cat "$EXIT_FILE" 2>/dev/null)
rm -f "$EXIT_FILE"
exit "\${CODE:-1}"
`
)
run(['chmod', '+x', wrapper])

console.log(`built ${app} (${identity ?? 'ad-hoc'}) and installed ${wrapper}`)
