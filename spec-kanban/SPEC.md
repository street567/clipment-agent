# 에이전트 칸반 폴더 계약 (맥 플러그인 ↔ iPhone 앱)

**계약 버전 1.3.0** (`spec/contract.json` 과 같아야 함)

서버·로그인 없음. 두 쪽은 **사용자 클라우드 폴더의 파일로만** 대화한다. 이 문서가 두 구현의 유일한 계약이다.
기존 클립멘트 계약(`../clip-review/spec/SPEC.md`)의 규칙을 그대로 따른다(§1). 원래 PRD 와 다른 점과 이유는 `docs/기존구조-비교.md`.

## 0. 루트 폴더
- 사용자가 고른 폴더. 맥 기본값 `~/Library/Mobile Documents/com~apple~CloudDocs/Agent Kanban/` (설정 `~/.config/agent-kanban/config.json` 의 `root`, 환경변수 `AGENT_KANBAN_ROOT` 가 우선).
- 아이폰은 폴더 선택기로 같은 폴더를 고르고 보안 범위 북마크로 저장한다(iCloud entitlement 불필요, 나중에 다른 클라우드도 가능).

## 1. 공통 규칙
- **불변**: 파일은 한 번 쓰고 고치지 않는다. 상태 변화는 새 파일로. 예외는 §3 `now.json` 하나(그 세션을 돌리는 맥만 쓴다 — 쓰는 쪽이 항상 하나).
- 쓰기: 같은 폴더 `.<name>.tmp` 에 쓰고 rename. 이미 있으면 실패(덮어쓰지 않음).
- 읽기: `.name.icloud` 자리표시자·dataless 는 내려받기를 요청하고 이번엔 건너뛴다. 점으로 시작하는 파일 무시. 깨진 JSON 은 없는 것으로 보고 다음에 다시.
- 모르는 필드·모르는 `type` 은 무시. 시각은 ISO 8601 UTC 밀리초(`2026-11-25T01:23:45.678Z`). 순서는 `created`(같으면 id).
- 파일 이름(확장자 제외)이 id. id 는 `[0-9a-f-]{8,64}` 또는 세션 id(`[A-Za-z0-9-]{8,64}`). 그 밖은 무시(경로 탈출 방지).
- 텍스트 길이: 제목 120, 요약 200, 보고 4000, 코멘트 4000자. 넘치면 쓰는 쪽이 자르고 `…`.
- **비밀 줄이기(맥)**: 도구 입력은 정해진 요약만 쓴다(§4). 도구 출력은 절대 쓰지 않는다. 보고·제목·요약은 토큰·키 모양(`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`, `password=…`, 텔레그램 봇 토큰 등)을 `•••` 로 가린다.

## 2. 구조
```
<root>/
  kanban.json                                  # {schema,contract:"1.0"|"1.1"|"1.2"|"1.3",name,created} 불변(리더는 MAJOR 만 본다 §10)
  boards/<boardId>/                            # 기본 "main" ([a-z0-9-]{1,32})
    board.json                                 # {schema,id,title,created}
    ops/<opId>.json                            # 보드 설정 변경 (1.1, §11)
    sessions/<sessionId>/session.json          # {schema,id,name,agent?,created}  name=작업 폴더 이름(전체 경로 아님), agent=LLM 종류(1.1, 없으면 "claude"), machine?·lane?·agentKey?(1.2, §16)
    sessions/<sessionId>/now.json              # 고쳐 쓰는 파일 (§3)
    cards/<cardId>/card.json                   # {schema,id,sessionId,kind,title,detail?,created, agentKey?,lane?,machine?(1.2 레인 카드, §16)}
    cards/<cardId>/events/<eventId>.json       # 맥만 (§5)
    cards/<cardId>/comments/<commentId>.json   # 사람(앱)·에이전트(맥) (§6)
    cards/<cardId>/actions/<actionId>.json     # 앱만 (§7)
    cards/<cardId>/receipts/<id>.json          # 맥만: 코멘트·처리 결과가 세션에 전달됨 (§8)
    cards/<cardId>/ops/<opId>.json             # 카드 속성 변경: 담당·카테고리·기한·체크리스트 등 (1.1, §11)
    cards/<cardId>/takes/<n>.json              # 맥만, 배타 생성(n=1,2,…): 어떤 세션이 이 카드를 맡음 (1.1, §14)
    requests/<id>.json                         # 앱만, 불변: 반영 요청 (1.3, §17)
    requests/<id>.taken.json                   # 맥만, 배타 생성: 어느 세션이 맡았나 (1.3, §17)
    requests/<id>.done.json                    # 맥만, 한 번: 다 했다 (1.3, §17)
  probes/<id>.json, probes/<id>.echo.json      # 지연 측정 (§9)
```
- `kind`: `session`(세션마다 하나, "이 세션이 지금 하는 일") · `task`(LLM 의 Task 하나) · `ask`(에이전트가 board_ask 로 연 사람 차례) · `manual`(1.1: 사람이 앱에서, 또는 에이전트가 board_card 로 만든 카드. `sessionId` 없음(에이전트가 만들면 있음), `cardId` 는 무작위 UUID, `by` 있음 §11).
- `cardId`: 결정적. `sha256("<kind>|<sessionId>|<key>")` 앞 32 hex 를 UUID 모양(8-4-4-4-12)으로. key = session 은 `""`, task 는 task_id, ask 는 무작위 UUID.

