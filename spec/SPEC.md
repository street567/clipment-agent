# Clipment 폴더 계약 (아이폰 앱 ↔ 맥 플러그인/CLI)

**계약 버전 1.10.0** (`spec/contract.json` 과 같아야 함 · 변경 이력은 `spec/CHANGELOG.md`)

이 폴더(`spec/`)가 계약의 **유일한 원본**이다. 앱 레포가 소유하고 맥 레포는 동기화해 쓴다(`spec/README.md`).
데이터 폴더가 따르는 계약 버전은 `workspace.json`·`.clipment/index.json` 의 `contract` 필드로 표시한다(§10).
JSON 스키마는 `spec/schemas/`, 예시는 `spec/fixtures/`.

테스트판 전용. 서버·로그인 없음. 두 쪽은 **클라우드 폴더의 파일로만** 대화한다.
이 문서가 두 구현의 유일한 계약이다. 바꿀 땐 여기부터 고친다(버전 규칙 §10).

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
        original.<ext>             # 선택 · 업로드용 원본 (§12, 원본 컨테이너 확장자 유지)
        meta.json
      v002/ ...
    comments/<commentId>.json      # 앱(사용자)만 생성. 생성 후 수정 안 함
    replies/<commentId>/<replyId>.json   # 누구나 생성. 생성 후 수정 안 함
    requests/<requestId>.json      # 앱만 생성
    progress/<requestId>/<eventId>.json  # 맥(AI)만 생성
    .clipment/preferences.md       # 선택 · 프로젝트 작업 지침 (§11, 고쳐 쓰는 예외)
    .clipment/upload.json          # 선택 · 업로드용 버전 지정 (§12, 고쳐 쓰는 예외)
    .clipment/quality.json         # 선택 · 작업용 화질 지정 (§13, 고쳐 쓰는 예외)
    script/script.json             # 선택 · 작업 대본 (§14, 고쳐 쓰는 예외)
    script/mine/<lineId>.m4a       # 선택 · 내 녹음 (§14, 앱이 씀)
    script/ai/<lineId>.m4a         # 선택 · AI 음성 (§14, 맥이 씀)
```

**규칙: 모든 파일은 한 번 쓰고 다시 고치지 않는다(불변).** (예외: §9 인덱스, §11 작업 지침, §12 업로드용 버전 지정, §13 작업용 화질 — 프로젝트 `quality.json` 과 `workspace.json` 의 `previewQuality`, §14 대본 `script/script.json` 과 음성 파일) 상태 변화는 새 파일(답글·이벤트)로 표현한다.
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
  "commentIds": null, "agent": "", "authorName": "개미", "message": "", "created": "..." }
```
- `agent`: 비어 있으면(앱 기본, 1.7~) 연결된 어떤 AI든 가져간다. 실제로 처리한 AI는 progress 이벤트의 `agent` 로 알 수 있다.
- `type` 은 정해진 것만: `apply_feedback` (commentIds null = 그 버전의 열린 코멘트 전부) · `answer` (질문 답글을 달았으니 이어서 진행) · `rerender` · `cancel` (`message` 에 취소할 requestId) · `apply_script` (1.10~, §14 — `version` + 선택 `draft`).
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
- 요청의 `agent` 가 비어 있지 않으면 그 이름의 AI(맥 `CLIPREV_AGENT`)만 가져간다 — Claude·Codex 가 서로의 요청을 가져가지 않게. 비어 있으면 누구든 가져간다(1.7부터 앱은 항상 빈 값을 쓴다: 어떤 AI로 처리할지는 맥 쪽 설정이 정한다).
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
- 선택 파일 `workspace.json` (워크스페이스 루트): `{ "schema": 1, "contract": "1.7", "name": "내 작업", "color": "cyan", "created": "..." }` (`contract`: 만든 쪽의 계약 `major.minor`, 없으면 "1.0" — §10). 없으면 폴더 이름을 표시 이름으로 쓴다. 맥 `init` 이 만들고, 앱은 연결할 때 없으면 만든다. `workspace.json` 은 만든 뒤 고치지 않는다(이름 변경은 각 기기의 로컬 별칭으로). 단 선택 필드 `previewQuality`(§13)만 고쳐 쓴다 — 다른 필드는 그대로 두고 그 필드만 바꾼다.
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

## 9. 루트 인덱스 (워크스페이스 목록을 맥이 정리, 폰은 읽기만)

