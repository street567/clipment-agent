> 원본: clip-review 레포 docs/SPEC-mvp.md — 계약을 바꿀 땐 원본부터 고치고 여기에 복사

# MVP 스펙 — 폴더 계약 (아이폰 앱 ↔ 맥 플러그인/CLI)

테스트판 전용. 서버·로그인 없음. 두 쪽은 **클라우드 폴더의 파일로만** 대화한다.
이 문서가 두 구현의 유일한 계약이다. 바꿀 땐 여기부터 고친다.

## 0. 루트 폴더

- 맥: `~/Library/Mobile Documents/com~apple~CloudDocs/ClipReview/` (환경변수 `CLIPREV_ROOT` 로 바꿀 수 있음)
- 아이폰: 첫 실행 때 파일 앱 폴더 선택기로 `iCloud Drive/ClipReview` 를 고르고 보안 범위 북마크로 저장.
  - 앱 전용 iCloud 컨테이너를 쓰지 않는다 → iCloud entitlement 불필요, 같은 방식으로 파일 앱에 붙는 구글 드라이브 폴더도 그대로 동작(2차).

## 1. 폴더 구조

```
ClipReview/
  <project>/                       # 영문 소문자·숫자·하이픈 (slug)
    project.json
    versions/
      v001/
        preview.mp4                # 리뷰용 미리보기본
        meta.json
      v002/ ...
    comments/<commentId>.json      # 앱(사용자)만 생성. 생성 후 수정 안 함
    replies/<commentId>/<replyId>.json   # 누구나 생성. 생성 후 수정 안 함
    requests/<requestId>.json      # 앱만 생성
    progress/<requestId>/<eventId>.json  # 맥(AI)만 생성
```

**규칙: 모든 파일은 한 번 쓰고 다시 고치지 않는다(불변).** 상태 변화는 새 파일(답글·이벤트)로 표현한다.
→ 폰과 맥이 동시에 써도 같은 파일을 두 곳에서 고치는 일이 없어 iCloud 충돌이 생기지 않는다.

- 쓰기는 원자적으로: 같은 폴더에 `.<name>.tmp` 로 쓴 뒤 rename.
- 읽기 전 iCloud 자리표시자(`.<name>.icloud`)가 있으면 내려받기를 요청한다 (맥: `brctl download <path>`, iOS: `FileManager.startDownloadingUbiquitousItem(at:)`), 내려받아질 때까지 그 항목은 건너뛴다.
- 모르는 필드는 무시한다(앞으로 필드가 늘어남).
- ID: 소문자 UUID v4. 시각: ISO 8601 UTC (`2026-11-19T01:23:45.678Z`).
- 파일명 정렬로 순서를 매기지 말고 `created` 로 정렬한다.

## 2. 파일 스키마 (JSON, UTF-8)

### project.json
```json
{ "schema": 1, "id": "simracing-vertical", "title": "심레이싱 버티컬", "created": "..." }
```

### versions/vNNN/meta.json
```json
{ "schema": 1, "version": 1, "label": "v001", "file": "preview.mp4",
  "duration": 801.34, "fps": 30, "width": 720, "height": 1280,
  "note": "첫 컷", "source": "DJI_..._0006_D.MP4", "created": "..." }
```
`version` 은 1부터 증가하는 정수, 폴더명은 `v` + 3자리.

### comments/<id>.json
```json
{ "schema": 1, "id": "…", "version": 1, "t": 12.533, "end": null,
  "tag": "cut", "text": "여기 2초 빨리 컷", "author": "user", "authorName": "개미", "created": "..." }
```
- `t`: 초(소수 3자리). `end`: 구간 코멘트면 끝 시각, 아니면 null (앱이 구간 코멘트를 쓰면 `end > t`. 그 외·`end <= t` 는 null 로 취급).
- `tag` 는 다음 중 하나: `cut` 컷 · `subtitle` 자막 · `broll_swap` B롤 교체 · `broll_remove` B롤 삭제 · `layout` 크기·위치 · `audio` 소리 · `other` 기타. `version` 이 0 이면 영상 전체 코멘트.

### replies/<commentId>/<id>.json
```json
{ "schema": 1, "id": "…", "commentId": "…", "author": "claude", "authorName": "클로드",
  "text": "반영했습니다. v002 12.5초 확인 부탁드립니다.", "status": "done",
  "fixedIn": 2, "created": "..." }
```
- `author`: `user` | `claude` | `codex` | 그 밖의 AI 이름 문자열.
- `status` (선택): `open` | `doing` | `done` | `question` | `wontfix`. 코멘트의 현재 상태 = `status` 가 있는 답글 중 가장 최근 것, 없으면 `open`.
- `fixedIn` (선택): 반영된 버전 번호.

