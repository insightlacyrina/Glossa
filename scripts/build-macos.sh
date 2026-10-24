#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${GLOSSA_MACOS_OUTPUT:-$ROOT/releases/macos}"
APP="$OUTPUT/Glossa.app"
BUILD_CACHE="${GLOSSA_SWIFT_CACHE:-$ROOT/swift/.build}"
export SWIFT_MODULECACHE_PATH="${SWIFT_MODULECACHE_PATH:-/private/tmp/glossa-swift-module-cache}"
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$SWIFT_MODULECACHE_PATH}"
SPM_OPTIONS=(--package-path "$ROOT/swift" --scratch-path "$BUILD_CACHE" --disable-sandbox -debug-info-format none
  --cache-path /private/tmp/glossa-swift-cache
  --config-path /private/tmp/glossa-swift-config
  --security-path /private/tmp/glossa-swift-security)

if [[ "$(uname -s)" != Darwin ]]; then
  echo "The native macOS app must be built on macOS." >&2
  exit 1
fi
DEVELOPER_ROOT="$(xcode-select -p)"
MACOS_SDK="${GLOSSA_MACOS_SDK:-${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}}"
# The current CLT macOS 27 SDK declares SwiftUI's new State macro without
# shipping its plugin. Prefer an explicit SDKROOT; otherwise use the installed
# macOS 26.5 SDK that still provides the supported State property wrapper.
if [[ -z "${GLOSSA_MACOS_SDK:-}" && -z "${SDKROOT:-}" && "$DEVELOPER_ROOT" == *CommandLineTools* &&
      ! -f "$DEVELOPER_ROOT/usr/lib/swift/host/plugins/libSwiftUIMacros.dylib" &&
      -d "$DEVELOPER_ROOT/SDKs/MacOSX26.5.sdk" ]] &&
   /usr/bin/grep -q 'StateMacro' "$MACOS_SDK/System/Library/Frameworks/SwiftUICore.framework/Modules/SwiftUICore.swiftmodule/arm64e-apple-macos.swiftinterface"; then
  MACOS_SDK="$DEVELOPER_ROOT/SDKs/MacOSX26.5.sdk"
fi
SPM_OPTIONS+=(--sdk "$MACOS_SDK")
echo "macOS SDK: $MACOS_SDK"
cd "$ROOT"
npm run build
node scripts/build-swift-core.mjs
swift build "${SPM_OPTIONS[@]}" -c release
BIN_DIR="$(swift build "${SPM_OPTIONS[@]}" -c release --show-bin-path)"

mkdir -p "$OUTPUT"
# Replace only this build product; never touch application support or user data.
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/Glossa" "$APP/Contents/MacOS/Glossa"
cp "$ROOT/swift/Info.plist" "$APP/Contents/Info.plist"
for resource in "$BIN_DIR"/*.bundle; do
  [[ -d "$resource" ]] || continue
  cp -R "$resource" "$APP/Contents/Resources/"
  cp -R "$resource" "$APP/Contents/MacOS/"
done
bash "$ROOT/scripts/bundle-macos-server.sh" "$APP/Contents/Resources"

swift -sdk "$MACOS_SDK" -module-cache-path "$SWIFT_MODULECACHE_PATH" "$ROOT/scripts/create-macos-icon.swift" "$OUTPUT/AppIcon.iconset"
mv "$OUTPUT/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$OUTPUT/AppIcon.iconset"
plutil -lint "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
ARCH="$(uname -m)"
ARCHIVE="$OUTPUT/Glossa-macOS-$ARCH.zip"
rm -f "$ARCHIVE"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
echo "Built: $APP"
echo "Archive: $ARCHIVE"