- **루트** = 사용자가 한 번 고르는 상위 클라우드 폴더(예: `iCloud Drive/Clipment`, 또는 iCloud Drive 최상위). 그 아래 어디든 워크스페이스가 있을 수 있다.
- 인덱스 파일: `<루트>/.clipment/index.json` — **맥(CLI·플러그인)만 쓴다. 폰은 읽기만 한다.** (한쪽만 쓰므로 고쳐 써도 충돌 없음, 쓰기는 원자적 tmp+rename.)
  ```json
  { "schema": 1, "contract": "1.7", "updated": "...",
    "workspaces": [ { "path": "영상/ClipReview", "name": "내 작업", "projects": 3 },
                    { "path": "공유/개미", "name": "개미 공유", "projects": 1 } ] }
  ```
  - `contract`: 인덱스를 쓴 맥의 계약 `major.minor` (없으면 "1.0", §10). 폰은 이 MAJOR 가 자기보다 크면 그 루트의 워크스페이스를 읽기 전용으로 연다.
  - `path`: 루트 기준 상대 경로(`/` 구분). 루트 자체가 워크스페이스면(`workspace.json` 이 있거나 프로젝트를 바로 담음) `"."`. `name`: 그 워크스페이스의 `workspace.json` 이름(없으면 폴더 이름). `projects`: 참고용 개수.
- 맥: `clipment index <루트> [--depth N]` 가 루트 아래를 훑어(기본 깊이 4, 숨김·프로젝트 폴더 안은 건너뜀) `workspace.json` 이 있거나 프로젝트를 담은 폴더를 찾아 인덱스를 쓴다. `workspaces add` 로 등록한 경로가 인덱스를 가진 루트 아래면 인덱스도 갱신한다. AI에게 "루트 정리해 줘"라고 하면 이 명령을 쓴다.
- 폰: "루트 연결"로 루트를 한 번 고르면(보안 범위 북마크 1개) 인덱스를 읽어 모든 워크스페이스를 한꺼번에 보여 준다. 각 워크스페이스 = 루트 북마크 + 상대 경로. 인덱스가 바뀌면(맥이 추가) 새로고침 때 자동 반영. 인덱스가 없으면 "맥에서 루트 정리 프롬프트를 실행하세요" 안내 + 복사 프롬프트.

## 10. 계약 버전 · 호환 규칙

- 계약 버전은 `MAJOR.MINOR.PATCH` (`spec/contract.json` 의 `version`). 규칙:
  - **MAJOR**: 깨지는 변경 — 옛 리더가 안전하게 읽거나 쓸 수 없다 (파일 위치·의미 변경, 필수 필드 삭제 등).
  - **MINOR**: 추가만 — 새 필드·새 파일 종류. 모르는 필드는 무시하므로 옛 리더도 읽을 수 있다.
  - **PATCH**: 문구·예시 정리, 동작 변화 없음.
- **데이터에 찍는 버전**: `workspace.json` 과 `.clipment/index.json` 은 `"contract": "<major>.<minor>"` (예: `"1.6"`)를 둔다.
  - 쓰는 쪽은 **만들 때** 자기가 지원하는 최신 `major.minor` 를 넣는다. 만든 뒤 고치지 않는다(`workspace.json` 은 불변, 인덱스는 맥이 갱신할 때 다시 씀).
  - 읽는 쪽은 `contract` 가 없으면 `"1.0"` 으로 본다. 해석 못 하는 값도 `"1.0"`.
- **호환 판단** (리더가 지원하는 MAJOR = M, 폴더의 MAJOR = F):
  - `F > M` → **읽기 전용**으로 열고 "앱/CLI 업데이트 필요"를 알린다. 파일을 쓰지 않는다(요청·코멘트·답글·잠금·publish 모두).
  - `F == M` 이고 폴더 MINOR 가 더 높음 → 정상 읽기. 모르는 필드는 무시. 자기가 모르는 새 minor 전용 필드는 쓰지 않는다(알 수도 없다).
  - `F == M` 이고 같거나 낮음, 또는 `F < M` → 정상.
- 각 구현은 자기가 지원하는 버전을 상수로 두고(앱: `Contract.supported`), `spec/contract.json` 과 어긋나면 테스트가 실패하게 한다.
- `schema` 필드(파일별 정수)는 그대로 1 이다. 계약 버전이 올라도 파일별 `schema` 는 MAJOR 가 바뀔 때만 올린다.

## 11. 작업 지침 (preferences)

