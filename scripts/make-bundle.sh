#!/usr/bin/env bash
# 소스 tar.gz (node_modules·test·.git·dist 제외, 최상위 폴더명 clipment-agent) 를 만든다.
# 사용: scripts/make-bundle.sh <출력 폴더>   → <출력>/clipment-agent-<package.json version>.tar.gz
set -euo pipefail
OUT="${1:-}"
[ -n "$OUT" ] || { echo "사용법: $0 <출력 폴더>" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
VER="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1)"
[ -n "$VER" ] || { echo "package.json 에서 version 을 찾지 못했습니다" >&2; exit 1; }
FILE="$OUT/clipment-agent-$VER.tar.gz"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/clipment-agent"
rsync -a --exclude='node_modules' --exclude='.git' --exclude='test' --exclude='dist' --exclude='.DS_Store' \
  --exclude='*.mp4' --exclude='*.mov' --exclude='.env' "$HERE/" "$STAGE/clipment-agent/"
# macOS tar 가 ._ 파일을 만들지 않도록
COPYFILE_DISABLE=1 tar -czf "$FILE" -C "$STAGE" clipment-agent
echo "$FILE"
