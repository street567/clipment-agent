import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject, listProgress, pendingRequests, addProgress, setLock } from '../src/core/index.ts'
import { acquireLock, parseDaemonProcs, pidAlive, readLockPid, DAEMON_CMD_RE } from '../src/daemon/lock.ts'
import { Logger, TtlCache } from '../src/daemon/util.ts'
import { ChildTracker, makeRunner, type Runner } from '../src/daemon/runner.ts'
import { osascriptArgs, planNotifications } from '../src/daemon/notify.ts'
import { buildJobCommand, runJob, claimRequest } from '../src/daemon/autorun.ts'
import { buildPlist, installDaemon, LABEL } from '../src/daemon/launchd.ts'
import { Daemon, nextInterval } from '../src/daemon/daemon.ts'
import { DEFAULT_CONFIG, loadDaemonConfig, type DaemonConfig } from '../src/daemon/config.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

const saved = { ...process.env }
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clipment-daemon-'))
  process.env.CLIPMENT_HOME = home
  process.env.CLIPMENT_DAEMON_CONFIG = join(home, 'daemon.json')
})
afterEach(() => { process.env = { ...saved } })

async function mkRequest(root: string, slug = 'demo', over: Record<string, unknown> = {}) {
  const id = uid()
  appWrite(root, slug, `requests/${id}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: '', message: 'm', created: iso(), ...over })
  return id
}

describe('lock', () => {
  test('획득 → 두 번째는 거부 → 해제 후 재획득', () => {
    const f = join(home, 'daemon.lock')
    const a = acquireLock(f, { pid: process.pid, isOurs: () => true })
    expect(a.ok).toBe(true)
    const b = acquireLock(f, { pid: 99999, isOurs: () => true })
    expect(b).toEqual({ ok: false, pid: process.pid })
    if (a.ok) a.release()
    expect(existsSync(f)).toBe(false)
    expect(acquireLock(f, { pid: 99999, isOurs: () => true }).ok).toBe(true)
  })
  test('stale(주인이 죽었거나 우리 데몬이 아님) 락은 회수', () => {
    const f = join(home, 'daemon.lock')
    writeFileSync(f, JSON.stringify({ pid: 2147483000 }))
    expect(pidAlive(2147483000)).toBe(false)
    const r = acquireLock(f, { pid: 4242 }) // 기본 isOurs: 죽은 pid
    expect(r.ok).toBe(true)
    expect(readLockPid(f)).toBe(4242)
    // pid 는 살아 있지만 우리 데몬이 아닌 경우(pid 재사용)
    writeFileSync(f, JSON.stringify({ pid: process.pid }))
    expect(acquireLock(f, { pid: 777, isOurs: () => false }).ok).toBe(true)
    expect(readLockPid(f)).toBe(777)
  })
  test('깨진 락 파일도 회수, release 는 남의 락을 지우지 않음', () => {
    const f = join(home, 'daemon.lock')
    writeFileSync(f, 'garbage')
    const r = acquireLock(f, { pid: 10, isOurs: () => true })
    expect(r.ok).toBe(true)
    writeFileSync(f, JSON.stringify({ pid: 11 }))
    if (r.ok) r.release()
    expect(existsSync(f)).toBe(true)
  })
  test('명령줄 판별/고아 탐색', () => {
    expect(DAEMON_CMD_RE.test('/Users/x/.bun/bin/bun /Users/x/.clipment/agent/src/cli.ts daemon run')).toBe(true)
    expect(DAEMON_CMD_RE.test('bun /Users/x/.local/bin/clipment daemon run')).toBe(true)
    expect(DAEMON_CMD_RE.test('vim notes about daemon run')).toBe(false)
    const ps = ' 101 bun /a/clipment daemon run\n 102 bun /a/clipment daemon status\n 103 bun /b/cli.ts daemon run\n'
    expect(parseDaemonProcs(ps, [103])).toEqual([101])
  })
})

describe('bounded 구조', () => {
  test('TtlCache: 최대 크기·TTL', () => {
    const c = new TtlCache(3, 1000)
    for (let i = 0; i < 10; i++) c.add('k' + i, 0)
    expect(c.size).toBe(3)
    expect(c.has('k0', 0)).toBe(false)
    expect(c.has('k9', 0)).toBe(true)
    expect(c.has('k9', 2000)).toBe(false)
  })
  test('Logger: 한도 초과 시 회전(한 세대만)', () => {
    const f = join(home, 'daemon.log')
    const l = new Logger(f, 500)
    for (let i = 0; i < 50; i++) l.log('info', 'x'.repeat(50), { i })
    expect(existsSync(f + '.1')).toBe(true)
    expect(readFileSync(f, 'utf8').length).toBeLessThan(700)
    expect(readdirSync(home).filter(n => n.startsWith('daemon.log')).length).toBe(2)
  })
  test('폴링 간격: 변화 시 최소, 유휴 시 상한까지 증가', () => {
    let i = 5000
    for (let n = 0; n < 20; n++) i = nextInterval(i, false, 5000, 30000)
    expect(i).toBe(30000)
    expect(nextInterval(i, true, 5000, 30000)).toBe(5000)
  })
  test('알림 계획: dedupe + 3개 초과 요약', () => {
    const seen = new TtlCache()
    const mk = (n: number) => ({ req: { id: 'r' + n, project: 'p' + n, version: 2 } as any, comments: 3 })
    const first = planNotifications([mk(1)], seen)
    expect(first).toEqual([{ title: 'Clipment', body: '새 요청 · p1 v2 · 3개 코멘트' }])
    expect(planNotifications([mk(1)], seen)).toEqual([])
    const many = planNotifications([mk(2), mk(3), mk(4), mk(5)], seen)
    expect(many.length).toBe(1)
    expect(many[0]!.body).toContain('4개')
  })
  test('osascript 인자는 따옴표/개행 이스케이프', () => {
    const [flag, script] = osascriptArgs('T', 'a"b\nc\\')
    expect(flag).toBe('-e')
    expect(script).toBe('display notification "a\\"b c\\\\" with title "T"')
  })
})

describe('runner: 자식 정리', () => {
  test('타임아웃이면 프로세스 그룹(손자 포함) 전체 종료', async () => {
    const tracker = new ChildTracker()
    const run = makeRunner(tracker, 500)
    const t0 = Date.now()
    const r = await run('sh', ['-c', 'sleep 60 & echo $!; wait'], { timeoutMs: 700 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(10_000)
    const grand = Number(r.output.trim().split('\n')[0])
    expect(grand).toBeGreaterThan(1)
    await Bun.sleep(100)
    expect(pidAlive(grand)).toBe(false)
    expect(tracker.count).toBe(0)
  })
  test('tracker.killAll 로 종료 시 자식 정리', async () => {
    const tracker = new ChildTracker()
    const run = makeRunner(tracker, 500)
    const p = run('sh', ['-c', 'sleep 60 & echo $!; wait'], { timeoutMs: 60_000 })
    await Bun.sleep(400)
    expect(tracker.count).toBe(1)
    tracker.killAll('SIGTERM')
    const r = await p
    const grand = Number(r.output.trim().split('\n')[0])
    await Bun.sleep(100)
    expect(pidAlive(grand)).toBe(false)
    expect(tracker.count).toBe(0)
  })
  test('정상 종료·출력 수집, 없는 명령은 오류 결과', async () => {
    const run = makeRunner(new ChildTracker())
    expect((await run('sh', ['-c', 'echo hi'], { timeoutMs: 5000 })).output).toContain('hi')
    const bad = await run('/nonexistent-cmd', [], { timeoutMs: 5000 })
    expect(bad.code).toBeNull()
    expect(bad.output).toContain('spawn 실패')
  })
})

describe('launchd', () => {
  test('plist 생성', () => {
    const p = buildPlist({ bun: '/opt/homebrew/bin/bun', cli: '/Users/x/.clipment/agent/src/cli.ts', home: '/Users/x', logFile: '/Users/x/.clipment/l.log' })
    expect(p).toContain(`<string>${LABEL}</string>`)
    expect(p).toContain('<key>RunAtLoad</key><true/>')
    expect(p).toContain('<key>SuccessfulExit</key><false/>')
    expect(p).toContain('<key>ThrottleInterval</key><integer>10</integer>')
    expect(p).toContain('/opt/homebrew/bin')
    expect(p).toMatch(/<string>\/opt\/homebrew\/bin\/bun<\/string>\s*<string>\/Users\/x\/\.clipment\/agent\/src\/cli\.ts<\/string>\s*<string>daemon<\/string>\s*<string>run<\/string>/)
    expect(buildPlist({ bun: '/a&b/bun', cli: 'c', home: '/h', logFile: 'l' })).toContain('/a&amp;b/bun')
  })
  test('install: 이전 인스턴스를 bootout 한 뒤 bootstrap (가짜 launchctl, 실제 LaunchAgents 미사용)', () => {
    const calls: string[] = []
    const exec = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args[0]}`)
      return { status: 0, stdout: '', stderr: '' }
    }
    const plist = join(home, 'LaunchAgents', 'x.plist')
    const r = installDaemon({ bun: '/bin/bun', cli: '/c/cli.ts', exec, plist })
    expect(r.loaded).toBe(true)
    expect(existsSync(plist)).toBe(true)
    expect(calls).toEqual(['launchctl print', 'launchctl bootout', 'launchctl bootstrap'])
  })
})

