// 컴퓨터 이름 · 레인(채널) 감지 · agentKey · 레인 소유자 기록 (SPEC 1.2 §16). 내장 모듈만 사용(hook·monitor 가 node_modules 없이 돌아야 함).
// 어떤 사용자의 개인 설정도 가정하지 않는다: 이름은 설정(machineName) → macOS ComputerName → hostname 순.
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import { iso, readJson, writeNew, writeReplace } from './fs.ts'
import { stateDir, withLock, type SessionState } from './localstate.ts'

export const LABEL_MAX = 40

/** 컴퓨터 이름·레인 이름 정리: 제어문자 제거, 경로 구분자 제거, 공백 정리, 최대 40자 */
export function sanitizeLabel(s: unknown, max = LABEL_MAX): string {
  if (typeof s !== 'string') return ''
  return s
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/[\/\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
}

export type MachineSource = 'config' | 'computername' | 'hostname' | 'fallback'
export interface MachineName {
  name: string
  source: MachineSource
}
type Run = (cmd: string, args: string[]) => string | null

const defaultRun: Run = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1500 })
    return r.status === 0 ? (r.stdout || '').trim() : null
  } catch {
    return null
  }
}

/** 컴퓨터 표시 이름: 설정 machineName → macOS ComputerName → os.hostname()(".local" 제거) */
export function resolveMachineName(configured?: string, run: Run = defaultRun, host: () => string = hostname): MachineName {
  const c = sanitizeLabel(configured)
  if (c) return { name: c, source: 'config' }
  if (process.platform === 'darwin') {
    const n = sanitizeLabel(run('scutil', ['--get', 'ComputerName']))
    if (n) return { name: n, source: 'computername' }
  }
  let h = ''
  try {
    h = sanitizeLabel(host().replace(/\.local$/i, ''))
  } catch {}
  return h ? { name: h, source: 'hostname' } : { name: 'computer', source: 'fallback' }
}

/** 이 컴퓨터의 안정적인 무작위 id(로컬 상태). 컴퓨터 이름을 바꿔도 같아서 카드 연속성이 유지된다 */
export function machineId(): string {
  const f = join(stateDir(), 'machine.json')
  const ok = (m: any): m is { id: string } => !!m && typeof m.id === 'string' && /^[0-9a-f-]{16,64}$/.test(m.id)
  try {
    let m = readJson<any>(f)
    if (ok(m)) return m.id
    writeNew(f, { v: 1, id: randomUUID(), created: iso() })
    m = readJson<any>(f)
    if (ok(m)) return m.id
  } catch {}
  // 상태 폴더에 쓸 수 없으면 hostname 에서 만든 값(그래도 같은 컴퓨터에서는 같다)
  return createHash('sha256').update(`host|${hostname()}`).digest('hex').slice(0, 32)
}

export type LaneSource = 'env' | 'telegram' | 'tmux' | 'folder'
export interface LaneInfo {
  lane: string
  source: LaneSource
}

function stripPrefix(name: string, prefixes: string[]): string {
  for (const p of [...prefixes].sort((a, b) => b.length - a.length)) {
    if (p && name.startsWith(p) && name.length > p.length) return name.slice(p.length)
  }
  return name
}

/** tmux 세션 이름: $TMUX 가 있을 때만 `tmux display -p -t $TMUX_PANE '#S'` (1초 제한). 실패하면 null */
export function tmuxSessionName(env: Record<string, string | undefined> = process.env, run: Run = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1000 })
    return r.status === 0 ? (r.stdout || '').trim() : null
  } catch {
    return null
  }
}): string | null {
  if (!env.TMUX) return null
  const pane = env.TMUX_PANE && /^%\d+$/.test(env.TMUX_PANE) ? ['-t', env.TMUX_PANE] : []
  return run('tmux', ['display', '-p', ...pane, '#S'])
}

/**
 * 레인 감지. 먼저 맞는 것이 이긴다:
 *  (a) AGENT_KANBAN_LANE
 *  (b) TELEGRAM_STATE_DIR 의 폴더 이름: `telegram-<x>` → x, `telegram` → "telegram", 그 밖의 이름은 그대로(전용 채널 상태 폴더라는 뜻)
 *  (c) $TMUX 가 있으면 tmux 세션 이름(laneStripPrefixes 로 접두어 제거. 숫자만 있는 이름은 tmux 기본 이름이라 무시)
 *  (d) 작업 폴더 이름 — 이것만 연속되지 않는다(source "folder")
 */