## 3. now.json (지금 하는 일)
```json
{ "schema":1, "sessionId":"…", "state":"working", "cardId":"…", "summary":"파일 고치는 중: Player.swift", "tool":"Edit", "ts":"…", "aliveAt":"…" }
```
- `state`: `working` | `idle` | `ended`. 도구 호출마다 갱신하되 최소 간격 5초(상태가 바뀌면 즉시). `aliveAt` 은 감시 스크립트가 1분마다 갱신한다(1.3 전에는 5분. "살아 있는 세션" §17 은 2분 안).
- 카드의 "지금 하는 일" = 그 카드가 `AI 작업 중`이고 세션 now.json 의 `cardId` 가 그 카드일 때 `summary`. 아니면 마지막 progress 이벤트의 `summary`.
- 1.2: 새 세션이 레인을 이어받으면 맥이 이전 세션의 now.json 을 `state:"ended"` + `replacedBy`(새 세션 id)로 고쳐 쓴다(같은 맥이 도는 세션이라 "쓰는 쪽이 하나"를 지킨다).
- 앱: `aliveAt`·`ts` 중 최근이 15분보다 오래되면 "세션 신호 없음"으로 표시한다(카드는 옮기지 않는다).

## 4. 도구 요약 (맥)
Bash=입력의 `description`(없으면 "명령 실행") · Read/Edit/Write/NotebookEdit=파일 이름만 · Grep/Glob="검색" · WebFetch=호스트만 · WebSearch="웹 검색" · Agent/Task="보조 에이전트: <description>" · MCP 도구=`서버 · 도구` 이름만 · 그 밖=도구 이름. 입력의 다른 값은 쓰지 않는다.

## 5. 이벤트와 리스트
```json
{ "schema":1, "id":"…", "cardId":"…", "sessionId":"…", "type":"needs_human", "summary":"…", "tool":"Bash",
  "title":"…", "ask":{"kind":"decide","options":["A","B"]}, "ref":"…", "created":"…" }
```
`type`:
- `created` 만들어짐 → 대기
- `replaced` (1.2) 레인 카드를 새 세션이 이어받음. `from`=이어받기 전 세션 id, `sessionId`=새 세션. 리스트·상태를 바꾸지 않는다(§16)
- `progress` 일하기 시작/이어서(상태가 바뀔 때만 쓴다; 매 도구 호출은 now.json) → AI 작업 중. `title` 이 있으면 카드 제목을 바꾼다(가장 최근 것).
- `paused` 세션이 멈췄는데 일이 안 끝남 → 대기(라벨 "멈춤")
- `needs_human` 내 차례를 연다. `ask.kind`: `approve` 승인 · `decide` 결정(`options` 2~6) · `do` 사람이 할 일 · `info` 터미널에서만 답할 수 있음(권한 확인 등 — 앱은 처리 버튼을 보이지 않는다)
- `resolved` `ref`=닫을 needs_human id
- `report` 마지막 보고(`summary` 최대 4000). 리스트를 바꾸지 않는다.
- `done` 끝남 → 완료
- `failed` 실패(API 오류·로그인 만료 등) → 내 차례(라벨 "문제")

**카드의 리스트**(순수 함수, 두 구현이 같아야 함 — `spec/fixtures/derive.json` 으로 검증):
1. `created` 순으로 읽어 기본 상태를 구한다: created→waiting, progress→working, paused→waiting, done→done, failed→failed. 없으면 waiting. 나머지 type 은 기본 상태를 바꾸지 않는다.
2. 열린 요청 = `needs_human` 중, 같은 카드의 `resolved.ref` 나 `actions[].ref` 가 가리키지 않고, 그보다 뒤에 `done` 이 없는 것. (`info` 는 그보다 뒤의 `progress`/`paused`/`done`/`failed` 로도 닫힌다.)
3. 열린 요청이 있으면 **내 차례**. 없고 기본 상태가 failed 면 **내 차례**. 아니면 waiting→**대기**, working→**AI 작업 중**, done→**완료**.
- 마지막 보고 = 가장 최근 `report.summary`. 정렬: 내 차례·AI 작업 중은 최근 이벤트가 위, 대기는 오래된 것이 위, 완료는 최근 것이 위.

## 6. 코멘트
```json
{ "schema":1, "id":"…", "cardId":"…", "author":"user", "authorName":"개미", "text":"…", "replyTo":null, "created":"…" }
```
- `author`: `user`(앱) | `agent`(맥). 에이전트의 처리 결과는 `author:"agent"` + `replyTo`=사람 코멘트 id.
- 처리 상태(앱 표시): 에이전트 답이 있으면 "처리됨", 없고 receipt 가 있으면 "전달됨", 둘 다 없으면 "보냄".

