import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProject, drainUnknownRequestTypes, addProgress } from '../src/core/index.ts'
import { Daemon, nextInterval } from '../src/daemon/daemon.ts'
import { DEFAULT_CONFIG, loadDaemonConfig, saveDaemonConfig } from '../src/daemon/config.ts'
import { formatHealth, readSessions, versionLabel, writeHeartbeat, startHeartbeat, sessionsDir } from '../src/daemon/health.ts'
import { Logger } from '../src/daemon/util.ts'
import { localTime, updateClaudePlugin } from '../src/cliutil.ts'
import { pruneSessionStates, readSessionState, writeSessionState } from '../src/relay/lib.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'
import { BUN, REPO, tmp } from './relay-helpers.ts'

const saved = { ...process.env }
let home: string
beforeEach(() => {
  home = tmp('clipment-au-')
  process.env.CLIPMENT_HOME = home
  process.env.CLIPMENT_DAEMON_CONFIG = join(home, 'daemon.json')
  process.env.CLIPMENT_SKIP_PLUGIN_UPDATE = '1'
})
afterEach(() => { process.env = { ...saved } })

const cli = (args: string[], env: Record<string, string> = {}) => {
  const r = Bun.spawnSync([BUN, join(REPO, 'src/cli.ts'), ...args], { env: { ...process.env, CLIPREV_ROOT: join(home, 'ws'), CLIPREV_CONFIG: join(home, 'c.json'), ...env } })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}

describe('설정/CLI', () => {
  test('autoUpdate 기본 false, daemon.json 의 true 만 인정', () => {
    expect(loadDaemonConfig().autoUpdate).toBe(false)
    writeFileSync(process.env.CLIPMENT_DAEMON_CONFIG!, JSON.stringify({ autoUpdate: 'yes' })); expect(loadDaemonConfig().autoUpdate).toBe(false)
    saveDaemonConfig({ autoUpdate: true }); expect(loadDaemonConfig().autoUpdate).toBe(true)
  })
  test('clipment autoupdate on|off|status', () => {
    expect(cli(['autoupdate', 'status']).out).toContain('자동 업데이트: 꺼짐')
    expect(cli(['autoupdate', 'on']).out).toContain('자동으로 내려받아져 실행')
    expect(JSON.parse(readFileSync(process.env.CLIPMENT_DAEMON_CONFIG!, 'utf8')).autoUpdate).toBe(true)
    expect(cli(['autoupdate']).out).toContain('켜짐')
    cli(['autoupdate', 'off']); expect(loadDaemonConfig().autoUpdate).toBe(false)
    expect(cli(['autoupdate', 'bogus']).code).toBe(1)
  })
  test('update --check: 로컬 가짜 API 로 보고만 한다 (아무것도 안 바꿈)', async () => {
    let tag = 'v9.9.9'
    const srv = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: req => new URL(req.url).pathname === '/repos/street567/app-bridge/releases/latest' ? Response.json({ tag_name: tag, prerelease: false, draft: false }) : new Response('no', { status: 404 }) })
    try {
      const env = { CLIPMENT_UPDATE_API: `http://127.0.0.1:${srv.port}` }
      const r = await Bun.spawn([BUN, join(REPO, 'src/cli.ts'), 'update', '--check'], { env: { ...process.env, ...env }, stdout: 'pipe' })
      const out = await new Response(r.stdout).text()
      expect(out).toContain('최신 릴리스 v9.9.9'); expect(out).toContain('새 버전 있음'); expect(out).toContain('clipment update')
      expect(existsSync(join(home, 'update.json'))).toBe(false); expect(existsSync(join(home, 'bad-versions.json'))).toBe(false)
      tag = 'v0.0.1'
      const r2 = await Bun.spawn([BUN, join(REPO, 'src/cli.ts'), 'update', '--check'], { env: { ...process.env, ...env }, stdout: 'pipe' })
      expect(await new Response(r2.stdout).text()).toContain('현재가 더 높습니다')
    } finally { srv.stop(true) }
    const bad = cli(['update', '--check'], { CLIPMENT_UPDATE_API: 'http://127.0.0.1:1' })
    expect(bad.code).toBe(1); expect(bad.err).toContain('확인 실패')
  })
  test('update --rollback: 기록이 없으면 안내', () => {
    const r = cli(['update', '--rollback'])
    expect(r.code).toBe(1); expect(r.out).toContain('되돌릴 이전 상태가 없습니다')
  })
})

