import { currentLock, listRequests, listWorkspaceProjects } from './store.ts'
import { resolveProject, workspaces, type Workspace } from './paths.ts'
import { newerContractMessage, readWorkspaceContract } from './contract.ts'
import type { RequestWithState } from './types.ts'

export type PendingRequest = RequestWithState & { project: string; workspace: string; ref: string }

export function agentName(): string {
  return process.env.CLIPREV_AGENT?.trim() || 'claude'
}

/**
 * 허용 작성자 목록. 워크스페이스별 allowAuthors 가 있으면 그것을, 없으면 환경변수
 * CLIPREV_ALLOW_AUTHORS="개미,사용자" 를 쓴다. 둘 다 없으면 null(전부 허용).
 */
export function allowedAuthors(ws?: { allowAuthors?: string[] }): string[] | null {
  if (ws?.allowAuthors?.length) return ws.allowAuthors
  const raw = process.env.CLIPREV_ALLOW_AUTHORS
  if (!raw || !raw.trim()) return null
  const list = raw.split(',').map(s => s.trim()).filter(Boolean)
  return list.length ? list : null
}

export function isAuthorAllowed(r: { authorName?: string }, allow: string[] | null = allowedAuthors()): boolean {
  return !allow || (!!r.authorName && allow.includes(r.authorName))
}

/** 허용 목록이 있는데 이 이름이 거기 없으면 경고문 (add_comment 의 authorName=CLIPREV_USER_NAME 이 목록 밖이면 앱/요청 필터에서 걸릴 수 있음). 없으면 null */
export function authorAllowWarning(ws: { allowAuthors?: string[] } | undefined, authorName?: string): string | null {
  const allow = allowedAuthors(ws)
  if (!allow || isAuthorAllowed({ authorName }, allow)) return null
  return `경고: 허용 작성자 목록(${allow.join(',')})에 ${authorName ? `"${authorName}"` : '(이름 없음)'} 이(가) 없습니다. CLIPREV_USER_NAME 을 허용된 이름으로 설정하세요`
}

/**
 * 이 에이전트가 처리할 대기 요청 (모든 워크스페이스). 요청의 agent 가 비어 있지 않고 다른 에이전트 이름이면 제외.
 * 잠긴 프로젝트는 제외. (type 화이트리스트는 listRequests 에서 이미 적용됨)
 * `project` = 유일하면 slug, 모호하면 "워크스페이스/slug" (그대로 다른 도구에 넘겨도 되는 값), `ref` 는 항상 한정 이름.
 */
const warned = new Set<string>()
/** 더 새 계약 워크스페이스 경고: 프로세스당 워크스페이스별 한 번만 stderr 로 */
function defaultSkipWarn(ws: Workspace, msg: string) {
  if (warned.has(ws.path)) return
  warned.add(ws.path)
  process.stderr.write(`clipment: [${ws.name}] ${msg}\n`)
}

export async function pendingRequests(
  project?: string, agent: string | null = agentName(),
  onSkip: (ws: Workspace, msg: string) => void = defaultSkipWarn,
): Promise<PendingRequest[]> {
  const targets: { ws: Workspace; slug: string }[] = []
  if (project) {
    const r = resolveProject(project)
    targets.push({ ws: r.workspace, slug: r.slug })
  } else {
    for (const w of workspaces()) for (const p of await listWorkspaceProjects(w)) targets.push({ ws: w, slug: p.id })
  }
  const counts = new Map<string, number>()
  for (const t of targets) counts.set(t.slug, (counts.get(t.slug) ?? 0) + 1)
  const multi = workspaces().length > 1
  const out: PendingRequest[] = []
  for (const { ws, slug } of targets) {
    const ref = `${ws.name}/${slug}`
    const wc = await readWorkspaceContract(ws.path)
    if (wc.readOnly) { onSkip(ws, newerContractMessage(wc.version)); continue }
    if (await currentLock(ref)) continue
    const allow = allowedAuthors(ws)
    for (const r of await listRequests(ref, { pendingOnly: true })) {
      if (agent && r.agent && r.agent !== agent) continue
      if (!isAuthorAllowed(r, allow)) continue
      out.push({ ...r, workspace: ws.name, ref, project: multi && (counts.get(slug) ?? 0) > 1 ? ref : slug })
    }
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : 1))
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function waitForRequests(opts: {
  project?: string; timeoutSec?: number; agent?: string | null; pollMs?: number; signal?: AbortSignal
}): Promise<PendingRequest[]> {
  const deadline = Date.now() + Math.max(0, opts.timeoutSec ?? 600) * 1000
  const poll = opts.pollMs ?? 1500
  for (;;) {
    const found = await pendingRequests(opts.project, opts.agent)
    if (found.length) return found
    if (Date.now() >= deadline || opts.signal?.aborted) return []
    await sleep(Math.min(poll, Math.max(0, deadline - Date.now())))
  }
}
