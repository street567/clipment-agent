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
exit $fail
