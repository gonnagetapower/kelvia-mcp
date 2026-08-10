#!/usr/bin/env bash
# Packs the stdio server as an MCP Bundle for Claude Desktop.
#
#   ./scripts/build-mcpb.sh
#
# The bundle is a self-contained zip: the compiled server, its production
# dependencies, an icon, and a manifest. The tools and prompts listed in the
# manifest are read back out of the built server rather than maintained by hand,
# so a manifest can never drift from what the server actually publishes.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/build/mcpb"
VERSION="$(node -p "require('./package.json').version")"

echo "==> building the server"
npm run build --silent >/dev/null

echo "==> staging bundle contents"
rm -rf "$OUT"
mkdir -p "$OUT/server"
cp -R dist/. "$OUT/server/"
cp icon.png "$OUT/icon.png"
cp README.md LICENSE "$OUT/"

# Production dependencies only: the bundle ships node_modules, and the dev
# toolchain would multiply its size for nothing.
node -e "
  const pkg = require('./package.json');
  const { devDependencies, scripts, ...rest } = pkg;
  require('fs').writeFileSync(
    '$OUT/package.json',
    JSON.stringify({ ...rest, main: 'server/index.js' }, null, 2) + '\n',
  );
"
(cd "$OUT" && npm install --omit=dev --no-audit --no-fund --silent >/dev/null)

echo "==> reading the published surface from the server"
node "$ROOT/scripts/mcpb-manifest.mjs" "$OUT/manifest.json" "$VERSION"

echo "==> packing"
npx -y @anthropic-ai/mcpb@latest pack "$OUT" "$ROOT/build/kelvia-mcp-$VERSION.mcpb"

echo "==> $(cd "$ROOT/build" && ls -lh "kelvia-mcp-$VERSION.mcpb" | awk '{print $9, $5}')"
