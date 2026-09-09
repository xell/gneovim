# Releasing (macOS)

`npm run release` quits a running gneovim, runs `tauri build --bundles app`,
injects the Liquid Glass icon and re-signs (`scripts/mac-glass-icon.sh`), then
installs to `/Applications`.

## Code signing

Set `APPLE_SIGNING_IDENTITY` in your environment before building. Both
`tauri build` and `scripts/mac-glass-icon.sh` read it.

```sh
# one-off
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
npm run release

# or add the export to ~/.zshrc so every shell has it
```

`security find-identity -v -p codesigning` prints the exact string.

The identity is deliberately **not** stored in `tauri.conf.json` or any tracked
file: the string embeds a personal name and Apple Team ID, and this is a public
repo. Keep it in your shell env (or a gitignored `src-tauri/.env`, which the
Tauri CLI loads).

### Why it matters

Without a stable identity the build is **ad-hoc signed**, which gives the app a
`cdhash`-pinned designated requirement. Every rebuild changes the cdhash, so
macOS TCC treats it as a brand-new app and re-prompts for Accessibility (and any
other granted permission) after every `npm run release`. A real signing identity
makes the designated requirement identity/team based and stable across rebuilds,
so a granted permission sticks.

After switching from ad-hoc to a real identity once, clear the stale TCC entries:

```sh
tccutil reset All com.xell.gneovim
```

then grant again on next launch.

## Notarization (only for distributing to other machines)

Not needed to run your own local build (`npm run release` strips the quarantine
xattr). To distribute:

1. Add `"macOS": { "hardenedRuntime": true }` under `bundle` (Tauri then adds the
   WKWebView JIT entitlements).
2. `xcrun notarytool submit <app>.zip --apple-id ... --team-id ... --password ...`
3. `xcrun stapler staple <app>`
