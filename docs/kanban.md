# agent-kanban 플러그인

> 이 문서는 agent-kanban 레포 `plugin/README.md` 에서 옮겨 온 것입니다. 이제 칸반은 `street567/client-ai-bridge` 플러그인(`client-ai-bridge@street567`)의 일부입니다. 경로 읽는 법: `src/X.ts` → `src/kanban/X.ts`, `codex/` → `docs/kanban-codex/`, 설치는 플러그인 하나(`claude plugin install client-ai-bridge@street567`), MCP 서버 시작은 `bun run start:kanban`. 설정은 `kanban setup --root <폴더>` 또는 MCP 도구 `kanban_setup` 으로도 됩니다.


Claude Code 세션의 진행을 아이폰 칸반 앱에서 볼 수 있게 하고, 폰에서 남긴 의견을 세션에 전달합니다. 서버·로그인 없이 사용자 클라우드 폴더의 파일로만 아이폰 앱과 대화합니다(계약: `../spec/SPEC.md`).

구성: `hooks/hooks.json`(세션 상태 기록) · `monitors/monitors.json`(폰 의견·맡긴 일 신호) · `.mcp.json`(board_ask · board_note · board_reply · board_list · board_inbox · board_card · board_members · board_label · board_take · board_submit) · `skills/kanban`(에이전트용 규칙) · `src/cli.ts`(`kanban` 명령) · `codex/`(Codex 설치 예시). 런타임은 bun. 계약 1.1(여럿이 쓰는 보드: 담당·카테고리·리스트·맡기기·여러 LLM).

## 설치
이 폴더를 Claude Code 플러그인으로 설치합니다(예: 자신의 마켓플레이스에 올리거나 `claude --plugin-dir <이 폴더>` 로 시험). hooks 와 monitor 는 내장 모듈만 써서 `node_modules` 없이 동작합니다. MCP 서버는 첫 실행 때 `bun install` 로 의존성(@modelcontextprotocol/sdk, zod)을 받습니다.

CLI 를 쓰려면: `bun <플러그인 폴더>/src/cli.ts <명령>` 또는 `bun link` 후 `kanban <명령>`.

## 설정
설정 파일이 없으면 플러그인은 **아무것도 하지 않습니다**.
```
kanban init [--root <클라우드 폴더>]     # 설정과 폴더를 만든다(이미 있으면 덮어쓰지 않음)
kanban doctor                              # 설정·폴더·bun·iCloud 상태·hook 로그 오류 점검
```
`~/.config/agent-kanban/config.json` (`AGENT_KANBAN_CONFIG` 로 위치 변경, `AGENT_KANBAN_ROOT` 가 root 보다 우선):
```json
{
  "enabled": true,
  "root": "~/Library/Mobile Documents/com~apple~CloudDocs/Agent Kanban",
  "board": "main",
  "includePaths": [], "excludePaths": [],
  "includeHeadless": false,
  "allowAuthors": [],
  "monitor": { "intervalSec": 5, "busyDelaySec": 30 },
  "telegram": { "enabled": false, "chatId": "", "tokenEnv": "AGENT_KANBAN_TELEGRAM_TOKEN", "apiBase": "https://api.telegram.org" }
}
```
- `includePaths`/`excludePaths`: 작업 폴더가 그 밑일 때만 / 그 밑이면 제외. (여러 보드는 아래 "여러 보드(워크스페이스)")
- `allowAuthors`(선택): 있으면 `authorName` 이 목록에 있는 코멘트·처리만 전달.
- `includeHeadless`: `claude -p`·SDK 세션(`CLAUDE_CODE_ENTRYPOINT` 가 `sdk` 로 시작)도 기록할지. 기본은 제외. (그 변수가 없으면 부모 프로세스 인자의 `-p`/`--print` 를 보고, 그래도 모르면 대화형으로 취급합니다.)
- 텔레그램: 새 "사람 차례"와 "문제"가 생길 때 한 번 알림. 토큰은 환경변수(`tokenEnv`)에서만 읽고, 파일을 찾아 읽지 않습니다. 기본 꺼짐.

