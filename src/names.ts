// 배포 이름의 단일 출처 (의존성 없음 — relay/lib.ts 도 가져다 씀). 저장소·마켓플레이스·플러그인 이름을 바꿀 땐 여기와
// install.sh 위 NAMES 블록, .claude-plugin/*.json, mcpb/manifest.json, 문서( grep -rn "client-ai-bridge" )를 같이 바꾼다.
export const OWNER = 'street567'
export const REPO_NAME = 'client-ai-bridge'
/** GitHub 저장소 (owner/name) */
export const REPO = `${OWNER}/${REPO_NAME}`
/** 예전 저장소 이름들 — 이 origin 을 가진 기존 클론도 계속 업데이트한다 */
export const LEGACY_REPOS = ['street567/clipment-agent']
/** Claude Code 마켓플레이스·플러그인 이름 */
export const MARKETPLACE = 'street567'
export const PLUGIN = 'client-ai-bridge'
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`
/** 예전(0.5.x 이하) 플러그인 — 업그레이드 때 제거 대상 */
export const LEGACY_PLUGIN_ID = 'clipment@clipment-agent'
export const LEGACY_MARKETPLACE = 'clipment-agent'
/**
 * package.json 의 name. 옛 업데이터/릴레이(0.5.x)가 "name === clipment-agent" 로 새 버전을 검증하므로
 * 저장소 이름이 바뀌어도 일부러 그대로 둔다(바꾸면 기존 설치의 자동 업데이트가 거부됨). 릴리스 tar.gz 이름도 같은 이유.
 */
export const PKG_NAME = 'clipment-agent'
export const PKG_NAMES = [PKG_NAME]

/** origin URL 로 쓸 수 있는 형태들 */
export const originsOf = (repo: string) => [`https://github.com/${repo}.git`, `https://github.com/${repo}`, `git@github.com:${repo}.git`, `ssh://git@github.com/${repo}.git`]
export const EXPECTED_ORIGINS = [REPO, ...LEGACY_REPOS].flatMap(originsOf)
