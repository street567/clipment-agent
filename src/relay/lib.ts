// 릴레이(src/mcp.ts)와 서버(src/server.ts)·데몬 업데이터가 함께 쓰는 작은 도우미.
// node/bun 내장 모듈만 쓴다 (npm 의존성 없음 — 릴레이는 의존성 설치 전에도 떠야 한다).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export const clipHome = (): string => {
  const e = process.env.CLIPMENT_HOME
  return e && e.trim() ? e : join(homedir(), '.clipment')
}
export const daemonConfigFile = (): string => {
  const e = process.env.CLIPMENT_DAEMON_CONFIG
  return e && e.trim() ? e : join(homedir(), '.config/clipment/daemon.json')
}
/** 관리형 설치 위치: CLIPMENT_DIR > <CLIPMENT_HOME>/agent (기본 ~/.clipment/agent) */
export const managedDir = (): string => {
  const e = process.env.CLIPMENT_DIR
  return e && e.trim() ? e : join(clipHome(), 'agent')
}

// ---------- 버전 ----------

export const TAG_RE = /^v\d+\.\d+\.\d+$/
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
/** a<b: -1, 같음: 0, a>b: 1. 파싱 불가면 null */
export function cmpVersion(a: string, b: string): number | null {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1
  return 0
}
export const majorOf = (v: string): number | null => parseVersion(v)?.[0] ?? null

export function readPkg(dir: string): { name: string; version: string } | null {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof j?.name === 'string' && typeof j?.version === 'string' ? { name: j.name, version: j.version } : null
  } catch { return null }
}

// ---------- 설정 ----------

/** daemon.json 의 autoUpdate (기본 false). 깨진/없는 파일도 false */
export function readAutoUpdate(file = daemonConfigFile()): boolean {
  try { return JSON.parse(readFileSync(file, 'utf8'))?.autoUpdate === true } catch { return false }
}

// ---------- 나쁜 버전 목록 (릴레이·업데이터 공용, 영속) ----------

export const badListPath = () => join(clipHome(), 'bad-versions.json')
export type BadList = Record<string, { at: string; reason: string }>

function writeJsonAtomic(file: string, v: unknown) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n')
  renameSync(tmp, file)
}

export function readBadList(): BadList {
  try {
    const j = JSON.parse(readFileSync(badListPath(), 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}
export const isBad = (version: string): boolean => version in readBadList()
export function addBad(version: string, reason: string): void {
  const l = readBadList()
  l[version] = { at: new Date().toISOString(), reason: reason.slice(0, 300) }
  try { writeJsonAtomic(badListPath(), l) } catch {}
}

// ---------- 업데이트 적용 중 잠금 (릴레이는 이 동안 새 버전을 고르지 않는다) ----------

export const updateLockPath = () => join(clipHome(), 'update.lock')
export const UPDATE_LOCK_STALE_MS = 15 * 60_000
export function updateLockActive(now = Date.now()): boolean {
  try { return now - statSync(updateLockPath()).mtimeMs < UPDATE_LOCK_STALE_MS } catch { return false }
}

/**
 * 업데이트 적용/롤백/수동 업데이트 동안 잡는 배타 잠금 (wx). 주인이 죽었거나 오래됐으면 회수.
 * 잡았으면 release 함수, 이미 누가 쥐고 있으면 null.
 */
export function acquireUpdateLock(now = Date.now()): (() => void) | null {
  const f = updateLockPath()
  mkdirSync(dirname(f), { recursive: true })
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(f, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + '\n', { flag: 'wx' })
      return () => { try { unlinkSync(f) } catch {} }
    } catch (e: any) { if (e?.code !== 'EEXIST') throw e }
    let owner = -1
    try { owner = JSON.parse(readFileSync(f, 'utf8'))?.pid ?? -1 } catch {}
    const stale = !updateLockActive(now) || (owner > 0 && owner !== process.pid && !pidIsAlive(owner))
    if (!stale) return null
    try { unlinkSync(f) } catch {}
  }
  return null
}

// ---------- 대상(타깃) 선택 ----------

export interface Target { dir: string; version: string; source: 'bundled' | 'managed' }

/**
 * 어떤 server.ts 를 쓸지. autoUpdate 가 꺼져 있으면 항상 번들(릴레이 자신이 있는 폴더).
 * 켜져 있으면 관리형 설치(managedDir)가 server.ts 를 갖고, 이름이 clipment-agent 이고, major 가 같고,
 * 버전이 번들 이상이며, 나쁜 버전 목록에 없을 때만 그쪽.
 */
export function selectTarget(bundledDir: string, o: { autoUpdate?: boolean; managed?: string; bad?: (v: string) => boolean } = {}): Target {
  const bp = readPkg(bundledDir)
  const bundled: Target = { dir: bundledDir, version: bp?.version ?? '0.0.0', source: 'bundled' }
  const on = o.autoUpdate ?? readAutoUpdate()
  if (!on) return bundled
  const dir = o.managed ?? managedDir()
  if (!existsSync(join(dir, 'src/server.ts'))) return bundled
  const mp = readPkg(dir)
  if (!mp || mp.name !== 'clipment-agent' || !bp) return bundled
  const c = cmpVersion(mp.version, bp.version)
  if (c === null || c < 0 || majorOf(mp.version) !== majorOf(bp.version)) return bundled
  if ((o.bad ?? isBad)(mp.version)) return bundled
  return { dir, version: mp.version, source: 'managed' }
}

// ---------- 줄 단위 JSON-RPC ----------

export class LineSplitter {
  private dec = new StringDecoder('utf8')
  private buf = ''
  push(chunk: Buffer | string): string[] {
    this.buf += typeof chunk === 'string' ? chunk : this.dec.write(chunk)
    const out: string[] = []
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      if (line.trim()) out.push(line)
    }
    return out
  }
}

