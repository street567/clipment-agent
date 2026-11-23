import type { Runner } from './runner.ts'
import { TtlCache } from './util.ts'
import type { PendingRequest } from '../core/index.ts'

export type Notifier = (title: string, body: string) => Promise<void>

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').slice(0, 200)

/** osascript 인자 구성 (테스트용으로 분리) */
export function osascriptArgs(title: string, body: string): string[] {
  return ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`]
}

export function osascriptNotifier(run: Runner): Notifier {
  return async (title, body) => { await run('osascript', osascriptArgs(title, body), { timeoutMs: 10_000 }) }
}

export function notificationBody(r: PendingRequest, comments: number): string {
  if (r.type === 'apply_script') return `새 요청 · ${r.project} v${r.version} · 대본 ${r.draft ? '초안' : '영상 반영'}`
  return `새 요청 · ${r.project} v${r.version} · ${comments}개 코멘트`
}

export const MAX_INDIVIDUAL = 3

/**
 * 새 요청들 → 보낼 알림 목록. 이미 알린(dedupe 캐시) 요청은 제외, 한 번에 3개 초과면 요약 1건으로 합친다.
 */
export function planNotifications(
  fresh: { req: PendingRequest; comments: number }[], seen: TtlCache, now = Date.now(),
): { title: string; body: string }[] {
  const items = fresh.filter(f => !seen.has('n:' + f.req.id, now))
  for (const f of items) seen.add('n:' + f.req.id, now)
  if (items.length === 0) return []
  if (items.length > MAX_INDIVIDUAL) return [{ title: 'Clipment', body: `새 요청 ${items.length}개 (${items.slice(0, 3).map(i => i.req.project).join(', ')} …)` }]
  return items.map(f => ({ title: 'Clipment', body: notificationBody(f.req, f.comments) }))
}