describe('daemon status 표시 (폴링 null / 갱신 날짜 원인)', () => {
  test('state.json 의 updated 는 UTC ISO — 로컬 시각 + 상대 시간으로 보여 준다', () => {
    const now = Date.parse('2026-11-24T18:16:30.000Z')
    const s = localTime('2026-11-24T18:16:12.683Z', now)
    expect(s).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(17초 전\)$/)
    expect(s).not.toContain('Z'); expect(localTime(undefined)).toBe('?'); expect(localTime('x')).toBe('?')
    expect(localTime(new Date(now - 3 * 3600_000).toISOString(), now)).toContain('3시간 전')
  })
  test('설정 일부가 빠져도(NaN) interval/pollMs 가 null 로 새지 않는다', () => {
    expect(nextInterval(NaN, false, 1000, NaN)).toBe(1500)
    expect(nextInterval(1000, false, 1000, undefined as any)).toBe(1500)
    expect(Number.isFinite(nextInterval(undefined as any, true, NaN, NaN))).toBe(true)
    expect(JSON.stringify({ p: nextInterval(NaN, false, NaN, NaN) })).not.toContain('null')
  })
  test('실제 데몬 상태 파일의 pollMs 는 숫자', async () => {
    const root = tempRoot(); mkdirSync(root, { recursive: true })
    const d = new Daemon({ notifier: async () => {}, runner: async () => ({ code: 0, signal: null, timedOut: false, output: '' }), config: () => ({ ...DEFAULT_CONFIG } as any), noWatch: true, logger: new Logger(join(home, 'd.log')), appDir: REPO })
    await d.tick()
    const st = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
    expect(typeof st.pollMs).toBe('number'); expect(st.version).toBe(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version)
    d.stop()
  })
})

describe('하트비트 version / health 표시', () => {
  test('새 필드는 읽히고 옛 하트비트(필드 없음)도 그대로 읽힌다', () => {
    const now = Date.now()
    writeHeartbeat({ pid: process.pid, cwd: '/a', startedAt: iso(), lastBeat: new Date(now).toISOString(), version: '0.4.1', sessionVersion: '0.4.0' })
    writeFileSync(join(sessionsDir(), `${process.pid + 1}.json`), JSON.stringify({ pid: process.pid + 1, cwd: '/old', startedAt: iso(), lastBeat: new Date(now).toISOString() }))
    const ss = readSessions(now, 120_000, () => true)
    const a = ss.find(s => s.cwd === '/a')!, old = ss.find(s => s.cwd === '/old')!
    expect([a.version, a.sessionVersion]).toEqual(['0.4.1', '0.4.0']); expect(old.version).toBeUndefined()
    expect(versionLabel(a)).toContain('서버 v0.4.1 (세션 시작 v0.4.0'); expect(versionLabel(old)).toBe(''); expect(versionLabel({ version: '0.4.0', sessionVersion: '0.4.0' })).toBe(' · 서버 v0.4.0')
    const text = formatHealth({ checkedAt: iso(), daemon: { installed: true, loaded: true, running: true, pid: 1 }, sessions: ss, liveSessions: 2, unclaimed: [], staleComments: [], issues: [], ok: true })
    expect(text).toContain('서버 v0.4.1'); expect(text).toContain('cwd=/old')
  })
  test('릴레이 아래 하트비트(pid≠자기 pid)는 stop 해도 파일을 지우지 않는다', () => {
    const stop = startHeartbeat({ pid: 424242, cwd: '/x', everyMs: 10_000 })
    expect(existsSync(join(sessionsDir(), '424242.json'))).toBe(true)
    stop(); expect(existsSync(join(sessionsDir(), '424242.json'))).toBe(true)
  })
  test('세션 상태 파일: 쓰기/읽기, 죽은 pid 정리', () => {
    writeSessionState(111, { v: 1, notified: ['a'], repush: [{ id: 'a', n: 1, at: 5 }], startedAt: 1, hbStartedAt: iso(), updated: iso() })
    writeSessionState(222, { v: 1, notified: [], repush: [], startedAt: 1, hbStartedAt: iso(), updated: iso() })
    expect(readSessionState(111)?.notified).toEqual(['a'])
    expect(pruneSessionStates(pid => pid === 111)).toBe(1)
    expect(readSessionState(222)).toBeNull(); expect(readSessionState(111)).not.toBeNull()
  })
})