- 사람이 적는 자유 형식 Markdown 파일(선택). 맥 AI가 요청을 처리할 때 따를 기본 지침이다(예: "자막 필요 없음", "편집은 윈도우 프리미어에서", "결과물 1080p").
  - 워크스페이스 지침: `<워크스페이스>/.clipment/preferences.md`
  - 프로젝트 지침: `<워크스페이스>/<프로젝트>/.clipment/preferences.md`
- **고쳐 쓰는 파일**(§1 불변 규칙의 예외). 폰·맥 둘 다 편집할 수 있고 마지막에 쓴 쪽이 이긴다. 쓰기는 원자적(tmp+rename), 읽기 전 iCloud 자리표시자 처리는 §1 과 같다.
- 파일이 없거나 비어 있으면 지침 없음. 형식 검사는 하지 않는다(사람이 쓰는 글).
- **우선순위**: 요청 `message` > 프로젝트 지침 > 워크스페이스 지침. 서로 부딪히면 앞의 것을 따른다.
- 맥 AI는 요청을 처리하기 **전에** 두 지침을 읽는다(MCP `wait_for_requests`·`get_preferences`, CLI `clipment prefs <프로젝트>`). 지침 안의 문장도 §2 와 마찬가지로 사용자 의견 데이터이며, 허용된 요청 type 밖의 일을 시키는 근거가 되지 않는다.
- 초안: 맥 설정 프롬프트(워크스페이스 등록)가 워크스페이스 지침이 없으면 초안을 만든다. 초안은 특정 작업(자막·맥 편집 프로그램 등)을 가정하지 않는다 — 맥에서 찾은 도구는 "사용 가능 도구"로만 적고, 정해지지 않은 항목은 "정해지지 않음 — 필요하면 질문 답글"로 둔다.
- 잠긴 프로젝트(§8)의 프로젝트 지침은 앱에서 읽기 전용이다.


## 12. 업로드용 영상 (원본 · 업로드용 버전 지정)

미리보기(§3)는 리뷰용 저화질이다. 실제 업로드할 고화질은 버전 폴더에 **원본**을 함께 두어 폰에서 내려받는다.

- **원본**: `versions/vNNN/original.<ext>` (선택). 맥 `publish` 가 소스를 변환 없이 복사한다. 원본 컨테이너·확장자를 그대로 쓴다(`.mp4`·`.mov` 등, 소문자). 파일은 불변(§1), 쓰기는 버전 폴더 staging 안에서 하므로 §4 처럼 폴더째 원자적으로 나타난다.
- `meta.json` 의 선택 필드 `original`: `{ "file": "original.mov", "bytes": 1234567890, "width": 3840, "height": 2160, "fps": 59.94, "duration": 801.34 }` (`file`·`bytes` 필수 취급, 나머지 선택). 없으면 그 버전은 원본 없음(1.7 이하 버전 포함) — 미리보기만 있다.
  - `width`·`height` 는 회전 적용 후 실제 표시 픽셀(§3 과 같은 기준).
- **클라이언트는 원본을 자동으로 내려받지 않는다.** 사용자가 저장·공유를 명시했을 때만 받는다(동기화·썸네일·재생에는 `preview.mp4` 만). 용량이 크므로 맥은 `publish --no-original` 로 건너뛸 수 있다.
- **업로드용 버전 지정**: `<프로젝트>/.clipment/upload.json` (선택). **고쳐 쓰는 파일**(§1 예외, §11 과 같은 방식) — 폰·맥 둘 다 쓸 수 있고 마지막에 쓴 쪽이 이긴다. 원자적 tmp+rename.
  ```json
  { "schema": 1, "version": 3, "author": "user", "authorName": "개미", "via": "app", "updated": "..." }
  ```
  - `version`: 지정한 버전 번호(정수, 존재하는 버전). `author`: `user` | AI 이름, `authorName`: 표시 이름(선택), `via`: 어느 쪽에서 지정했나 `app` | `mac`, `updated`: 지정 시각(ISO 8601 UTC).
  - 지정 해제 = 파일 삭제(맥 `upload-version --clear`). 앱은 해제하지 않고 다른 버전으로 바꾸기만 한다.
