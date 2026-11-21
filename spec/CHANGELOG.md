# 계약 변경 이력

버전 규칙 (SPEC §10): **MAJOR** 깨지는 변경(옛 리더가 안전하게 읽거나 쓸 수 없음) · **MINOR** 추가만(모르는 필드는 무시) · **PATCH** 문구·예시 정리.
1.0.0~1.5.0 은 git 이력(`docs/SPEC-mvp.md`)에서 복원했다.

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
