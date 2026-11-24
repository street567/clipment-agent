#!/usr/bin/env bash
# Claude 데스크톱 확장(.mcpb) 빌드: bun 으로 node 타겟 번들 → mcpb pack → dist/clipment.mcpb
# 데스크톱 내장 node 로 실행되므로 bun 은 사용자 쪽에 필요 없다 (빌드할 때만 필요).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$HERE/dist}"
VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1)"
[ -n "$VER" ] || { echo "version 을 찾지 못했습니다" >&2; exit 1; }
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server" "$OUT"
(cd "$HERE" && bun build src/server.ts --target=node --outfile="$STAGE/server/index.mjs" >/dev/null)
sed "s/__VERSION__/$VER/" "$HERE/mcpb/manifest.json" > "$STAGE/manifest.json"
cp "$HERE/LICENSE" "$STAGE/LICENSE"
# NODE_OPTIONS 에 남은 preload 때문에 npx 가 실패하는 환경 방지
env -u NODE_OPTIONS npx -y @anthropic-ai/mcpb validate "$STAGE/manifest.json"
env -u NODE_OPTIONS npx -y @anthropic-ai/mcpb pack "$STAGE" "$OUT/clipment.mcpb"
echo "$OUT/clipment.mcpb"
