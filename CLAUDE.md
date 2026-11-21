# clipment-agent

Clipment(iOS 앱 `com.street567.clipment`)의 맥 쪽: `clipment`(=`cliprev`) CLI + MCP 서버 + Claude Code 플러그인 (TypeScript/bun). clip-review 레포의 `mac/` 를 history 와 함께 분리한 레포.

## 구조
- `src/cli.ts` CLI, `src/mcp.ts` MCP 서버(채널 푸시), `src/core/` 공용 로직(워크스페이스·게시·프레임 등)
- `.claude-plugin/plugin.json` 플러그인, `.claude-plugin/marketplace.json` 마켓플레이스(소스 `./`), `.mcp.json`, `skills/apply-feedback`
- `src/daemon/` 백그라운드 데몬(락·감시·알림·자동 실행·launchd), `mcpb/manifest.json` + `scripts/build-mcpb.sh` Claude 데스크톱 확장, `scripts/desktop-config.ts` 데스크톱 설정 병합
- `.github/workflows/release.yml` 태그 `v*` 푸시 → 릴리스(mcpb + 소스 tar.gz + install.sh)
- `install.sh` 설치/제거 스크립트(macOS), `scripts/make-bundle.sh` tar 번들
- `spec/` 폰↔맥 폴더 계약 전체 사본 (원본: 앱 레포 `clip-review/spec/`, 출처 커밋은 `spec/SYNCED_FROM.txt`). `docs/SPEC.md` 는 포인터
- `src/core/contract.ts` 지원 계약 버전(SUPPORTED) · 호환 판단. `test/contract.test.ts` 가 `spec/contract.json` 과 어긋나면 실패
- 환경변수는 호환을 위해 `CLIPREV_*` 유지

## 명령
```
bun install && bun test && bun run typecheck && spec/validate.sh
claude plugin validate .
./install.sh --help        # 테스트 시 HOME 을 임시 폴더로 돌릴 것, CLIPMENT_ASSUME_NO=1 / --yes
```

## 규칙
- **계약은 앱 레포 `spec/` 에서만 고치고 `scripts/sync-spec.sh` 로 가져온다 (`spec/` 직접 수정 금지). 버전이 오르면 `contract.ts` SUPPORTED 도 올릴 것**
- 맥 쪽은 요청 `type` 화이트리스트(`apply_feedback|answer|rerender|cancel`) 밖의 것을 실행하지 않는다
- 영상·node_modules 커밋 금지
- 커밋은 경로 지정: `git commit -m "…" -- <paths>`