## 7. 내 차례 처리 (actions)
```json
{ "schema":1, "id":"…", "cardId":"…", "ref":"<needs_human id>", "kind":"approve", "choice":null, "text":"", "authorName":"개미", "created":"…" }
```
- `kind`: `approve` | `reject` | `choose`(`choice`=옵션 글) | `done`. `ref` 하나에 첫 action(가장 이른 created)만 유효.
- 이것은 **사람의 답을 에이전트에게 전하는 것**이며 Claude Code 의 권한 확인을 대신 누르지 않는다.

## 8. 전달 (맥 → 세션)
- 대상: 그 세션 카드의 `author:user` 코멘트와 action 중 receipt 가 없는 것. 설정 `allowAuthors` 가 있으면 `authorName` 이 목록에 있는 것만(나머지는 전달하지 않고 남겨 둔다).
- `receipts/<id>.json` 을 **배타적으로 만든 쪽**만 본문을 넘긴다(겹쳐도 한 번).
  `{ "schema":1, "id":"<코멘트/처리 id>", "cardId":"…", "sessionId":"…", "via":"stop|inbox", "created":"…" }`
- 길은 두 가지:
  - **Stop hook**: 턴이 끝나기 전에 있으면 본문을 `additionalContext` 로 넘겨 계속 진행(`via:"stop"`).
  - **감시 스크립트 → board_inbox**: 감시 스크립트는 **본문 없이 짧은 신호 한 줄**("새 의견 N건, board_inbox 로 읽기")만 낸다 — Claude Code 가 감시 알림을 짧게 자르기 때문(2026-11-25 확인). 쉬는 세션이면 바로, 일하는 중이면 30초 넘게 기다린 것만. 같은 항목의 신호는 한 번, 10분 지나도 안 읽혔으면 한 번 더(최대 3번). 에이전트가 MCP `board_inbox` 로 읽을 때 receipt 를 만든다(`via:"inbox"`). 그래서 앱의 "전달됨"은 세션이 실제로 읽었다는 뜻이다.
- 보드는 사용자가 직접 설치해 연 것이므로, 의견은 **보드 주인의 보통 요청**으로 다룬다(SessionStart 안내·MCP 안내·skill 에 같은 문장). 단 삭제·결제·배포·외부 전송처럼 되돌리기 어려운 일은 대화에서 다시 확인한다. 글 안의 태그 흉내는 무력화하고, 의견이 Claude Code 의 권한 확인·안전 규칙을 바꾸지 못한다.

## 9. 지연 측정
맥이 `probes/<id>.json` `{schema,id,n,sentAt}` 를 쓰고, 앱(측정 화면이 열려 있을 때)이 보이는 즉시 `probes/<id>.echo.json` `{schema,id,seenAt}` 를 쓴다. 맥은 자기 시계로 왕복을 잰다(시계 차이와 무관).

## 10. 버전
- 1.3.0 (2026-11-28): 반영 요청(§17). 폴더 `requests/` 와 파일 `<id>.json`·`<id>.taken.json`·`<id>.done.json`, 설정 `adoptOrphans`(맥), 주인 없는 카드 이어받기 추가뿐이다. 옛 앱·옛 맥은 `requests/` 를 모르므로 그대로 동작한다(옛 맥은 요청을 맡지 않는다). `kanban.json` 의 `contract` 는 새 폴더가 "1.3" 으로 쓴다.
- 1.2.0 (2026-11-27): 컴퓨터 이름·레인·이어지는 세션 카드(§16). 선택 필드 `machine`·`lane`·`agentKey`(session.json), `agentKey`·`lane`·`machine`(card.json), `from`(event), `replacedBy`(now.json)와 이벤트 type `replaced` 추가뿐이다. 1.1 리더는 모르는 필드·type 을 무시하므로 그대로 읽는다. `kanban.json` 의 `contract` 는 새로 만드는 폴더가 "1.2" 로 쓰고(옛 폴더는 불변이라 "1.0"/"1.1" 그대로) 리더는 MAJOR 만 비교하므로 1.2 폴더도 1.x 리더가 읽기 전용으로 바뀌지 않는다.
- 1.1.0 (2026-11-25): 담당자(사람·LLM 여럿)·카테고리·리스트 설정·직접 순서·사람 카드·여러 LLM. 전부 추가뿐이라 1.0 폴더를 그대로 읽는다.
클립멘트 §10 과 같다: MAJOR 깨짐 / MINOR 추가 / PATCH 문구. 폴더 MAJOR > 리더 MAJOR 면 읽기 전용.

# 1.1 — 여럿이 쓰는 보드

