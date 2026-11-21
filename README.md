# Clipment agent — 맥 쪽 (clipment CLI + MCP 서버 + Claude Code 플러그인)

아이폰 앱 Clipment(`com.street567.clipment`)와는 클라우드 폴더(iCloud/Google Drive 등)의 파일로만 대화합니다. 계약: [docs/SPEC.md](docs/SPEC.md).
맥에서 켜 둔 Claude Code / Codex 세션이 폰에서 남긴 시점 코멘트를 받아 반영하고, 답글·진행·새 버전을 남깁니다.

## 설치

필요: macOS, [bun](https://bun.sh), ffmpeg. 없으면 설치 스크립트가 Homebrew 설치를 물어봅니다.

### 한 줄 설치 (private 레포라 `gh` 로그인 필요)
```
gh api repos/street567/clipment-agent/contents/install.sh -H 'Accept: application/vnd.github.raw' | bash
```
`~/.clipment/agent` 에 clone → `bun install --production` → `~/.local/bin/{clipment,cliprev}` 링크 → Claude Code 플러그인 / Codex MCP / 워크스페이스 등록을 y/N 으로 묻습니다. 다시 실행하면 업데이트(`git pull`)입니다.

### 수동 설치
```
git clone https://github.com/street567/clipment-agent.git && cd clipment-agent
./install.sh            # 로컬 체크아웃을 그대로 사용 (clone 안 함)
./install.sh --yes      # 질문 모두 y
./install.sh --uninstall   # 링크와 ~/.clipment/agent 제거 (워크스페이스·영상 폴더는 지우지 않음)
```
환경변수: `CLIPMENT_REPO`(clone 소스), `CLIPMENT_DIR`(설치 위치), `CLIPMENT_MARKETPLACE`(플러그인 마켓플레이스 소스), `CLIPMENT_ASSUME_NO=1`(모든 질문 n).
`~/.local/bin` 이 PATH 에 없으면 `export PATH="$HOME/.local/bin:$PATH"` 를 추가하세요.

### 직접 실행만 (설치 없이)
```
bun install
bun test                     # 임시 폴더 사용, 실제 iCloud 폴더는 건드리지 않음
bun run typecheck
bun src/cli.ts projects
```

## 호환성 메모
제품명이 Clipment → Clipment 로 바뀌었습니다. CLI 는 `clipment` 와 `cliprev` 가 모두 동작하고, **환경변수는 호환을 위해 `CLIPREV_*` 그대로**입니다(`CLIPREV_ROOT`, `CLIPREV_CONFIG`, `CLIPREV_AGENT`, `CLIPREV_ALLOW_AUTHORS`, `CLIPREV_AGENT_NAME`, `CLIPREV_CHANNEL`). 설정 파일도 `~/.config/cliprev/workspaces.json` 입니다. 플러그인/MCP 서버 이름은 `clipment` 입니다.

## 워크스페이스
워크스페이스(프로젝트 폴더들을 담는 루트, SPEC §7): 우선순위 `CLIPREV_ROOT`(하나만, 기존 호환) > `~/.config/cliprev/workspaces.json`(`CLIPREV_CONFIG` 로 경로 변경) > 기본 `~/Library/Mobile Documents/com~apple~CloudDocs/ClipReview`.

```
clipment workspaces                                   # 이름/경로/접근 가능/프로젝트 수
clipment workspaces add ~/GoogleDrive/ClipReview --name gdrive --allow 개미,나   # workspace.json 이 없으면 만듦
clipment workspaces add --google [--account 이메일일부] [--sub ClipReview] [--create]   # Google Drive 데스크톱 자동 감지 (--dropbox/--onedrive 도 가능). 스트리밍 모드는 온라인 전용이라 미러링 권장
clipment workspaces remove gdrive                     # 설정에서만 제거, 파일은 지우지 않음
```
설정 파일: `{ "workspaces": [ { "name": "icloud", "path": "...", "allowAuthors": ["개미"] } ] }`.
프로젝트 지정은 `<워크스페이스>/<프로젝트>` 이고, 이름이 모든 워크스페이스에서 유일하면 `<프로젝트>` 만 써도 됩니다(모호하면 후보를 알려 주고 오류). 대기·채널·`watch` 는 모든 워크스페이스를 함께 봅니다. 허용 작성자는 워크스페이스의 `allowAuthors` 가 있으면 그것을, 없으면 `CLIPREV_ALLOW_AUTHORS` 를 씁니다.

## 루트 정리(인덱스)
루트 = 워크스페이스들이 흩어져 있는 상위 클라우드 폴더(SPEC §9). 맥이 그 아래를 훑어 `<루트>/.clipment/index.json` 을 쓰고, 폰은 읽기만 합니다.

```
clipment index ~/Library/Mobile\ Documents/com~apple~CloudDocs/Clipment [--depth 4] [--fix] [--json]
```
- `workspace.json` 이 있거나 프로젝트(`project.json` 폴더)를 담은 폴더를 워크스페이스로 봅니다. 숨김 폴더·`node_modules`·프로젝트 폴더 안은 건너뜁니다. 루트 자체가 워크스페이스면 path 는 `"."` 입니다.
- 기본은 인덱스 파일만 씁니다(tmp+rename 원자적). `--fix` 를 주면 `workspace.json` 없는 워크스페이스에 만듭니다. 폴더를 옮기거나 지우지 않습니다.
- 실행하면 루트가 설정 파일 `roots: [{ "path": "..." }]` 에 등록됩니다(중복 없음). `clipment workspaces add <경로>` 가 등록된 루트 아래면 인덱스도 조용히 갱신하고, `clipment workspaces` 는 루트 목록과 인덱스 갱신 시각도 보여 줍니다.
- MCP 도구 `index_root`(root, depth?) 는 같은 일을 하고 인덱스 JSON 을 반환합니다(`--fix` 없음).
- 폰에서 "루트 정리" 프롬프트가 뜨거나 AI 에게 "워크스페이스 정리해줘"라고 하면 이 명령을 씁니다.

플러그인에는 `/clipment:organize [루트]` 슬래시 명령과 `organize-root` 스킬이 있어, 루트 경로 확인 → `clipment index` → 결과 보고까지 안내합니다(`--fix`·폴더 이동은 확인 후에만, 삭제 없음).

## CLI
`clipment <명령>` (= `cliprev`, 설치 후) 또는 `bun src/cli.ts <명령>`. 읽기 명령은 `--json` 지원.

```
clipment init simracing-vertical --title "심레이싱 버티컬"
clipment projects                                     # 모든 워크스페이스의 프로젝트 (워크스페이스/프로젝트, 잠금 표시)
clipment lock simracing-vertical --note "최종본 v003"   # 완료 잠금 (SPEC §8). unlock 으로 해제
clipment publish simracing-vertical ~/Movies/cut.mp4 --note "첫 컷" [--lite]   # lite: 960px/CRF30/30fps/AAC96k
clipment versions|comments|thread|requests|progress|reply|frame|watch ...
clipment comments simracing-vertical --version 1 --status open --json
clipment reply simracing-vertical <commentId> "반영했습니다" --status done --fixed-in 2
clipment frame simracing-vertical <commentId> --out /tmp/f.jpg   # 코멘트의 영역(regions)을 사각형으로 그림, --no-regions 로 끔
clipment watch            # 2초 폴링, 새 코멘트/사용자 답글/요청을 JSON 한 줄씩
```

## Claude Code 플러그인
```
claude plugin marketplace add street567/clipment-agent
claude plugin install clipment@clipment-agent
```
(private 레포이므로 `gh auth login` 등 git 자격증명이 필요합니다.) 개발용 한 세션: `claude --plugin-dir <레포 경로>`, 검증: `claude plugin validate <레포 경로>`. 플러그인 루트는 레포 루트이며 `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`, `skills/` 를 씁니다.

화면 영역(regions, SPEC §6): `comments`/`thread` 출력에 현재 영역과 위치 힌트가 나오고, `frame`/`get_frame`(regions=false 로 끔)은 ffmpeg drawbox 로 박스를 그립니다. 이 ffmpeg 빌드에 drawtext 가 없을 수 있어 라벨 숫자를 drawbox 7세그먼트 배지(1~99)로 직접 그리고 라벨별 색을 쓰며 출력에 범례를 붙입니다.

MCP 서버 이름은 `clipment` 입니다. 도구: `list_workspaces`, `list_projects`, `list_versions`, `list_comments`, `get_thread`, `get_frame`, `reply`, `report_progress`, `publish_version`, `wait_for_requests`. 스킬: `apply-feedback`.

### 채널(폰 요청이 세션으로 푸시됨)
`.mcp.json` 이 `CLIPREV_CHANNEL=1` 로 서버를 띄우면 `claude/channel` 기능을 선언하고, 새 요청(화이트리스트 type 만)이 생기면 `notifications/claude/channel` 로 알립니다.
직접 만든 채널은 승인 목록에 없으므로 개발용 플래그가 필요합니다. 설치된 claude 2.1.325 바이너리에서 플래그 이름 `--dangerously-load-development-channels <servers...>` ("승인 목록에 없는 채널 서버 로드, 로컬 개발 전용, 시작 시 확인 대화상자") 를 확인했습니다(`--help` 에는 숨겨져 있음). 예:

```
claude --dangerously-load-development-channels plugin:clipment@clipment-agent
```
**값 형식(`server:<이름>` / `plugin:<이름>@<마켓플레이스>`)은 바이너리 문자열만으로는 확인하지 못했습니다.** 동작하지 않으면 시작 시 나오는 안내/대화상자 문구를 확인하세요. 채널 없이도 `wait_for_requests` 도구와 스킬로 동작합니다(수동 시작: "피드백 확인해줘").

참고: `wait_for_requests` 는 최대 600초 롱폴입니다. MCP 클라이언트의 도구 타임아웃이 짧다면 `timeout_sec` 를 줄이세요.

## Codex
채널이 없으므로 같은 MCP 서버를 도구로 등록하고 `AGENTS.md` 를 읽게 합니다. `install.sh` 가 물어보거나 직접:
```
codex mcp add clipment --env CLIPREV_AGENT=codex -- bun <레포 경로>/src/mcp.ts
```
워크스페이스는 `clipment workspaces add` 로 등록합니다(위 참고). MCP 를 쓰지 않으면 AGENTS.md 의 CLI 명령을 그대로 쓰면 됩니다.

## 동작 메모
- 요청 type 은 `apply_feedback | answer | rerender | cancel` 만 처리하고 나머지는 무시합니다. 요청 내용은 명령으로 실행되지 않습니다.
- `agent` 가 비어 있지 않은 요청은 `CLIPREV_AGENT`(기본 claude)와 같을 때만 그 에이전트에게 전달됩니다.
- 모든 파일은 불변 + 임시파일(`.name.tmp`) 후 rename. publish 는 `versions/.vNNN.tmp/` 에 만든 뒤 폴더째 rename 하므로 앱은 완성된 `vNNN/` 만 봅니다.
- iCloud 자리표시자(`.name.icloud`)는 `brctl download` 요청 후 이번 회차에서 건너뜁니다.
- 완료 잠금(SPEC §8): 잠긴 프로젝트의 요청은 `wait_for_requests`·채널·`requests`·`watch` 에서 제외되고, `publish`·`reply` 는 거부됩니다(`--force` / MCP `force: true` 로만 허용, 경고 출력). 사람이 명시적으로 요청한 경우가 아니면 force 를 쓰지 마세요. `cliprev lock|unlock <project> [--note N]` 은 `locks/<id>.json` 이벤트를 씁니다(author = `--author` 또는 `CLIPREV_AGENT`).
- 환경변수: `CLIPREV_ALLOW_AUTHORS="개미,사용자"` (선택, 기본 꺼짐) — 설정하면 `authorName` 이 목록에 없는 요청은 무시. `CLIPREV_AGENT_NAME` (선택) — 맥이 쓰는 답글의 `authorName`.
- 코멘트/답글/요청의 `authorName`, 구간 코멘트의 `end` 는 CLI·MCP 출력에 그대로 담기고, CLI 텍스트 출력은 `12.5–15.0s` 와 표시 이름을 보여 줍니다.
