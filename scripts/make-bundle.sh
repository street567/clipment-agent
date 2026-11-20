#!/usr/bin/env bash
# 레포 루트를 node_modules·test·.git 없이 tar.gz 로 묶는다.
# 사용: scripts/make-bundle.sh <출력 폴더>
set -euo pipefail
OUT="${1:-}"
[ -n "$OUT" ] || { echo "사용법: $0 <출력 폴더>" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAMP="$(date +%y%m%d)"
FILE="$OUT/clipment-agent-$STAMP.tar.gz"
# macOS tar 가 ._ 파일을 만들지 않도록
COPYFILE_DISABLE=1 tar -czf "$FILE" \
  -C "$(dirname "$HERE")" \
  --exclude='node_modules' --exclude='.git' --exclude='test' --exclude='.DS_Store' --exclude='*.mp4' --exclude='*.mov' \
  "$(basename "$HERE")"
echo "$FILE"
echo "풀기: tar -xzf $(basename "$FILE") && cd clipment-agent && bun install"