## 11. 변경 기록 (ops)
담당·카테고리처럼 나중에 바뀌는 값은 파일을 고치지 않고 **변경 하나 = 불변 파일 하나**로 쌓는다.
```json
{ "schema":1, "id":"…", "cardId":"…", "by":{"author":"user","name":"민수","member":"u-minsu"},
  "set":{ "assignee.u-minsu":true, "label.l-dev":true, "due":"2026-11-28" }, "created":"…" }
```
- 위치: 카드 것은 `cards/<id>/ops/`, 보드 것은 `boards/<b>/ops/`(`cardId` 없음). 쓰는 이: 앱과 맥 모두. `by.author` = `user` | `agent`. `by.member` 는 없을 수 있다.
- **합치기**: `created` 순(같으면 id)으로 읽어 **열쇠마다 마지막 값이 이긴다**. 값 `null` = 지움(없던 것과 같음). 모르는 열쇠는 무시. 값의 모양이 틀린 열쇠는 그 열쇠만 무시(앞의 값 유지).
- 쓰는 쪽은 지금까지 읽은 ops 의 가장 늦은 `created` 보다 최소 1ms 뒤 시각을 쓴다(기기 시계 차이 완화).
- 바뀐 열쇠만 쓴다(담당 한 명 추가 = 열쇠 하나). 그래서 두 사람이 동시에 다른 것을 바꿔도 둘 다 남는다.
- `set` 은 열쇠 1~200개.

카드 열쇠:
| 열쇠 | 값 |
|---|---|
| `title` | 글 1~120 (manual 카드만 유효) |
| `detail` | 글 ≤4000 (manual 카드만) |
| `assignee.<memberId>` | `true` |
| `label.<labelId>` | `true` |
| `due` | `"YYYY-MM-DD"` |
| `check.<itemId>` | `{"text":글 1~200,"done":bool,"rank":수,"assignee"?:memberId}` |
| `list` | listId (§13 사용자 리스트 배치) |
| `state` | `waiting`\|`working`\|`mine`\|`done` (manual 카드만, §12) |
| `archived` | `true` (보관. 보드에서 숨기고 보관함에만) |
| `released.<n>` | `true` (n 번째 맡음이 풀림, §14) |

보드 열쇠:
| 열쇠 | 값 |
|---|---|
| `member.<memberId>` | `{"name":글 1~20,"kind":"human"\|"llm","agent"?:종류,"project"?:글,"color"?:0~9,"rank"?:수}` |
| `label.<labelId>` | `{"name":글 1~20,"color":0~9,"rank":수,"assignees"?:[memberId]}` |
| `list.<listId>` | `{"title":글 1~20,"base":"waiting"\|"working"\|"mine"\|"done","rank":수}` |
| `rank.<cardId>` | 수 (§13) |
| `defaultHuman` | memberId (담당이 안 정해진 사람 차례의 담당) |
- `memberId`·`labelId`·`listId`·`itemId`: `[a-z0-9-]{1,64}`. `수` 는 유한한 실수. 카테고리의 `assignees` = 기본 담당: 앱·맥이 **manual 카드에 카테고리를 붙일 때 담당이 한 명도 없으면** 그 담당을 같은 op 에 함께 쓴다(읽을 때 끼워 넣지 않는다).

## 12. 담당 (누가 하나)
- **멤버** = 보드 ops 의 `member.*` + 기본 LLM 멤버 `llm-<agent>`(보드에 나온 세션의 agent 마다 자동. 같은 id 의 `member.` 값이 있으면 그것이 이긴다). 지운(null) 멤버가 담당으로 남아 있으면 "지운 멤버"로 표시한다.
- `agent`: `claude`|`codex`|`gemini`|그 밖 `[a-z0-9-]{1,20}`. 기본 이름: Claude·Codex·Gemini·그 밖은 그대로.
- **세션 → LLM 멤버**(`memberForSession`): `kind=="llm"` 이고 `agent` 가 같고 `project`==세션 name 인 것(rank, id 순 첫째) → 없으면 `llm-<agent>`. `project` 가 있는 멤버로 "알파(Claude)", "브라보(Claude)"처럼 세션별 담당을 나눈다.
- **카드 담당**(`assignees`): ops 의 `assignee.*` 중 true. manual 이 아닌 카드에 LLM 담당이 하나도 없으면 세션의 LLM 멤버를 앞에 더한다.
- **지금 움직일 사람/LLM**(`actors`, 카드 맨 위에 보이는 것):
  1. 열린 요청이 있으면: 맨 앞 요청의 `ask.to`(멤버 id 배열) 중 사람 → 비면 카드의 사람 담당 → 비면 `defaultHuman` → 비면 빈 배열("담당 미정 · 사람").
  2. 없고 리스트가 mine(문제·manual 의 state mine) 이면: 카드의 사람 담당 → defaultHuman → 빈 배열("담당 미정 · 사람").
  3. 그 밖: 카드 담당 전부(비면 빈 배열 "담당 미정").
- **카드 성격**(`nature`, 색·모양): actors 에 사람만 → `human`, LLM 만 → `llm`, 둘 다 → `both`, 비면 1·2 의 경우 `human`, 3 은 `none`. 정렬: 사람 먼저, 그다음 rank(없으면 1e9), id. 지운(모르는) 멤버는 맨 뒤이고 성격을 정할 때 빼며, 남는 것이 없으면 빈 것과 같다.
- 담당·성격·리스트·순서는 순수 함수이고 두 구현이 같아야 한다 — `spec/fixtures/team.json`(`checks` 는 [id, 글, done] 을 rank 순으로, `expect` 에 있는 것만 비교).
- 여러 사람이 담당이면 **누구든 먼저 처리한 것**이 유효하다(§7 첫 action). action 에 `authorMember`(선택)를 적어 누가 처리했는지 보인다. 코멘트도 `authorMember`(선택).
- `needs_human` 의 `ask.to`: [memberId] (선택, 최대 8). `ask.kind` 에 `check`(맡긴 일의 결과 확인, §14) 추가.

