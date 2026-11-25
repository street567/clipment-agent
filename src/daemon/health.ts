import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allowedAuthors, currentLock, isAuthorAllowed, listComments, listReplies, listRequests, listWorkspaceProjects, pendingRequests, readWorkspaceContract, workspaces,
  type PendingRequest,
} from '../core/index.ts'
import { DEFAULT_CONFIG, type DaemonConfig } from './config.ts'
import { daemonStatus } from './launchd.ts'
import { pidAlive } from './lock.ts'
import { clipmentHome, TtlCache } from './util.ts'

const MIN = 60_000

// ---------- 세션 하트비트 (채널 모드 MCP 서버 1개당 파일 1개) ----------

export const HEARTBEAT_EVERY_MS = 30_000
export const sessionsDir = () => join(clipmentHome(), 'sessions')
const beatFile = (pid: number) => join(sessionsDir(), `${pid}.json`)

/** version/sessionVersion 은 0.4.0 부터 (옛 하트비트 파일에는 없음 → 선택 필드). pid 는 릴레이 pid (세션 식별자) */
export interface Heartbeat { pid: number; cwd: string; startedAt: string; lastBeat: string; version?: string; sessionVersion?: string }
export interface SessionInfo extends Heartbeat { ageSec: number; alive: boolean; stale: boolean }

export function writeHeartbeat(h: Heartbeat): void {
  mkdirSync(sessionsDir(), { recursive: true })
  const f = beatFile(h.pid)
  writeFileSync(f + '.tmp', JSON.stringify(h) + '\n')
  renameSync(f + '.tmp', f)
}

export function removeHeartbeat(pid = process.pid): void { try { unlinkSync(beatFile(pid)) } catch {} }

/** 채널 모드 MCP 서버가 부른다. 즉시 한 번 쓰고 주기적으로 갱신. 반환 함수로 중지+파일 삭제. */
export function startHeartbeat(o: { pid?: number; cwd?: string; everyMs?: number; startedAt?: string; version?: string; sessionVersion?: string; removeOnStop?: boolean } = {}): (remove?: boolean) => void {
  const pid = o.pid ?? process.pid
  const startedAt = o.startedAt ?? new Date().toISOString()
  const beat = () => {
    try {
      writeHeartbeat({
        pid, cwd: o.cwd ?? process.cwd(), startedAt, lastBeat: new Date().toISOString(),
        ...(o.version ? { version: o.version } : {}), ...(o.sessionVersion ? { sessionVersion: o.sessionVersion } : {}),
      })
    } catch {}
  }
  beat()
  const t = setInterval(beat, o.everyMs ?? HEARTBEAT_EVERY_MS)
  t.unref?.()
  let done = false
  // 릴레이 아래에서는 pid(=릴레이) 파일의 주인이 릴레이이므로 서버는 자기 종료 때 파일을 지우지 않는다 (스왑 사이에 세션이 사라져 보이지 않게)
  const removeDefault = o.removeOnStop ?? pid === process.pid
  const stop = (remove = removeDefault) => { if (done) return; done = true; clearInterval(t); if (remove) removeHeartbeat(pid) }
  process.on('exit', () => stop())
  return stop
}

