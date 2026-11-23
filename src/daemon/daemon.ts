import { existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  listComments, listWorkspaceProjects, readWorkspaceContract, formatContract, CONTRACT_STAMP, type Compat, type WorkspaceContract, pendingRequests, readConfigRoots, reindexRootsFor, scanRoot, indexPath, readJson, indexRoot,
  workspaces, type PendingRequest, type Workspace, currentLock, scriptFileOf, generateVoices, createTtsEngine, type TtsEngine, type VoiceResult,
} from '../core/index.ts'
import { AUTO_TYPES, runJob, type AutoRun } from './autorun.ts'
import { configuredTtsEngine, loadDaemonConfig, type DaemonConfig } from './config.ts'
import { acquireLock } from './lock.ts'
import { osascriptNotifier, planNotifications, type Notifier } from './notify.ts'
import { ChildTracker, makeRunner, type Runner } from './runner.ts'
import { buildHealthReport, newHealthNotifyState, planHealthNotifications } from './health.ts'
import { clipmentHome, lockPath, logPath, Logger, statePath, TtlCache } from './util.ts'

export const RSS_LIMIT_MB = 200
export const RSS_CHECK_MS = 10 * 60_000
export const EXIT_OK = 0
export const EXIT_RSS_RESTART = 75 // EX_TEMPFAIL: launchd KeepAlive 가 되살림
export const MAX_QUEUE = 20
export const MAX_STATE_PENDING = 50

/** 변화가 있으면 최소 간격으로, 없으면 1.5배씩 늘려 상한까지 */
export function nextInterval(cur: number, changed: boolean, min: number, max: number): number {
  return changed ? min : Math.min(max, Math.max(min, Math.round(cur * 1.5)))
}

export interface DaemonDeps {
  notifier?: Notifier
  runner?: Runner
  config?: () => DaemonConfig
  appDir?: string
  bun?: string
  logger?: Logger
  /** 테스트용: fs.watch 끄기 */
  noWatch?: boolean
  rootCheckMs?: number
  /** 테스트용: AI 음성 엔진 주입 (기본: 설정된 엔진) */
  tts?: TtsEngine
}

export interface DaemonState {
  pid: number; started: string; updated: string; version: string; autoRun: AutoRun
  pollMs: number; rssMB: number; lastTickOk: boolean
  pending: { id: string; ref: string; type: string; version: number; agent: string; created: string; state: string }[]
  pendingTotal: number; lastSeen: string | null
  currentJob: { id: string; ref: string; since: string } | null
  workspaces: { name: string; path: string; reachable: boolean; projects: number; watching: boolean; contract: string; compat: Compat; readOnly: boolean; error?: string }[]
}

export class Daemon {
  readonly log: Logger
  readonly tracker = new ChildTracker()
  private run: Runner
  private notifier: Notifier
  private cfg: () => DaemonConfig
  private seen = new TtlCache(500)
  private queued = new TtlCache(200)
  private notified = new TtlCache(500)
  private healthState = newHealthNotifyState()
  private healthBusy = false
  private lastCommentScan = 0
  private queue: PendingRequest[] = []
  private watchers = new Map<string, FSWatcher>()
  private wakeFn: (() => void) | null = null
  private stopping = false
  private skippedNewer = new Set<string>()
  private interval: number
  private firstTick = true
  private sig = ''
  private reindexDue = 0
  private rootSigs = new Map<string, string>()
  private lastRootCheck = 0
  private lastStateJson = ''
  private lastStateWrite = 0
  private scriptSigs = new Map<string, string>()
  private scriptBusy: Promise<unknown> | null = null
  private startedAt = Date.now()
  private lastSeen: string | null = null
  private currentJob: DaemonState['currentJob'] = null
  private jobWorker: Promise<void> | null = null
  private timers: ReturnType<typeof setInterval>[] = []
  exitCode = EXIT_OK

  constructor(private deps: DaemonDeps = {}) {
    this.log = deps.logger ?? new Logger(logPath())
    this.run = deps.runner ?? makeRunner(this.tracker)
    this.notifier = deps.notifier ?? osascriptNotifier(makeRunner(this.tracker))
    this.cfg = deps.config ?? (() => loadDaemonConfig())
    this.interval = this.cfg().pollMs
  }

  get appDir() { return this.deps.appDir ?? resolve(import.meta.dir, '../..') }

