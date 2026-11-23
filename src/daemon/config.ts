import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { AUTO_RUNS, type AutoRun } from './autorun.ts'
import { daemonConfigPath } from './util.ts'

export interface DaemonConfig {
  autoRun: AutoRun; jobTimeoutMin: number; notify: boolean; pollMs: number; maxPollMs: number; maxAgeMin: number
  /** 헬스 체크 */
  healthCheckMs: number; unclaimedRepushMin: number; unclaimedNotifyMin: number; sessionStaleMin: number; sessionAlertRepeatMin: number; orphanCommentMin: number
}
export const DEFAULT_CONFIG: DaemonConfig = { autoRun: 'off', jobTimeoutMin: 30, notify: true, pollMs: 5000, maxPollMs: 30000, maxAgeMin: 1440,
  healthCheckMs: 60_000, unclaimedRepushMin: 3, unclaimedNotifyMin: 10, sessionStaleMin: 2, sessionAlertRepeatMin: 30, orphanCommentMin: 30,
}

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
    healthCheckMs: num(j.healthCheckMs, c.healthCheckMs, 1000, 3_600_000),
    unclaimedRepushMin: num(j.unclaimedRepushMin, c.unclaimedRepushMin, 0.1, 10_000),
    unclaimedNotifyMin: num(j.unclaimedNotifyMin, c.unclaimedNotifyMin, 0.1, 10_000),
    sessionStaleMin: num(j.sessionStaleMin, c.sessionStaleMin, 0.1, 10_000),
    sessionAlertRepeatMin: num(j.sessionAlertRepeatMin, c.sessionAlertRepeatMin, 0.1, 10_000),
    orphanCommentMin: num(j.orphanCommentMin, c.orphanCommentMin, 0.1, 100_000),
  }
}

/** 기존 키는 보존하고 일부만 갱신 */
export function saveDaemonConfig(patch: Partial<DaemonConfig>, file = daemonConfigPath()): void {
  let j: any = {}
  try { if (existsSync(file)) j = JSON.parse(readFileSync(file, 'utf8')) } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...j, ...patch }, null, 2) + '\n')
}
