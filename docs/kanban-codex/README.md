# Codex 에 에이전트 칸반 붙이기

Claude Code 와 같은 hook 스크립트(`plugin/src/hook.ts`)를 `--agent codex` 로 쓰면 Codex 세션도 같은 보드에 기록됩니다(계약 `../../spec/SPEC.md` §15). 이 폴더의 파일은 **예시**이며, 이 저장소는 사용자의 `~/.codex` 를 절대 건드리지 않습니다. 설치는 아래 순서로 직접 하세요.

## 준비
1. `kanban init` 으로 설정·보드 폴더를 만듭니다(Claude Code 쪽과 같은 설정 파일을 씁니다).
2. 보드에서 멤버를 정합니다. Codex 세션은 자동으로 기본 멤버 `llm-codex`(이름 "Codex")가 됩니다. 프로젝트마다 나누려면 `kanban member add 코덱스-앱 --agent codex --project <작업 폴더 이름>`.

## hooks 설치 (사용자가 직접)
1. `hooks.json.example` 을 복사해 `/ABSOLUTE/PATH` 를 이 저장소의 절대 경로로 바꿉니다.
2. 저장 위치(문서 기준): 사용자 전체 `$CODEX_HOME/hooks.json`(기본 `~/.codex/hooks.json`), 또는 신뢰한 프로젝트의 `.codex/hooks.json`.
3. Codex 를 열고 `/hooks` 에서 새 hook 을 **직접 검토하고 신뢰**합니다. 신뢰하기 전에는 실행되지 않습니다(정의가 바뀌면 다시 검토). `--dangerously-bypass-hook-trust` 는 쓰지 마세요.
4. 명령 대신 환경변수로 종류를 줄 수도 있습니다: `AGENT_KANBAN_AGENT=codex`.

기록되는 이벤트: SessionStart · UserPromptSubmit(turn_id 를 prompt_id 로) · PostToolUse(도구 요약만, 패치·명령 내용은 쓰지 않음) · PermissionRequest(권한 확인 카드) · Stop · Interrupt(중간에 끊김 → "멈춤"으로 정리) · SessionEnd. Task 이벤트는 Codex 에 없어 세션 카드와 맡은 카드만 씁니다.

## 폰의 의견 전달
Codex 의 Stop hook 은 `{"decision":"block","reason":"…"}` 로 이어 가므로, 폰에서 남긴 의견이 있으면 그 글이 다음 지시로 전달되고 Codex 가 계속 일합니다(없으면 출력 없음). 감시 스크립트(monitor)는 Claude Code 플러그인 전용이라 Codex 에서는 쓰지 않습니다 — Stop 때와 `board_inbox` 로 받습니다.

## 보드 MCP (선택)
`config.toml.example` 의 `[mcp_servers.kanban]` 을 Codex 설정에 옮기면 board_ask · board_card · board_take · board_submit 등을 쓸 수 있습니다. 환경변수 `AGENT_KANBAN_AGENT=codex` 가 있어야 작성자 이름이 "Codex" 로 남습니다.

## 확인한 것 / 확인하지 못한 것
확인(문서 https://learn.chatgpt.com/docs/hooks, 2026-11-25): 모든 hook 이 stdin 으로 `session_id`·`transcript_path`·`cwd`·`hook_event_name`·`model` 을 받음 · 턴 단위 이벤트에 `turn_id` · Stop 은 JSON `decision:"block"`+`reason` 으로 이어 감(평문 출력은 무효) · Interrupt 이벤트(타임아웃 1~3초) · PermissionRequest 는 출력 없이 두면 기본 승인 흐름 · hook 은 사용자가 검토·신뢰해야 실행.
**미확인**: ① Codex 세션 id 형식(`thr_…` 같은 예시만 있음 → 형식이 다르면 `sha256(codex|원래 id)` UUID 모양으로 바꿔 씁니다) ② MCP 서버가 어느 세션인지 아는 방법(Codex 가 MCP 프로세스에 세션 id 환경변수를 주는지 모름 → hook 이 남긴 프로세스 매핑을 조상 프로세스로 찾는데, 실제 Codex 에서의 동작은 직접 확인 필요) ③ `config.toml` 의 MCP 서버 설정 형식 ④ `codex exec`(헤드리스)에서 hook 이 도는지 — Codex 에는 Claude Code 식 헤드리스 판별을 쓰지 않습니다 ⑤ Codex 의 도구 이름 중 `apply_patch`·`spawn_agent` 외 이름의 요약(그 밖은 도구 이름만 씁니다).
