import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 데몬 홈 (~/.clipment). 테스트/스모크는 HOME 이나 CLIPMENT_HOME 으로 돌린다. */
export function clipmentHome(): string {
  const e = process.env.CLIPMENT_HOME
  return e && e.trim() ? e : join(homedir(), '.clipment')
}
export const statePath = () => join(clipmentHome(), 'state.json')
export const lockPath = () => join(clipmentHome(), 'daemon.lock')
export const logPath = () => join(clipmentHome(), 'daemon.log')
export const daemonConfigPath = () => {
  const e = process.env.CLIPMENT_DAEMON_CONFIG
  return e && e.trim() ? e : join(homedir(), '.config/clipment/daemon.json')
}

/** 크기 제한 있는 TTL 캐시 (dedupe 용). 가득 차면 가장 오래된 항목부터 버린다. */
export class TtlCache {
  private m = new Map<string, number>()
  constructor(private max = 500, private ttlMs = 24 * 3600_000) {}
  has(key: string, now = Date.now()): boolean {
    const t = this.m.get(key)
    if (t === undefined) return false
    if (now - t > this.ttlMs) { this.m.delete(key); return false }
    return true
  }
  add(key: string, now = Date.now()): void {
    this.m.delete(key)
    this.m.set(key, now)
    if (this.m.size > this.max) this.prune(now)
  }
  private prune(now: number) {
    for (const [k, t] of this.m) if (now - t > this.ttlMs) this.m.delete(k)
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string)
  }
  get size() { return this.m.size }
}

/** 줄 단위 JSON 로그, maxBytes 넘으면 .1 로 회전(한 세대만 유지) */
export class Logger {
  private size = 0
  constructor(private file: string, private maxBytes = 5 * 1024 * 1024, private echo = false) {
    try { this.size = existsSync(file) ? statSync(file).size : 0 } catch {}
  }
  log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(data ?? {}) }) + '\n'
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      if (this.size + line.length > this.maxBytes) { renameSync(this.file, this.file + '.1'); this.size = 0 }
      appendFileSync(this.file, line)
      this.size += line.length
    } catch {}
    if (this.echo) process.stderr.write(line)
  }
}
