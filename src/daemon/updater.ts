// 데몬 업데이터: GitHub 최신 릴리스를 확인하고, 알림만 하거나(기본) autoUpdate 가 켜져 있으면
// 임시 폴더에 스테이징 → 스모크 테스트 → (한가할 때) 관리형 git 클론에 적용한다.
// 외부에서 온 값(태그·URL 등)은 전부 argv 로만 넘긴다 (셸 문자열 없음). 주입 가능: fetch/runner/시계/알림.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import {
  TAG_RE, acquireUpdateLock, addBad, clipHome, cmpVersion, isBad, majorOf, managedDir, readPkg,
} from '../relay/lib.ts'
import type { DaemonConfig } from './config.ts'
import type { Notifier } from './notify.ts'
import type { Runner } from './runner.ts'
import type { Logger } from './util.ts'
import { EXPECTED_ORIGINS, PKG_NAMES, REPO } from '../names.ts'

export { REPO, EXPECTED_ORIGINS }
export const DEFAULT_API = 'https://api.github.com'
const HOUR = 3600_000
const DAY = 24 * HOUR
export const EXIT_UPDATE_RESTART = 75 // daemon.ts EXIT_RSS_RESTART 와 같은 값: launchd KeepAlive 가 되살림

export const updateStatePath = () => join(clipHome(), 'update.json')

