import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject } from '../src/core/index.ts'
import {
  buildHealthReport, newHealthNotifyState, pickUnclaimed, planHealthNotifications, readSessions, RepushTracker, selectRepush, sessionsDir,
  staleCommentsOf, startHeartbeat, writeHeartbeat, type HealthReport,
} from '../src/daemon/health.ts'
import { Daemon } from '../src/daemon/daemon.ts'
import { DEFAULT_CONFIG, loadDaemonConfig } from '../src/daemon/config.ts'
import { Logger } from '../src/daemon/util.ts'
import { appWrite, iso, tempRoot, uid } from './helpers.ts'

const saved = { ...process.env }
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clipment-health-'))
  process.env.CLIPMENT_HOME = home
  process.env.CLIPMENT_DAEMON_CONFIG = join(home, 'daemon.json')
})
afterEach(() => { process.env = { ...saved } })

const MIN = 60_000
const pr = (id: string, ageMin: number, now: number, over: Record<string, unknown> = {}): any => ({
  id, ref: 'ws/demo', project: 'demo', workspace: 'ws', type: 'apply_feedback', version: 1, commentIds: null, agent: '', message: '', schema: 1,
  created: new Date(now - ageMin * MIN).toISOString(), state: 'pending', ...over,
})
const daemonOk = { installed: true, loaded: true, running: true, pid: 1 }

describe('defaults', () => {
  test('설정 기본값', () => {
    const c = loadDaemonConfig()
    expect(c).toMatchObject({ healthCheckMs: 60000, unclaimedRepushMin: 3, unclaimedNotifyMin: 10, sessionStaleMin: 2, sessionAlertRepeatMin: 30, orphanCommentMin: 30 })
  })
})

describe('heartbeat', () => {
  test('기록/삭제와 stale 판정 (2분 초과 또는 pid 사망)', () => {
    const now = Date.now()
    writeHeartbeat({ pid: 111, cwd: '/a', startedAt: iso(), lastBeat: new Date(now - 30_000).toISOString() })
    writeHeartbeat({ pid: 222, cwd: '/b', startedAt: iso(), lastBeat: new Date(now - 3 * MIN).toISOString() })
    writeHeartbeat({ pid: 333, cwd: '/c', startedAt: iso(), lastBeat: new Date(now - 10_000).toISOString() })
    const s = readSessions(now, 2 * MIN, pid => pid !== 333)
    const by = Object.fromEntries(s.map(x => [x.pid, x]))
    expect(by[111]!.stale).toBe(false)
    expect(by[222]!.stale).toBe(true) // 오래됨
    expect(by[333]!.stale).toBe(true) // pid 죽음
    expect(by[111]!.cwd).toBe('/a')
    expect(readSessions(now, 5 * MIN, () => true).find(x => x.pid === 222)!.stale).toBe(false)
  })
  test('startHeartbeat 은 파일을 쓰고 stop 하면 지운다', () => {
    const stop = startHeartbeat({ pid: process.pid, cwd: '/x', everyMs: 50 })
    const f = join(sessionsDir(), `${process.pid}.json`)
    expect(existsSync(f)).toBe(true)
    expect(readSessions()[0]).toMatchObject({ pid: process.pid, cwd: '/x', stale: false })
    stop()
    expect(existsSync(f)).toBe(false)
  })
})

describe('미처리 판정', () => {
  test('state=pending 만, 임계 시간 이상만, agent 필터 없음', () => {
    const now = Date.now()
    const list = [pr('a', 2, now), pr('b', 4, now), pr('c', 20, now, { agent: 'codex' }), pr('d', 30, now, { state: 'received' })]
    expect(pickUnclaimed(list, now, 3 * MIN).map(u => u.id)).toEqual(['b', 'c'])
    expect(pickUnclaimed(list, now, 10 * MIN).map(u => u.id)).toEqual(['c'])
    expect(pickUnclaimed(list, now).length).toBe(3)
    expect(pickUnclaimed(list, now)[0]!.ageMin).toBe(2)
  })
})

describe('재푸시 백오프', () => {
  test('3분 후 첫 재푸시, 이후 3→6→12→12분 간격, 처리되면 잊음', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z')
    const tr = new RepushTracker(3 * MIN)
    const u = (now: number) => pickUnclaimed([pr('x', 0, t0)], now)
    const at = (m: number) => selectRepush(u(t0 + m * MIN), tr, t0 + m * MIN).length
    expect(at(1)).toBe(0)
    expect(at(3)).toBe(1) // 1차
    expect(at(4)).toBe(0)
    expect(at(5)).toBe(0)
    expect(at(6)).toBe(1) // +3
    expect(at(11)).toBe(0)
    expect(at(12)).toBe(1) // +6
    expect(at(23)).toBe(0)
    expect(at(24)).toBe(1) // +12
    expect(at(36)).toBe(1) // +12 (상한)
    expect(selectRepush([], tr, t0 + 40 * MIN)).toEqual([]) // 처리됨 → 잊음
    expect(tr.due('x', t0, t0 + 40 * MIN)).toBe(true)
  })
})

