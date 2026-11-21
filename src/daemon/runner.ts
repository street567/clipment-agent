import { spawn } from 'node:child_process'

export interface RunResult { code: number | null; signal: string | null; timedOut: boolean; output: string }
export interface RunOpts { timeoutMs: number; cwd?: string; env?: Record<string, string | undefined> }
/** 주입 가능한 실행기. 항상 완료까지 await 된다. */
export type Runner = (cmd: string, args: string[], opts: RunOpts) => Promise<RunResult>

const OUTPUT_CAP = 64 * 1024

/** 살아 있는 자식 프로세스 그룹 추적 → 종료 시 전부 정리 */
export class ChildTracker {
  private pgids = new Set<number>()
  track(pgid: number) { this.pgids.add(pgid) }
  untrack(pgid: number) { this.pgids.delete(pgid) }
  get count() { return this.pgids.size }
  killAll(sig: NodeJS.Signals = 'SIGTERM') {
    for (const g of this.pgids) { try { process.kill(-g, sig) } catch {} }
  }
}

/**
 * 자식을 독립 프로세스 그룹(detached)으로 띄워 타임아웃/종료 시 그룹 전체(-pgid)를 죽인다.
 * stdout/stderr 는 꼬리 64KB 만 보관 (메모리 상한).
 */
export function makeRunner(tracker: ChildTracker, killGraceMs = 3000): Runner {
  return (cmd, args, opts) => new Promise<RunResult>(resolve => {
    let output = ''
    let timedOut = false
    let settled = false
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    })
    const pgid = child.pid
    if (pgid) tracker.track(pgid)
    const take = (d: Buffer) => { output += d.toString('utf8'); if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP) }
    child.stdout?.on('data', take); child.stderr?.on('data', take)
    const killGroup = (sig: NodeJS.Signals) => { if (pgid) try { process.kill(-pgid, sig) } catch {} }
    let hardKill: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      killGroup('SIGTERM')
      hardKill = setTimeout(() => killGroup('SIGKILL'), killGraceMs)
    }, opts.timeoutMs)
    const done = (code: number | null, signal: string | null, extra = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer); if (hardKill) clearTimeout(hardKill)
      killGroup('SIGKILL') // 남은 손자 프로세스 정리 (이미 없으면 무시)
      if (pgid) tracker.untrack(pgid)
      resolve({ code, signal, timedOut, output: output + extra })
    }
    child.on('error', e => done(null, null, `\nspawn 실패: ${e.message}`))
    child.on('close', (code, signal) => done(code, signal))
  })
}