**manual 카드의 리스트**: §5 에서 기본 상태를 구할 때 이벤트와 `state` ops 를 한 줄로 세워(`created`, 같으면 id) 마지막 것이 이긴다. `state` 값 mine 은 기본 상태 `turn` → 열린 요청이 없으면 **내 차례(mine)**. 처음 값은 waiting. `state` op 이 이벤트 뒤에 오면 그보다 앞의 열린 요청은 닫힌 것으로 본다. `state` 는 manual 이 아닌 카드에서는 무시한다(LLM 카드의 상태는 hooks 만 바꾼다).
**check 요청**: 그 요청의 첫 action 이 `approve` 면 그 시각에 `done` 이벤트가 있는 것으로, `reject` 면 `paused` 가 있는 것으로 본다(카드 kind 는 무관하지만 `ask.kind` 가 check 인 요청에만).

## 13. 리스트와 순서
- 기본 리스트 4개: id `mine`(사람 차례) `working`(진행 중) `waiting`(대기) `done`(완료), base 는 자기 자신, rank 0·1·2·3. `list.<같은 id>` op 로 이름·rank 를 바꿀 수 있고 base 는 못 바꾼다. 없앨 수 없다(null = 기본값으로).
- 사용자 리스트: `list.<id>`. null 이면 사라지고 그 카드들은 기본 리스트로.
- **카드가 보이는 리스트**: 파생된 base B 에 대해, 카드 ops 의 `list` 가 가리키는 리스트가 있고 그 base==B 면 거기, 아니면 기본 리스트 B. 그래서 LLM 이 일을 시작하면 "나중에"(base waiting)에 두었던 카드도 저절로 "진행 중"으로 간다.
- **옮기기**: manual 카드는 어디로든(대상 base 가 지금 base 와 다르면 `state` 와 `list` 를 한 op 에). LLM 카드는 base 가 같은 리스트끼리만. 다른 곳에 놓으면 되돌리고 이유를 알린다. 열린 요청이 있는 manual 카드를 옮기면 요청이 닫히므로(§12) 확인을 받는다.
- **직접 순서**: `rank.<cardId>` 없으면 `-(card.created 의 epoch 초)`(새 카드가 위). 작은 것이 위, 같으면 id. 사이에 놓기 = 두 이웃의 가운데. 벌어진 틈이 1e-6 보다 작으면 그 리스트 전체를 1 간격으로 다시 매긴다. 자동 정렬 상태에서 끌어 놓으면 **보이던 순서 그대로** 리스트 전체의 rank 를 한 보드 op 에 쓰고 직접 순서로 바꾼다.
- 정렬 방식(리스트마다, 기기에만 저장): 자동(§5) · 직접 순서 · 최근 변경 · 오래 기다린 순 · 만든 날(새것/옛것) · 기한 · 담당 · 카테고리 · 제목.

## 14. LLM 에게 맡기기
- manual 카드에 LLM 멤버를 담당으로 붙이면 맡긴 것이다(§8 과 같이 보드 주인의 보통 요청, `allowAuthors` 는 카드 `by.name` **과** 그 assignee op 의 `by.name` 둘 다에 적용). 에이전트가 만든 카드·붙인 담당(`by.author=="agent"`)은 맡긴 것으로 보지 않는다(LLM 끼리 일을 시켜 도는 것 방지).
- 대상 세션: `memberForSession` 이 그 멤버인 세션. 멤버에 `project` 가 있으면 감시 스크립트가 §8 처럼 신호("맡긴 일 N건, board_inbox 로 읽기")를 낸다. 없으면(`llm-claude` 같은 공용) 신호 없이 `board_list`·`board_inbox` 에서만 보인다(아무 세션이나 깨우지 않는다).
- 맡을 수 있는 세션: 카드의 LLM 담당이 `memberForSession` 이거나, `project` 없는 같은 agent 의 멤버(공용)인 세션.
- 세션은 `board_take(card_id)` 로 맡는다: `takes/<n>.json` `{schema,cardId,sessionId,created}`(파일 이름 n 은 1부터 정수, n = 지금 가장 큰 번호 + 1)를 배타 생성한 세션만. **지금 맡은 세션** = 가장 큰 n 의 take 인데 카드 ops 에 `released.<n>` 이 없을 때. 있으면 비어 있다(다른 세션이 다시 맡을 수 있음). 안 풀렸으면 새로 맡을 수 없다.
- 푸는 때: 세션이 끝날 때(SessionEnd) 맥이 풀고 `paused`, 사람이 앱에서 "맡은 것 풀기", 사람이 그 카드의 `state` 를 바꿀 때 앱이 같은 op 에 함께, 담당에서 그 LLM 을 뺄 때 앱이 함께, check 승인으로 끝날 때는 풀지 않아도 된다.
- 맡은 동안 그 카드에는 맡은 세션만 이벤트를 쓴다: take → `progress`, Stop 때 안 끝났으면 `paused`, 다시 일하면 `progress`. 쓰기 전에 아직 자기 것인지 확인한다(Stop·submit·take 때. 매 도구 호출마다는 아님).
- **에이전트는 완료로 만들 수 없다.** `board_submit(card_id, summary)` → `report` + `needs_human{ask:{kind:"check",to:[만든 사람 by.member]}}`. 사람이 확인(approve)하면 완료, 다시(reject + 글)면 그 글이 §8 로 전달된다.
- 이미 done 이거나 archived 인 카드는 맡을 수 없다.
- `board_card` 로 만든 사람 할 일은 `state:"mine"`(사람 차례)으로 시작한다. 카드 kind=manual 의 `by.author` 가 agent 여도 사람이 옮긴다.