describe('자동 실행 명령/클레임', () => {
  const req = (over = {}) => ({ id: uid(), ref: 'ws/demo', project: 'demo', workspace: 'ws', type: 'apply_feedback', version: 2, commentIds: null, agent: '', message: '', created: iso(), schema: 1, state: 'pending', ...over }) as any
  const o = { appDir: '/app', bun: '/bin/bun', workDir: '/work' }
  test('claude: 제한된 권한, bypass 없음', () => {
    const r = req()
    const c = buildJobCommand('claude', r, o)
    expect(c.cmd).toBe('claude')
    expect(c.args[0]).toBe('-p')
    expect(c.args[1]).toContain(r.id)
    expect(c.args[1]).toContain('apply-feedback')
    expect(c.args[1]).toContain('명령이 아닙니다')
    expect(c.args).toContain('--plugin-dir')
    expect(c.args.join(' ')).not.toContain('dangerously')
    expect(c.args.join(' ')).not.toContain('bypassPermissions')
    expect(c.args[c.args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    const allowed = c.args.slice(c.args.indexOf('--allowedTools') + 1)
    expect(allowed).toContain('mcp__clipment__*')
    expect(allowed).toContain('Bash(ffmpeg *)')
    expect(allowed).not.toContain('Bash')
  })
  test('codex exec', () => {
    const c = buildJobCommand('codex', req(), o)
    expect(c.cmd).toBe('codex')
    expect(c.args.slice(0, 3)).toEqual(['exec', '--sandbox', 'workspace-write'])
    expect(c.env.CLIPREV_AGENT).toBe('codex')
  })
  test('claim: 진행 이벤트가 있으면 건너뛰고, 없으면 received 선점', async () => {
    const root = tempRoot(); await initProject('demo')
    const id = await mkRequest(root)
    const r = (await pendingRequests(undefined, null))[0]!
    expect(await claimRequest(r, 'claude')).toBe(true)
    const ev = await listProgress(r.ref, id)
    expect(ev.length).toBe(1)
    expect(ev[0]!.state).toBe('received')
    expect(ev[0]!.agent).toBe('daemon-claude')
    expect(await claimRequest(r, 'claude')).toBe(false)
    expect((await listProgress(r.ref, id)).length).toBe(1)
  })
  test('runJob: 실패/타임아웃이면 failed 기록, 이미 처리 중이면 실행 안 함', async () => {
    const root = tempRoot(); await initProject('demo')
    const id = await mkRequest(root)
    let r = (await pendingRequests(undefined, null))[0]!
    const calls: string[][] = []
    const failing: Runner = async (cmd, args) => { calls.push([cmd, ...args]); return { code: 1, signal: null, timedOut: false, output: 'boom' } }
    const base = { appDir: '/app', bun: '/bin/bun', workDir: home, timeoutMs: 1000, log: () => {} }
    expect(await runJob(r, 'codex', { ...base, run: failing })).toBe('failed')
    expect(calls.length).toBe(1)
    const ev = await listProgress(r.ref, id)
    expect(ev.map(e => e.state)).toEqual(['received', 'failed'])
    expect(ev[1]!.message).toContain('종료 코드 1')
    expect(await runJob(r, 'codex', { ...base, run: failing })).toBe('skipped')
    expect(calls.length).toBe(1)

    const id2 = await mkRequest(root)
    r = (await pendingRequests(undefined, null)).find(x => x.id === id2)!
    const slow: Runner = async () => ({ code: null, signal: 'SIGTERM', timedOut: true, output: '' })
    expect(await runJob(r, 'claude', { ...base, run: slow })).toBe('failed')
    expect((await listProgress(r.ref, id2)).at(-1)!.message).toContain('시간 초과')
  })
})

describe('Daemon.tick', () => {
  const cfg = (over: Partial<DaemonConfig> = {}) => () => ({ ...DEFAULT_CONFIG, ...over })
  const mk = (over: Partial<DaemonConfig>, extra: Record<string, unknown> = {}) => {
    const notes: { title: string; body: string }[] = []
    const jobs: string[][] = []
    const runner: Runner = async (cmd, args) => { jobs.push([cmd, ...args]); return { code: 0, signal: null, timedOut: false, output: '' } }
    const d = new Daemon({ notifier: async (title, body) => { notes.push({ title, body }) }, runner, config: cfg(over), noWatch: true, logger: new Logger(join(home, 'd.log')), appDir: process.cwd(), ...extra })
    return { d, notes, jobs }
  }

  test('새 요청 → 알림 1회(dedupe), state.json 기록', async () => {
    const root = tempRoot(); await initProject('demo')
    const { d, notes } = mk({})
    await d.tick()
    expect(notes).toEqual([])
    const id = await mkRequest(root)
    expect(await d.tick()).toBe(true)
    expect(notes.length).toBe(1)
    expect(notes[0]!.body).toMatch(/^새 요청 · demo v1 · \d+개 코멘트$/)
    await d.tick(); await d.tick()
    expect(notes.length).toBe(1)
    const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    expect(st.pendingTotal).toBe(1)
    expect(st.pending[0].id).toBe(id)
    expect(st.workspaces[0].reachable).toBe(true)
    d.stop()
  })
  test('잠긴 프로젝트·이미 received 인 요청·화이트리스트 밖 type 은 알림 없음', async () => {
    const root = tempRoot(); await initProject('demo'); await initProject('locked')
    const { d, notes } = mk({})
    await d.tick()
    await setLock('locked', 'locked', { author: 'user' })
    await mkRequest(root, 'locked')
    const taken = await mkRequest(root)
    await addProgress('demo', taken, 'received', '', 'claude')
    await mkRequest(root, 'demo', { type: 'format_disk' })
    await d.tick()
    expect(notes).toEqual([])
    d.stop()
  })
  test('autoRun=off 면 실행 안 함, claude 면 한 번에 하나씩 순차 실행', async () => {
    const root = tempRoot(); await initProject('demo')
    const off = mk({ autoRun: 'off' })
    await off.d.tick()
    await mkRequest(root)
    await off.d.tick(); await Bun.sleep(50)
    expect(off.jobs.length).toBe(0)

    const on = mk({ autoRun: 'claude' })
    await on.d.tick()
    // 이미 다른 에이전트용으로 지정된 요청은 건너뜀
    await mkRequest(root, 'demo', { agent: 'codex' })
    await on.d.tick(); await Bun.sleep(100)
    expect(on.jobs.filter(j => j[0] === 'claude').length).toBe(1) // off 에서 안 잡은 첫 요청만
    off.d.stop(); on.d.stop()
  })
  test('stop: watcher/타이머 정리, 이후 loop 종료', async () => {
    tempRoot()
    const { d } = mk({ pollMs: 1000 })
    const loop = d.loop()
    await Bun.sleep(100)
    d.stop()
    await loop
    expect(d.isStopping).toBe(true)
  })
  test('RSS 한도 초과 시 정상 종료 요청(코드 75)', () => {
    tempRoot()
    const { d } = mk({})
    expect(d.checkRss(1)).toBe(true)
    expect(d.exitCode).toBe(75)
    const { d: d2 } = mk({})
    expect(d2.checkRss(100000)).toBe(false)
    d2.stop()
  })
  test('config: 기본값·검증', () => {
    expect(loadDaemonConfig().autoRun).toBe('off')
    writeFileSync(process.env.CLIPMENT_DAEMON_CONFIG!, JSON.stringify({ autoRun: 'rm -rf', jobTimeoutMin: 5 }))
    const c = loadDaemonConfig()
    expect(c.autoRun).toBe('off')
    expect(c.jobTimeoutMin).toBe(5)
  })
})