- **현재 업로드용 버전**(읽는 쪽 규칙): ① `upload.json` 의 `version` 이 실제 있는 버전이면 그것. ② 아니면(파일 없음·깨짐·없는 버전) 원본이 있는 버전 중 **가장 최신**. ③ 원본 있는 버전이 하나도 없으면 가장 최신 버전.
- 현재 업로드용 버전보다 더 최신 버전이 있으면(번호가 더 큼) 클라이언트는 "더 최신 버전이 있다"를 알리고 그 버전으로 바꾸는 길을 줄 수 있다. 지정이든 기본 규칙(②③)이든 같다 — 최신이 원본 없는 미리보기만일 때도 알린다(바꾸면 그 버전이 지정된다).
- 잠긴 프로젝트(§8): 앱은 지정을 바꾸지 못한다(읽기 전용). 맥 `upload-version`·`publish` 의 지정은 거부(`--force` 로만 허용).


## 13. 작업용 화질 (미리보기 화질 선택)

`preview.mp4`(§3)를 얼마나 가볍게 인코딩할지 고른다. 모바일 데이터·저장 공간과 화질 사이의 선택이다.

| 값 | 긴 변 | 비고 |
|---|---|---|
| `360p` | 640 | 아주 가볍게 |
| `540p` | 960 | 가볍게 (옛 `lite`) |
| `720p` | 1280 | **기본** (§3 과 같음) |
| `1080p` | 1920 | 선명하게 |

긴 변 기준이므로 세로 영상은 값이 긴 변에 적용된다(예: 360p 세로 = 360×640). 원본보다 키우지 않는다.

- **워크스페이스 기본**: `workspace.json` 의 선택 필드 `previewQuality`(고쳐 쓰는 필드 — 쓰는 쪽은 다른 필드를 보존하고 원자적으로 쓴다, 마지막에 쓴 쪽이 이김). 없으면 720p. 해제 = 필드 삭제.
- **프로젝트 지정**: `<프로젝트>/.clipment/quality.json` (선택). **고쳐 쓰는 파일**(§1 예외, §11·§12 와 같은 방식) — 폰·맥 둘 다 쓰고 마지막에 쓴 쪽이 이긴다. 원자적 tmp+rename.
  ```json
  { "schema": 1, "quality": "540p", "author": "user", "authorName": "개미", "via": "app", "updated": "..." }
  ```
  - `quality`: 위 4개 값 중 하나(모르는 값은 없는 것으로 취급). `author`·`authorName`·`via`(`app`|`mac`)·`updated` 는 `upload.json` 과 같다.
  - 지정 해제 = 파일 삭제(그러면 워크스페이스 기본을 따른다). 앱은 "워크스페이스 기본값 따르기"로 파일을 지운다.
- **게시 때 결정 순서**: 명시 인자(CLI `--quality`, MCP `quality`) > 프로젝트 `quality.json` > 워크스페이스 `previewQuality` > `720p`.
- **적용 범위**: 이후 게시되는 버전부터. 이미 있는 버전은 바뀌지 않는다.
- `meta.json` 의 선택 필드 `quality` 에 그 버전을 만들 때 쓴 화질을 적는다(없으면 알 수 없음 — 1.8 이하 버전 포함).
- 잠긴 프로젝트(§8): 앱은 프로젝트 지정을 바꾸지 못한다(읽기 전용). 맥 `quality` 의 프로젝트 지정은 `--force` 없이 거부.


## 14. 대본 (보이스)

영상 위에 얹을 나레이션/자막 대본을 프로젝트가 하나 가진다. 코멘트와 달리 **프로젝트 단위의 작업 문서**이고, 폰·맥이 함께 고친다.

```
<프로젝트>/script/script.json          # 대본 (고쳐 쓰는 파일)
<프로젝트>/script/mine/<lineId>.m4a    # 내 녹음 (앱이 씀, 덮어쓰기 가능)
<프로젝트>/script/ai/<lineId>.m4a      # AI 음성 (맥이 씀, 덮어쓰기 가능)
versions/vNNN/script.json              # 게시 시점의 대본 스냅샷 (읽기 전용 기록)
```

