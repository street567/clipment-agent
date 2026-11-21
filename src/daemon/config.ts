import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AUTO_RUNS, type AutoRun } from './autorun.ts'
import { daemonConfigPath } from './util.ts'

export interface DaemonConfig {
  autoRun: AutoRun; jobTimeoutMin: number; notify: boolean; pollMs: number; maxPollMs: number; maxAgeMin: number
}
export const DEFAULT_CONFIG: DaemonConfig = { autoRun: 'off', jobTimeoutMin: 30, notify: true, pollMs: 5000, maxPollMs: 30000, maxAgeMin: 1440 }

export function loadDaemonConfig(file = daemonConfigPath()): DaemonConfig {
  let j: any = {}
  try { if (existsSync(file)) j = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  const num = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d)
  const c = DEFAULT_CONFIG
  return {
    autoRun: AUTO_RUNS.includes(j.autoRun) ? j.autoRun : 'off',
    jobTimeoutMin: num(j.jobTimeoutMin, c.jobTimeoutMin, 1, 600),
    notify: j.notify === false ? false : true,
    pollMs: num(j.pollMs, c.pollMs, 1000, 600_000),
    maxPollMs: num(j.maxPollMs, c.maxPollMs, 1000, 600_000),
    maxAgeMin: num(j.maxAgeMin, c.maxAgeMin, 1, 100_000),
  }
}

/** 기존 키는 보존하고 일부만 갱신 */
export function saveDaemonConfig(patch: Partial<DaemonConfig>, file = daemonConfigPath()): void {
  let j: any = {}
  try { if (existsSync(file)) j = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...j, ...patch }, null, 2) + '\n')
}