### requests/<id>.json  (폰 → 맥 "액션")
```json
{ "schema": 1, "id": "…", "type": "apply_feedback", "version": 1,
  "commentIds": null, "agent": "claude", "authorName": "개미", "message": "", "created": "..." }
```
- `type` 은 정해진 것만: `apply_feedback` (commentIds null = 그 버전의 열린 코멘트 전부) · `answer` (질문 답글을 달았으니 이어서 진행) · `rerender` · `cancel` (`message` 에 취소할 requestId).
- 맥 쪽은 **이 목록 밖의 type 은 무시**하고, 요청을 임의 명령으로 실행하지 않는다.

### progress/<requestId>/<id>.json  (맥 → 폰 진행)
```json
{ "schema": 1, "id": "…", "requestId": "…", "state": "working",
  "message": "3개 중 1번째 반영 중", "agent": "claude", "created": "..." }
```
`state`: `received` | `working` | `done` | `failed`. 요청의 현재 상태 = 가장 최근 이벤트. 이벤트가 없으면 "대기".

## 3. 미리보기본 인코딩 (맥 publish)

ffmpeg: H.264 High, 긴 변 1280px(세로 영상이면 720×1280), 원본 fps 유지(최대 60), CRF 26, preset veryfast, AAC 128k, `-movflags +faststart`. 회전 정보가 있는 원본(DJI 세로)은 회전을 적용해 실제 세로 픽셀로 저장한다.

## 4. 구현에서 정한 세부 (MVP 1차 구현 후 추가)

- 버전 폴더는 정확히 `v` + 숫자만 버전으로 본다. 맥 publish 는 `versions/.vNNN.tmp/` 에 다 쓴 뒤 폴더째 rename 하므로, `.` 으로 시작하는 폴더는 무시한다.
- 파일명(소문자 UUID)이 id 다. JSON 안의 `id` 와 다르면 파일명을 따른다. 파일명이 UUID 가 아니면 무시. 모르는 `tag` 는 `other`.
- 요청의 `agent` 가 비어 있지 않으면 그 이름의 AI(맥 `CLIPREV_AGENT`)만 가져간다 — Claude·Codex 가 서로의 요청을 가져가지 않게.
- 같은 스레드 안 답글/이벤트의 `created` 는 직전 것보다 최소 1ms 뒤로 보정해 쓴다(같은 ms 정렬 뒤집힘 방지).
- 앱: `open`·`doing`·`question` 을 "열림"으로 묶어 보여 준다. 질문 상태 코멘트에 사용자가 답하면 `answer` 요청을 함께 쓴다. 영상 전체 코멘트(version 0)는 모든 버전 목록에 보인다.

## 5. 작성자 표시 이름 · 구간 코멘트 · 허용 목록 · lite 미리보기 (추가)

- `authorName` (선택, 문자열): 사람이 보는 표시 이름(예: "개미"). 코멘트·답글·요청에 둘 수 있다. `author` 는 기존대로 `user` | AI 이름이며 로직(누가 썼나)에 쓰고, `authorName` 은 화면 표시용이다. 없으면 `author` 를 보여 준다. 맥이 쓰는 답글은 환경변수 `CLIPREV_AGENT_NAME` 이 있으면 `authorName` 으로 넣는다(없으면 생략).
- 구간 코멘트: 앱이 `end` 를 쓴다(`end > t`). 맥은 `12.5–15.0s` 처럼 구간으로 표시하고, 프레임은 시작 `t` 기준으로 뽑는다.
- 허용 목록(맥, 선택·기본 꺼짐): 환경변수 `CLIPREV_ALLOW_AUTHORS="개미,사용자"` 가 설정되면 `authorName` 이 목록에 없는(또는 없는) 요청은 무시한다(`wait_for_requests`, `cliprev requests`, 채널 알림).
- `--lite` 미리보기: `cliprev publish --lite` / MCP `publish_version` 의 `lite: true`. 긴 변 960px, CRF 30, fps 최대 30, AAC 96k, `+faststart`, 회전 적용은 동일. 기본값(§3)은 그대로. 폰은 `meta.json` 의 width/height 를 그대로 쓰므로 앱 변경 불필요.

## 6. 화면 영역 표시 (regions)

코멘트가 화면의 특정 부분을 가리킬 수 있다.

- 코멘트에 선택 필드 `regions`: 사각형 배열. 각 항목 `{ "x": 0.12, "y": 0.70, "w": 0.40, "h": 0.10 }`.
  - 좌표는 **영상 프레임 기준 0~1 정규화**(왼쪽 위가 0,0). 레터박스·화면 크기와 무관. 소수 4자리.
  - `label`: 그린 순서대로 붙는 번호 문자열 "1","2",…. 지워도 나머지 번호는 바꾸지 않고, 새 영역은 기존 최대값+1. 본문에서 "1번 영역" 처럼 참조한다. 없으면 배열 순번으로 표시.
  - 빈 배열 또는 필드 없음 = 영역 없음. 최대 8개.
