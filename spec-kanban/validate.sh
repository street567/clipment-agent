#!/usr/bin/env bash
# spec/fixtures/<kind>.json 을 contract.json 의 스키마로 검증한다. (bunx ajv-cli 필요)
set -euo pipefail
cd "$(dirname "$0")"
runner=(bunx --bun ajv-cli@5)
command -v bunx >/dev/null || runner=(npx --yes ajv-cli@5)
fail=0
err=$(mktemp); trap 'rm -f "$err"' EXIT
for kind in $(python3 -c 'import json;print(" ".join(json.load(open("contract.json"))["files"]))'); do
  schema=$(python3 -c "import json;print(json.load(open('contract.json'))['files']['$kind'])")
  fixture="fixtures/$(basename "$schema" .schema.json).json"
  [ -f "$fixture" ] || { echo "MISSING fixture: $fixture"; fail=1; continue; }
  if "${runner[@]}" validate --spec=draft2020 -s "$schema" -d "$fixture" >/dev/null 2>"$err"; then
    echo "ok   $kind"
  else echo "FAIL $kind"; cat "$err"; fail=1; fi
done
# fixtures/invalid/<스키마 이름>.<사례>.json 은 반드시 검증에 실패해야 한다 (1.3: 반영 요청 파일 모양)
for bad in fixtures/invalid/*.json; do
  [ -f "$bad" ] || continue
  name=$(basename "$bad" .json); schema="schemas/${name%%.*}.schema.json"
  if "${runner[@]}" validate --spec=draft2020 -s "$schema" -d "$bad" >/dev/null 2>&1; then
    echo "FAIL invalid fixture 가 통과함: $bad"; fail=1
  else echo "ok   invalid $name"; fi
done
exit $fail
