import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type DaemonConfig } from '../src/daemon/config.ts'
import { ChildTracker, makeRunner, type Runner } from '../src/daemon/runner.ts'
import { Logger } from '../src/daemon/util.ts'
import { Updater, fetchLatestRelease, readUpdateState, rollback, updateApi, type FetchLike } from '../src/daemon/updater.ts'
import { readBadList, updateLockActive } from '../src/relay/lib.ts'
import { BUN, REPO, tmp } from './relay-helpers.ts'

const saved = { ...process.env }
let home: string, appDir: string, bare: string, dev: string
beforeEach(() => {
  home = tmp('clipment-upd-')
  process.env.CLIPMENT_HOME = home
  delete process.env.CLIPMENT_DIR
  delete process.env.CLIPMENT_NO_UPDATE_CHECK
  appDir = join(home, 'agent')
})
afterEach(() => { process.env = { ...saved } })

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...a], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
/** 가짜 원격(bare)과 작업 레포: 버전마다 package.json 만 바꿔 커밋(+태그) */
function mkRemote(steps: { version: string; tag?: boolean }[]) {
  const base = tmp('clipment-remote-')
  bare = join(base, 'origin.git'); dev = join(base, 'dev')
  mkdirSync(dev, { recursive: true })
  git(dev, 'init', '-q', '-b', 'main')
  cpSync(join(REPO, 'src'), join(dev, 'src'), { recursive: true })
  cpSync(join(REPO, 'bun.lock'), join(dev, 'bun.lock'))
  writeFileSync(join(dev, '.gitignore'), 'node_modules/\n')
  for (const s of steps) {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    writeFileSync(join(dev, 'package.json'), JSON.stringify({ ...pkg, version: s.version }, null, 2))
    git(dev, 'add', '-A'); git(dev, 'commit', '-q', '-m', `v${s.version}`)
    if (s.tag) git(dev, 'tag', `v${s.version}`)
  }
  git(base, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(dev, 'push', '-q', bare, 'main', '--tags')
}
/** rev 가 있으면 main 을 그 커밋으로 되돌려 둔다(원격보다 뒤처진 상태). detach 면 분리 HEAD */
function clone(rev?: string, detach = false) {
  git(home, 'clone', '-q', bare, appDir)
  if (rev) detach ? git(appDir, 'checkout', '-q', '--detach', rev) : git(appDir, 'checkout', '-q', '-B', 'main', rev)
  symlinkSync(join(REPO, 'node_modules'), join(appDir, 'node_modules'))
}
const ver = (d = appDir) => JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')).version
const detached = () => spawnSync('git', ['-C', appDir, 'symbolic-ref', '-q', 'HEAD']).status !== 0

interface Rig { u: Updater; notes: string[]; exits: number[]; fetches: number; setLatest(tag: string | null): void; clock: { t: number }; idle: { v: boolean }; cfg: { v: Partial<DaemonConfig> }; failInstall: { stage: boolean; apply: boolean }; installs: string[] }
function rig(o: { origin?: boolean; smoke?: boolean | 'fail'; realSmoke?: boolean } = {}): Rig {
  const real = makeRunner(new ChildTracker())
  const r: Rig = { notes: [], exits: [], fetches: 0, clock: { t: 1_800_000_000_000 }, idle: { v: true }, cfg: { v: { autoUpdate: true } }, failInstall: { stage: false, apply: false }, installs: [], setLatest() {}, u: null as any }
  let latest: string | null = 'v0.5.0'
  r.setLatest = t => { latest = t }
  const run: Runner = async (cmd, args, opts) => {
    if (cmd === BUN && args[0] === 'install') {
      const isApp = opts.cwd === appDir
      r.installs.push(`${isApp ? 'app' : 'stage'}:${args.join(' ')}`)
      if ((isApp && r.failInstall.apply) || (!isApp && r.failInstall.stage)) return { code: 1, signal: null, timedOut: false, output: 'install boom' }
      if (opts.cwd && !existsSync(join(opts.cwd, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(opts.cwd, 'node_modules'))
      return { code: 0, signal: null, timedOut: false, output: '' }
    }
    return real(cmd, args, opts)
  }
  const fetchFn: FetchLike = async () => {
    r.fetches++
    if (latest === null) throw new Error('network down')
    return { ok: true, status: 200, json: async () => ({ tag_name: latest, prerelease: false, draft: false }) }
  }
  r.u = new Updater({
    run, appDir, bun: BUN, cfg: () => ({ ...DEFAULT_CONFIG, ...r.cfg.v }), notify: async (_t, b) => { r.notes.push(b) },
    log: new Logger(join(home, 'daemon.log')), isIdle: async () => r.idle.v, exit: c => { r.exits.push(c) },
    fetch: fetchFn, now: () => r.clock.t, random: () => 0.5,
    env: { ...process.env, ...(o.origin === false ? {} : { CLIPMENT_UPDATE_ORIGIN: bare }) } as NodeJS.ProcessEnv,
    stageRoot: join(home, 'stage'),
    smoke: o.realSmoke ? undefined : async () => { if (o.smoke === 'fail') throw new Error('smoke boom') },
    aliveMs: 1500,
  })
  return r
}

describe('릴리스 조회', () => {
  const ok = (j: any): FetchLike => async () => ({ ok: true, status: 200, json: async () => j })
  test('정상/초안/프리릴리스/태그 형식/HTTP 오류', async () => {
    expect(await fetchLatestRelease(ok({ tag_name: 'v1.2.3', draft: false, prerelease: false }))).toEqual({ tag: 'v1.2.3', version: '1.2.3' })
    await expect(fetchLatestRelease(ok({ tag_name: 'v1.2.3', prerelease: true }))).rejects.toThrow('프리릴리스')
    await expect(fetchLatestRelease(ok({ tag_name: 'v1.2.3', draft: true }))).rejects.toThrow('초안')
    for (const bad of ['main', 'v1.2', 'v1.2.3-rc1', '1.2.3', 'v1.2.3; rm -rf /', undefined]) await expect(fetchLatestRelease(ok({ tag_name: bad }))).rejects.toThrow('태그')
    await expect(fetchLatestRelease(async () => ({ ok: false, status: 403, json: async () => ({}) }))).rejects.toThrow('403')
  })
  test('API 주소: https 와 로컬 테스트 서버만, 그 외 환경변수는 무시', () => {
    expect(updateApi({ CLIPMENT_UPDATE_API: 'http://127.0.0.1:1234/' } as any)).toBe('http://127.0.0.1:1234')
    expect(updateApi({ CLIPMENT_UPDATE_API: 'http://evil.example' } as any)).toBe('https://api.github.com')
    expect(updateApi({} as any)).toBe('https://api.github.com')
  })
})

describe('업데이터', () => {
  test('autoUpdate 꺼짐: 새 버전이면 버전당 알림 한 번, notify=false 면 무음, 같거나 낮으면 무시', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.5.0', tag: true }]); clone('v0.4.0')
    const r = rig(); r.cfg.v = { autoUpdate: false }
    expect((await r.u.check()).status).toBe('notified')
    expect((await r.u.check()).status).toBe('notified')
    expect(r.notes).toEqual(['새 버전 v0.5.0 · clipment update'])
    expect(ver()).toBe('0.4.0') // 아무것도 안 바뀜
    const quiet = rig(); quiet.cfg.v = { autoUpdate: false, notify: false }
    rmState(); await quiet.u.check(); expect(quiet.notes).toEqual([])
    const same = rig(); same.setLatest('v0.4.0'); expect((await same.u.check()).status).toBe('uptodate')
    same.setLatest('v0.3.0'); expect((await same.u.check()).status).toBe('uptodate') // 다운그레이드 안 함
    expect(same.notes).toEqual([])
  })

  test('메이저 올림은 autoUpdate 가 켜져 있어도 알림만', async () => {
    mkRemote([{ version: '0.4.0', tag: true }]); clone()
    const r = rig(); r.setLatest('v1.0.0')
    const res = await r.u.check()
    expect(res.status).toBe('notified'); expect(res.detail).toBe('major')
    expect(r.notes[0]).toContain('메이저'); expect(r.installs).toEqual([]); expect(r.exits).toEqual([])
  })

  test('켜짐 + 한가함: 스테이징 → 분리 체크아웃 → 상태 기록 → 종료 코드 75, 이전 ref 기록', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.5.0', tag: true }]); clone('v0.4.0')
    const before = git(appDir, 'rev-parse', 'HEAD')
    const r = rig()
    const res = await r.u.check()
    expect(res.status).toBe('applied')
    expect(ver()).toBe('0.5.0'); expect(detached()).toBe(true)
    expect(r.exits).toEqual([75])
    const st = readUpdateState()
    expect(st.previousRef).toBe('main'); expect(st.previousSha).toBe(before); expect(st.version).toBe('0.5.0'); expect(st.appliedAt).toBeTruthy()
    expect(updateLockActive()).toBe(false) // 잠금 해제
    expect(r.installs.some(i => i.startsWith('stage:install --production --frozen-lockfile --ignore-scripts'))).toBe(true)
    expect(r.installs.some(i => i.startsWith('app:install --production --frozen-lockfile --ignore-scripts'))).toBe(true)
    expect(existsSync(join(home, 'stage', '0.5.0'))).toBe(false)
  })

  test('작업 중이면 스테이징만 하고 대기, 한가해지면 tick 이 적용', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.5.0', tag: true }]); clone('v0.4.0')
    const r = rig(); r.idle.v = false
    const res = await r.u.check()
    expect(res.status).toBe('staged'); expect(ver()).toBe('0.4.0'); expect(r.exits).toEqual([])
    expect(readUpdateState().staged?.version).toBe('0.5.0')
    expect((await r.u.tick())?.status).toBe('staged') // 여전히 바쁨
    r.idle.v = true
    expect((await r.u.tick())?.status).toBe('applied')
    expect(ver()).toBe('0.5.0'); expect(r.exits).toEqual([75]); expect(readUpdateState().staged).toBeUndefined()
  })

  test('origin 허용: 새 이름(app-bridge)과 예전 이름(clipment-agent)의 https/ssh 형태 모두, 그 외는 거부', async () => {
    mkRemote([{ version: '0.5.0', tag: true }]); clone('v0.5.0')
    const r = rig({ origin: false })
    const ok = ['https://github.com/street567/app-bridge.git', 'https://github.com/street567/app-bridge', 'git@github.com:street567/app-bridge.git', 'ssh://git@github.com/street567/app-bridge.git',
      'https://github.com/street567/clipment-agent.git', 'https://github.com/street567/clipment-agent', 'git@github.com:street567/clipment-agent.git', 'ssh://git@github.com/street567/clipment-agent.git']
    for (const url of ok) { git(appDir, 'remote', 'set-url', 'origin', url); expect(await r.u.eligible()).toEqual({ ok: true }) }
    for (const url of ['https://github.com/street567/other.git', 'https://github.com/evil/app-bridge.git', 'https://github.com/street567/app-bridge.git.evil', 'http://github.com/street567/app-bridge.git']) {
      git(appDir, 'remote', 'set-url', 'origin', url); const e = await r.u.eligible(); expect(e.ok).toBe(false)
    }
  })

  test('더러운 작업 트리 / 다른 origin / 관리형 위치 아님 → 알림만', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.5.0', tag: true }]); clone('v0.4.0')
    writeFileSync(join(appDir, 'src/cli.ts'), readFileSync(join(appDir, 'src/cli.ts'), 'utf8') + '\n// local edit\n')
    let r = rig(); let res = await r.u.check()
    expect(res.status).toBe('ineligible'); expect(res.detail).toContain('수정 사항'); expect(r.notes[0]).toContain('자동 적용 불가'); expect(r.installs).toEqual([])
    git(appDir, 'checkout', '--', 'src/cli.ts'); rmState()
    r = rig({ origin: false }); res = await r.u.check()
    expect(res.status).toBe('ineligible'); expect(res.detail).toContain('origin')
    rmState()
    process.env.CLIPMENT_DIR = join(home, 'elsewhere')
    r = rig(); res = await r.u.check()
    expect(res.status).toBe('ineligible'); expect(res.detail).toContain('관리형'); expect(ver()).toBe('0.4.0')
  })

  test('스테이징 실패(스모크/설치/버전 불일치): 나쁜 버전 기록 + 알림 한 번 + 아무것도 안 바뀜', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.5.0', tag: true }]); clone('v0.4.0')
    const before = git(appDir, 'rev-parse', 'HEAD')
    let r = rig({ smoke: 'fail' })
    let res = await r.u.check()
    expect(res.status).toBe('stage-failed'); expect(res.detail).toContain('스모크')
    expect(Object.keys(readBadList())).toEqual(['0.5.0'])
    expect(r.notes).toEqual(['v0.5.0 자동 업데이트 준비에 실패해 건너뜁니다 (현재 버전 유지)'])
    expect(git(appDir, 'rev-parse', 'HEAD')).toBe(before); expect(r.exits).toEqual([])
    expect((await r.u.check()).status).toBe('bad') // 같은 버전을 다시 시도하지 않음
    expect(r.notes.length).toBe(1)
    // 설치 실패
    rmState(); rmBad()
    r = rig(); r.failInstall.stage = true; res = await r.u.check()
    expect(res.status).toBe('stage-failed'); expect(res.detail).toContain('bun install')
    // 태그와 package.json 버전이 다른 릴리스
    rmState(); rmBad()
    r = rig(); r.setLatest('v0.4.9'); git(dev, 'tag', 'v0.4.9'); git(dev, 'push', '-q', bare, 'v0.4.9')
    res = await r.u.check()
    expect(res.status).toBe('stage-failed'); expect(res.detail).toContain('태그')
    expect(ver()).toBe('0.4.0')
  })

  test('적용 도중 실패(bun install): 이전 ref 로 복원 + 나쁜 버전 + 종료 안 함', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.5.0', tag: true }]); clone('v0.4.0')
    const before = git(appDir, 'rev-parse', 'HEAD')
    const r = rig(); r.failInstall.apply = true
    const res = await r.u.check()
    expect(res.status).toBe('apply-failed')
    expect(ver()).toBe('0.4.0'); expect(detached()).toBe(false); expect(git(appDir, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(appDir, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(Object.keys(readBadList())).toEqual(['0.5.0'])
    expect(r.exits).toEqual([]); expect(r.notes.at(-1)).toContain('되돌렸어요'); expect(updateLockActive()).toBe(false)
  })

  test('rollback: 이전 ref 로 복귀 + 그 버전을 나쁜 버전으로', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.5.0', tag: true }]); clone('v0.4.0')
    const r = rig(); await r.u.check()
    expect(ver()).toBe('0.5.0')
    const out = await rollback({ run: makeRunner(new ChildTracker()), appDir, bun: 'true' })
    expect(out.ok).toBe(true)
    expect(ver()).toBe('0.4.0'); expect(git(appDir, 'symbolic-ref', '--short', 'HEAD')).toBe('main')
    expect(Object.keys(readBadList())).toEqual(['0.5.0'])
    expect((await rollback({ run: makeRunner(new ChildTracker()), appDir, bun: 'true' })).ok).toBe(false) // 두 번째는 되돌릴 게 없음
  })

  test('스케줄: 첫 tick 은 예약만, 하루 한 번, 실패는 지수 백오프, 모르는 type 은 시간당 최대 한 번', async () => {
    mkRemote([{ version: '0.4.0', tag: true }]); clone()
    const r = rig(); r.cfg.v = { autoUpdate: false }; r.setLatest('v0.4.0')
    expect(await r.u.tick()).toBeNull(); expect(r.fetches).toBe(0)
    r.clock.t += 31 * 60_000
    await r.u.tick(); expect(r.fetches).toBe(1)
    r.clock.t += 20 * 3600_000; await r.u.tick(); expect(r.fetches).toBe(1) // 아직 하루 안 됨
    r.clock.t += 7 * 3600_000; await r.u.tick(); expect(r.fetches).toBe(2) // 24h + 지터 지남
    // 모르는 type: 추가 확인(시간당 1회)
    r.u.noteUnknownType(); await r.u.tick(); expect(r.fetches).toBe(3)
    r.clock.t += 10 * 60_000; r.u.noteUnknownType(); await r.u.tick(); expect(r.fetches).toBe(3)
    r.clock.t += 61 * 60_000; await r.u.tick(); expect(r.fetches).toBe(4)
    // 실패는 조용히 + 백오프
    r.setLatest(null); r.clock.t += 25 * 3600_000
    expect((await r.u.tick())?.status).toBe('error'); expect(r.fetches).toBe(5)
    r.clock.t += 10 * 60_000; expect(await r.u.tick()).toBeNull(); expect(r.fetches).toBe(5)
    r.clock.t += 61 * 60_000; await r.u.tick(); expect(r.fetches).toBe(6)
    expect(r.notes).toEqual([])
  })

  test('CLIPMENT_NO_UPDATE_CHECK=1 이면 아무것도 안 함', async () => {
    mkRemote([{ version: '0.4.0', tag: true }]); clone()
    const r = rig(); process.env.CLIPMENT_NO_UPDATE_CHECK = '1'
    const u = new Updater({ ...(r.u as any).d, env: process.env })
    expect((await u.check()).status).toBe('disabled'); expect(await u.tick()).toBeNull(); expect(r.fetches).toBe(0)
  })

  test('실제 스모크(격리 환경): cli --version, MCP 핸드셰이크+tools/list, daemon run 생존', async () => {
    mkRemote([{ version: '0.4.0', tag: true }, { version: '0.4.1', tag: true }]); clone('v0.4.0', true)
    const r = rig({ realSmoke: true }); r.setLatest('v0.4.1')
    const res = await r.u.check()
    expect(res.status).toBe('applied')
    expect(ver()).toBe('0.4.1')
    // 스모크가 진짜 홈을 건드리지 않음: 격리 폴더는 스테이징 안(삭제됨)
    expect(existsSync(join(home, 'stage', '0.4.1'))).toBe(false)
  }, 60000)

  test('실제 스모크 실패(깨진 server.ts) → 나쁜 버전', async () => {
    mkRemote([{ version: '0.4.0', tag: true }])
    writeFileSync(join(dev, 'src/server.ts'), 'throw new Error("broken release")\n')
    const pkg = JSON.parse(readFileSync(join(dev, 'package.json'), 'utf8')); writeFileSync(join(dev, 'package.json'), JSON.stringify({ ...pkg, version: '0.4.1' }))
    git(dev, 'add', '-A'); git(dev, 'commit', '-q', '-m', 'broken'); git(dev, 'tag', 'v0.4.1'); git(dev, 'push', '-q', bare, 'main', '--tags')
    clone('v0.4.0', true)
    const r = rig({ realSmoke: true }); r.setLatest('v0.4.1')
    const res = await r.u.check()
    expect(res.status).toBe('stage-failed'); expect(res.detail).toContain('스모크')
    expect(ver()).toBe('0.4.0'); expect(Object.keys(readBadList())).toEqual(['0.4.1'])
  }, 60000)
})

function rmState() { try { require('node:fs').rmSync(join(home, 'update.json'), { force: true }) } catch {} }
function rmBad() { try { require('node:fs').rmSync(join(home, 'bad-versions.json'), { force: true }) } catch {} }
