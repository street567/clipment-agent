import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'

/** `... clipment|cliprev|cli.ts daemon run` 형태의 명령줄인지 */
export const DAEMON_CMD_RE = /(clipment|cliprev|cli\.ts)\S*\s+daemon\s+run(\s|$)/

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' }
}

export function cmdlineOf(pid: number): string {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : ''
}

/** pid 가 살아 있고 우리 데몬 명령줄이면 true (pid 재사용 방지) */
export function defaultIsOurs(pid: number): boolean {
  return pidAlive(pid) && DAEMON_CMD_RE.test(cmdlineOf(pid))
}

export type LockResult = { ok: true; release: () => void } | { ok: false; pid: number }

export function readLockPid(file: string): number | null {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return Number.isInteger(j?.pid) && j.pid > 0 ? j.pid : null
  } catch { return null }
}

/** pid 파일 락: wx 로 배타 생성. 기존 락의 주인이 죽었거나 우리 데몬이 아니면 회수(stale). */
export function acquireLock(file: string, opts: { pid?: number; isOurs?: (pid: number) => boolean } = {}): LockResult {
  const pid = opts.pid ?? process.pid
  const isOurs = opts.isOurs ?? defaultIsOurs
  mkdirSync(dirname(file), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid, started: new Date().toISOString() }) + '\n', { flag: 'wx' })
      return {
        ok: true,
        release: () => { if (readLockPid(file) === pid) try { unlinkSync(file) } catch {} },
      }
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e
    }
    const other = readLockPid(file)
    if (other !== null && other !== pid && isOurs(other)) return { ok: false, pid: other }
    try { unlinkSync(file) } catch {} // stale
  }
  return { ok: false, pid: readLockPid(file) ?? -1 }
}

/** ps 출력에서 `daemon run` 프로세스 pid 목록 (제외 pid 빼고) */
export function parseDaemonProcs(psOut: string, exclude: number[] = []): number[] {
  const out: number[] = []
  for (const line of psOut.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    if (exclude.includes(pid)) continue
    if (DAEMON_CMD_RE.test(m[2]!) && !/\b(ps|pgrep|grep)\b/.test(m[2]!.split(/\s+/)[0] ?? '')) out.push(pid)
  }
  return out
}

export function findDaemonProcs(exclude: number[] = [process.pid]): number[] {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  return r.status === 0 ? parseDaemonProcs(r.stdout, exclude) : []
}