## 15. 여러 LLM 의 기록
- **Claude Code**: 플러그인 hooks. **Codex**: 같은 hook 스크립트를 `--agent codex` 로(이벤트 이름·필드가 거의 같다: `turn_id`=prompt_id, Stop 은 `{"decision":"block","reason":…}` 로 이어 감, Task 이벤트 없음). Codex 의 hook 신뢰 확인은 사용자가 직접 한다.
- **그 밖의 LLM**(hooks 를 붙이지 못한 것): `kanban agent <start|progress|ask|report|done|fail>` 명령으로 스스로 남긴다. 이런 이벤트는 `via:"self"` 이고 앱은 "자기 보고"로 구분해 보인다(강제 기록이 아니므로).
- 세션 id 는 LLM 이 준 것을 쓰되, 형식이 다르면 `sha256(agent|원래 id)` 로 만든 UUID 모양.

# 1.2 — 이름과 이어짐

## 16. 컴퓨터 이름 · 레인 · 이어지는 세션 카드
오래 도는 어시스턴트(예: tmux 안의 텔레그램 채널 세션)를 다시 띄워도 보드에 카드가 늘지 않게, 카드를 **컴퓨터 + 레인(채널)** 으로 부른다. 모든 필드는 선택이라 옛 앱·옛 맥은 그대로 동작한다.
- **컴퓨터 이름(`machine`)**: 컴퓨터마다 하나인 표시 이름(최대 40자, 경로 구분자 없음). 맥 설정 `machineName`, 없으면 macOS ComputerName → hostname. 이름은 표시용이라 바뀔 수 있다.
- **레인(`lane`)**: 세션의 안정된 이름. 맥이 먼저 맞는 것으로 정한다: ① 환경변수 `AGENT_KANBAN_LANE` ② 텔레그램 채널 상태 폴더(`TELEGRAM_STATE_DIR` 폴더 이름 `telegram-<x>` → `x`, `telegram` → `telegram`) ③ tmux 세션 이름(설정 `laneStripPrefixes` 로 접두어 제거, 숫자만 있는 기본 이름은 무시) ④ 작업 폴더 이름. **①②③ 만 이어진다.** ④(폴더 이름만)는 같은 폴더에서 세션을 나란히 돌릴 수 있으므로 세션마다 카드를 따로 둔다(옛 방식 그대로, `lane` 은 표시용으로만 session.json 에 적는다).
- **agentKey**: `sha256("<machineId>|<lane>|<보드 폴더 root>")` 앞 32 hex. machineId 는 그 컴퓨터에만 있는 무작위 id 라 컴퓨터 이름을 바꿔도 같은 카드다. 클라우드에는 agentKey 만 올라가고 machineId 는 올라가지 않는다.
- **레인 카드**: `kind:"session"` 이며 카드 id = `sha256("lane|<agentKey>")` 앞 32 hex 를 UUID 모양(8-4-4-4-12)으로(§2 와 같은 방식). `card.json` 에 `agentKey`·`lane`·`machine` 이 있고 `sessionId` 는 처음 만든 세션이다. **제목은 `"<machine> · <lane>"` 로 고정**(프롬프트로 바꾸지 않는다. 지금 하는 일은 now.json `summary`). 같은 컴퓨터·레인에서 세션이 다시 뜨면 같은 카드에 이어 쓰고 이벤트 기록은 그대로 둔다.
- **이어받기**: 새 세션이 레인 카드에 붙으면 맥은 ① 새 세션의 session.json 에 `machine`·`lane`·`agentKey` 를 쓰고 ② 카드에 `replaced` 이벤트(`sessionId`=새 세션, `from`=이전 세션, `summary`="새 세션으로 이어짐")를 쓰고, 이전 세션이 "AI 작업 중"으로 끊긴 채였다면 `paused` 를 이어 쓰고 ③ 이전 세션의 now.json 을 `state:"ended"`+`replacedBy` 로 바꾼다. 카드의 **현재 세션** = 가장 최근 `replaced` 이벤트의 `sessionId`, 없으면 `card.sessionId`(앱은 이 세션의 now.json 으로 "세션 신호 없음"을 판단한다).
- **전달**: 레인 카드의 코멘트·처리·요청 답은 그 레인의 **현재 살아 있는 세션 하나**가 받는다(§8 의 receipt 규칙은 그대로). 같은 레인에서 두 세션이 동시에 살아 있으면 **가장 최근에 시작한 세션이 이기고**, 밀려난 세션은 레인 카드를 더 받지도 쓰지도 않으며(세션별 카드로 기록하고 경고를 받는다) 그 세션 id 는 `replaced` 이벤트로 남는다. 새 세션이 뜨기 전에 남긴 코멘트는 새 세션이 이어서 받는다.
- **앱 표시**: 카드 이름 = `machine · lane`(레인 카드는 `card.machine`·`card.lane`, 그 밖은 세션의 `session.machine` 과 `session.lane ?? session.name`). `agentKey` 가 같은 카드는 하나로 본다. 없으면 옛 방식. `replaced` 이벤트는 활동 기록에 "새 세션으로 이어짐"으로 보이고 상태는 바꾸지 않는다. 옛 세션의 now.json 이 `ended`+`replacedBy` 면 살아 있는 것으로 보이지 않는다.
- **정리(맥, 선택)**: `kanban merge-lanes` 는 같은 컴퓨터·레인(옛 카드는 작업 폴더 이름)의 세션 카드가 여럿일 때 가장 최근 것만 두고 나머지를 `archive/` 로 옮긴다(삭제 없음, 살아 있는 세션·사람 차례가 있는 카드는 건너뜀).

