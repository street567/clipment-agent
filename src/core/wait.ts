import { listProjects, listRequests } from './store.ts'
import { isSlug } from './paths.ts'
import type { RequestWithState } from './types.ts'

export type PendingRequest = RequestWithState & { project: string }

export function agentName(): string {
  return process.env.CLIPREV_AGENT?.trim() || 'claude'
}

/**
 * 이 에이전트가 처리할 대기 요청. 요청의 agent 가 비어 있지 않고 다른 에이전트 이름이면 제외.
 * (type 화이트리스트는 listRequests 에서 이미 적용됨)
 */
export async function pendingRequests(project?: string, agent: string = agentName()): Promise<PendingRequest[]> {
  const slugs = project ? [project] : (await listProjects()).map(p => p.id)
  const out: PendingRequest[] = []
  for (const slug of slugs) {
    if (!isSlug(slug)) continue
    for (const r of await listRequests(slug, { pendingOnly: true })) {
      if (r.agent && r.agent !== agent) continue
      out.push({ ...r, project: slug })
    }
  }
  return out.sort((a, b) => (a.created < b.created ? -1 : 1))
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function waitForRequests(opts: {
  project?: string; timeoutSec?: number; agent?: string; pollMs?: number; signal?: AbortSignal
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