describe('데몬: 한가함 판정 / 모르는 type', () => {
  const mkD = () => new Daemon({ notifier: async () => {}, runner: async () => ({ code: 0, signal: null, timedOut: false, output: '' }), config: () => ({ ...DEFAULT_CONFIG }), noWatch: true, logger: new Logger(join(home, 'd.log')), appDir: REPO })
  test('대기·진행(received/working) 요청이 있으면 한가하지 않고, done/failed·너무 오래된 것은 무시', async () => {
    const root = tempRoot(); await initProject('demo')
    const d = mkD()
    expect(await d.isIdle()).toBe(true)
    const id = uid()
    appWrite(root, 'demo', `requests/${id}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: '', message: '', created: iso() })
    expect(await d.isIdle()).toBe(false) // pending
    await addProgress('demo', id, 'received', '', 'claude'); expect(await d.isIdle()).toBe(false)
    await addProgress('demo', id, 'working', '', 'claude'); expect(await d.isIdle()).toBe(false) // pendingRequests 에는 안 보이는 상태도 막는다
    await addProgress('demo', id, 'done', '', 'claude'); expect(await d.isIdle()).toBe(true)
    appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: '', message: '', created: iso(-3 * 86400) })
    expect(await d.isIdle()).toBe(true) // 하루 넘게 방치된 요청은 무시
    ;(d as any).currentJob = { id: 'x', ref: 'y', since: iso() }; expect(await d.isIdle()).toBe(false)
    ;(d as any).currentJob = null; ;(d as any).scriptBusy = Promise.resolve(); expect(await d.isIdle()).toBe(false) // 음성 생성 중
    d.stop()
  })
  test('화이트리스트 밖 type 은 실행되지 않고 업데이트 점검 신호만', async () => {
    const root = tempRoot(); await initProject('demo')
    drainUnknownRequestTypes()
    const calls: number[] = []
    const d = mkD(); ;(d as any).updater = { noteUnknownType: () => calls.push(1), tick: async () => null }
    appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'future_thing', version: 1, agent: '', message: 'm', created: iso() })
    await d.tick(); await d.tick()
    expect(calls.length).toBe(1) // 같은 요청은 한 번만
    d.stop()
  })
})

let fakeN = 0
describe('claude 플러그인 갱신 (가짜 claude)', () => {
  function fakeClaude(listOut: string, failOn = '') {
    const dir = join(home, `bin${++fakeN}`); mkdirSync(dir, { recursive: true })
    const log = join(dir, 'claude.log')
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1 $2" = "plugin list" ]; then echo '${listOut}'; exit 0; fi\n[ "$*" = "${failOn}" ] && exit 1\nexit 0\n`)
    chmodSync(join(dir, 'claude'), 0o755)
    return { env: { ...process.env, PATH: `${dir}:/usr/bin:/bin`, CLIPMENT_SKIP_PLUGIN_UPDATE: '' } as NodeJS.ProcessEnv, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) }
  }
  test('설치돼 있으면 마켓플레이스 → 플러그인 순서로 갱신', () => {
    const f = fakeClaude('[{"id":"app-bridge@street567"}]')
    expect(updateClaudePlugin(f.env)).toBe('updated')
    expect(f.calls()).toEqual(['plugin list --json', 'plugin marketplace update street567', 'plugin update app-bridge@street567'])
  })
  test('미설치/환경변수로 건너뜀/claude 없음/실패해도 비치명', () => {
    let f = fakeClaude('[]'); expect(updateClaudePlugin(f.env)).toBe('not-installed'); expect(f.calls()).toEqual(['plugin list --json'])
    f = fakeClaude('[{"id":"app-bridge@street567"}]'); expect(updateClaudePlugin({ ...f.env, CLIPMENT_SKIP_PLUGIN_UPDATE: '1' })).toBe('skipped'); expect(f.calls()).toEqual([])
    f = fakeClaude('[{"id":"clipment@clipment-agent"}]'); expect(updateClaudePlugin(f.env)).toBe('not-installed'); expect(f.calls()).toEqual(['plugin list --json']) // 예전 플러그인만 있으면 갱신하지 않고 이전을 안내
    expect(updateClaudePlugin({ PATH: '/nonexistent' } as any)).toBe('no-claude')
    f = fakeClaude('app-bridge@street567  enabled', 'plugin marketplace update street567'); expect(updateClaudePlugin(f.env)).toBe('failed')
    expect(f.calls().length).toBe(3) // 마켓플레이스가 실패해도 플러그인 갱신은 시도
  })
})
void BUN