// ---------- 세션 상태 (스왑 때 채널 푸시 상태를 새 서버에 넘긴다) ----------

export interface SessionState {
  v: 1
  /** 이미 푸시(또는 건너뜀 처리)한 요청 id */
  notified: string[]
  /** 미처리 재푸시 백오프 상태 */
  repush: { id: string; n: number; at: number }[]
  /** 채널 루프 최초 시작 시각 (오래된 요청 건너뛰기 기준) */
  startedAt: number
  /** 하트비트 startedAt (ISO) */
  hbStartedAt: string
  /** guide 를 이미 푸시에 붙여 보낸 서버 버전 */
  guideSentFor?: string
  updated: string
}
export const heartbeatPath = (pid: number) => join(clipHome(), 'sessions', `${pid}.json`)
export const sessionStateDir = () => join(clipHome(), 'relay')
export const sessionStatePath = (pid: number) => join(sessionStateDir(), `${pid}.json`)

export function readSessionState(pid: number): SessionState | null {
  try {
    const j = JSON.parse(readFileSync(sessionStatePath(pid), 'utf8'))
    if (j?.v !== 1 || !Array.isArray(j.notified) || !Number.isFinite(j.startedAt)) return null
    return {
      v: 1, notified: j.notified.filter((x: unknown) => typeof x === 'string'),
      repush: Array.isArray(j.repush) ? j.repush.filter((r: any) => r && typeof r.id === 'string' && Number.isFinite(r.n) && Number.isFinite(r.at)) : [],
      startedAt: j.startedAt, hbStartedAt: typeof j.hbStartedAt === 'string' ? j.hbStartedAt : new Date(j.startedAt).toISOString(),
      ...(typeof j.guideSentFor === 'string' ? { guideSentFor: j.guideSentFor } : {}), updated: String(j.updated ?? ''),
    }
  } catch { return null }
}
export function writeSessionState(pid: number, s: SessionState): void {
  try { writeJsonAtomic(sessionStatePath(pid), s) } catch {}
}
export function removeSessionState(pid: number): void { try { unlinkSync(sessionStatePath(pid)) } catch {} }

/** 죽은 pid 의 세션 상태 파일 정리 */
export function pruneSessionStates(alive: (pid: number) => boolean): number {
  let n = 0
  try {
    for (const f of readdirSync(sessionStateDir())) {
      const m = /^(\d+)\.json$/.exec(f)
      if (!m) continue
      if (!alive(Number(m[1]))) { try { unlinkSync(join(sessionStateDir(), f)); n++ } catch {} }
    }
  } catch {}
  return n
}

export function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}
