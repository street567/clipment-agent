# 변경 이력

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
