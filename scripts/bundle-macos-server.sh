#!/bin/bash
set -euo pipefail
GLOSSA_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GLOSSA_RESOURCES="${1:?Pass the application Resources directory}"
GLOSSA_NODE="${GLOSSA_NODE_BINARY:-$(command -v node)}"
GLOSSA_NODE_VERSION="$("$GLOSSA_NODE" -p process.version)"
GLOSSA_ARCH="$(uname -m)"
GLOSSA_RUNTIME="$GLOSSA_RESOURCES/server-runtime"
if [[ "$GLOSSA_NODE_VERSION" != v24.* ]]; then
  echo "The bundled server requires Node.js 24; found $GLOSSA_NODE_VERSION." >&2
  exit 1
fi
GLOSSA_LICENSE="${GLOSSA_NODE_LICENSE:-$GLOSSA_ROOT/swift/ThirdParty/Node-LICENSE}"
if [[ ! -s "$GLOSSA_LICENSE" ]]; then
  echo "Node.js license is missing; set GLOSSA_NODE_LICENSE to its LICENSE file." >&2
  exit 1
fi
mkdir -p "$GLOSSA_RUNTIME/server" "$GLOSSA_RUNTIME/web"
if /usr/bin/lipo -info "$GLOSSA_NODE" | /usr/bin/grep -q 'Architectures in the fat file'; then
  /usr/bin/lipo "$GLOSSA_NODE" -thin "$GLOSSA_ARCH" -output "$GLOSSA_RUNTIME/node"
else
  cp "$GLOSSA_NODE" "$GLOSSA_RUNTIME/node"
fi
chmod 755 "$GLOSSA_RUNTIME/node"
cp "$GLOSSA_ROOT"/server/*.mjs "$GLOSSA_RUNTIME/server/"
cp -R "$GLOSSA_ROOT/dist/." "$GLOSSA_RUNTIME/web/"
cp "$GLOSSA_LICENSE" "$GLOSSA_RUNTIME/Node-LICENSE"
printf '{"nodeVersion":"%s","architecture":"%s","license":"Node-LICENSE"}\n' "$GLOSSA_NODE_VERSION" "$GLOSSA_ARCH" > "$GLOSSA_RUNTIME/runtime.json"
/usr/bin/codesign --force --sign - "$GLOSSA_RUNTIME/node"
"$GLOSSA_RUNTIME/node" --input-type=module -e 'import {DatabaseSync,backup} from "node:sqlite"; if (!DatabaseSync || !backup) process.exit(1);'
echo "Bundled independent server runtime: Node.js $GLOSSA_NODE_VERSION ($GLOSSA_ARCH)."