## 여러 보드(워크스페이스) (0.7.0~)
보드 폴더를 여러 개 둘 수 있습니다. 클라우드 계약은 그대로이고, 맥 설정과 세션 라우팅만 바뀝니다.
```json
{
  "enabled": true,
  "workspaces": [
    { "name": "개인", "root": "~/…/Agent Kanban" },
    { "name": "회사", "root": "~/…/Work Kanban", "board": "main", "includePaths": ["~/work/app", "~/work/api"], "excludePaths": [] }
  ],
  "excludePaths": [], "includeHeadless": false, "monitor": {…}, "telegram": {…}
}
```
- 전역 옵션(`enabled`, `includeHeadless`, `allowAuthors`, `monitor`, `telegram`, 최상위 `excludePaths`)은 최상위에 둡니다. 옛 최상위 `root`(+`board`/`includePaths`)는 워크스페이스 하나로 읽습니다. 둘 다 있으면 `workspaces` 가 우선이고, 목록에 없는 옛 `root` 는 추가 워크스페이스로 붙습니다(경로 기준 중복 제거). `AGENT_KANBAN_ROOT` 는 "이 root 하나만 쓰는 워크스페이스" override 입니다.
- **라우팅(세션 cwd 기준)**: ① 전역/워크스페이스 `excludePaths` 밑이면 제외 ② `includePaths` 가 cwd 를 포함하는 워크스페이스 중 가장 긴 접두사 ③ 없으면 `includePaths` 없는 "기본" 워크스페이스가 정확히 하나일 때 그것 ④ 그 외(기본이 둘, 같은 범위 겹침, 해당 없음)는 추적 안 함 — hook 은 조용히 exit 0, monitor 는 무출력, `kanban_status` 가 이유와 경고를 알려 줌. hook·monitor·MCP 보드 도구는 모두 그 세션의 워크스페이스 root·board 를 씁니다(세션은 처음 붙은 워크스페이스에 머뭅니다).
- 설정: `kanban setup --root <폴더> [--name 이름] [--include <프로젝트 폴더>]...` / `kanban_setup`. 새 폴더에 범위가 없는데 이미 기본이 있으면 `needsScope`(종료코드 3)로 아무것도 바꾸지 않습니다 — 어느 프로젝트 폴더를 새 보드로 보낼지 사용자에게 물은 뒤 `--include` 로 다시 실행하세요. 기존 범위를 옮기거나 추측하지 마세요. `--confirm-replace` 는 옛 "단일 root 교체"(추가를 권장).
- 연결 해제: `kanban remove --root <폴더> --confirm` / `kanban_remove`. 설정에서만 빼고(`config.json.bak` 백업) 폴더·파일은 지우지 않습니다. 기본 보드를 빼면 결과의 `defaultRemoved: true` — 범위 밖 폴더 세션은 더 이상 추적되지 않습니다.
- 처음 setup 으로 설정을 고치면 옛 최상위 `root`/`board`/`includePaths` 는 `workspaces` 로 옮겨 씁니다(전역 옵션은 유지, 이전 파일은 `.bak`). 0.7 미만 플러그인은 `workspaces` 만 있는 설정을 못 읽으니 되돌릴 땐 `.bak` 을 쓰세요.

## 팀 보드 (계약 1.1)
- **멤버**: 사람과 LLM. LLM 은 보드에 나온 세션의 종류마다 `llm-claude`·`llm-codex` 처럼 자동으로 생기고, 프로젝트별로 나누려면 `kanban member add 알파 --agent claude --project <작업 폴더 이름>`. 담당이 정해지지 않은 사람 차례는 기본 담당(`kanban member add 민수 --default`)이 봅니다.
- **카테고리**: `kanban label add 개발 --assignees 민수` (기본 담당은 사람이 만든 카드에 카테고리를 붙일 때 담당이 없으면 함께 붙는 담당).
- **맡기기**: 앱에서 사람이 LLM 멤버를 사람 카드(manual)의 담당으로 붙이면 맡긴 것입니다. 세션은 `board_take` → 일하고 → `board_submit`(확인 요청). 완료는 사람이 확인(승인)해야 합니다. LLM 이 만든 카드·붙인 담당은 맡긴 것으로 보지 않고(LLM 끼리 일 시키기 방지), `board_card` 는 사람만 담당으로 붙입니다. `allowAuthors` 는 카드를 만든 사람과 담당을 붙인 사람 모두에게 적용됩니다.
- **풀기**: 맡으면 `takes/<n>.json`, 세션이 끝나면(SessionEnd) `paused` 와 `released.<n>` op(by.author=agent)으로 풀려 다른 세션이 다시 맡을 수 있습니다. 사람이 앱에서 풀거나 담당에서 빼거나 보관하면 맡았던 세션은 Stop·submit·take 때 확인해 더 쓰지 않고 `board_list`·`board_inbox` 에 "회수됨"으로 알립니다. 세션이 비정상 종료(SIGKILL)되면 풀리지 않으니 앱에서 사람이 풉니다. `board_card` 로 만든 카드는 사람 차례(`state: mine`)로 시작합니다.
- **신호**: 프로젝트가 있는 멤버(`--project`)에게 맡긴 카드는 감시 스크립트가 "맡긴 일 N건" 신호를 냅니다(같은 카드 최대 3번). 공용 `llm-<종류>`(project 없는 같은 종류 멤버)에 맡긴 카드는 project 세션도 맡을 수 있지만 신호 없이 `board_list`·`board_inbox` 에서만 보입니다. 감시 스크립트는 수정 시각이 바뀐 카드만 다시 읽고, hook 은 매 도구 호출마다 보드를 훑지 않습니다(SessionStart 때 맡긴 일 개수만 한 번 셉니다).
- **텔레그램**: 사람 차례 알림 끝에 "담당: 민수, 지연"(없으면 "담당: 미정")이 붙습니다.
- **여러 LLM**: Codex 는 `codex/README.md`. hooks 를 붙이지 못한 LLM 은 `kanban agent <start|progress|ask|report|done|fail> --agent gemini --session <id> --name <폴더> --text "…"` 로 스스로 남깁니다(이벤트에 `via:"self"`, 앱에는 "자기 보고"로 표시).

