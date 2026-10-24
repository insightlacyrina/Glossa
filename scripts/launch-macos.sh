#!/bin/zsh
set -euo pipefail
GLOSSA_PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GLOSSA_APP="$GLOSSA_PROJECT_DIR/releases/macos/Glossa.app"
if [[ ! -x "$GLOSSA_APP/Contents/MacOS/Glossa" ]]; then
  print -u2 "未找到笺注应用，请在工程目录运行：npm run build:macos"
  exit 1
fi
if [[ "${1:-}" == "--check" ]]; then
  /usr/bin/plutil -lint "$GLOSSA_APP/Contents/Info.plist"
  print "笺注启动入口检查通过。"
  exit 0
fi
# LaunchServices reuses the running application instead of creating another writer.
exec /usr/bin/open -a "$GLOSSA_APP" --args "$@"
