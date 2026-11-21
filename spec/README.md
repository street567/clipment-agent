# spec/ — 폰↔맥 폴더 계약의 원본

이 폴더가 계약의 **유일한 원본**이다. 앱 레포(clip-review)가 소유한다.

| 파일 | 내용 |
|---|---|
| `SPEC.md` | 계약 본문 (맨 위 "계약 버전 x.y.z") |
| `CHANGELOG.md` | 버전별 변경 이력 |
| `contract.json` | `version`, `minReaderMajor`, 파일 종류 → 스키마 경로 |
| `schemas/*.schema.json` | JSON Schema 2020-12 (알려진 필드만 표시, 추가 필드 허용 = 앞방향 호환) |
| `fixtures/*.json` | 파일 종류별 유효 예시 1개 |
| `validate.sh` | fixtures 를 스키마로 검증 (`bunx ajv-cli`) |

## 버전 올리는 법
1. 규칙(SPEC §10): MAJOR 깨짐 / MINOR 추가 / PATCH 문구.
2. `SPEC.md` 본문 + 맨 위 버전, `CHANGELOG.md` 새 항목, `contract.json` 의 `version` 을 함께 고친다.
3. 스키마·fixture 를 맞춘다 → `spec/validate.sh` 통과.
4. 데이터에 찍는 `contract` 는 `major.minor` — MAJOR/MINOR 가 바뀌면 `ios/ClipReview/Models/Contract.swift` 의 `supported` 도 같이 올린다 (`ContractSyncTests` 가 `contract.json` 과 어긋나면 실패).
5. 앱 `CURRENT_PROJECT_VERSION` 은 동작이 바뀌었을 때만 올린다.

## 맥 레포 동기화
- 맥 레포(`clipment-agent`)는 이 폴더를 그대로 복사해 쓴다 (동기화 스크립트는 맥 레포에 추가 예정, 예: `scripts/sync-spec.sh`). 맥 레포에서 직접 고치지 않는다.
- 맥 CI 는 복사본이 앱 레포 `spec/` 와 같은지(내용 동일) 확인하고, 맥 구현의 지원 버전이 `contract.json` 과 맞는지 테스트한다.
- 판단 규칙은 SPEC §10: 폴더 MAJOR > 리더 MAJOR 면 읽기 전용 + 업데이트 안내.