## kanban 명령
`init` · `setup` · `remove` · `status` · `board [--archived]`(텍스트 보드: 담당 [사람]/[LLM]·카테고리·기한, 보관 카드는 숨김 — `--archived` 로 보관함) · `member add|list|remove` · `label add|list|remove`(사람이 터미널에서 설정, `--as 이름` 으로 작성자 이름, 기본 "나") · `agent …` · `doctor` · `probe [-n 30]`(앱 왕복 지연 p50/p90/max, 앱의 측정 화면을 열어 둘 것) · `upload-probe`(맥에서 쓴 파일이 iCloud 에 올라갈 때까지) · `prune --days N [--apply]`(완료 카드를 `boards/<board>/archive/` 로 옮김. 기본은 미리보기, 삭제 없음).

## 끄기
- 잠깐: 설정의 `"enabled": false` (hooks·monitor 가 즉시 아무것도 안 함).
- 프로젝트 제외: `excludePaths`.
- 완전히: 플러그인 비활성화/제거, `~/.config/agent-kanban`, `~/.agent-kanban` 삭제. 클라우드 폴더의 보드는 직접 지우세요(플러그인은 지우지 않습니다).

## 개인정보
클라우드 폴더에 쓰는 것: 세션 폴더 이름(전체 경로 아님), 카드 제목(사람 입력의 첫 줄), 도구 요약(Bash 는 입력의 `description`, 파일 도구는 파일 이름만, 웹은 호스트만), AI 의 마지막 보고, 상태 이벤트, 에이전트가 board_*·`kanban agent` 로 직접 쓴 글(`board_card` 의 제목·설명·체크리스트 포함), 멤버·카테고리 이름.
쓰지 않는 것: 도구 출력, 명령 내용, 파일 내용, 전체 경로. 토큰·키 모양의 문자열(`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=…`, 봇 토큰 등)은 `•••` 로 가리고, 두 마디 이상의 절대 경로는 마지막 이름만 남깁니다. 붙여넣은 덩어리(`pasted_content`)는 제목에서 내용까지 버립니다.
로컬에만 남는 것(`~/.agent-kanban`): 세션별 상태, 락, 오류 로그(1MB 회전, 토큰은 가려서만). 텔레그램을 켜면 제목과 질문 글이 봇 서버로 갑니다.

## 안전
- hooks 는 세션을 방해하지 않습니다: 모든 오류는 로컬 로그에만 남기고 exit 0. Stop 에서 정해진 JSON(폰 의견 전달) 외에는 stdout 에 아무것도 쓰지 않습니다. 권한 요청에 허용/거부를 출력하지 않습니다.
- 폰에서 온 글은 보드 주인의 보통 요청으로 전달되며(되돌리기 어려운 일은 대화에서 재확인) `<` `>` 는 바뀝니다. 의견은 권한 확인·안전 규칙을 바꾸지 못하고, 앱의 "승인"은 Claude Code 권한 확인을 대신하지 않습니다.
- 전달 길: Stop hook 이 본문을 직접 넘기거나(`via stop`), 감시 스크립트가 본문 없는 신호 한 줄을 내면 에이전트가 `board_inbox` 로 읽습니다(`via inbox`). 신호는 항목당 1회, 10분 안 읽히면 다시(최대 3회).

## 개발
`bun test`(임시 폴더·가짜 텔레그램 서버만 사용), `bun run typecheck`. 환경변수: `AGENT_KANBAN_STATE`(로컬 상태 위치), `AGENT_KANBAN_LOG`, `AGENT_KANBAN_AGENT`(hook·MCP 의 LLM 종류, `--agent` 가 우선), `AGENT_KANBAN_SESSION`(`kanban agent` 의 세션 id 기본값).
