# clipment-agent

Clipment(iOS 앱 `com.street567.clipment`)의 맥 쪽: `clipment`(=`cliprev`) CLI + MCP 서버 + Claude Code 플러그인 (TypeScript/bun). clip-review 레포의 `mac/` 를 history 와 함께 분리한 레포.

## 구조
- `src/cli.ts` CLI, `src/mcp.ts` MCP 서버(채널 푸시), `src/core/` 공용 로직(워크스페이스·게시·프레임 등)
- `.claude-plugin/plugin.json` 플러그인, `.claude-plugin/marketplace.json` 마켓플레이스(소스 `./`), `.mcp.json`, `skills/apply-feedback`
- `install.sh` 설치/제거 스크립트(macOS), `scripts/make-bundle.sh` tar 번들
- `docs/SPEC.md` 폰↔맥 폴더 계약 (원본은 clip-review 레포 `docs/SPEC-mvp.md`)
- 환경변수는 호환을 위해 `CLIPREV_*` 유지

## 명령
```
bun install && bun test && bun run typecheck
claude plugin validate .
./install.sh --help        # 테스트 시 HOME 을 임시 폴더로 돌릴 것, CLIPMENT_ASSUME_NO=1 / --yes
```

## 규칙
- **계약(`docs/SPEC.md`)을 바꿀 땐 clip-review 레포 `docs/SPEC-mvp.md` 부터 고치고 여기에 복사**
- 맥 쪽은 요청 `type` 화이트리스트(`apply_feedback|answer|rerender|cancel`) 밖의 것을 실행하지 않는다
- 영상·node_modules 커밋 금지
- 커밋은 경로 지정: `git commit -m "…" -- <paths>`