describe('코멘트 ↔ 요청', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  const at = (m: number) => new Date(now - m * MIN).toISOString()
  const c = (id: string, ageMin: number, version = 1) => ({ id, version, t: 1, created: at(ageMin), text: 'x' })
  test('30분 넘은 open 코멘트가 요청으로 덮이지 않으면 stale', () => {
    const rs = (...r: any[]) => r
    expect(staleCommentsOf([c('a', 40)], [], 'w/p', now, 30 * MIN).map(x => x.commentId)).toEqual(['a'])
    expect(staleCommentsOf([c('a', 10)], [], 'w/p', now, 30 * MIN)).toEqual([]) // 너무 최근
    // 코멘트 이후 같은 버전 apply_feedback(null) → 덮임
    expect(staleCommentsOf([c('a', 40)], rs({ type: 'apply_feedback', version: 1, commentIds: null, created: at(35) }), 'w/p', now, 30 * MIN)).toEqual([])
    // 코멘트 이전 요청 / 다른 버전 / 다른 type / 다른 id 는 덮지 못함
    expect(staleCommentsOf([c('a', 40)], rs({ type: 'apply_feedback', version: 1, commentIds: null, created: at(50) }), 'w/p', now, 30 * MIN).length).toBe(1)
    expect(staleCommentsOf([c('a', 40)], rs({ type: 'apply_feedback', version: 2, commentIds: null, created: at(35) }), 'w/p', now, 30 * MIN).length).toBe(1)
    expect(staleCommentsOf([c('a', 40)], rs({ type: 'rerender', version: 1, commentIds: null, created: at(35) }), 'w/p', now, 30 * MIN).length).toBe(1)
    expect(staleCommentsOf([c('a', 40)], rs({ type: 'apply_feedback', version: 1, commentIds: ['b'], created: at(35) }), 'w/p', now, 30 * MIN).length).toBe(1)
    expect(staleCommentsOf([c('a', 40)], rs({ type: 'apply_feedback', version: 1, commentIds: ['a'], created: at(35) }), 'w/p', now, 30 * MIN)).toEqual([])
    // version 0(영상 전체) 코멘트는 아무 버전 요청이나 덮음
    expect(staleCommentsOf([c('a', 40, 0)], rs({ type: 'apply_feedback', version: 3, commentIds: null, created: at(35) }), 'w/p', now, 30 * MIN)).toEqual([])
  })
})

describe('알림 dedupe', () => {
  const rep = (over: Partial<HealthReport>): HealthReport => ({ checkedAt: '', daemon: daemonOk, sessions: [], liveSessions: 1, unclaimed: [], staleComments: [], issues: [], ok: true, ...over })
  const unc = (id: string, ageMin: number) => ({ ref: 'w/p', project: 'p', id, type: 'apply_feedback', version: 1, agent: '', created: '', ageMin })
  const cfg = DEFAULT_CONFIG
  test('10분 넘은 요청은 요청당 1회만', () => {
    const st = newHealthNotifyState(), now = Date.now()
    expect(planHealthNotifications(rep({ unclaimed: [unc('a', 5)] }), st, cfg, now)).toEqual([])
    expect(planHealthNotifications(rep({ unclaimed: [unc('a', 11)] }), st, cfg, now).length).toBe(1)
    expect(planHealthNotifications(rep({ unclaimed: [unc('a', 12)] }), st, cfg, now + MIN)).toEqual([])
    expect(planHealthNotifications(rep({ unclaimed: [unc('a', 12), unc('b', 11)] }), st, cfg, now + 2 * MIN).length).toBe(1)
  })
  test('세션 없음 알림은 30분에 한 번', () => {
    const st = newHealthNotifyState(), now = Date.now()
    const r = rep({ liveSessions: 0, unclaimed: [unc('a', 1)] })
    expect(planHealthNotifications(r, st, cfg, now).map(n => n.body)).toEqual([expect.stringContaining('처리 세션이 꺼져 있어요')])
    expect(planHealthNotifications(r, st, cfg, now + 29 * MIN)).toEqual([])
    expect(planHealthNotifications(r, st, cfg, now + 31 * MIN).length).toBe(1)
    expect(planHealthNotifications(rep({ liveSessions: 1, unclaimed: [unc('a', 1)] }), newHealthNotifyState(), cfg, now)).toEqual([])
    expect(planHealthNotifications(rep({ liveSessions: 0, unclaimed: [] }), newHealthNotifyState(), cfg, now)).toEqual([])
  })
  test('요청 없는 코멘트는 프로젝트당 하루 1회 (낮은 우선순위)', () => {
    const st = newHealthNotifyState(), now = Date.parse('2026-01-01T10:00:00Z')
    const sc = (ref: string) => ({ ref, commentId: 'c', version: 1, t: 1, created: '', ageMin: 40, text: '' })
    const r = rep({ staleComments: [sc('w/p'), sc('w/p'), sc('w/q')] })
    const a = planHealthNotifications(r, st, cfg, now)
    expect(a.length).toBe(2)
    expect(a.every(n => n.low)).toBe(true)
    expect(planHealthNotifications(r, st, cfg, now + 5 * 3600_000)).toEqual([])
    expect(planHealthNotifications(r, st, cfg, now + 24 * 3600_000).length).toBe(2)
  })
})