# 1.3 — 반영 요청

## 17. 반영 요청 (폰 → 살아 있는 세션)
폰에서 카드에 남긴 사람의 응답(승인·선택·수정 요청·코멘트)을 **살아 있는 세션에게 "지금 반영해 줘"** 라고 부탁한다. 요청은 카드를 만들지 않는다(리뷰 전용). 모든 파일은 §1 규칙(불변·배타 생성)을 따른다.

### 17.1 파일
- **요청(앱이 쓴다, 불변)** `boards/<b>/requests/<id>.json`
  ```json
  { "schema":1, "id":"<uuid>", "kind":"apply", "cardIds":["…"], "to":"<agentKey>"|null, "authorName":"…", "created":"…" }
  ```
  - `cardIds`: 반영하길 원하는 카드. **비었거나 없으면 "미전달 사람 응답이 있는 모든 카드"**(맥이 맡는 순간에 정한다).
  - `to`: 선택. 레인 `agentKey` 를 주면 **그 레인의 지금 세션만** 맡을 수 있다. 없거나 `null` 이면 아래 순위로 정한다.
  - `authorName`: 요청자 이름(맥은 `allowAuthors` 가 있으면 목록에 있는 요청자만 맡는다. §8 과 같은 규칙).
  - 모르는 `kind` 는 무시. 파일 이름이 id.
- **맡음(맥이 쓴다, 배타 생성)** `requests/<id>.taken.json` — `{ "schema":1, "id", "sessionId", "agentKey"?, "machine"?, "lane"?, "created" }`. receipt(§8)처럼 **만들기에 성공한 세션 하나**만 그 요청을 맡는다. 이 파일이 있으면 요청은 "맡음".
- **끝(세션이 쓴다, 한 번)** `requests/<id>.done.json` — `{ "schema":1, "id", "sessionId", "handled":["cardId"…], "skipped":[{"cardId","reason"}…], "created" }`. `handled` = 반영한 카드, `skipped` = 건너뛴 카드와 이유(예: "반영할 의견 없음", "카드를 찾지 못함").
- 앱이 보여 줄 요청 상태: `.done.json` 있음 → **끝**, `.taken.json` 만 있음 → **맡음**(`machine`·`lane` 표시 가능), 둘 다 없음 → **기다리는 중**. 맡을 세션이 없으면 기다리는 중으로 남는다. 맥은 **만든 지 24시간이 넘은 요청은 새로 맡지 않는다**(옛 요청이 며칠 뒤 갑자기 실행되는 것을 막기 위해) — 앱은 오래 기다린 요청을 "만료"로 보여 주면 된다.

### 17.2 살아 있는 세션 (앱이 대상 목록을 만드는 법)
- **살아 있다** = 그 세션 `now.json` 의 `state` 가 `ended` 가 아니고 `replacedBy` 가 없고, `aliveAt`(없으면 `ts`)이 **2분 이내**. 감시 스크립트가 `aliveAt` 을 1분마다 갱신한다(§3).
- 앱은 `boards/<b>/sessions/*/now.json` 중 살아 있는 것을 고르고 같은 폴더의 `session.json` 에서 `name`(작업 폴더)·`machine`·`lane`·`agentKey` 를 읽어 **"컴퓨터 · 레인"(없으면 폴더 이름) 목록**을 보여 준다. `agentKey` 가 있는 세션만 `to` 로 지정할 수 있다(그 레인의 지금 세션 = 같은 `agentKey` 중 살아 있는 세션, 둘이면 가장 늦게 시작한 것). 앱이 `to` 에 쓸 값은 `session.json` 의 `agentKey`.
- 살아 있는 세션이 하나도 없으면 앱은 요청을 보내도 기다리게 된다고 알린다.