/** stale = lastBeat 가 staleMs 보다 오래됐거나 pid 가 죽음. 죽은 pid 의 파일은 정리한다(prune). */
export function readSessions(now = Date.now(), staleMs = DEFAULT_CONFIG.sessionStaleMin * MIN, alive: (pid: number) => boolean = pidAlive, prune = false): SessionInfo[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []
  const out: SessionInfo[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    let j: any
    try { j = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { continue }
    if (!Number.isInteger(j?.pid) || typeof j.lastBeat !== 'string') continue
    const last = Date.parse(j.lastBeat)
    const isAlive = alive(j.pid)
    if (!isAlive && prune) { try { unlinkSync(join(dir, f)) } catch {} }
    out.push({
      pid: j.pid, cwd: String(j.cwd ?? ''), startedAt: String(j.startedAt ?? ''), lastBeat: j.lastBeat,
      ...(typeof j.version === 'string' ? { version: j.version } : {}), ...(typeof j.sessionVersion === 'string' ? { sessionVersion: j.sessionVersion } : {}),
      ageSec: Number.isFinite(last) ? Math.round((now - last) / 1000) : Infinity,
      alive: isAlive, stale: !isAlive || !Number.isFinite(last) || now - last > staleMs,
    })
  }
  return out.sort((a, b) => a.pid - b.pid)
}
export const liveSessions = (s: SessionInfo[]) => s.filter(x => !x.stale)

// ---------- 미처리 요청 ----------

export interface UnclaimedRequest { ref: string; project: string; id: string; type: string; version: number; agent: string; created: string; ageMin: number }

/** 아무도 잡지 않은(진행 이벤트 없음, state=pending) 요청. olderThanMs 이상 묵은 것만. 소유자(agent) 필터 없음. */
export function pickUnclaimed(pending: PendingRequest[], now: number, olderThanMs = 0): UnclaimedRequest[] {
  const out: UnclaimedRequest[] = []
  for (const r of pending) {
    if (r.state !== 'pending') continue
    const age = now - Date.parse(r.created)
    if (!Number.isFinite(age) || age < olderThanMs) continue
    out.push({ ref: r.ref, project: r.project, id: r.id, type: r.type, version: r.version, agent: r.agent, created: r.created, ageMin: Math.floor(age / MIN) })
  }
  return out
}

export const allPending = () => pendingRequests(undefined, null, () => {})

/** 채널 재푸시 백오프: 처음엔 나이 ≥ base 면 due, 이후 base·2^(n-1) (상한 base·4) 만큼 지나야 다시 due. (3, 6, 12, 12 … 분) */
export class RepushTracker {
  private m = new Map<string, { n: number; at: number }>()
  constructor(private baseMs = 3 * MIN) {}
  due(id: string, createdMs: number, now: number): boolean {
    const s = this.m.get(id)
    if (!s) return now - createdMs >= this.baseMs
    return now - s.at >= Math.min(this.baseMs * 2 ** (s.n - 1), this.baseMs * 4)
  }
  mark(id: string, now: number) { const s = this.m.get(id); this.m.set(id, { n: (s?.n ?? 0) + 1, at: now }) }
  /** 스왑 때 새 서버에 넘기는 상태 */
  dump(): { id: string; n: number; at: number }[] { return [...this.m].map(([id, s]) => ({ id, n: s.n, at: s.at })) }
  load(list: { id: string; n: number; at: number }[]) { for (const s of list) this.m.set(s.id, { n: s.n, at: s.at }) }
  /** 더는 미처리가 아닌 요청은 잊는다 */
  retain(ids: Set<string>) { for (const k of this.m.keys()) if (!ids.has(k)) this.m.delete(k) }
}

/** 이번에 재푸시할 요청들 (tracker 갱신 포함) */
export function selectRepush(unclaimed: UnclaimedRequest[], tracker: RepushTracker, now: number): UnclaimedRequest[] {
  tracker.retain(new Set(unclaimed.map(u => u.id)))
  const due = unclaimed.filter(u => tracker.due(u.id, Date.parse(u.created), now))
  for (const u of due) tracker.mark(u.id, now)
  return due
}

export function repushText(list: UnclaimedRequest[]): string {
  const items = list.slice(0, 10).map(u => `${u.ref} ${u.type} v${u.version} (requestId ${u.id}, ${u.ageMin}분 경과${u.agent ? `, agent=${u.agent}` : ''})`).join('; ')
  return `⚠️ 미처리 요청 ${list.length}건, 확인 필요: ${items}${list.length > 10 ? ' …' : ''}. 특정 AI 를 지정하지 않은 요청은 모든 워크스페이스/프로젝트를 가리지 말고 처리하세요(wait_for_requests / 채널 알림 사용, 셸 루프 금지).`
}

// ---------- 코멘트만 있고 요청이 없는 경우 ----------

export interface StaleComment { ref: string; commentId: string; version: number; t: number; created: string; ageMin: number; text: string }

/**
 * 열린(open) 코멘트 중 `olderThanMs` 이상 묵었는데 그 코멘트를 덮는 요청이 없는 것.
 * SPEC §요청: apply_feedback 의 commentIds=null 은 "그 버전의 열린 코멘트 전부", 배열이면 그 코멘트들.
 * 덮는다 = apply_feedback 이고 코멘트가 (다시) 열린 시점 이후에 만들어졌고, commentIds 배열이면 거기 포함(요청 version 과 무관 — 여러 버전의 코멘트가 섞일 수 있다, SPEC §15),
 * commentIds 가 null 이면 version 이 같을 때(코멘트 version 0 이면 아무 version).
 * 열린 시점 = 다시 열린 코멘트면 현재 open 상태를 만든 답글의 created(openedAt), 아니면 코멘트 created.
 * via=channel(사람이 채널에서 한 말을 AI 가 대신 남긴 코멘트)은 이미 처리 중이므로 제외.
 * 처리 끝난(done) 요청도 덮은 것으로 본다(그 뒤에도 open 이면 AI 가 답글을 안 단 것이라 요청 문제가 아님 → 보수적으로 제외).
 */
export function staleCommentsOf(
  comments: { id: string; version: number; t: number; created: string; text: string; via?: string; openedAt?: string }[],
  requests: { type: string; version: number; commentIds: string[] | null; created: string }[],
  ref: string, now: number, olderThanMs: number,
): StaleComment[] {
  const out: StaleComment[] = []
  for (const c of comments) {
    if (c.via === 'channel') continue
    const created = Date.parse(c.created)
    const opened = c.openedAt ? Date.parse(c.openedAt) : NaN
    const cm = Number.isFinite(opened) && Number.isFinite(created) ? Math.max(created, opened) : created
    if (!Number.isFinite(cm) || now - cm < olderThanMs) continue
    const covered = requests.some(r => r.type === 'apply_feedback' && Date.parse(r.created) >= cm
      && (r.commentIds ? r.commentIds.includes(c.id) : (c.version === 0 || r.version === c.version)))
    if (!covered) out.push({ ref, commentId: c.id, version: c.version, t: c.t, created: c.created, ageMin: Math.floor((now - cm) / MIN), text: c.text.slice(0, 80) })
  }
  return out
}

export async function findStaleComments(now: number, olderThanMs: number): Promise<StaleComment[]> {
  const out: StaleComment[] = []
  for (const w of workspaces()) {
    let projects: { id: string }[] = []
    try { projects = await listWorkspaceProjects(w) } catch { continue }
    try { if ((await readWorkspaceContract(w.path)).readOnly) continue } catch { continue }
    const allow = allowedAuthors(w)
    for (const p of projects) {
      const ref = `${w.name}/${p.id}`
      try {
        if (await currentLock(ref)) continue
        const open = (await listComments(ref, { status: 'open' })).filter(c => isAuthorAllowed(c, allow) && c.via !== 'channel')
        if (!open.length) continue
        // 다시 열린 코멘트: 현재 open 상태를 만든 (가장 최근 status) 답글의 created 가 기준
        const withOpened = await Promise.all(open.map(async c => {
          if (!c.replyCount) return c
          const last = (await listReplies(ref, c.id)).filter(r => r.status).pop()
          return last ? { ...c, openedAt: last.created } : c
        }))
        out.push(...staleCommentsOf(withOpened, await listRequests(ref), ref, now, olderThanMs))
      } catch {}
    }
  }
  return out
}

// ---------- 리포트 ----------

export interface HealthReport {
  checkedAt: string
  daemon: { installed: boolean; loaded: boolean; running: boolean; pid: number | null }
  sessions: SessionInfo[]
  liveSessions: number
  unclaimed: UnclaimedRequest[]
  staleComments: StaleComment[]
  issues: string[]
  ok: boolean
}

export interface HealthOpts { now?: number; cfg?: DaemonConfig; skipComments?: boolean; daemon?: HealthReport['daemon']; alive?: (pid: number) => boolean }

export async function buildHealthReport(o: HealthOpts = {}): Promise<HealthReport> {
  const now = o.now ?? Date.now()
  const cfg = o.cfg ?? DEFAULT_CONFIG
  const daemon = o.daemon ?? (() => {
    const s = daemonStatus()
    return { installed: s.installed, loaded: s.loaded, running: s.lockAlive, pid: s.lockAlive ? s.lockPid : null }
  })()
  const sessions = readSessions(now, cfg.sessionStaleMin * MIN, o.alive, true)
  const live = liveSessions(sessions).length
  const unclaimed = pickUnclaimed(await allPending(), now)
  const staleComments = o.skipComments ? [] : await findStaleComments(now, cfg.orphanCommentMin * MIN)
  const issues: string[] = []
  if (!daemon.installed) issues.push('데몬이 설치되지 않았습니다 (clipment daemon install)')
  else if (!daemon.loaded || !daemon.running) issues.push('데몬이 실행 중이 아닙니다 (clipment daemon restart)')
  if (unclaimed.length && live === 0) issues.push('대기 요청이 있는데 살아 있는 채널 모드 세션이 없습니다')
  const overdue = unclaimed.filter(u => u.ageMin >= cfg.unclaimedRepushMin)
  if (overdue.length) issues.push(`${cfg.unclaimedRepushMin}분 넘게 미처리인 요청 ${overdue.length}건`)
  if (staleComments.length) issues.push(`요청 없이 ${cfg.orphanCommentMin}분 넘게 열려 있는 코멘트 ${staleComments.length}개`)
  return { checkedAt: new Date(now).toISOString(), daemon, sessions, liveSessions: live, unclaimed, staleComments, issues, ok: issues.length === 0 }
}

/** " · 서버 v0.4.1 (세션 시작 v0.4.0)" — 옛 하트비트(필드 없음)면 빈 문자열 */
export function versionLabel(s: { version?: string; sessionVersion?: string }): string {
  if (!s.version) return ''
  return ` · 서버 v${s.version}${s.sessionVersion && s.sessionVersion !== s.version ? ` (세션 시작 v${s.sessionVersion}, 지침은 옛 버전)` : ''}`
}

export function formatHealth(r: HealthReport): string {
  const L: string[] = []
  const d = r.daemon
  L.push(`데몬: 설치 ${d.installed ? '예' : '아니오'} · launchd 로드 ${d.loaded ? '예' : '아니오'} · 실행 ${d.running ? `pid ${d.pid}` : '아니오'}`)
  L.push(`채널 세션: 살아 있음 ${r.liveSessions}개 (전체 기록 ${r.sessions.length}개)`)
  for (const s of r.sessions) L.push(`  pid ${s.pid} ${s.stale ? '[stale]' : '[live]'} cwd=${s.cwd} lastBeat=${s.lastBeat} (${s.ageSec}초 전)${versionLabel(s)}`)
  L.push(`미처리 요청: ${r.unclaimed.length}건`)
  for (const u of r.unclaimed) L.push(`  ${u.ref} ${u.type} v${u.version} ${u.ageMin}분 경과 agent=${u.agent || '-'} — ${u.id}`)
  L.push(`요청 없는 열린 코멘트: ${r.staleComments.length}개`)
  for (const c of r.staleComments.slice(0, 20)) L.push(`  ${c.ref} v${c.version} ${c.ageMin}분 경과 — ${c.text} (${c.commentId})`)
  L.push(r.ok ? '상태: 정상' : `상태: 확인 필요\n${r.issues.map(i => `  - ${i}`).join('\n')}`)
  return L.join('\n')
}

// ---------- 데몬 알림 (dedupe) ----------

export interface HealthNotifyState { seen: TtlCache; lastSessionAlert: number }
export const newHealthNotifyState = (): HealthNotifyState => ({ seen: new TtlCache(1000), lastSessionAlert: 0 })
const day = (now: number) => new Date(now).toISOString().slice(0, 10)

export function planHealthNotifications(r: HealthReport, st: HealthNotifyState, cfg: DaemonConfig, now = Date.now()): { title: string; body: string; low?: boolean }[] {
  const out: { title: string; body: string; low?: boolean }[] = []
  // 1) 오래 미처리 — 요청별 1회
  const fresh = r.unclaimed.filter(u => u.ageMin >= cfg.unclaimedNotifyMin && !st.seen.has('u:' + u.ref + ':' + u.id, now))
  for (const u of fresh) st.seen.add('u:' + u.ref + ':' + u.id, now)
  if (fresh.length > 3) out.push({ title: 'Clipment', body: `${cfg.unclaimedNotifyMin}분 넘게 미처리 요청 ${fresh.length}건 (${fresh.slice(0, 3).map(u => u.project).join(', ')} …)` })
  else for (const u of fresh) out.push({ title: 'Clipment', body: `미처리 요청 ${u.ageMin}분째 · ${u.project} v${u.version} (${u.type})` })
  // 2) 세션 없음 — 최대 sessionAlertRepeatMin 마다
  if (r.unclaimed.length && r.liveSessions === 0 && now - st.lastSessionAlert >= cfg.sessionAlertRepeatMin * MIN) {
    st.lastSessionAlert = now
    out.push({ title: 'Clipment', body: `Clipment 처리 세션이 꺼져 있어요 (대기 요청 ${r.unclaimed.length}건)` })
  }
  // 3) 요청 없는 코멘트 — 프로젝트당 하루 1회, 낮은 우선순위
  const byRef = new Map<string, number>()
  for (const c of r.staleComments) byRef.set(c.ref, (byRef.get(c.ref) ?? 0) + 1)
  for (const [ref, n] of byRef) {
    const key = `c:${ref}:${day(now)}`
    if (st.seen.has(key, now)) continue
    st.seen.add(key, now)
    out.push({ title: 'Clipment (참고)', body: `${ref}: 열린 코멘트 ${n}개가 있지만 폰에서 요청을 보내지 않았어요`, low: true })
  }
  return out
}