describe('daemon.healthCheck / buildHealthReport / CLI', () => {
  test('autoRun off 여도 healthCheck 가 알림을 보내고 같은 요청은 재알림하지 않는다', async () => {
    const root = tempRoot()
    await initProject('demo')
    const id = uid()
    appWrite(root, 'demo', `requests/${id}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: '', message: '', created: iso(-11 * 60) })
    const notes: string[] = []
    const d = new Daemon({ notifier: async (_t, b) => { notes.push(b) }, config: () => ({ ...DEFAULT_CONFIG, autoRun: 'off' }), noWatch: true, logger: new Logger(join(home, 'd.log')), appDir: process.cwd() })
    await d.healthCheck()
    expect(notes.length).toBe(2) // 오래 미처리 + 세션 없음
    expect(notes.some(n => n.includes('처리 세션이 꺼져 있어요'))).toBe(true)
    await d.healthCheck(Date.now() + 5 * MIN)
    expect(notes.length).toBe(2)
  })

  test('buildHealthReport: 하트비트 + 미처리 + stale 코멘트', async () => {
    const root = tempRoot()
    await initProject('demo')
    appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'answer', version: 1, commentIds: null, agent: 'codex', message: '', created: iso(-5 * 60) })
    appWrite(root, 'demo', `comments/${uid()}.json`, { schema: 1, version: 1, t: 1, end: null, tag: 'cut', text: '컷', author: 'user', created: iso(-40 * 60) })
    writeHeartbeat({ pid: process.pid, cwd: '/w', startedAt: iso(), lastBeat: iso() })
    const r = await buildHealthReport({ daemon: daemonOk })
    expect(r.liveSessions).toBe(1)
    expect(r.unclaimed.length).toBe(1)
    expect(r.unclaimed[0]!.agent).toBe('codex')
    expect(r.staleComments.length).toBe(1)
    expect(r.ok).toBe(false)
  })

  async function cli(env: Record<string, string>, ...args: string[]) {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'health', ...args], { env: { ...process.env, ...env } as any, stdout: 'pipe', stderr: 'pipe' })
    const out = await new Response(p.stdout).text()
    return { code: await p.exited, out }
  }

  test('CLI health: 문제 없으면 0, 미처리 요청이 있으면 1 + --json', async () => {
    const root = tempRoot()
    await initProject('demo')
    const env = { CLIPREV_ROOT: root, CLIPREV_CONFIG: process.env.CLIPREV_CONFIG!, CLIPMENT_HOME: home, CLIPMENT_DAEMON_CONFIG: join(home, 'daemon.json') }
    const a = await cli(env, '--json')
    const ja = JSON.parse(a.out)
    expect(ja.unclaimed).toEqual([])
    expect(Array.isArray(ja.sessions)).toBe(true)
    // 데몬 상태는 실제 launchd 에 의존 → 데몬 이슈만 있을 수 있으므로 요청 관련 이슈는 없어야 함
    expect(ja.issues.filter((i: string) => i.includes('요청'))).toEqual([])

    appWrite(root, 'demo', `requests/${uid()}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: '', message: '', created: iso(-5 * 60) })
    const b = await cli(env)
    expect(b.code).toBe(1)
    expect(b.out).toContain('미처리 요청: 1건')
    expect(b.out).toContain('apply_feedback v1')
    expect(b.out).toContain('상태: 확인 필요')
    const j = JSON.parse((await cli(env, '--json')).out)
    expect(j.unclaimed[0]).toMatchObject({ ref: expect.stringContaining('demo'), ageMin: 5 })
    expect(j.ok).toBe(false)
  })
})