  wake = () => { this.wakeFn?.() }

  private syncWatchers(list: Workspace[]) {
    if (this.deps.noWatch) return
    const want = new Set(list.map(w => w.path))
    for (const [p, w] of this.watchers) if (!want.has(p)) { try { w.close() } catch {} this.watchers.delete(p); this.log.log('info', 'watch 해제', { path: p }) }
    let debounce: ReturnType<typeof setTimeout> | undefined
    for (const w of list) {
      if (this.watchers.has(w.path) || !existsSync(w.path)) continue
      try {
        const fw = watch(w.path, { recursive: true }, () => {
          clearTimeout(debounce); debounce = setTimeout(this.wake, 500)
        })
        fw.on('error', () => { try { fw.close() } catch {} this.watchers.delete(w.path) })
        this.watchers.set(w.path, fw)
      } catch (e) { this.log.log('warn', 'fs.watch 실패(폴링만 사용)', { path: w.path, err: String(e) }) }
    }
  }

  /** 한 번 스캔. 변화가 있었으면 true */
  async tick(now = Date.now()): Promise<boolean> {
    const cfg = this.cfg()
    const list = workspaces()
    this.syncWatchers(list)
    let changed = false

    // 워크스페이스 상태 + 변경 감지(시그니처)
    const wsState: DaemonState['workspaces'] = []
    const sigParts: string[] = []
    for (const w of list) {
      const reachable = existsSync(w.path)
      let projects = 0, error: string | undefined
      if (reachable) { try { projects = (await listWorkspaceProjects(w)).length } catch (e) { error = String(e) } }
      let wc: WorkspaceContract = { version: { major: 1, minor: 0 }, compat: 'ok', readOnly: false }
      if (reachable) { try { wc = await readWorkspaceContract(w.path) } catch {} }
      if (wc.readOnly && !this.skippedNewer.has(w.path)) {
        this.skippedNewer.add(w.path)
        this.log.log('warn', '더 새 계약 워크스페이스 — 건너뜀(읽기 전용)', { workspace: w.name, contract: formatContract(wc.version), supported: CONTRACT_STAMP })
      } else if (!wc.readOnly) this.skippedNewer.delete(w.path)
      wsState.push({ name: w.name, path: w.path, reachable, projects, watching: this.watchers.has(w.path), contract: formatContract(wc.version), compat: wc.compat, readOnly: wc.readOnly, ...(error ? { error } : {}) })
      sigParts.push(`${w.name}|${w.path}|${reachable}|${projects}`)
    }
    const sig = sigParts.join('\n')
    if (sig !== this.sig) {
      if (!this.firstTick) { changed = true; this.reindexDue = now + 5000; this.log.log('info', '워크스페이스 변경 감지 — 인덱스 갱신 예약') }
      this.sig = sig
    }
    if (this.reindexDue && now >= this.reindexDue) {
      this.reindexDue = 0
      for (const w of list) { try { const d = await reindexRootsFor(w.path); if (d.length) this.log.log('info', '루트 인덱스 갱신', { roots: d }) } catch {} }
    }
    await this.checkRoots(now)

    // 요청 감지 (모든 agent 대상 알림)
    let pending: PendingRequest[] = []
    let ok = true
    try { pending = await pendingRequests(undefined, null, () => {}) } catch (e) { ok = false; this.log.log('warn', '요청 스캔 실패', { err: String(e) }) }
    const fresh: { req: PendingRequest; comments: number }[] = []
    for (const r of pending) {
      const key = r.ref + ':' + r.id
      if (this.seen.has(key, now)) continue
      this.seen.add(key, now)
      changed = true
      this.lastSeen = new Date(now).toISOString()
      // 기동 시점에 이미 오래된(10분+) 요청은 알림 생략
      if (r.state !== 'pending') continue
      if (this.firstTick && now - Date.parse(r.created) > 10 * 60_000) continue
      let n = r.commentIds?.length ?? 0
      if (!r.commentIds && r.type !== 'apply_script') { try { n = (await listComments(r.ref, { version: r.version, status: 'open' })).length } catch {} }
      fresh.push({ req: r, comments: n })
    }
    if (cfg.notify) {
      for (const n of planNotifications(fresh.map(f => ({ ...f })), this.notified, now)) {
        this.log.log('info', '알림', n)
        try { await this.notifier(n.title, n.body) } catch (e) { this.log.log('warn', '알림 실패', { err: String(e) }) }
      }
    } else if (fresh.length) this.log.log('info', '새 요청 (알림 꺼짐)', { n: fresh.length })
    for (const f of fresh) this.log.log('info', '새 요청', { ref: f.req.ref, id: f.req.id, type: f.req.type, version: f.req.version })

    // 자동 처리 큐
    if (cfg.autoRun !== 'off') this.enqueue(pending, cfg, now)

    // 대본 AI 음성 (SPEC §14): script.json 이 바뀐 프로젝트만. 합성은 느리므로 백그라운드로 돌리고 tick 은 막지 않는다
    if (!this.scriptBusy) this.scriptBusy = this.scriptPass(now).catch(e => this.log.log('warn', '대본 음성 점검 실패', { err: String(e) })).finally(() => { this.scriptBusy = null })

    this.firstTick = false
    this.interval = nextInterval(this.interval, changed, cfg.pollMs, cfg.maxPollMs)
    this.writeState(cfg, wsState, pending, ok, changed, now)
    return changed
  }

