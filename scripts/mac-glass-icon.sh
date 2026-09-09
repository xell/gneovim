#!/usr/bin/env bash
# Inject the macOS 26 "Liquid Glass" app icon into a built .app bundle.
#
# Tauri's bundler only knows about flat .icns / .png icons. The glass icon is an
# Icon Composer document (src-tauri/icons/gneovim.icon) that has to be compiled
# with actool into an Assets.car and referenced from Info.plist via
# CFBundleIconName. This script does that to an already-bundled .app, then
# re-signs it ad-hoc (editing Resources/ and Info.plist breaks the seal).
#
# Usage: scripts/mac-glass-icon.sh path/to/gneovim.app
# No-ops with a warning if actool is unavailable, so plain builds still work.
set -euo pipefail

APP="${1:?usage: mac-glass-icon.sh path/to/App.app}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_SRC="$REPO/src-tauri/icons/gneovim.icon"
ICON_NAME="gneovim"   # the --app-icon stem; also the CFBundleIcon* value

if [[ ! -d "$APP" ]]; then
  echo "mac-glass-icon: no such app bundle: $APP" >&2
  exit 1
fi
if [[ ! -d "$ICON_SRC" ]]; then
  echo "mac-glass-icon: missing $ICON_SRC" >&2
  exit 1
fi
if ! xcrun -f actool >/dev/null 2>&1; then
  echo "mac-glass-icon: actool not found (need full Xcode); leaving flat icon in place" >&2
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

xcrun actool "$ICON_SRC" \
  --compile "$WORK" \
  --app-icon "$ICON_NAME" \
  --output-partial-info-plist "$WORK/partial.plist" \
  --platform macosx --target-device mac \
  --minimum-deployment-target 26.0 \
  --errors --warnings --notices

RES="$APP/Contents/Resources"
PLIST="$APP/Contents/Info.plist"
mkdir -p "$RES"
cp "$WORK/Assets.car" "$RES/Assets.car"
cp "$WORK/$ICON_NAME.icns" "$RES/$ICON_NAME.icns"

# CFBundleIconName -> Assets.car lookup (macOS 26 glass render).
# CFBundleIconFile -> flat .icns fallback for older macOS / Finder previews.
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIconName string $ICON_NAME" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile $ICON_NAME" "$PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string $ICON_NAME" "$PLIST"

# Re-seal: we just rewrote Resources/ and Info.plist.
codesign --force --sign - --timestamp=none "$APP"

# Nudge Finder/Dock icon caches.
touch "$APP"

echo "mac-glass-icon: injected $ICON_NAME.icon into $(basename "$APP")"
