#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "The native test suite requires macOS and JavaScriptCore." >&2
  exit 1
fi
export CLANG_MODULE_CACHE_PATH="${CLANG_MODULE_CACHE_PATH:-$ROOT/swift/.build/module-cache}"
export SWIFTPM_MODULECACHE_OVERRIDE="${SWIFTPM_MODULECACHE_OVERRIDE:-$ROOT/swift/.build/module-cache}"
OPTIONS=(--package-path "$ROOT/swift" --scratch-path "$ROOT/swift/.build-tests"
  --disable-sandbox --disable-xctest --enable-swift-testing
  --cache-path /private/tmp/glossa-swift-cache
  --config-path /private/tmp/glossa-swift-config
  --security-path /private/tmp/glossa-swift-security)

# Command Line Tools ships Swift Testing separately from the SDK. Its macro
# library needs an explicit load on toolchains whose build engine omits it.
COMPILER="$(xcrun --find swiftc)"
TOOLCHAIN_USR="$(dirname "$(dirname "$COMPILER")")"
TESTING_MACRO="$TOOLCHAIN_USR/lib/swift/host/plugins/testing/libTestingMacros.dylib"
if [[ -f "$TESTING_MACRO" ]]; then
  OPTIONS+=(-Xswiftc -load-plugin-library -Xswiftc "$TESTING_MACRO")
fi
DEVELOPER="$(xcode-select -p)"
SDK="${GLOSSA_MACOS_SDK:-${SDKROOT:-$(xcrun --sdk macosx --show-sdk-path)}}"
SDK="$(cd "$SDK" && pwd -P)"
if [[ -z "${GLOSSA_MACOS_SDK:-}" && -z "${SDKROOT:-}" && "$SDK" == *MacOSX27*.sdk && -d "$DEVELOPER/SDKs/MacOSX26.5.sdk" ]]; then
  SDK="$DEVELOPER/SDKs/MacOSX26.5.sdk"
fi
OPTIONS+=(--sdk "$SDK")
for FRAMEWORKS in "$DEVELOPER/Library/Developer/Frameworks" "$DEVELOPER/Platforms/MacOSX.platform/Developer/Library/Frameworks"; do
  if [[ -d "$FRAMEWORKS/Testing.framework" ]]; then
    OPTIONS+=(-Xswiftc -F -Xswiftc "$FRAMEWORKS" -Xlinker -rpath -Xlinker "$FRAMEWORKS")
    break
  fi
done
node scripts/build-swift-core.mjs
swift test "${OPTIONS[@]}" "$@"
