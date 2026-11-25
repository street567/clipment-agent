# 계약 변경 이력

버전 규칙 (SPEC §10): **MAJOR** 깨지는 변경(옛 리더가 안전하게 읽거나 쓸 수 없음) · **MINOR** 추가만(모르는 필드는 무시) · **PATCH** 문구·예시 정리.
1.0.0~1.5.0 은 git 이력(`docs/SPEC-mvp.md`)에서 복원했다.

## 1.11.0 — 리뷰(반영 확인)
- §15 답글 선택 필드 `fixedAt`(반영 버전에서의 시점, 초), `kind: "review"` + `review: approved|pending`(사람의 확인). 확인됨·확인 필요 파생 규칙.
- §15 코멘트 선택 필드 `via: "channel"`(앱 밖에서 한 요청을 AI 가 대신 기록).
- 요청 `commentIds` 에 다른 버전의 코멘트가 섞일 수 있음을 명시(맥은 id 로 찾는다).

## 1.10.0 — 대본(보이스)
- §14 프로젝트 대본 `<프로젝트>/script/script.json`(고쳐 쓰는 파일: 폰·맥 모두 쓰고 마지막이 이김) — `language`(en|ko) + `lines[]{id,start,end?,text,voice(ai|mine),aiTextHash?,updated,author?}`. 스키마 `script.schema.json`.
- 내 녹음 `script/mine/<lineId>.m4a`(앱), AI 음성 `script/ai/<lineId>.m4a`(맥) + `aiTextHash`(= SHA-256(language+"\n"+NFC·trim 텍스트) 앞 16 hex)로 오래됨 판단. 맥은 오래된 AI 음성을 자동 재생성.
- 요청 type `apply_script`(`version`, 선택 `draft`) 추가 — whitelist 확장. 게시 시 `versions/vNNN/script.json` 스냅샷.

## 1.9.0 — 작업용 화질
- §13 미리보기 화질 `360p|540p|720p|1080p`(긴 변 640/960/1280/1920, 기본 720p). 워크스페이스 기본 `workspace.json` `previewQuality`(선택), 프로젝트 지정 `<프로젝트>/.clipment/quality.json`(선택, 고쳐 쓰는 파일, 마지막에 쓴 쪽이 이김). 스키마 `quality.schema.json`.
- 게시 때 화질 결정 순서: 명시 인자 > 프로젝트 quality.json > 워크스페이스 previewQuality > 720p. 이미 있는 버전은 그대로.
- `meta.json` 선택 필드 `quality`(게시에 쓴 화질).

## 1.8.0 — 업로드용 영상
- §12 `versions/vNNN/original.<ext>` (선택 원본) + `meta.json` `original{file,bytes,width,height,fps?,duration?}`. 클라이언트는 원본을 자동으로 내려받지 않는다.
- §12 `<프로젝트>/.clipment/upload.json` (선택, 고쳐 쓰는 파일) 업로드용 버전 지정 + 기본 규칙(원본 있는 최신 → 최신). 스키마 `upload.schema.json`.

## 1.7.0 — 작업 지침 · 요청 agent 비움
- §11 `.clipment/preferences.md` (워크스페이스·프로젝트, 선택, 고쳐 쓰는 Markdown). 우선순위: 요청 message > 프로젝트 > 워크스페이스.
- 요청 `agent`: 앱은 빈 값을 쓴다(연결된 어떤 AI든 처리). 실제 처리 AI는 progress `agent`.

## 1.6.0 — 계약 버전 필드
- `workspace.json`·`.clipment/index.json` 에 `contract: "<major>.<minor>"` 추가(선택, 없으면 "1.0").
- SPEC §10 호환 규칙: 폴더 MAJOR 가 리더보다 크면 읽기 전용 + 업데이트 안내, 같은 MAJOR 의 높은 MINOR 는 정상 읽기.
- `spec/` 폴더(SPEC·스키마·fixtures·contract.json)를 앱 레포의 원본으로 신설.

## 1.5.0 — 루트 인덱스 (§9)
- `<루트>/.clipment/index.json`: 맥이 쓰고 폰은 읽기만. 루트 자체가 워크스페이스면 path `"."` (785df6d, c0cde85).

## 1.4.0 — 프로젝트 완료 잠금 (§8)
- `locks/<id>.json` (locked/unlocked 이벤트, 불변). 잠긴 프로젝트는 앱 읽기 전용, 맥은 요청 무시·publish/reply 거부 (bf53e85).

## 1.3.0 — 워크스페이스 (§7)
- 여러 루트(워크스페이스), 선택 파일 `workspace.json`, 맥 `workspaces.json` 설정, `<워크스페이스>/<프로젝트>` 지정, 워크스페이스별 allowAuthors (0ea69e4).

## 1.2.0 — 화면 영역 (§6)
- 코멘트 `regions`(0~1 정규화 사각형, 최대 8), 안정 `label` 번호, 영역 수정은 `kind:"regions"` 답글 (d7e2080, 9b82781).

## 1.1.0 — 작성자 이름·구간·lite·허용 목록 (§5)
- `authorName`, 구간 코멘트 `end`, `publish --lite`, `CLIPREV_ALLOW_AUTHORS` (c9cc7a5).

## 1.0.0 — 기본 폴더 계약 (§0–4)
- 폴더 구조, 불변 파일 규칙, project/meta/comment/reply/request/progress 스키마, 미리보기 인코딩 (ec0d364, 4000263).
