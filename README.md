# Clip Review — 맥 쪽 (cliprev CLI + MCP 서버 + Claude Code 플러그인)

아이폰 앱과는 iCloud 폴더의 파일로만 대화합니다. 계약: `../docs/SPEC-mvp.md`.
루트 폴더: `CLIPREV_ROOT` (기본 `~/Library/Mobile Documents/com~apple~CloudDocs/ClipReview`).

## 준비
```
cd mac && bun install        # bun: ~/.bun/bin/bun, ffmpeg/ffprobe: /opt/homebrew/bin
bun test                     # 임시 폴더 사용, 실제 iCloud 폴더는 건드리지 않음
bun run typecheck
```

## CLI
`bun src/cli.ts <명령>` (또는 `bun link` 후 `cliprev <명령>`). 읽기 명령은 `--json` 지원.

```
cliprev init simracing-vertical --title "심레이싱 버티컬"
cliprev publish simracing-vertical ~/Movies/cut.mp4 --note "첫 컷" [--lite]   # lite: 960px/CRF30/30fps/AAC96k
cliprev versions|comments|thread|requests|progress|reply|frame|watch ...
cliprev comments simracing-vertical --version 1 --status open --json
cliprev reply simracing-vertical <commentId> "반영했습니다" --status done --fixed-in 2
cliprev frame simracing-vertical <commentId> --out /tmp/f.jpg   # 코멘트의 영역(regions)을 사각형으로 그림, --no-regions 로 끔
cliprev watch            # 2초 폴링, 새 코멘트/사용자 답글/요청을 JSON 한 줄씩
```

## Claude Code 플러그인 설치
플러그인 루트는 이 `mac/` 폴더입니다 (`.claude-plugin/plugin.json`, `.mcp.json`, `skills/`).

- 개발용(한 세션만): `claude --plugin-dir /Users/pgzcore/Projects/delta-trend/clip-review/mac`
- 검증: `claude plugin validate /Users/pgzcore/Projects/delta-trend/clip-review/mac`
- 영구 설치는 로컬 마켓플레이스(`claude plugin marketplace add <경로>`)에 등록한 뒤 `claude plugin install clip-review@<마켓플레이스>` 형태입니다. 이 레포에는 마켓플레이스 매니페스트를 아직 만들지 않았습니다.

화면 영역(regions, SPEC §6): `comments`/`thread` 출력에 현재 영역과 위치 힌트가 나오고, `frame`/`get_frame`(regions=false 로 끔)은 ffmpeg drawbox 로 박스를 그립니다. 이 ffmpeg 빌드에 drawtext 가 없을 수 있어 숫자 대신 라벨별 색 + 왼쪽 위 점 개수로 표시하고 출력에 범례를 붙입니다.

MCP 서버 이름은 `clip-review` 입니다. 도구: `list_projects`, `list_versions`, `list_comments`, `get_thread`, `get_frame`, `reply`, `report_progress`, `publish_version`, `wait_for_requests`. 스킬: `apply-feedback`.

### 채널(폰 요청이 세션으로 푸시됨)
`.mcp.json` 이 `CLIPREV_CHANNEL=1` 로 서버를 띄우면 `claude/channel` 기능을 선언하고, 새 요청(화이트리스트 type 만)이 생기면 `notifications/claude/channel` 로 알립니다.
직접 만든 채널은 승인 목록에 없으므로 개발용 플래그가 필요합니다. 설치된 claude 2.1.325 바이너리에서 플래그 이름 `--dangerously-load-development-channels <servers...>` ("승인 목록에 없는 채널 서버 로드, 로컬 개발 전용, 시작 시 확인 대화상자") 를 확인했습니다(`--help` 에는 숨겨져 있음). 예:

```
claude --plugin-dir <mac 경로> --dangerously-load-development-channels plugin:clip-review@inline
```
**값 형식(`server:<이름>` / `plugin:<이름>@<마켓플레이스>`)은 바이너리 문자열만으로는 확인하지 못했습니다.** 동작하지 않으면 시작 시 나오는 안내/대화상자 문구를 확인하세요. 채널 없이도 `wait_for_requests` 도구와 스킬로 동작합니다(수동 시작: "피드백 확인해줘").

참고: `wait_for_requests` 는 최대 600초 롱폴입니다. MCP 클라이언트의 도구 타임아웃이 짧다면 `timeout_sec` 를 줄이세요.

## Codex
채널이 없으므로 같은 MCP 서버를 도구로 등록하고 `AGENTS.md` 를 읽게 합니다. `~/.codex/config.toml`:

```toml
[mcp_servers.clip-review]
command = "/Users/pgzcore/.bun/bin/bun"
args = ["/Users/pgzcore/Projects/delta-trend/clip-review/mac/src/mcp.ts"]
env = { CLIPREV_AGENT = "codex" }
# CLIPREV_ROOT 를 바꾸려면 env 에 추가
```
MCP 를 쓰지 않으면 AGENTS.md 의 CLI 명령을 그대로 쓰면 됩니다.

## 동작 메모
- 요청 type 은 `apply_feedback | answer | rerender | cancel` 만 처리하고 나머지는 무시합니다. 요청 내용은 명령으로 실행되지 않습니다.
- `agent` 가 비어 있지 않은 요청은 `CLIPREV_AGENT`(기본 claude)와 같을 때만 그 에이전트에게 전달됩니다.
- 모든 파일은 불변 + 임시파일(`.name.tmp`) 후 rename. publish 는 `versions/.vNNN.tmp/` 에 만든 뒤 폴더째 rename 하므로 앱은 완성된 `vNNN/` 만 봅니다.
- iCloud 자리표시자(`.name.icloud`)는 `brctl download` 요청 후 이번 회차에서 건너뜁니다.
- 환경변수: `CLIPREV_ALLOW_AUTHORS="개미,사용자"` (선택, 기본 꺼짐) — 설정하면 `authorName` 이 목록에 없는 요청은 무시. `CLIPREV_AGENT_NAME` (선택) — 맥이 쓰는 답글의 `authorName`.
- 코멘트/답글/요청의 `authorName`, 구간 코멘트의 `end` 는 CLI·MCP 출력에 그대로 담기고, CLI 텍스트 출력은 `12.5–15.0s` 와 표시 이름을 보여 줍니다.
