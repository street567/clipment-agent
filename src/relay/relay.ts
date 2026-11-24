// stdio 릴레이: Claude 가 세션당 한 번 띄우는 MCP 서버(src/mcp.ts) 앞에 서서, 실제 서버(src/server.ts)를
// 자식 프로세스로 돌리고 새 버전이 생기면 세션을 끊지 않고 자식만 바꿔 끼운다. 줄 단위 JSON-RPC 를 그대로 중계한다.
// node/bun 내장 모듈과 ./lib.ts 만 쓴다 (npm 의존성 없음).
import { spawn, type ChildProcess } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  LineSplitter, addBad, heartbeatPath, pidIsAlive, pruneSessionStates, removeSessionState, selectTarget, updateLockActive, type Target,
} from './lib.ts'

const PRIVATE_INIT_ID = '__clipment_relay_init__'
const MAX_RESTARTS = 5 // RESTART_WINDOW_MS 안에서 허용하는 비정상 종료 횟수
const RESTART_WINDOW_MS = 120_000

export interface RelayOpts {
  bundledDir: string
  bun?: string
  pollMs?: number
  initTimeoutMs?: number
  killGraceMs?: number
  select?: () => Target
  log?: (msg: string) => void
  env?: NodeJS.ProcessEnv
}

interface Kid {
  proc: ChildProcess
  target: Target
  split: LineSplitter
  isClosed: boolean
  retiring: boolean
  closed: Promise<void>
  onLine: (line: string) => void
  onClose: (() => void) | null
  write: (line: string) => void
}

type Mode = 'normal' | 'swapping' | 'restarting'

