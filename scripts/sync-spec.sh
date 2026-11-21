#!/usr/bin/env bash
# 앱 레포의 spec/ 를 이 레포의 spec/ 로 그대로 복사하고 spec/SYNCED_FROM.txt 를 갱신한다.
# 사용: scripts/sync-spec.sh [<app-repo-path> | --github]
#   기본 원본: 환경변수 CLIPMENT_APP_REPO, 없으면 ../clip-review
#   --github : gh api repos/street567/clipment 로 가져옴 (그 레포가 있을 때만; 아직 없음)
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$here/spec"
arg="${1:-}"

if [ "$arg" = "--github" ]; then
  repo="street567/clipment"
  if ! command -v gh >/dev/null || ! gh api "repos/$repo" --silent >/dev/null 2>&1; then
    echo "GitHub 레포 $repo 를 사용할 수 없습니다 (아직 없거나 접근 권한 없음). 로컬 경로로 실행하세요: scripts/sync-spec.sh <app-repo-path>" >&2
    exit 2
  fi
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  sha="$(gh api "repos/$repo/commits/HEAD" --jq .sha)"
  gh api "repos/$repo/tarball/$sha" > "$tmp/src.tgz"
  mkdir "$tmp/x"; tar -xzf "$tmp/src.tgz" -C "$tmp/x" --strip-components=1
  [ -d "$tmp/x/spec" ] || { echo "$repo 에 spec/ 가 없습니다" >&2; exit 2; }
  src="$tmp/x/spec"; origin="github:$repo"
else
  app="${arg:-${CLIPMENT_APP_REPO:-$here/../clip-review}}"
  [ -d "$app/spec" ] || { echo "원본 spec/ 를 찾을 수 없습니다: $app/spec" >&2; exit 1; }
  app="$(cd "$app" && pwd)"
  src="$app/spec"; origin="$app"
  sha="$(git -C "$app" rev-parse HEAD 2>/dev/null || echo unknown)"
fi

rm -rf "$dest.new"; mkdir -p "$dest.new"
cp -R "$src"/. "$dest.new"/
rm -f "$dest.new/SYNCED_FROM.txt"
rm -rf "$dest"; mv "$dest.new" "$dest"
cat > "$dest/SYNCED_FROM.txt" <<TXT
source: $origin
commit: $sha
synced: $(date -u +%Y-%m-%dT%H:%M:%SZ)
(scripts/sync-spec.sh 로 복사한 사본입니다. 직접 고치지 마세요 — 원본은 앱 레포 spec/)
TXT
echo "spec/ 동기화 완료 ($origin @ $sha)"
