---
description: 클라우드 루트를 정리해 아이폰 앱이 워크스페이스를 찾게 한다 (clipment index)
argument-hint: "[루트 경로]"
---

`organize-root` 스킬을 따라 루트를 정리하세요. 루트 경로: $ARGUMENTS (비어 있으면 사용자에게 물어 확인).

1. 경로 확인 후 `clipment index <루트>` (또는 MCP `index_root`) 실행, 찾은 워크스페이스를 보고.
2. `workspace.json` 이 없는 곳은 사용자 확인 후에만 `--fix`.
3. 흩어진 프로젝트 폴더는 이동을 제안만 하고, 명시적 승인 없이 옮기지 않는다. 삭제는 절대 하지 않는다.