- 수정(불변 규칙 유지): 코멘트 파일은 고치지 않는다. 영역을 고치거나 지우면 **답글**에 `regions` 를 담아 쓴다(전체 교체, 빈 배열 = 모두 삭제). 텍스트는 비워도 된다(`text: ""`). 이런 답글은 `kind: "regions"` 를 가진다(일반 답글 목록에서는 "영역을 수정했습니다" 한 줄로 표시).
- **현재 영역** = `regions` 필드가 있는 답글 중 가장 최근 것, 없으면 코멘트의 `regions`.
- 표시 시점: 점 코멘트는 `t` 전후 ±1.5초, 구간 코멘트는 `t`~`end` 동안 플레이어 위에 겹쳐 그린다.
- 맥: 코멘트 출력에 현재 영역을 포함한다. 프레임 추출(`get_frame` / `cliprev frame`)은 기본으로 현재 영역을 사각형으로 그린 이미지를 돌려준다(`--no-regions` 로 끄기).

## 7. 워크스페이스 (여러 루트)

- **워크스페이스** = 프로젝트 폴더들을 담는 루트 폴더 하나(§0 의 `ClipReview/` 가 워크스페이스 하나). 안의 구조는 §1 그대로.
- 워크스페이스는 여러 개 둘 수 있다(예: iCloud 내 작업, 구글 드라이브, 개미 님 공유 폴더). 서로 독립이며 파일 규칙은 같다.
- 선택 파일 `workspace.json` (워크스페이스 루트): `{ "schema": 1, "name": "내 작업", "color": "cyan", "created": "..." }`. 없으면 폴더 이름을 표시 이름으로 쓴다. 맥 `init` 이 만들고, 앱은 연결할 때 없으면 만든다. `workspace.json` 은 만든 뒤 고치지 않는다(이름 변경은 각 기기의 로컬 별칭으로).
- 루트에서 `workspace.json` 과 `.` 으로 시작하는 항목은 프로젝트가 아니다. 프로젝트 = 루트 바로 아래의 slug 폴더 중 `project.json` 이 있는 것.
- 앱: 워크스페이스 목록을 기기에 저장(보안 범위 북마크 여러 개 + 로컬 별칭·색). 추가/연결 해제(파일은 지우지 않음). 프로젝트 목록은 워크스페이스별로 묶어 보여 준다.
- 맥: 설정 파일 `~/.config/cliprev/workspaces.json` = `{ "workspaces": [ { "name": "icloud", "path": "...", "allowAuthors": ["개미"]? } ] }`. 환경변수 `CLIPREV_ROOT` 가 있으면 그 하나만 쓴다(기존 호환). 둘 다 없으면 §0 기본 경로 하나.
- 프로젝트 지정: `<워크스페이스이름>/<프로젝트>`. 프로젝트 이름이 모든 워크스페이스에서 유일하면 프로젝트 이름만으로도 된다. 요청 대기·채널 알림은 등록된 모든 워크스페이스를 함께 본다. 허용 목록은 워크스페이스별 `allowAuthors` 가 있으면 그것을, 없으면 `CLIPREV_ALLOW_AUTHORS` 를 쓴다.

## 8. 프로젝트 완료 잠금

- 프로젝트 폴더에 `locks/<id>.json` (누구나 생성, 불변): `{ "schema": 1, "id": "…", "state": "locked" | "unlocked", "author": "user", "authorName": "개미", "note": "최종본 v003", "created": "..." }`.
- **현재 잠금 상태** = `locks/` 중 `created` 가 가장 최근인 이벤트의 `state`. 없으면 잠기지 않음.
- 잠긴 프로젝트:
  - 앱: 읽기 전용(보기·코멘트 화면 열람만). 코멘트·답글·영역 수정·요청 버튼 숨김. 프로젝트 목록에 자물쇠와 "완료" 표시, 기본 필터 "진행 중"에서는 접힘. 잠금 해제는 확인 + (설정에서 켠 경우) Face ID.
  - 맥: 잠긴 프로젝트의 요청은 가져가지 않고(대기·채널·목록에서 제외), `publish`·`reply` 는 거부한다(`--force` 로만 허용, 출력에 경고). AI 지침: 잠긴 프로젝트는 손대지 않는다.
- 잠금은 실수 방지용이다. 폴더 쓰기 권한이 있는 사람은 파일을 직접 만들 수 있으므로 보안 경계가 아니다.