  private enqueue(pending: PendingRequest[], cfg: DaemonConfig, now: number) {
    const agent = cfg.autoRun
    for (const r of pending) {
      if (!(AUTO_TYPES as readonly string[]).includes(r.type)) continue
      if (r.agent && r.agent !== agent) continue
      if (r.state !== 'pending') continue // 이미 received 등 진행 이벤트가 있으면 누군가 잡은 것
      if (now - Date.parse(r.created) > cfg.maxAgeMin * 60_000) continue
      const key = r.ref + ':' + r.id
      if (this.queued.has(key, now)) continue
      if (this.queue.length >= MAX_QUEUE) { this.log.log('warn', '자동 처리 큐 가득 — 다음 스캔에서 재시도'); break }
      this.queued.add(key, now)
      this.queue.push(r)
    }
    if (this.queue.length && !this.jobWorker) {
      this.jobWorker = this.drain().finally(() => { this.jobWorker = null })
    }
  }

  /** 한 번에 하나씩 */
  private async drain() {
    while (!this.stopping) {
      const r = this.queue.shift()
      if (!r) return
      const cfg = this.cfg()
      if (cfg.autoRun === 'off') return
      this.currentJob = { id: r.id, ref: r.ref, since: new Date().toISOString() }
      try {
        const out = await runJob(r, cfg.autoRun, {
          run: this.run, appDir: this.appDir, bun: this.deps.bun ?? process.execPath,
          workDir: this.workDir(), timeoutMs: cfg.jobTimeoutMin * 60_000,
          log: (msg, d) => this.log.log('info', msg, d),
        })
        this.log.log('info', '자동 처리 결과', { id: r.id, outcome: out })
      } catch (e) { this.log.log('error', '자동 처리 오류', { id: r.id, err: String(e) }) }
      this.currentJob = null
      this.wake()
    }
  }

  /**
   * 대본 한 번 점검 (SPEC §14): script/script.json 이 마지막 점검 이후 바뀐 프로젝트에서 없는·오래된 AI 음성을 만들고 aiTextHash 를 써 넣는다.
   * 잠긴 프로젝트·더 새 계약(읽기 전용) 워크스페이스는 건너뛴다. 자기 write-back 은 파일 시그니처(mtime+size)가 바뀌어 한 번 더 읽히지만
   * 그때는 오래된 줄이 없어 아무 것도 하지 않으므로 루프가 생기지 않는다. 실패해도 파일이 바뀌기 전까지 재시도하지 않는다.
   */
  async scriptPass(_now = Date.now()): Promise<{ ref: string; result?: VoiceResult; error?: string }[]> {
    const out: { ref: string; result?: VoiceResult; error?: string }[] = []
    for (const w of workspaces()) {
      if (!existsSync(w.path)) continue
      let wc: WorkspaceContract
      try { wc = await readWorkspaceContract(w.path) } catch { continue }
      if (wc.readOnly) continue
      for (const p of await listWorkspaceProjects(w)) {
        const ref = `${w.name}/${p.id}`
        const file = scriptFileOf(join(w.path, p.id))
        let sig: string
        try { const st = statSync(file); sig = `${st.mtimeMs}:${st.size}` } catch { this.scriptSigs.delete(ref); continue }
        if (this.scriptSigs.get(ref) === sig) continue
        if (await currentLock(ref)) continue // 잠긴 프로젝트는 음성을 만들지 않는다 (서명은 기억하지 않아 잠금 해제 후 다시 본다)
        this.scriptSigs.set(ref, sig)
        try {
          const engine = this.deps.tts ?? createTtsEngine(configuredTtsEngine(this.cfg()))
          const result = await generateVoices(ref, { engine })
          if (result.generated.length || result.failed.length || result.removed.length)
            this.log.log(result.failed.length ? 'warn' : 'info', 'AI 음성 생성', { ref, engine: result.engine, generated: result.generated.length, failed: result.failed, removed: result.removed.length })
          out.push({ ref, result })
        } catch (e) {
          this.log.log('warn', 'AI 음성 생성 실패 (대본이 바뀌면 다시 시도)', { ref, err: String(e) })
          out.push({ ref, error: String(e instanceof Error ? e.message : e) })
        }
      }
    }
    return out
  }