export interface UpdateState {
  nextCheckAt?: number; lastCheckAt?: number; lastTypeCheckAt?: number
  failures?: number; backoffUntil?: number
  latest?: string
  /** 이미 알림을 보낸 키 ("0.5.0", "fail:0.5.0") */
  notified?: string[]
  staged?: { version: string; tag: string; dir: string; sha: string; at: string }
  previousRef?: string; previousSha?: string; previousVersion?: string; version?: string; appliedAt?: string; rolledBackAt?: string
}
export function readUpdateState(): UpdateState {
  try { const j = JSON.parse(readFileSync(updateStatePath(), 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
}
export function writeUpdateState(s: UpdateState): void {
  const f = updateStatePath()
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f + '.tmp', JSON.stringify(s, null, 2) + '\n')
  renameSync(f + '.tmp', f)
}

// ---------- GitHub 릴리스 ----------

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>
export interface ReleaseInfo { tag: string; version: string }

/** API 기준 주소: https:// 또는 로컬 테스트 서버(http://127.0.0.1) 만 허용. 환경변수 CLIPMENT_UPDATE_API 는 테스트용 */
export function updateApi(env: NodeJS.ProcessEnv = process.env): string {
  const e = env.CLIPMENT_UPDATE_API?.trim().replace(/\/+$/, '')
  if (e && (/^https:\/\//.test(e) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(e))) return e
  return DEFAULT_API
}

/** releases/latest 를 비인증 HTTPS 로 읽는다. 초안·프리릴리스·형식 어긋난 태그는 거부 */
export async function fetchLatestRelease(fetchFn: FetchLike = fetch as unknown as FetchLike, o: { api?: string; timeoutMs?: number } = {}): Promise<ReleaseInfo> {
  const url = `${o.api ?? updateApi()}/repos/${REPO}/releases/latest`
  const res = await fetchFn(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'client-ai-bridge-updater', 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
  })
  if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`)
  const j = await res.json()
  if (!j || typeof j !== 'object') throw new Error('릴리스 응답 형식 오류')
  if (j.draft === true || j.prerelease === true) throw new Error('최신 릴리스가 초안/프리릴리스입니다')
  const tag = j.tag_name
  if (typeof tag !== 'string' || !TAG_RE.test(tag)) throw new Error(`태그 형식 불일치: ${String(tag).slice(0, 40)}`)
  return { tag, version: tag.slice(1) }
}

export interface Eligibility { ok: boolean; reason?: string }

// ---------- 스모크 테스트 (격리 환경) ----------

export function isolatedEnv(root: string): Record<string, string> {
  mkdirSync(join(root, 'home'), { recursive: true }); mkdirSync(join(root, 'ws'), { recursive: true })
  return {
    HOME: join(root, 'home'), CLIPMENT_HOME: join(root, 'clipment-home'), CLIPMENT_DAEMON_CONFIG: join(root, 'daemon.json'),
    CLIPREV_ROOT: join(root, 'ws'), CLIPREV_CONFIG: join(root, 'cliprev.json'), CLIPMENT_DIR: join(root, 'no-agent'),
    CLIPMENT_NO_UPDATE_CHECK: '1', CLIPMENT_SKIP_PLUGIN_UPDATE: '1', CLIPREV_CHANNEL: '', CLIPMENT_SESSION_PID: '', CLIPMENT_SESSION_VERSION: '',
  }
}

/** server.ts 에 initialize + tools/list 를 보내 도구가 하나 이상 나오는지 본다 */
export function mcpHandshake(bun: string, server: string, env: Record<string, string>, version: string, timeoutMs = 20_000): Promise<number> {
  return new Promise((resolveP, reject) => {
    const p = spawn(bun, [server], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let buf = '', err = '', done = false
    const finish = (e?: Error, n?: number) => {
      if (done) return; done = true; clearTimeout(t)
      try { p.kill('SIGKILL') } catch {}
      if (e) reject(e); else resolveP(n ?? 0)
    }
    const t = setTimeout(() => finish(new Error(`MCP 핸드셰이크 시간 초과 ${err.slice(-200)}`)), timeoutMs)
    p.stderr!.on('data', d => { err += d })
    p.on('exit', c => finish(new Error(`MCP 서버가 종료됨 (${c}) ${err.slice(-200)}`)))
    p.stdout!.on('data', d => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let m: any; try { m = JSON.parse(line) } catch { continue }
        if (m?.id === 1) {
          if (m.error) return finish(new Error(`initialize 오류 ${JSON.stringify(m.error).slice(0, 200)}`))
          if (m.result?.serverInfo?.version !== version) return finish(new Error(`서버 버전 불일치: ${m.result?.serverInfo?.version} != ${version}`))
          p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
        } else if (m?.id === 2) {
          const n = Array.isArray(m.result?.tools) ? m.result.tools.length : 0
          return n > 0 ? finish(undefined, n) : finish(new Error('tools/list 가 비어 있습니다'))
        }
      }
    })
    p.stdin!.on('error', () => {})
    p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'clipment-update-smoke', version: '0' } } }) + '\n')
  })
}

/** `cli.ts daemon run` 이 aliveMs 동안 죽지 않고 버티는지, SIGTERM 으로 깨끗이 끝나는지 */
export function daemonAlive(bun: string, cli: string, env: Record<string, string>, aliveMs: number): Promise<void> {
  return new Promise((resolveP, reject) => {
    const p = spawn(bun, [cli, 'daemon', 'run'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let out = '', exited = false
    p.stdout!.on('data', d => { out += d }); p.stderr!.on('data', d => { out += d })
    p.on('exit', c => {
      exited = true
      if (!stopping) reject(new Error(`daemon run 이 ${aliveMs}ms 안에 종료됨 (${c}) ${out.slice(-200)}`))
    })
    let stopping = false
    setTimeout(() => {
      if (exited) return
      stopping = true
      p.kill('SIGTERM')
      const k = setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, 5000)
      p.on('exit', () => { clearTimeout(k); resolveP() })
    }, aliveMs)
  })
}

export type Smoke = (tree: string, version: string, env: Record<string, string>) => Promise<void>

// ---------- 업데이터 ----------

export interface UpdaterDeps {
  run: Runner
  appDir: string
  bun: string
  cfg: () => DaemonConfig
  notify: Notifier
  log: Logger
  isIdle: () => Promise<boolean>
  /** 적용이 끝났을 때 데몬을 종료시킨다 (launchd KeepAlive 가 새 코드로 되살림) */
  exit: (code: number) => void
  fetch?: FetchLike
  now?: () => number
  random?: () => number
  env?: NodeJS.ProcessEnv
  stageRoot?: string
  smoke?: Smoke
  aliveMs?: number
}

export type CheckStatus = 'disabled' | 'error' | 'uptodate' | 'bad' | 'notified' | 'ineligible' | 'stage-failed' | 'staged' | 'applied' | 'apply-failed' | 'locked'
export interface CheckResult { status: CheckStatus; current: string; latest?: string; detail?: string }

export class Updater {
  private busy = false
  private typeFlag = false
  private d: UpdaterDeps & { now: () => number; random: () => number; env: NodeJS.ProcessEnv }
  constructor(deps: UpdaterDeps) {
    this.d = { ...deps, now: deps.now ?? Date.now, random: deps.random ?? Math.random, env: deps.env ?? process.env }
  }

  private get disabled() { return this.d.env.CLIPMENT_NO_UPDATE_CHECK === '1' }
  get current(): string { return readPkg(this.d.appDir)?.version ?? '0.0.0' }

  /** 화이트리스트 밖 type 의 요청을 봤다 → 폰 앱이 더 새롭다. 시간당 한 번만 추가 확인 */
  noteUnknownType() { this.typeFlag = true }

  private git(args: string[], timeoutMs = 120_000, cwd?: string) {
    return this.d.run('git', args, { timeoutMs, cwd, env: { GIT_TERMINAL_PROMPT: '0' } })
  }
  private app(args: string[], timeoutMs?: number) { return this.git(['-C', this.d.appDir, ...args], timeoutMs) }

  /** 데몬이 1분마다 부른다 */
  async tick(): Promise<CheckResult | null> {
    if (this.disabled || this.busy) return null
    const now = this.d.now()
    const st = readUpdateState()
    if (st.backoffUntil && now < st.backoffUntil) return null
    this.busy = true
    try {
      if (st.staged) return await this.continueStaged(st)
      if (st.nextCheckAt === undefined) {
        // 첫 기동: 바로 두드리지 않고 30분 안의 임의 시각
        writeUpdateState({ ...st, nextCheckAt: now + Math.floor(this.d.random() * 30 * 60_000) })
        return null
      }
      const typeDue = this.typeFlag && now - (st.lastTypeCheckAt ?? 0) >= HOUR
      if (now >= st.nextCheckAt || typeDue) {
        if (typeDue) { this.typeFlag = false; writeUpdateState({ ...readUpdateState(), lastTypeCheckAt: now }) }
        return await this.checkInner(false)
      }
      return null
    } finally { this.busy = false }
  }

  /** 즉시 확인 (CLI/테스트). reportOnly 면 상태를 바꾸거나 알림을 보내지 않는다 */
  async check(reportOnly = false): Promise<CheckResult> {
    if (this.busy) return { status: 'locked', current: this.current, detail: '다른 점검이 진행 중' }
    this.busy = true
    try { return await this.checkInner(reportOnly) } finally { this.busy = false }
  }

  private async checkInner(reportOnly: boolean): Promise<CheckResult> {
    const cur = this.current
    if (this.disabled) return { status: 'disabled', current: cur }
    const now = this.d.now()
    const st = readUpdateState()
    let rel: ReleaseInfo
    try {
      rel = await fetchLatestRelease(this.d.fetch, { api: updateApi(this.d.env) })
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      this.d.log.log('info', '업데이트 확인 실패(무시)', { err: msg })
      if (!reportOnly) {
        const failures = (st.failures ?? 0) + 1
        writeUpdateState({ ...st, failures, backoffUntil: now + Math.min(DAY, HOUR * 2 ** (failures - 1)), lastCheckAt: now })
      }
      return { status: 'error', current: cur, detail: msg }
    }
    if (!reportOnly) {
      writeUpdateState({ ...st, failures: 0, backoffUntil: undefined, lastCheckAt: now, latest: rel.version, nextCheckAt: now + DAY + Math.floor(this.d.random() * 2 * HOUR) })
    }
    const c = cmpVersion(rel.version, cur)
    if (c === null || c <= 0) return { status: 'uptodate', current: cur, latest: rel.version } // 같거나 더 낮음(다운그레이드 안 함)
    if (reportOnly) return { status: 'notified', current: cur, latest: rel.version, detail: '새 버전 있음' }
    if (isBad(rel.version)) return { status: 'bad', current: cur, latest: rel.version }

    const cfg = this.d.cfg()
    const major = (majorOf(rel.version) ?? 0) > (majorOf(cur) ?? 0)
    if (major) {
      await this.notifyOnce(rel.version, `새 메이저 버전 v${rel.version} · clipment update (자동 적용 안 함)`)
      return { status: 'notified', current: cur, latest: rel.version, detail: 'major' }
    }
    if (!cfg.autoUpdate) {
      await this.notifyOnce(rel.version, `새 버전 v${rel.version} · clipment update`)
      return { status: 'notified', current: cur, latest: rel.version }
    }
    const el = await this.eligible()
    if (!el.ok) {
      this.d.log.log('info', '자동 업데이트 불가 — 알림만', { reason: el.reason })
      await this.notifyOnce(rel.version, `새 버전 v${rel.version} · clipment update (자동 적용 불가: ${el.reason})`)
      return { status: 'ineligible', current: cur, latest: rel.version, detail: el.reason }
    }
    const staged = await this.stage(rel)
    if (!staged.ok) {
      addBad(rel.version, staged.reason)
      this.d.log.log('warn', '업데이트 스테이징 실패', { version: rel.version, reason: staged.reason })
      await this.notifyOnce(`fail:${rel.version}`, `v${rel.version} 자동 업데이트 준비에 실패해 건너뜁니다 (현재 버전 유지)`)
      return { status: 'stage-failed', current: cur, latest: rel.version, detail: staged.reason }
    }
    writeUpdateState({ ...readUpdateState(), staged: staged.info })
    return await this.continueStaged(readUpdateState())
  }

  private async continueStaged(st: UpdateState): Promise<CheckResult> {
    const s = st.staged!
    const cur = this.current
    const drop = (why: string): CheckResult => { this.dropStage(s.dir); writeUpdateState({ ...readUpdateState(), staged: undefined }); return { status: 'uptodate', current: cur, latest: s.version, detail: why } }
    if (!this.d.cfg().autoUpdate) return drop('autoUpdate 꺼짐')
    const c = cmpVersion(s.version, cur)
    if (c === null || c <= 0) return drop('이미 적용됨/더 낮음')
    if (isBad(s.version)) return drop('나쁜 버전')
    if (!(await this.d.isIdle())) {
      this.d.log.log('info', '업데이트 대기 — 작업 진행 중', { version: s.version })
      return { status: 'staged', current: cur, latest: s.version, detail: '작업 중이라 대기' }
    }
    return await this.apply(s)
  }

  // ---------- 자격 ----------

  async eligible(): Promise<Eligibility> {
    const app = resolve(this.d.appDir)
    if (app !== resolve(managedDir())) return { ok: false, reason: '관리형 설치(~/.clipment/agent) 가 아님' }
    if (!existsSync(join(app, '.git'))) return { ok: false, reason: 'git 클론이 아님 (릴리스 tarball 설치)' }
    const o = await this.app(['remote', 'get-url', 'origin'], 15_000)
    if (o.code !== 0) return { ok: false, reason: 'origin 을 읽지 못함' }
    const url = o.output.trim()
    const want = this.d.env.CLIPMENT_UPDATE_ORIGIN?.trim()
    if (want ? url !== want : !EXPECTED_ORIGINS.includes(url)) return { ok: false, reason: `origin 이 예상과 다름: ${url.slice(0, 80)}` }
    const s = await this.app(['status', '--porcelain', '--untracked-files=no'], 30_000)
    if (s.code !== 0) return { ok: false, reason: 'git status 실패' }
    if (s.output.trim()) return { ok: false, reason: '작업 트리에 수정 사항이 있음' }
    return { ok: true }
  }

  // ---------- 스테이징 ----------

  private stageDir(version: string) { return join(this.d.stageRoot ?? join(clipHome(), 'update-stage'), version) }
  private dropStage(dir: string) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }

  private async installDeps(cwd: string, timeoutMs = 300_000) {
    const frozen = existsSync(join(cwd, 'bun.lock')) || existsSync(join(cwd, 'bun.lockb'))
    return this.d.run(this.d.bun, ['install', '--production', ...(frozen ? ['--frozen-lockfile'] : []), '--ignore-scripts', '--no-summary'], { timeoutMs, cwd })
  }

  async stage(rel: ReleaseInfo): Promise<{ ok: true; info: NonNullable<UpdateState['staged']> } | { ok: false; reason: string }> {
    const dir = this.stageDir(rel.version)
    this.dropStage(dir)
    const fail = (reason: string) => { this.dropStage(dir); return { ok: false as const, reason } }
    try {
      mkdirSync(dir, { recursive: true })
      const f = await this.app(['fetch', '--no-tags', 'origin', `+refs/tags/${rel.tag}:refs/tags/${rel.tag}`], 180_000)
      if (f.code !== 0) return fail(`git fetch 실패: ${f.output.slice(-200)}`)
      const rp = await this.app(['rev-parse', '--verify', '--quiet', `refs/tags/${rel.tag}^{commit}`], 15_000)
      const sha = rp.output.trim()
      if (rp.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) return fail('태그를 찾지 못함')
      const tar = join(dir, 'src.tar'), tree = join(dir, 'tree')
      mkdirSync(tree, { recursive: true })
      const a = await this.app(['archive', '--format=tar', '-o', tar, sha], 120_000)
      if (a.code !== 0) return fail(`git archive 실패: ${a.output.slice(-200)}`)
      const x = await this.d.run('tar', ['-xf', tar, '-C', tree], { timeoutMs: 60_000 })
      if (x.code !== 0) return fail(`압축 해제 실패: ${x.output.slice(-200)}`)
      const pkg = readPkg(tree)
      if (!pkg || !PKG_NAMES.includes(pkg.name)) return fail(`package.json 이름이 ${PKG_NAMES.join('|')} 가 아님`)
      if (pkg.version !== rel.version) return fail(`package.json 버전(${pkg.version}) 이 태그(${rel.tag}) 와 다름`)
      if (!existsSync(join(tree, 'src/server.ts')) || !existsSync(join(tree, 'src/cli.ts'))) return fail('src/server.ts 또는 src/cli.ts 가 없음')
      const i = await this.installDeps(tree)
      if (i.code !== 0) return fail(`bun install 실패: ${i.output.slice(-200)}`)
      try { await (this.d.smoke ?? this.realSmoke)(tree, rel.version, isolatedEnv(join(dir, 'iso'))) } catch (e: any) { return fail(`스모크 테스트 실패: ${String(e?.message ?? e).slice(0, 300)}`) }
      return { ok: true, info: { version: rel.version, tag: rel.tag, dir, sha, at: new Date(this.d.now()).toISOString() } }
    } catch (e: any) { return fail(String(e?.message ?? e)) }
  }

  private realSmoke: Smoke = async (tree, version, env) => {
    const v = await this.d.run(this.d.bun, [join(tree, 'src/cli.ts'), '--version'], { timeoutMs: 30_000, cwd: tree, env })
    if (v.code !== 0 || v.output.trim() !== version) throw new Error(`cli --version: ${v.output.trim().slice(0, 100)}`)
    await mcpHandshake(this.d.bun, join(tree, 'src/server.ts'), env, version)
    await daemonAlive(this.d.bun, join(tree, 'src/cli.ts'), env, this.d.aliveMs ?? 5000)
  }

  // ---------- 적용 ----------

  private async currentRef(): Promise<{ ref: string; sha: string } | null> {
    const sha = await this.app(['rev-parse', 'HEAD'], 15_000)
    if (sha.code !== 0) return null
    const br = await this.app(['symbolic-ref', '-q', '--short', 'HEAD'], 15_000)
    return { ref: br.code === 0 && br.output.trim() ? br.output.trim() : sha.output.trim(), sha: sha.output.trim() }
  }

  private async restore(prev: { ref: string; sha: string }) {
    const co = await this.app(['checkout', '--force', prev.ref], 60_000)
    if (co.code !== 0) await this.app(['checkout', '--force', '--detach', prev.sha], 60_000)
    await this.installDeps(this.d.appDir)
  }

  private async apply(s: NonNullable<UpdateState['staged']>): Promise<CheckResult> {
    const cur = this.current
    const release = acquireUpdateLock(this.d.now())
    if (!release) return { status: 'locked', current: cur, latest: s.version, detail: '다른 업데이트가 진행 중' }
    let prev: { ref: string; sha: string } | null = null
    try {
      const el = await this.eligible() // 스테이징 이후 바뀌었을 수 있다
      if (!el.ok) { await this.notifyOnce(s.version, `새 버전 v${s.version} · clipment update (자동 적용 불가: ${el.reason})`); return { status: 'ineligible', current: cur, latest: s.version, detail: el.reason } }
      prev = await this.currentRef()
      if (!prev) throw new Error('현재 커밋을 읽지 못함')
      const co = await this.app(['checkout', '--detach', s.sha], 60_000) // 태그가 옮겨져도 스모크를 통과한 그 커밋만
      if (co.code !== 0) throw new Error(`git checkout 실패: ${co.output.slice(-200)}`)
      const i = await this.installDeps(this.d.appDir)
      if (i.code !== 0) throw new Error(`bun install 실패: ${i.output.slice(-200)}`)
      if (readPkg(this.d.appDir)?.version !== s.version) throw new Error('적용 후 버전이 태그와 다름')
      writeUpdateState({ ...readUpdateState(), staged: undefined, previousRef: prev.ref, previousSha: prev.sha, previousVersion: cur, version: s.version, appliedAt: new Date(this.d.now()).toISOString(), rolledBackAt: undefined })
      this.dropStage(s.dir)
      this.d.log.log('info', '업데이트 적용 — 데몬 재시작', { from: cur, to: s.version, previousRef: prev.ref })
      if (this.d.cfg().notify) { try { await this.d.notify('Clipment', `v${s.version} 로 업데이트했어요 (되돌리기: clipment update --rollback)`) } catch {} }
      release()
      this.d.exit(EXIT_UPDATE_RESTART)
      return { status: 'applied', current: cur, latest: s.version }
    } catch (e: any) {
      const reason = String(e?.message ?? e)
      this.d.log.log('error', '업데이트 적용 실패 — 이전으로 복원', { version: s.version, reason })
      if (prev) { try { await this.restore(prev) } catch (re) { this.d.log.log('error', '복원 중 오류', { err: String(re) }) } }
      addBad(s.version, reason)
      this.dropStage(s.dir)
      writeUpdateState({ ...readUpdateState(), staged: undefined })
      await this.notifyOnce(`fail:${s.version}`, `v${s.version} 업데이트 적용에 실패해 이전 버전으로 되돌렸어요`)
      release()
      return { status: 'apply-failed', current: this.current, latest: s.version, detail: reason }
    }
  }

  private async notifyOnce(key: string, body: string) {
    const st = readUpdateState()
    const seen = st.notified ?? []
    if (seen.includes(key)) return
    writeUpdateState({ ...st, notified: [...seen, key].slice(-50) })
    this.d.log.log('info', '업데이트 알림', { body })
    if (!this.d.cfg().notify) return
    try { await this.d.notify('Clipment', body) } catch (e) { this.d.log.log('warn', '알림 실패', { err: String(e) }) }
  }
}

// ---------- 롤백 (CLI) ----------

export interface RollbackResult { ok: boolean; message: string; from?: string; to?: string }

/** 마지막 자동 적용 전 상태(previousRef)로 돌아가고 그 버전을 나쁜 버전 목록에 올린다 */
export async function rollback(o: { run: Runner; appDir: string; bun: string }): Promise<RollbackResult> {
  const st = readUpdateState()
  if (!st.previousRef) return { ok: false, message: '되돌릴 이전 상태가 없습니다 (자동 적용 기록 없음)' }
  const git = (args: string[]) => o.run('git', ['-C', o.appDir, ...args], { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: '0' } })
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
  if (dirty.code !== 0) return { ok: false, message: 'git status 실패' }
  if (dirty.output.trim()) return { ok: false, message: '작업 트리에 수정 사항이 있어 되돌리지 않습니다' }
  const release = acquireUpdateLock()
  if (!release) return { ok: false, message: '다른 업데이트가 진행 중입니다' }
  try {
    const from = readPkg(o.appDir)?.version
    let co = await git(['checkout', st.previousRef])
    if (co.code !== 0 && st.previousSha) co = await git(['checkout', '--detach', st.previousSha])
    if (co.code !== 0) return { ok: false, message: `git checkout 실패: ${co.output.slice(-200)}` }
    const frozen = existsSync(join(o.appDir, 'bun.lock')) || existsSync(join(o.appDir, 'bun.lockb'))
    const i = await o.run(o.bun, ['install', '--production', ...(frozen ? ['--frozen-lockfile'] : []), '--ignore-scripts', '--no-summary'], { timeoutMs: 300_000, cwd: o.appDir })
    if (i.code !== 0) return { ok: false, message: `bun install 실패: ${i.output.slice(-200)}` }
    const bad = st.version ?? from
    if (bad) addBad(bad, '수동 롤백 (clipment update --rollback)')
    const to = readPkg(o.appDir)?.version
    writeUpdateState({ ...readUpdateState(), previousRef: undefined, previousSha: undefined, rolledBackAt: new Date().toISOString() })
    return { ok: true, message: `v${from ?? '?'} -> v${to ?? '?'} 로 되돌렸습니다${bad ? ` (v${bad} 는 나쁜 버전으로 기록)` : ''}`, from, to }
  } finally { release() }
}
