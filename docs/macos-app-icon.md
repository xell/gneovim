# macOS app icon (Liquid Glass)

## Overview

The app icon is authored in Apple's Icon Composer as `src-tauri/icons/gneovim.icon`, an Icon Composer document (an `icon.json` layer spec plus `Assets/` source PNGs). This is the macOS 26 "Liquid Glass" format: the system rasterises it live with real depth, specular highlights and blur, so it cannot be shipped as a flat `.icns`.

### Why Tauri needs a post build step

The Tauri bundler only understands flat icons: the `bundle.icon` array in `src-tauri/tauri.conf.json` points at `icons/32x32.png`, `icons/128x128.png`, `icons/128x128@2x.png`, `icons/icon.icns`, `icons/icon.ico`. It writes `CFBundleIconFile` into `Contents/Info.plist` and drops the `.icns` into `Contents/Resources/`. There is no hook for an `Assets.car`.

The glass icon has to be compiled with `actool` and referenced from `Info.plist` via `CFBundleIconName`, which points at an asset catalog entry rather than a file. So we let Tauri build a normal bundle and then patch the finished `.app`.

### The patch: `scripts/mac-glass-icon.sh`

`scripts/mac-glass-icon.sh path/to/gneovim.app` does four things:

1. `xcrun actool src-tauri/icons/gneovim.icon --compile <tmp> --app-icon gneovim --output-partial-info-plist <tmp>/partial.plist --platform macosx --target-device mac --minimum-deployment-target 26.0`. Pointed straight at the `.icon` bundle (no synthetic `.xcassets` wrapper, which produces nothing) this emits `Assets.car` (the compiled glass icon, about 1.7 MB) and `gneovim.icns` (a flat fallback render, about 50 KB).
2. Copies `Assets.car` and `gneovim.icns` into `Contents/Resources/`.
3. Sets `CFBundleIconName = gneovim` (macOS 26 resolves this through `Assets.car` and renders the glass icon) and `CFBundleIconFile = gneovim` (older macOS and Finder Quick Look fall back to `gneovim.icns`).
4. Re-signs the bundle ad hoc with `codesign --force --sign -`, because rewriting `Resources/` and `Info.plist` breaks the seal Tauri applied, then `touch`es the app so Finder and the Dock refresh their icon caches.

If `actool` is missing (no full Xcode) the script prints a warning and exits 0, leaving the flat Tauri icon in place so the build still succeeds.

### Wiring

`npm run release` runs the script automatically, right after `npm run tauri build` and before the `ditto` into `/Applications`:

```
npm run tauri build -- --bundles app && bash scripts/mac-glass-icon.sh src-tauri/target/release/bundle/macos/gneovim.app && rm -rf /Applications/gneovim.app && ditto ...
```

`npm run tauri build` on its own (or `tauri dev`) still produces a working app, just with the flat icon.

## Making or updating the icon

Follow this the next time you draw a new icon or tweak the existing one.

### 1. Author or edit in Icon Composer

The source of truth is `src-tauri/icons/gneovim.icon`. Open it directly in Icon Composer and edit in place.

If you started a brand new document somewhere else (for example `~/Downloads/whatever.icon`), replace the vendored copy wholesale and keep the name `gneovim.icon`:

```
rm -rf src-tauri/icons/gneovim.icon
cp -R ~/Downloads/whatever.icon src-tauri/icons/gneovim.icon
```

The bundle name does not have to be `gneovim.icon`, but if you change it you must also change `ICON_SRC` in `scripts/mac-glass-icon.sh`. Easier to keep it.

### 2. Refresh the flat fallback

`src-tauri/icons/icon.icns` is the flat render used by `npm run tauri build` and `tauri dev` and by older macOS. Regenerate it from the new artwork:

```
xcrun actool src-tauri/icons/gneovim.icon --compile /tmp/gicon --app-icon gneovim \
  --output-partial-info-plist /tmp/gicon/partial.plist --platform macosx \
  --target-device mac --minimum-deployment-target 26.0
cp /tmp/gicon/gneovim.icns src-tauri/icons/icon.icns
```

Skip this only if you do not care what a non release build shows.

### 3. Build the real thing

```
npm run release
```

This runs `npm run tauri build`, then `scripts/mac-glass-icon.sh` compiles the `.icon`, drops `Assets.car` and `gneovim.icns` into the bundle, sets `CFBundleIconName` and `CFBundleIconFile`, re-signs, and installs to `/Applications/gneovim.app`.

### 4. See the change

macOS caches icons aggressively. If the Dock or Finder still shows the old one:

```
rm -rf /Applications/gneovim.app
sudo rm -rf /Library/Caches/com.apple.iconservices.store
killall Dock Finder
```

Then run `npm run release` again. Logging out and back in clears any remaining stragglers.

### 5. Commit

```
git add src-tauri/icons/gneovim.icon src-tauri/icons/icon.icns
git commit
```

### Non macOS targets

`src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png` and `icon.ico` feed Linux and Windows builds and are not produced by any of the above. If you ever ship those platforms, re export the PNGs at those sizes from the new art and rebuild the `.ico`. For a macOS only release you can ignore them.

## Troubleshooting

`actool not found`: you are missing full Xcode (`xcode-select -p` should point inside `Xcode.app`, not the Command Line Tools). Install Xcode, then `sudo xcode-select -s /Applications/Xcode.app`.

Icon looks flat in the built app, not glass: check that `/Applications/gneovim.app/Contents/Resources/Assets.car` exists and that `/usr/libexec/PlistBuddy -c "Print :CFBundleIconName" /Applications/gneovim.app/Contents/Info.plist` prints `gneovim`. If both are true it is an icon cache issue, see step 4.

`actool` warns about size or gamut: fix it in Icon Composer and redo from step 2. Warnings do not stop the build but can degrade the render.