const key = (id: unknown) => JSON.stringify(id)
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export class Relay {
  private kid: Kid | null = null
  private mode: Mode = 'normal'
  private held: string[] = []
  private clientInit: { msg: any } | null = null
  private initResponded = false
  private clientInitialized = false
  private negotiated: string | null = null
  private inflight = new Map<string, unknown>()
  private serverInflight = new Set<string>()
  private shuttingDown = false
  private crashes: number[] = []
  private failed = new Set<string>()
  /** 새 버전이 있지만 진행 중 요청이 끝나길 기다리는 중 */
  private swapPending = false
  private timer: ReturnType<typeof setInterval> | undefined
  private sessionVersion = ''
  private readonly o: Required<Omit<RelayOpts, 'select' | 'log' | 'env'>> & { select: () => Target; log: (m: string) => void; env: NodeJS.ProcessEnv }

  constructor(o: RelayOpts) {
    const num = (k: string, d: number) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d }
    this.o = {
      bundledDir: o.bundledDir,
      bun: o.bun ?? process.execPath,
      pollMs: o.pollMs ?? num('CLIPMENT_RELAY_POLL_MS', 30_000),
      initTimeoutMs: o.initTimeoutMs ?? num('CLIPMENT_RELAY_INIT_TIMEOUT_MS', 15_000),
      killGraceMs: o.killGraceMs ?? 3000,
      select: o.select ?? (() => selectTarget(o.bundledDir)),
      log: o.log ?? (m => process.stderr.write(`clipment-relay: ${m}\n`)),
      env: o.env ?? process.env,
    }
  }

  // ---------- 시작/종료 ----------

  start(): void {
    pruneSessionStates(pidIsAlive)
    removeSessionState(process.pid) // pid 재사용으로 남은 옛 상태
    const t = this.select()
    this.sessionVersion = t.version
    this.kid = this.spawnKid(t)
    this.kid.onLine = l => this.onKidLine(this.kid!, l)
    this.o.log(`시작: v${t.version} (${t.source}) ${t.dir}`)

    process.stdin.on('data', c => { for (const l of this.clientSplit.push(c)) this.onClientLine(l) })
    process.stdin.on('end', () => void this.shutdown(0))
    process.stdin.on('close', () => void this.shutdown(0))
    process.stdout.on('error', () => void this.shutdown(0))
    for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(s, () => void this.shutdown(0))
    process.on('exit', () => { try { if (this.kid && !this.kid.isClosed) this.kid.proc.kill('SIGKILL') } catch {} })
    this.timer = setInterval(() => this.poll(), this.o.pollMs)
  }
  private clientSplit = new LineSplitter()

  async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    if (this.timer) clearInterval(this.timer)
    const k = this.kid
    if (k && !k.isClosed) {
      k.retiring = true
      try { k.proc.kill('SIGTERM') } catch {}
      await Promise.race([k.closed, sleep(this.o.killGraceMs)])
      if (!k.isClosed) try { k.proc.kill('SIGKILL') } catch {}
    }
    try { rmSync(heartbeatPath(process.pid), { force: true }) } catch {}
    removeSessionState(process.pid)
    process.exit(code)
  }

  // ---------- 대상 선택 ----------

  private select(): Target {
    return this.o.select()
  }

  private poll() {
    if (this.shuttingDown || this.mode !== 'normal' || !this.kid) return
    if (updateLockActive()) return // 데몬이 업데이트를 적용하는 중
    let t: Target
    try { t = this.select() } catch (e) { this.o.log(`대상 선택 실패: ${e}`); return }
    if (t.version === this.kid.target.version || this.failed.has(t.version)) { this.swapPending = false; return }
    void this.swapTo(t).catch(e => { this.o.log(`스왑 오류: ${e}`); if (this.mode !== 'restarting') { this.mode = 'normal'; this.flush() } })
  }

  // ---------- 자식 프로세스 ----------

  private spawnKid(target: Target): Kid {
    const env: NodeJS.ProcessEnv = {
      ...this.o.env,
      CLIPMENT_SESSION_PID: String(process.pid),
      CLIPMENT_SESSION_VERSION: this.sessionVersion || target.version,
    }
    const proc = spawn(this.o.bun, [join(target.dir, 'src/server.ts')], { stdio: ['pipe', 'pipe', 'inherit'], env })
    let resolveClosed!: () => void
    const kid: Kid = {
      proc, target, split: new LineSplitter(), isClosed: false, retiring: false,
      closed: new Promise<void>(r => { resolveClosed = r }),
      onLine: () => {}, onClose: null,
      write: line => { try { if (!kid.isClosed) proc.stdin!.write(line + '\n') } catch {} },
    }
    proc.stdin!.on('error', () => {})
    proc.stdout!.on('data', c => { for (const l of kid.split.push(c)) kid.onLine(l) })
    const done = () => {
      if (kid.isClosed) return
      kid.isClosed = true; resolveClosed()
      kid.onClose?.()
      void this.onKidClosed(kid)
    }
    proc.on('close', done)
    proc.on('error', e => { this.o.log(`자식 실행 실패: ${e.message}`); done() })
    return kid
  }

  // ---------- 클라이언트 → 자식 ----------

  private onClientLine(line: string) {
    if (this.shuttingDown) return
    let msg: any = null
    try { msg = JSON.parse(line) } catch {}
    if (this.mode !== 'normal') {
      if (msg?.method === 'ping' && msg.id !== undefined) return this.toClient({ jsonrpc: '2.0', id: msg.id, result: {} })
      this.held.push(line); return
    }
    this.forward(line, msg)
  }

  private forward(line: string, msg: any) {
    if (msg && typeof msg === 'object') {
      if (msg.method === 'initialize' && msg.id !== undefined) { this.clientInit = { msg }; this.initResponded = false }
      if (msg.method === 'notifications/initialized') this.clientInitialized = true
      if (msg.method && msg.id !== undefined) this.inflight.set(key(msg.id), msg.id)
      if (msg.method === 'notifications/cancelled' && msg.params && 'requestId' in msg.params) this.inflight.delete(key(msg.params.requestId))
      if (!msg.method && msg.id !== undefined) this.serverInflight.delete(key(msg.id))
    }
    this.kid?.write(line)
    // 취소로 진행 중 요청이 비었을 수 있다
    if (this.swapPending && this.isIdle()) setTimeout(() => this.poll(), 0)
  }

  private flush() {
    const h = this.held; this.held = []
    for (const l of h) this.onClientLine(l)
  }

  // ---------- 자식 → 클라이언트 ----------

  private toClient(obj: unknown) { this.writeOut(JSON.stringify(obj)) }
  private writeOut(line: string) {
    try { process.stdout.write(line + '\n') } catch {}
  }

  private onKidLine(_kid: Kid, line: string) {
    let msg: any = null
    try { msg = JSON.parse(line) } catch {}
    if (msg && typeof msg === 'object') {
      if (!msg.method && msg.id !== undefined) {
        this.inflight.delete(key(msg.id))
        if (this.clientInit && key(msg.id) === key(this.clientInit.msg.id) && msg.result) {
          this.initResponded = true
          if (typeof msg.result.protocolVersion === 'string') this.negotiated = msg.result.protocolVersion
        }
      } else if (msg.method && msg.id !== undefined) this.serverInflight.add(key(msg.id))
    }
    this.writeOut(line)
    // 롱폴(wait_for_requests)이 이어지는 세션도 호출 사이의 빈 틈을 놓치지 않게, 응답이 나가는 즉시 교체를 시도한다
    if (this.swapPending && this.isIdle()) this.poll()
  }

  // ---------- 핸드셰이크 ----------

  /** 새 자식에 initialize 를 다시 보내 응답을 확인한다. privateId=true 면 응답을 삼키고(클라이언트에 안 보냄), 아니면 원래 id 로 보내 응답을 전달한다. */
  private handshake(kid: Kid, privateId: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const init = this.clientInit!.msg
      const id = privateId ? PRIVATE_INIT_ID : init.id
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true; clearTimeout(t); kid.onClose = null
        if (err) reject(err); else resolve()
      }
      const t = setTimeout(() => finish(new Error(`initialize 응답 시간 초과 (${this.o.initTimeoutMs}ms)`)), this.o.initTimeoutMs)
      kid.onClose = () => finish(new Error('핸드셰이크 중 자식이 종료됐습니다'))
      kid.onLine = line => {
        let m: any; try { m = JSON.parse(line) } catch { return }
        if (!m || m.method || m.id !== id) return
        if (m.error) return finish(new Error(`initialize 오류: ${JSON.stringify(m.error).slice(0, 200)}`))
        const pv = m.result?.protocolVersion
        if (this.negotiated !== null && pv !== this.negotiated) return finish(new Error(`protocolVersion 불일치: ${pv} != ${this.negotiated}`))
        if (!privateId) { this.initResponded = true; this.negotiated = pv ?? this.negotiated; this.inflight.delete(key(id)); this.writeOut(line) }
        finish()
      }
      kid.write(JSON.stringify({ ...init, id }))
    })
  }

  // ---------- 스왑 ----------

  private isIdle() { return this.inflight.size === 0 && this.serverInflight.size === 0 }

  private async swapTo(target: Target): Promise<void> {
    if (!this.clientInit || !this.clientInitialized || this.negotiated === null || !this.kid) return // 아직 핸드셰이크 전
    // 진행 중 요청이 있으면 막지 않고 기다린다 (긴 wait_for_requests 동안 다른 호출이 멈추면 안 됨)
    this.swapPending = !this.isIdle()
    if (this.swapPending) return
    const old = this.kid
    if (old.isClosed) return
    this.mode = 'swapping'
    const fresh = this.spawnKid(target)
    try {
      await this.handshake(fresh, true)
    } catch (e: any) {
      this.o.log(`새 버전 v${target.version} 시작 실패 — 기존 v${old.target.version} 유지: ${e?.message ?? e}`)
      this.failed.add(target.version)
      if (target.source === 'managed') addBad(target.version, String(e?.message ?? e))
      fresh.retiring = true
      try { fresh.proc.kill('SIGKILL') } catch {}
      this.mode = 'normal'
      if (old.isClosed) { void this.onKidClosed(old); return } // 핸드셰이크 사이 옛 자식이 죽었다
      this.flush()
      return
    }
    // 새 자식은 initialize 까지만 끝낸 상태(채널 루프 미시작). 옛 자식을 먼저 내려 푸시를 멈추고 상태를 넘겨받게 한 뒤 initialized 를 보낸다.
    await this.retire(old)
    fresh.onLine = l => this.onKidLine(fresh, l)
    fresh.onClose = null
    fresh.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    this.kid = fresh
    this.o.log(`스왑 완료: v${old.target.version} -> v${target.version} (${target.source})`)
    this.mode = 'normal'
    if (fresh.isClosed) { void this.onKidClosed(fresh); return }
    this.flush()
    this.toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }

  /** SIGUSR2: 서버가 푸시를 멈추고 진행 중 푸시를 마치고 상태 파일을 쓰고 스스로 종료. 출력이 끝까지 중계되도록 close 를 기다린다. */
  private async retire(k: Kid): Promise<void> {
    k.retiring = true
    if (k.isClosed) return
    try { k.proc.kill('SIGUSR2') } catch {}
    await Promise.race([k.closed, sleep(this.o.killGraceMs + 2000)])
    if (!k.isClosed) { try { k.proc.kill('SIGKILL') } catch {} await Promise.race([k.closed, sleep(1000)]) }
  }

  // ---------- 비정상 종료 ----------

  private async onKidClosed(kid: Kid): Promise<void> {
    if (this.shuttingDown || kid.retiring || kid !== this.kid) return
    if (this.mode === 'swapping') return // 스왑 경로가 처리
    this.o.log(`서버(v${kid.target.version}) 종료 감지 — 재시작합니다`)
    await this.restart(kid)
  }

  private errorOutInflight(except?: unknown) {
    for (const [k, id] of this.inflight) {
      if (except !== undefined && k === key(except)) continue
      this.toClient({ jsonrpc: '2.0', id, error: { code: -32603, message: 'clipment 서버가 예기치 않게 종료되어 요청을 마치지 못했습니다 (자동 재시작 중). 잠시 후 다시 시도하세요.' } })
    }
    this.inflight.clear(); this.serverInflight.clear()
  }

  private async restart(dead: Kid): Promise<void> {
    this.mode = 'restarting'
    // initialize 응답을 기다리던 중 죽었다면 원래 id 로 다시 보내 응답을 전달한다
    const initPending = !!this.clientInit && !this.initResponded && this.inflight.has(key(this.clientInit.msg.id))
    this.errorOutInflight(initPending ? this.clientInit!.msg.id : undefined)
    let last = dead
    for (;;) {
      const now = Date.now()
      this.crashes = this.crashes.filter(t => now - t < RESTART_WINDOW_MS)
      this.crashes.push(now)
      if (this.crashes.length > MAX_RESTARTS) {
        this.o.log(`${RESTART_WINDOW_MS / 1000}초 안에 ${MAX_RESTARTS}회 넘게 종료돼 포기합니다`)
        if (initPending) this.errorOutInflight()
        return void this.shutdown(1)
      }
      await sleep(Math.min(8000, 250 * 2 ** (this.crashes.length - 1)))
      if (this.shuttingDown) return
      let target: Target
      try { target = this.select() } catch { target = selectTarget(this.o.bundledDir, { autoUpdate: false }) }
      // 같은 관리형 버전이 두 번 이상 죽으면 나쁜 버전으로 기록하고 번들로 되돌아간다
      if (this.crashes.length >= 2 && last.target.source === 'managed' && target.source === 'managed' && target.version === last.target.version) {
        addBad(target.version, '반복 비정상 종료'); this.failed.add(target.version)
        target = selectTarget(this.o.bundledDir, { autoUpdate: false })
        this.o.log(`v${last.target.version} 반복 종료 — 나쁜 버전으로 기록, 번들 v${target.version} 로 복귀`)
      }
      const kid = this.spawnKid(target)
      last = kid
      try {
        if (this.clientInit) {
          await this.handshake(kid, !initPending)
          if (this.clientInitialized) kid.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
        }
      } catch (e: any) {
        this.o.log(`재시작 핸드셰이크 실패: ${e?.message ?? e}`)
        kid.retiring = true; try { kid.proc.kill('SIGKILL') } catch {}
        continue
      }
      kid.onLine = l => this.onKidLine(kid, l)
      kid.onClose = null
      this.kid = kid
      this.o.log(`재시작 완료: v${target.version} (${target.source})`)
      this.mode = 'normal'
      if (kid.isClosed) return void this.onKidClosed(kid)
      this.flush()
      if (this.clientInitialized) this.toClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      return
    }
  }
}

export function startRelay(o: RelayOpts): Relay {
  const r = new Relay(o)
  r.start()
  return r
}