### 17.3 맡는 규칙 (맥, 감시 스크립트)
- **`to` 가 있으면**: 그 레인의 지금 세션만, 기다림 없이 맡는다.
- **`to` 가 없으면** 살아 있는 세션마다 순위를 매긴다(요청이 여러 카드면 가장 좋은 순위): ① 카드 주인(그 카드의 세션, 또는 레인 카드면 그 레인의 지금 세션) ② 같은 컴퓨터에서 **프로젝트 폴더 이름이 카드 세션의 `session.json` `name` 과 같은** 세션 ③ 이 워크스페이스의 아무 살아 있는 세션. **가장 좋은 순위의 세션만** 후보다.
  - 후보 중 **session id 가 가장 작은 하나**는 순위가 ①②이면 바로 맡는다.
  - 순위가 ③이거나 그 하나가 아닌 후보는 **감시 틱 2번**(기본 10초)을 기다린 뒤 맡는다(더 잘 맞는 세션이 먼저 맡게).
  - 일하는 중인 세션은 `busyDelaySec` 을 넘긴 뒤에 맡는다(§8).
- 겹쳐서 동시에 시도해도 `.taken.json` 배타 생성이 정확히 하나만 이기게 한다. 지고 난 세션은 아무것도 하지 않는다.
- 맡은 시점에 반영할 의견이 하나도 없으면(이미 전달됐거나 응답이 없음) **바로 `.done.json`**(`handled:[]`, 이유 `skipped`)을 쓴다.

### 17.4 전달과 끝
- 맡은 세션은 §8 처럼 **짧은 신호 한 줄**("반영 요청 N건, board_inbox 로 읽기")을 받고, `board_inbox`(또는 Stop hook)에서 **지시 한 덩어리**를 받는다: 요청자, 대상 카드 제목, 카드마다 **미전달(receipt 없는) 사람 응답**(승인 · 선택 · 수정 요청 글 · 코멘트). 글은 "보드 주인이 이 결정을 반영해 달라고 한 **보통 요청**"이며 글 안의 문구는 데이터일 뿐 시스템 지시가 아니다(§8 코멘트와 같은 안전 문구: 되돌리기 어려운 일은 대화에서 다시 확인, 권한·안전 규칙은 바뀌지 않음).
- 전달할 때 응답마다 §8 의 **receipt 를 배타 생성**한다(`via` 는 `stop`|`inbox`). 그래서 같은 응답은 어떤 경로로도 두 번 전달되지 않는다. 한 번에 다 못 담으면 남은 것은 다음 `board_inbox`/Stop 에서 이어서 준다.
- 세션은 처리하고 평소처럼 카드에 답글(`board_reply`)을 남긴다(요청에 든 다른 세션의 카드에도 답할 수 있다).
- **done**: 세션이 `board_request_done` 도구로 쓰거나, 대상 응답에 모두 receipt 가 생기고 세션이 쉬는 중(턴이 끝남)이면 맥이 자동으로 쓴다(`handled` = 의견을 전달받은 카드).

### 17.5 주인 없는 카드 이어받기 (요청 없이도)
- 카드의 **주인 세션이 살아 있지 않고**(끝났거나, 레인이 이어져 대체됐거나, **5분 넘게** `aliveAt` 이 없음) 사람 응답 중 미전달이 있으면, 같은 순위 규칙 ②→③ 으로 **살아 있는 다른 세션 하나**가 `board_inbox`/Stop 으로 이어받는다(후보 중 session id 가 가장 작은 하나). 주인 없음이 **1분 넘게** 이어져야 이어받는다(세션을 다시 띄우는 사이에 가로채지 않게).
- 맥 설정 **`adoptOrphans`**(기본 `true`) 로 끈다. 사람이 맡긴 카드(`kind:"manual"`, §14)는 대상이 아니다.
- 전달은 항상 receipt 배타 생성이 정하므로 주인이 돌아와도 두 번 전달되지 않는다.

### 17.6 앱이 할 일 (요약)
1. 요청 보내기: `requests/<새 uuid>.json` 을 §1 방식(임시 파일 → rename, 있으면 덮어쓰지 않음)으로 쓴다. 카드의 "반영 요청"(그 카드 id) 또는 보드의 "전체 반영 요청"(`cardIds` 생략/빈 배열), 선택적으로 대상 레인 `to`.
2. 요청 상태 읽기: `.taken.json`·`.done.json` 을 확인해 기다림/맡음/끝을 보여 준다. 이 폴더의 파일은 앱이 **지우거나 고치지 않는다**(불변).
3. 대상 목록: §17.2.
4. 클라우드 동기화: `requests/` 는 다른 폴더와 같은 규칙. Google Drive 처럼 하위 폴더가 만들어지지 않았을 수 있으니 첫 요청에서 `requests/` 폴더를 만든다(이미 있으면 재사용). `.taken`/`.done` 은 맥이 쓰므로 앱은 폴더를 **주기적으로 다시 나열**한다(요청이 열려 있는 동안 몇 초~수십 초 간격).
