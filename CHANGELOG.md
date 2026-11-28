# 변경 이력

## Unreleased (0.9.1)
- **새 프로젝트를 올릴 워크스페이스를 짐작하지 않기** (MCP 지침·`skills/apply-feedback`). 사람이 이름을 말했거나 연동 프롬프트·요청에 적힌 워크스페이스만 쓰고, 정해지지 않았으면 `list_workspaces` 후보를 보여 주고 먼저 묻는다. 제목·파일 이름이 워크스페이스 이름과 비슷하다고 고르지 않는다("슬라이드 …" 영상이 `slide-base` 로 들어간 일).

## Unreleased (0.9.0)
- **에이전트 칸반: 반영 요청 (계약 1.3, 추가만, SPEC §17)**. 폰이 `boards/<b>/requests/<id>.json`(`{schema,id,kind:"apply",cardIds,to,authorName,created}`)을 쓰면 살아 있는 세션 하나가 `requests/<id>.taken.json` 을 배타 생성해 맡고, 카드에 남긴 사람 응답(승인·선택·수정 요청·코멘트)을 `board_inbox`/Stop 으로 한 덩어리(요청자·카드·미전달 응답·보드 주인의 보통 요청 + 코멘트와 같은 안전 문구)로 받습니다. 처리하면 평소처럼 receipt 가 남아 두 번 전달되지 않고, 끝나면 `requests/<id>.done.json`(`handled`·`skipped`).
- 맡는 규칙: `to`(레인 agentKey)가 있으면 그 레인의 지금 세션만. 없으면 가장 좋은 순위의 세션 — ① 카드 주인(세션·레인) ② 같은 컴퓨터·프로젝트 폴더 이름이 카드 세션 `name` 과 같은 세션 ③ 아무 세션(감시 틱 2번 기다림). 같은 순위는 session id 가 작은 쪽이 먼저, 나머지는 2틱 뒤. 경주는 `.taken` 배타 생성이 하나만 이기게 함. 24시간 넘은 요청은 맡지 않음.
- 새 MCP 도구 `board_request_done(request_id, handled?, skipped?)`(이 세션이 맡은 요청만, 한 번만). 의견이 모두 전달되고 세션이 쉬면 자동으로도 done. 요청에 든 다른 세션의 카드에도 `board_reply` 가능. 요청은 카드를 만들지 않음.
- **주인 없는 카드 이어받기**: 카드 주인 세션이 끝났거나 5분 넘게 신호가 없고(1분 넘게 이어질 때) 미전달 사람 응답이 있으면, 같은 폴더 이름 세션 → 아무 살아 있는 세션 순으로 하나가 `board_inbox` 로 이어받음. 설정 `adoptOrphans`(기본 `true`)로 끔. 전달은 항상 receipt 배타 생성이 정함.
- "살아 있는 세션" = now.json 이 ended/replacedBy 가 아니고 `aliveAt` 2분 이내. 그래서 감시의 `aliveAt` 갱신 주기를 5분 → 1분으로. 앱이 대상 목록을 만드는 법은 SPEC §17.2.
- 새 보드의 `kanban.json` 은 `contract:"1.3"`. 스펙 사본 `spec-kanban/` 은 agent-kanban 의 `spec/` 과 동일(스키마 `request`·`request-taken`·`request-done`, 잘못된 픽스처 검사 추가).

## Unreleased (0.8.0)
- **에이전트 칸반: 컴퓨터 이름 + 레인으로 카드 이름·이어짐 (계약 1.2, 추가만)**. 카드는 `<컴퓨터 이름> · <레인>`. 같은 컴퓨터·레인의 재시작 세션은 같은 카드에 이어지고(`replaced` 이벤트 "새 세션으로 이어짐", 이전 세션은 ended), 코멘트·처리는 지금 살아 있는 세션이 받음(동시에 둘이면 가장 새 세션이 이기고 옛 세션은 별도 카드+경고).
- 컴퓨터 이름: 설정 `machineName` → macOS ComputerName → hostname. 새 도구 `kanban_machine(name?)`, CLI `kanban machine [--name N]`, `kanban_status` 에 `machine`(·세션이면 `session` 레인 정보).
- 레인 감지 순서: `AGENT_KANBAN_LANE` → `TELEGRAM_STATE_DIR` 폴더 이름(`telegram-<x>`→x) → tmux 세션 이름(설정 `laneStripPrefixes`, 숫자만 있는 이름 무시) → 작업 폴더. 앞의 셋만 이어지고 폴더만인 세션은 옛 방식(세션별 카드).
- `kanban merge-lanes [--dry-run|--apply] [--lane N]`: 같은 컴퓨터·레인(옛 카드는 폴더 이름)의 세션 카드 중복을 `archive/` 로 옮김(미리보기가 기본, 삭제 없음). 기존 카드는 그대로.
- 새 보드의 `kanban.json` 은 `contract:"1.2"`(옛 폴더는 불변). 1.1 리더(앱 포함)는 모르는 필드·type 을 무시하고 MAJOR 만 비교하므로 읽기 전용이 되지 않음. 스킬·MCP 안내에 이름 규칙 추가(이름을 지어내지 않기, 설정 순서 `kanban_status` → `kanban_machine` → `kanban_setup`).
- `kanban_setup` 이 `kanban_machine` 이 먼저 만든 설정(이름만 있음)을 거부하지 않고 이름을 보존.

