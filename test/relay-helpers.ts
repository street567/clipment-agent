import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const REPO = join(import.meta.dir, '..')
export const BUN = process.execPath
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const tmp = (p = 'clipment-relay-') => mkdtempSync(join(tmpdir(), p))

/** <dir> 를 가짜 서버 에이전트 폴더로 만든다 (src/server.ts + package.json) */
export function mkFake(dir: string, version: string, fake: Record<string, unknown> = {}, name = 'clipment-agent') {
  mkdirSync(join(dir, 'src'), { recursive: true })
  copyFileSync(join(import.meta.dir, 'fixtures/fake-server.ts'), join(dir, 'src/server.ts'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, fake }))
}
/** 릴레이(mcp.ts + relay/)까지 복사한 번들 폴더 (번들 = 이 폴더) */
export function mkBundled(dir: string, version: string, fake: Record<string, unknown> = {}) {
  mkFake(dir, version, fake)
  copyFileSync(join(REPO, 'src/mcp.ts'), join(dir, 'src/mcp.ts'))
  cpSync(join(REPO, 'src/relay'), join(dir, 'src/relay'), { recursive: true })
}
/** 진짜 server.ts 를 쓰는 폴더: src 전체 복사 + node_modules 심볼릭 링크 + 버전만 바꾼 package.json */
export function mkReal(dir: string, version: string) {
  mkdirSync(dir, { recursive: true })
  cpSync(join(REPO, 'src'), join(dir, 'src'), { recursive: true })
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ ...pkg, version }))
  if (!existsSync(join(dir, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'))
}
export function setVersion(dir: string, version: string) {
  const p = join(dir, 'package.json')
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), version }))
}

export interface Sandbox { base: string; home: string; cfg: string; managed: string; log: string; env: Record<string, string> }
export function sandbox(autoUpdate: boolean, extra: Record<string, string> = {}): Sandbox {
  const base = tmp()
  const home = join(base, 'home'), cfg = join(base, 'daemon.json'), managed = join(base, 'agent'), log = join(base, 'fake.log')
  mkdirSync(home, { recursive: true })
  writeFileSync(cfg, JSON.stringify({ autoUpdate }))
  writeFileSync(log, '')
  return {
    base, home, cfg, managed, log,
    env: {
      CLIPMENT_HOME: home, CLIPMENT_DAEMON_CONFIG: cfg, CLIPMENT_DIR: managed, FAKE_LOG: log,
      CLIPMENT_RELAY_POLL_MS: '150', CLIPMENT_RELAY_INIT_TIMEOUT_MS: '2000', CLIPREV_ROOT: join(base, 'ws'), CLIPREV_CONFIG: join(base, 'cliprev.json'),
      ...extra,
    },
  }
}
export const logLines = (sb: Sandbox) => readFileSync(sb.log, 'utf8').split('\n').filter(Boolean)

/** 줄 단위 JSON-RPC 클라이언트 (진짜 stdio) */
export class RpcSession {
  proc: ChildProcess
  msgs: any[] = []
  stderr = ''
  private nextId = 1
  private waiters: (() => void)[] = []
  exited = false
  constructor(script: string, env: Record<string, string>) {
    this.proc = spawn(BUN, [script], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
    let buf = ''
    this.proc.stdout!.on('data', d => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line.trim()) { try { this.msgs.push(JSON.parse(line)) } catch { this.msgs.push({ raw: line }) } }
      }
      this.waiters.splice(0).forEach(w => w())
    })
    this.proc.stderr!.on('data', d => { this.stderr += d })
    this.proc.on('exit', () => { this.exited = true; this.waiters.splice(0).forEach(w => w()) })
  }
  get pid() { return this.proc.pid! }
  send(o: unknown) { this.proc.stdin!.write(JSON.stringify(o) + '\n') }
  async until<T>(f: () => T | undefined | false, ms = 8000, what = '조건'): Promise<T> {
    const end = Date.now() + ms
    for (;;) {
      const v = f()
      if (v) return v as T
      if (Date.now() > end) throw new Error(`시간 초과: ${what}\nmsgs=${JSON.stringify(this.msgs).slice(0, 800)}\nstderr=${this.stderr.slice(-600)}`)
      await new Promise<void>(r => { this.waiters.push(r); setTimeout(r, 50) })
    }
  }
  async request(method: string, params?: unknown, ms = 8000): Promise<any> {
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    return this.until(() => this.msgs.find(m => m.id === id && !m.method), ms, `응답 ${method}`)
  }
  notify(method: string, params?: unknown) { this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) }
  async init() {
    const r = await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    this.notify('notifications/initialized')
    return r
  }
  async tools(): Promise<string[]> { return (await this.request('tools/list')).result.tools.map((t: any) => t.name) }
  async call(name: string, args: Record<string, unknown> = {}, ms = 8000): Promise<string> {
    return (await this.request('tools/call', { name, arguments: args }, ms)).result.content[0].text
  }
  count(method: string) { return this.msgs.filter(m => m.method === method).length }
  async close() {
    if (this.exited) return
    try { this.proc.stdin!.end() } catch {}
    await Promise.race([new Promise<void>(r => this.proc.once('exit', () => r())), sleep(4000)])
    if (!this.exited) this.proc.kill('SIGKILL')
  }
}
export const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
export const pidsFromLog = (sb: Sandbox) => logLines(sb).map(l => /^start v(\S+) pid=(\d+)/.exec(l)).filter(Boolean).map(m => ({ version: m![1]!, pid: Number(m![2]) }))