  /** 헬스 체크 (autoRun 과 무관, 1분마다). 오래 미처리 요청 / 세션 없음 / 요청 없는 코멘트를 macOS 알림으로. */
  async healthCheck(now = Date.now()): Promise<void> {
    if (this.healthBusy) return
    this.healthBusy = true
    try {
      const cfg = this.cfg()
      // 코멘트 스캔은 모든 프로젝트를 읽으므로 10분에 한 번만
      const scanComments = now - this.lastCommentScan >= 10 * 60_000
      if (scanComments) this.lastCommentScan = now
      const rep = await buildHealthReport({ now, cfg, skipComments: !scanComments, daemon: { installed: true, loaded: true, running: true, pid: process.pid } })
      const notes = planHealthNotifications(rep, this.healthState, cfg, now)
      for (const n of notes) {
        this.log.log('info', '헬스 알림', n)
        if (!cfg.notify) continue
        try { await this.notifier(n.title, n.body) } catch (e) { this.log.log('warn', '알림 실패', { err: String(e) }) }
      }
    } catch (e) { this.log.log('warn', '헬스 체크 실패', { err: String(e) }) } finally { this.healthBusy = false }
  }

  private workDir(): string {
    const d = join(clipmentHome(), 'work')
    mkdirSync(d, { recursive: true })
    return d
  }

  /** 루트는 5분마다만 스캔해 인덱스 내용이 달라졌을 때 갱신 */
  private async checkRoots(now: number) {
    const every = this.deps.rootCheckMs ?? 5 * 60_000
    if (now - this.lastRootCheck < every) return
    this.lastRootCheck = now
    for (const r of readConfigRoots()) {
      if (!existsSync(r.path)) continue
      try {
        const sigOf = (ws: { path: string; name: string; projects: number }[]) => JSON.stringify(ws.map(w => [w.path, w.name, w.projects]))
        if (!this.rootSigs.has(r.path)) {
          const j = await readJson(indexPath(r.path))
          this.rootSigs.set(r.path, Array.isArray(j?.workspaces) ? sigOf(j.workspaces) : '')
        }
        const cur = sigOf((await scanRoot(r.path)).workspaces)
        if (cur !== this.rootSigs.get(r.path)) {
          await indexRoot(r.path, { register: false })
          this.rootSigs.set(r.path, cur)
          this.log.log('info', '루트 인덱스 갱신', { root: r.path })
        }
      } catch (e) { this.log.log('warn', '루트 점검 실패', { root: r.path, err: String(e) }) }
    }
  }