- **script.json** (선택, **고쳐 쓰는 파일** — §1 불변 규칙의 예외, §11~§13 과 같은 방식: 폰·맥 둘 다 쓰고 마지막에 쓴 쪽이 이긴다, 원자적 tmp+rename, 쓰는 쪽은 모르는 필드를 보존):
  ```json
  { "schema": 1, "language": "en", "updated": "...",
    "lines": [ { "id": "…", "start": 0.0, "end": 3.2, "text": "This is how it starts.",
                 "voice": "ai", "aiTextHash": "9f2c1a7b3d4e5f60", "updated": "...", "author": "user" } ] }
  ```
  - `language`: `en` | `ko` (없거나 모르는 값은 `en`). 대본 전체의 언어이며 AI 음성의 언어가 된다.
  - `lines[]`: `id`(소문자 UUID v4, 음성 파일명), `start`(초, 영상 시각), `end`(선택, 초, `end > start` 일 때만 유효 — 자막 표시 끝. 없으면 다음 줄 시작 또는 start+음성 길이), `text`, `voice`(`ai` | `mine`, 없거나 모르는 값은 `ai`) = 최종 영상에 쓸 음성, `aiTextHash`(선택, 맥이 AI 음성을 만든 뒤 적는다), `updated`, `author`(선택, `user` | AI 이름).
  - **순서 = `start` 오름차순**(같으면 배열 순서). 파일 배열 순서에 의존하지 않는다.
  - 버전 `vNNN` 과 무관한 프로젝트 문서다(영상이 새 버전이 되어도 대본은 그대로). 시각은 그 시점 최신 버전 기준이다.
- **aiTextHash**: AI 음성이 어떤 글로 만들어졌는지를 나타내는 해시. `hex(SHA-256(UTF-8(language + "\n" + normalized)))` 의 앞 16자(소문자), `normalized` = `text` 를 유니코드 NFC 로 바꾸고 앞뒤 공백·줄바꿈을 자른 것. 두 구현이 같은 값을 내야 한다. 시험값: `en` + `This is how it starts.` → `b6aa39f69905a507` (`fixtures/script.json` 의 첫 줄).
  - 줄의 AI 음성이 **최신** = `script/ai/<id>.m4a` 가 있고 `aiTextHash` 가 지금 `text`·`language` 로 계산한 값과 같다. 아니면 **준비 중**(없음 또는 오래됨): 앱은 "AI 음성 준비 중"으로 표시하고(오래된 파일은 재생하지 않는다), 맥이 자동으로 다시 만든다.
  - 맥은 음성을 만든 뒤 `script.json` 에 `aiTextHash` 를 써 넣는다(이때 다른 필드는 그대로, `updated` 는 줄·파일 모두 갱신하지 않아도 된다).
- **내 녹음**: 앱이 `script/mine/<lineId>.m4a` 를 쓰고 `voice: "mine"` 으로 바꾼다. 텍스트를 고쳐도 녹음은 그대로(사람의 목소리이므로 사용자가 다시 녹음할지 판단). 줄을 지우면 앱은 두 음성 파일도 지운다(맥도 대본에 없는 줄의 AI 음성 파일은 정리해도 된다).
- **요청 `apply_script`** (§2): `{ "type": "apply_script", "version": N, "draft": true|false, "message": "" }`.
  - `draft: true` — "이 영상에 맞는 대본 초안을 써 줘". AI 는 영상을 보고 `script.json` 에 줄(시각 포함)을 쓴다(영상은 만들지 않는다). 기존 줄은 사용자 것이므로 비어 있을 때만 통째로 채우고, 있으면 덧붙이거나 `message` 의 지시를 따른다.
  - `draft` 가 없거나 false — "현재 대본 + 고른 음성(`voice`)을 영상에 반영": 나레이션 트랙(줄마다 선택한 음성을 `start` 에 배치)과 자막(줄 `text`)을 입혀 새 버전을 게시한다. 쇼츠는 음악을 얹지 않는다.
  - 진행 상황은 다른 요청처럼 progress 이벤트로 알린다. 폰은 `draft` 가 true 면 "대본 초안", 아니면 "영상에 반영"으로 표시한다.
- **게시 스냅샷**: 맥 `publish` 는 `script/script.json` 이 있으면 새 버전 폴더에 `script.json` 으로 복사한다(변환 없음, 불변 기록). 음성 파일은 복사하지 않는다. 없으면 만들지 않는다.
- 잠긴 프로젝트(§8): 앱은 대본·녹음·요청 모두 읽기 전용(재생·열람만). 맥은 잠긴 프로젝트의 AI 음성을 만들지 않고 `apply_script` 도 가져가지 않는다.
- 맥 AI 음성 생성은 결정적인 로컬 작업(TTS)이며 요청이 필요 없다: `script.json` 이 바뀌면 오래된·없는 AI 음성을 자동으로 다시 만든다.
- **호환**: 1.9 이하 리더는 `script/` 와 `apply_script` 를 모르고 무시한다(`apply_script` 요청은 whitelist 밖이므로 무시됨).