export function detectLane(o: { env?: Record<string, string | undefined>; stripPrefixes?: string[]; cwd?: string; tmux?: () => string | null } = {}): LaneInfo | null {
  const env = o.env ?? process.env
  const a = sanitizeLabel(env.AGENT_KANBAN_LANE)
  if (a) return { lane: a, source: 'env' }
  const dir = (env.TELEGRAM_STATE_DIR ?? '').trim().replace(/[\/\\]+$/, '')
  if (dir) {
    const b = basename(dir)
    const x = sanitizeLabel(/^telegram-(.+)$/.test(b) ? b.slice(9) : b)
    if (x) return { lane: x, source: 'telegram' }
  }
  if (env.TMUX) {
    const raw = sanitizeLabel((o.tmux ?? (() => tmuxSessionName(env)))() ?? '')
    const t = sanitizeLabel(stripPrefix(raw, o.stripPrefixes ?? []))
    if (t && !/^[0-9]+$/.test(t)) return { lane: t, source: 'tmux' }
  }
  const f = sanitizeLabel(o.cwd ? basename(o.cwd) : '')
  return f ? { lane: f, source: 'folder' } : null
}

/** agentKey = sha256(machineId | lane | workspaceRoot) 앞 32 hex */
export function agentKeyOf(machine: string, lane: string, workspaceRoot: string): string {
  return createHash('sha256').update(`${machine}|${lane}|${workspaceRoot}`).digest('hex').slice(0, 32)
}

/** 레인 카드 id: sha256("lane|<agentKey>") 앞 32 hex 를 UUID 모양으로 (SPEC 1.2 §2) */
export function laneCardId(agentKey: string): string {
  const h = createHash('sha256').update(`lane|${agentKey}`).digest('hex').slice(0, 32)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

export const laneTitle = (machine: string, lane: string) => `${machine} · ${lane}`

// ── 레인 소유자: 이 컴퓨터에서 그 레인의 "지금 세션" (가장 늦게 시작한 세션이 이긴다)
interface LaneRec {
  v: 1
  agentKey: string
  sessionId: string
  lane: string
  since: string
}
const laneFile = (key: string) => join(stateDir(), 'lanes', `${key.replace(/[^0-9a-f]/g, '')}.json`)
export function laneOwner(key: string): string | undefined {
  const r = readJson<LaneRec>(laneFile(key))
  return r && typeof r.sessionId === 'string' ? r.sessionId : undefined
}

/**
 * 레인을 이 세션이 가져간다. 직전 소유자가 다른 세션이면 prev 로 돌려준다.
 * force=false(SessionStart 가 아닌 첫 이벤트)이면 직전 소유자가 살아 있을 때 빼앗지 않는다(owned=false).
 */
export async function claimLane(key: string, sid: string, lane: string, o: { force: boolean; isLive: (sid: string) => boolean }): Promise<{ owned: boolean; prev?: string }> {
  return withLock(`lane-${key}`, () => {
    const cur = laneOwner(key)
    if (cur && cur !== sid && !o.force && o.isLive(cur)) return { owned: false, prev: cur }
    if (cur !== sid) writeReplace(laneFile(key), { v: 1, agentKey: key, sessionId: sid, lane, since: iso() } satisfies LaneRec)
    return { owned: true, ...(cur && cur !== sid ? { prev: cur } : {}) }
  })
}

/** 더 새로운 세션이 레인을 가져갔으면 이 세션의 로컬 상태를 "밀려남"으로 바꾼다(레인 카드는 더 받지도 쓰지도 않음). 바뀌면 true */
export function checkSuperseded(st: SessionState): boolean {
  const l = st.lane
  if (!l || l.superseded) return false
  const owner = laneOwner(l.agentKey)
  if (!owner || owner === st.sessionId) return false
  l.superseded = true
  l.replacedBy = owner
  l.pendingFrom = undefined
  delete st.cards[l.cardId]
  st.openInfos = st.openInfos.filter((i) => i.cardId !== l.cardId)
  if (st.now?.cardId === l.cardId) st.now = { ...st.now, state: 'ended', cardId: undefined }
  return true
}

/** 로컬 상태로 본 세션이 아직 살아 있는가: 끝나지 않았고 최근 15분 안에 신호가 있음 */
export function sessionLooksLive(st: SessionState | null | undefined, nowMs = Date.now()): boolean {
  const n = st?.now
  return !!n && n.state !== 'ended' && nowMs - (n.aliveMs || n.writtenMs || 0) < 15 * 60_000
}