  private writeState(cfg: DaemonConfig, ws: DaemonState['workspaces'], pending: PendingRequest[], ok: boolean, changed: boolean, now: number) {
    const st: DaemonState = {
      pid: process.pid, started: new Date(this.startedAt).toISOString(), updated: new Date(now).toISOString(),
      version: this.version(), autoRun: cfg.autoRun, pollMs: this.interval, rssMB: Math.round(process.memoryUsage.rss() / 1048576),
      lastTickOk: ok,
      pending: pending.slice(0, MAX_STATE_PENDING).map(r => ({ id: r.id, ref: r.ref, type: r.type, version: r.version, agent: r.agent, created: r.created, state: r.state })),
      pendingTotal: pending.length, lastSeen: this.lastSeen, currentJob: this.currentJob, workspaces: ws,
    }
    // updated/rss/pollMs 는 비교에서 제외: 내용 변화가 있거나 60초 지났을 때만 디스크에 쓴다
    const cmp = JSON.stringify({ ...st, updated: 0, rssMB: 0, pollMs: 0 })
    if (cmp === this.lastStateJson && now - this.lastStateWrite < 60_000) return
    this.lastStateJson = cmp; this.lastStateWrite = now
    try {
      const f = statePath()
      mkdirSync(dirname(f), { recursive: true })
      writeFileSync(f + '.tmp', JSON.stringify(st, null, 2) + '\n')
      renameSync(f + '.tmp', f)
    } catch (e) { this.log.log('warn', 'state.json 쓰기 실패', { err: String(e) }) }
  }

  private version(): string {
    try { return JSON.parse(readFileSync(join(this.appDir, 'package.json'), 'utf8')).version } catch { return '?' }
  }

  checkRss(limitMB = RSS_LIMIT_MB): boolean {
    const mb = process.memoryUsage.rss() / 1048576
    this.log.log('info', 'RSS 점검', { rssMB: Math.round(mb) })
    if (mb > limitMB) {
      this.log.log('warn', `RSS ${Math.round(mb)}MB > ${limitMB}MB — 정상 종료 후 재시작`)
      this.exitCode = EXIT_RSS_RESTART
      this.stop()
      return true
    }
    return false
  }

  /** 정리: 자식 그룹 종료, watcher 닫기, 타이머 해제. 루프는 곧 끝난다. */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    this.queue.length = 0
    this.tracker.killAll('SIGTERM')
    setTimeout(() => this.tracker.killAll('SIGKILL'), 2000).unref()
    for (const w of this.watchers.values()) { try { w.close() } catch {} }
    this.watchers.clear()
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.wake()
  }

  get isStopping() { return this.stopping }

  async loop(): Promise<void> {
    this.timers.push(setInterval(() => this.checkRss(), RSS_CHECK_MS))
    this.timers.push(setInterval(() => { void this.healthCheck() }, this.cfg().healthCheckMs))
    void this.healthCheck()
    while (!this.stopping) {
      try { await this.tick() } catch (e) { this.log.log('error', 'tick 오류', { err: String(e) }) }
      if (this.stopping) break
      await new Promise<void>(res => {
        const t = setTimeout(res, this.interval)
        this.wakeFn = () => { clearTimeout(t); res() }
      })
      this.wakeFn = null
    }
    if (this.jobWorker) await this.jobWorker.catch(() => {})
    if (this.scriptBusy) await this.scriptBusy.catch(() => {})
    this.tracker.killAll('SIGKILL')
  }
}

/** `clipment daemon run` 본체. 종료 코드 반환. */
export async function runDaemon(deps: DaemonDeps = {}): Promise<number> {
  const logger = deps.logger ?? new Logger(logPath(), 5 * 1024 * 1024, !!process.stderr.isTTY)
  const lock = acquireLock(lockPath())
  if (!lock.ok) {
    console.error(`이미 실행 중인 데몬이 있습니다 (pid ${lock.pid}). 종료합니다.`)
    logger.log('info', '중복 실행 시도 — 종료', { other: lock.pid })
    return EXIT_OK
  }
  // launchd 출력 로그가 무한히 커지지 않게
  try { const f = join(clipmentHome(), 'daemon.launchd.log'); if (existsSync(f) && statSync(f).size > 1_000_000) truncateSync(f, 0) } catch {}
  const d = new Daemon({ ...deps, logger })
  logger.log('info', '데몬 시작', { pid: process.pid, autoRun: loadDaemonConfig().autoRun })
  const onSig = (s: string) => () => { logger.log('info', `${s} 수신 — 정리 후 종료`); d.stop() }
  const handlers: [NodeJS.Signals, () => void][] = (['SIGTERM', 'SIGINT', 'SIGHUP'] as const).map(s => [s, onSig(s)])
  for (const [s, h] of handlers) process.on(s, h)
  try { await d.loop() } finally {
    for (const [s, h] of handlers) process.off(s, h)
    lock.release()
    logger.log('info', '데몬 종료', { exitCode: d.exitCode })
  }
  return d.exitCode
}