## Unreleased (0.7.0)
- **에이전트 칸반: 여러 보드 폴더(워크스페이스)**. 설정 `workspaces: [{ name?, root, board?, includePaths?, excludePaths? }]`; 옛 단일 `root` 설정은 그대로 동작(둘 다 있으면 `workspaces` 우선, 옛 `root` 는 추가로 붙음). 세션 cwd 로 보드 결정: includePaths 가장 긴 접두사 → 기본(범위 없는) 보드 하나 → 아니면 추적 안 함(모호하면 경고). hook·monitor·MCP 도구가 세션의 보드를 씀. 칸반 계약·클라우드 폴더 구조는 변경 없음.
- `kanban_setup` 에 `name`·`includePaths`, 결과 `created|added|updated|unchanged|needsScope|replaced`(+전체 `workspaces`). 새 폴더에 범위가 없고 이미 기본 보드가 있으면 `needsScope` 로 아무것도 바꾸지 않음. 모든 변경 전 `config.json.bak` 백업.
- `kanban_status` 가 모든 워크스페이스·현재 세션이 가는 보드·경고(기본 둘/범위 겹침/닿지 않는 root)를 보고. 새 `kanban_remove`/`kanban remove --root --confirm`(설정에서만 뺌, 폴더는 안 지움).
- 주의: setup 으로 설정을 고치면 옛 최상위 `root` 가 `workspaces` 로 옮겨져 0.6 이하 플러그인은 그 설정을 못 읽음(`.bak` 으로 복구).

## 0.6.0
- **이름 변경**: 저장소 `street567/clipment-agent` → `street567/client-ai-bridge`, 마켓플레이스 `street567`, 플러그인 `client-ai-bridge` (이전: `clipment@clipment-agent`). 설치 `claude plugin marketplace add street567/client-ai-bridge` → `claude plugin install client-ai-bridge@street567`.
- **에이전트 칸반 합치기**: 별도 `agent-kanban` 플러그인을 한 플러그인으로 합침(`src/kanban/`, hooks·monitor·스킬 `kanban`·MCP 서버 `kanban`·`kanban` CLI). 보드 폴더를 설정하기 전에는 완전히 꺼져 있음. 새 도구 `kanban_setup`·`kanban_status`, CLI `kanban setup|status`(`clipment kanban …` 로도). 칸반 계약 1.1 은 그대로.
- **업로드 글(계약 1.12)**: `src/core/posts.ts`, 도구 `get_posts`·`write_post`·`add_post_target`·`reorder_post_targets`, CLI `posts`·`post-write`·`post-targets`, 요청 type `write_post`.
- 업데이터: GitHub API 와 origin 검사가 새 이름을 쓰고, 예전 `street567/clipment-agent` origin(https/ssh)의 기존 클론도 계속 업데이트됨. `install.sh`: 새 이름, `~/.local/bin/kanban` 링크, 예전 플러그인이 있으면 제거 제안(y/N). 설치 위치 `~/.clipment/agent` 와 데이터 경로는 그대로.
- 유지(호환): package.json `name` 과 릴리스 tar.gz 이름은 `clipment-agent`, 환경변수 `CLIPMENT_*`/`CLIPREV_*`, mcpb 확장 이름 `clipment`.
- **업그레이드(기존 사용자)**:
  ```
  claude plugin uninstall clipment@clipment-agent
  claude plugin marketplace remove clipment-agent
  claude plugin marketplace add street567/client-ai-bridge
  claude plugin install client-ai-bridge@street567
  ```
  그다음 Claude 세션을 새로 시작. (이전 이력은 git log 참고 — 이 파일은 0.6.0 부터.)
