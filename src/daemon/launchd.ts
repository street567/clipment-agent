import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findDaemonProcs, pidAlive, readLockPid, defaultIsOurs } from './lock.ts'
import { clipmentHome, lockPath, logPath, statePath } from './util.ts'

export const LABEL = 'com.street567.clipment.daemon'
export const plistPath = () => join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`)

const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export interface PlistOpts { bun: string; cli: string; home: string; pathEnv?: string; logFile: string }

export const DEFAULT_PATH_ENV = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

/** RunAtLoad + 비정상 종료 시에만 재시작(KeepAlive SuccessfulExit=false) + 10초 ThrottleInterval */
export function buildPlist(o: PlistOpts): string {
  const pathEnv = o.pathEnv ?? `${join(o.home, '.local/bin')}:${join(o.home, '.bun/bin')}:${DEFAULT_PATH_ENV}`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(o.bun)}</string>
    <string>${x(o.cli)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${x(pathEnv)}</string>
    <key>HOME</key><string>${x(o.home)}</string>
  </dict>
  <key>StandardOutPath</key><string>${x(o.logFile)}</string>
  <key>StandardErrorPath</key><string>${x(o.logFile)}</string>
</dict>
</plist>
`
}

export interface Exec { (cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string } }
export const realExec: Exec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}
const uid = () => (process.getuid ? process.getuid() : 501)
export const domain = () => `gui/${uid()}`

export function isLoaded(exec: Exec = realExec): boolean {
  return exec('launchctl', ['print', `${domain()}/${LABEL}`]).status === 0
}

function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** pid 에 SIGTERM → 최대 timeout 대기 → 남으면 SIGKILL */
export function killPid(pid: number, timeoutMs = 5000): boolean {
  if (!pidAlive(pid)) return true
  try { process.kill(pid, 'SIGTERM') } catch {}
  const end = Date.now() + timeoutMs
  while (Date.now() < end && pidAlive(pid)) sleepSync(100)
  if (pidAlive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} sleepSync(200) }
  return !pidAlive(pid)
}

export interface StopReport { booted: boolean; killed: number[]; orphans: number[] }

/** launchd bootout → 락 pid 종료. 고아(락과 무관한 daemon run)는 killOrphans 일 때만 종료, 아니면 목록만 반환 */
export function stopDaemon(o: { killOrphans?: boolean; exec?: Exec } = {}): StopReport {
  const exec = o.exec ?? realExec
  let booted = false
  if (isLoaded(exec)) { exec('launchctl', ['bootout', `${domain()}/${LABEL}`]); booted = true }
  const killed: number[] = []
  const lp = readLockPid(lockPath())
  if (lp && defaultIsOurs(lp) && killPid(lp)) killed.push(lp)
  try { unlinkSync(lockPath()) } catch {}
  const orphans = findDaemonProcs([process.pid])
  if (o.killOrphans) for (const p of orphans) if (killPid(p)) killed.push(p)
  return { booted, killed, orphans: o.killOrphans ? [] : orphans.filter(p => pidAlive(p)) }
}

export function installDaemon(o: { bun: string; cli: string; killOrphans?: boolean; exec?: Exec; plist?: string }): { plist: string; report: StopReport; loaded: boolean; error?: string } {
  const exec = o.exec ?? realExec
  const file = o.plist ?? plistPath()
  const report = stopDaemon({ killOrphans: o.killOrphans, exec }) // 이전 인스턴스/LaunchAgent 먼저 내림
  mkdirSync(dirname(file), { recursive: true })
  mkdirSync(clipmentHome(), { recursive: true })
  writeFileSync(file, buildPlist({ bun: o.bun, cli: o.cli, home: homedir(), logFile: join(clipmentHome(), 'daemon.launchd.log') }))
  const r = exec('launchctl', ['bootstrap', domain(), file])
  return { plist: file, report, loaded: r.status === 0, ...(r.status === 0 ? {} : { error: (r.stderr || r.stdout).trim() }) }
}

export function uninstallDaemon(o: { killOrphans?: boolean; exec?: Exec; plist?: string } = {}): { removed: boolean; report: StopReport } {
  const file = o.plist ?? plistPath()
  const report = stopDaemon({ killOrphans: o.killOrphans, exec: o.exec })
  let removed = false
  if (existsSync(file)) { unlinkSync(file); removed = true }
  return { removed, report }
}

export function restartDaemon(exec: Exec = realExec): { ok: boolean; message: string } {
  const file = plistPath()
  if (isLoaded(exec)) {
    const r = exec('launchctl', ['kickstart', '-k', `${domain()}/${LABEL}`])
    return { ok: r.status === 0, message: r.status === 0 ? '재시작했습니다 (launchctl kickstart -k)' : (r.stderr || r.stdout).trim() }
  }
  if (!existsSync(file)) return { ok: false, message: 'LaunchAgent 가 설치돼 있지 않습니다. 먼저: clipment daemon install' }
  const r = exec('launchctl', ['bootstrap', domain(), file])
  return { ok: r.status === 0, message: r.status === 0 ? '로드했습니다 (launchctl bootstrap)' : (r.stderr || r.stdout).trim() }
}

export interface DaemonStatus {
  installed: boolean; loaded: boolean; lockPid: number | null; lockAlive: boolean
  duplicates: number[]; state: unknown | null; plist: string
}
export function daemonStatus(exec: Exec = realExec): DaemonStatus {
  const lp = readLockPid(lockPath())
  const alive = !!lp && defaultIsOurs(lp)
  const procs = findDaemonProcs([process.pid])
  let state: unknown = null
  try { state = JSON.parse(readFileSync(statePath(), 'utf8')) } catch {}
  return {
    installed: existsSync(plistPath()), loaded: isLoaded(exec), lockPid: lp, lockAlive: alive,
    duplicates: procs.filter(p => p !== (alive ? lp : -1)), state, plist: plistPath(),
  }
}

export const logFile = logPath
