import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { initProject } from '../src/core/index.ts'
import { appWrite, iso, uid } from './helpers.ts'
import { RpcSession, alive, mkReal, sandbox, sleep, tmp, type Sandbox } from './relay-helpers.ts'

// 진짜 server.ts 로 채널 푸시를 스왑 전후에 검증: 중복 없음, 누락 없음, 상태 인수인계, 지침(guide) 첨부, 하트비트 버전

const open: RpcSession[] = []
const savedEnv = { ...process.env }
afterEach(async () => { for (const s of open.splice(0)) await s.close(); process.env = { ...savedEnv } })

function channel(sb: Sandbox) {
  const bundled = join(sb.base, 'bundled')
  mkReal(bundled, '0.4.0')
  const s = new RpcSession(join(bundled, 'src/mcp.ts'), { ...sb.env, CLIPREV_CHANNEL: '1', CLIPREV_AGENT: 'claude' })
  open.push(s)
  return s
}
const pushes = (s: RpcSession) => s.msgs.filter(m => m.method === 'notifications/claude/channel')
const idsOf = (s: RpcSession) => pushes(s).filter(m => m.params.meta.requestId).map(m => m.params.meta.requestId as string)

describe('채널 푸시 + 스왑 (실제 server.ts)', () => {
  test('스왑 전후 요청이 정확히 한 번씩 푸시되고, 스왑 뒤 첫 푸시에 지침이 붙는다', async () => {
    const sb = sandbox(true)
    const root = join(sb.base, 'ws'); mkdirSync(root, { recursive: true })
    process.env.CLIPREV_ROOT = root; process.env.CLIPREV_CONFIG = join(sb.base, 'cfg.json'); process.env.CLIPMENT_HOME = sb.home
    await initProject('demo')
    const s = channel(sb)
    expect((await s.init()).result.serverInfo.version).toBe('0.4.0')
    expect(s.msgs.find(m => m.result?.capabilities)?.result.capabilities.experimental?.['claude/channel']).toBeDefined()

    const a = uid(); appWrite(root, 'demo', `requests/${a}.json`, { schema: 1, type: 'apply_feedback', version: 1, commentIds: null, agent: 'claude', created: iso() })
    await s.until(() => idsOf(s).includes(a), 8000, 'A 푸시')
    // 하트비트: 릴레이 pid 로 기록, 서버 버전 표기
    const hb = () => JSON.parse(readFileSync(join(sb.home, 'sessions', `${s.pid}.json`), 'utf8'))
    expect(hb().version).toBe('0.4.0'); expect(hb().sessionVersion).toBe('0.4.0')
    const hbStarted = hb().startedAt

    mkReal(sb.managed, '0.4.1')
    const b = uid(); appWrite(root, 'demo', `requests/${b}.json`, { schema: 1, type: 'apply_feedback', version: 2, commentIds: null, agent: 'claude', created: iso() }) // 스왑 시점 근처에 도착
    await s.until(() => s.count('notifications/tools/list_changed') === 1, 15000, 'list_changed')
    await s.until(() => idsOf(s).includes(b), 8000, 'B 푸시')
    const c = uid(); appWrite(root, 'demo', `requests/${c}.json`, { schema: 1, type: 'apply_feedback', version: 3, commentIds: null, agent: 'claude', created: iso() })
    await s.until(() => idsOf(s).includes(c), 8000, 'C 푸시')
    await sleep(2500) // 새 서버가 A/B 를 다시 푸시하지 않는지 지켜본다

    const ids = idsOf(s)
    expect(ids.sort()).toEqual([a, b, c].sort()) // 중복도 누락도 없음
    // 지침은 스왑 뒤 첫 푸시에만 한 번
    const withGuide = pushes(s).filter(m => String(m.params.content).includes('최신 지침'))
    expect(withGuide.length).toBe(1)
    expect(withGuide[0].params.content).toContain('0.4.0 -> 0.4.1')
    // 서버는 새 버전, 세션 시작 버전은 그대로 → wait_for_requests 에 guide
    expect(hb().version).toBe('0.4.1'); expect(hb().sessionVersion).toBe('0.4.0'); expect(hb().startedAt).toBe(hbStarted)
    const w = JSON.parse((await s.request('tools/call', { name: 'wait_for_requests', arguments: { timeout_sec: 0 } })).result.content[0].text)
    expect(w.guide).toContain('0.4.0 -> 0.4.1')
    // 상태 파일은 릴레이 pid 키
    expect(existsSync(join(sb.home, 'relay', `${s.pid}.json`))).toBe(true)
    // 종료하면 정리
    const kids = (await Bun.$`pgrep -P ${s.pid}`.nothrow().text()).split('\n').filter(Boolean).map(Number)
    s.proc.stdin!.end()
    await s.until(() => s.exited, 8000, '종료')
    await sleep(300)
    for (const k of kids) expect(alive(k)).toBe(false)
    expect(existsSync(join(sb.home, 'relay', `${s.pid}.json`))).toBe(false)
    expect(existsSync(join(sb.home, 'sessions', `${s.pid}.json`))).toBe(false)
  }, 60000)

  test('릴레이가 SIGKILL 되면 진짜 server.ts 도 스스로 종료', async () => {
    const sb = sandbox(false)
    const s = channel(sb)
    await s.init()
    await sleep(300)
    const kids = (await Bun.$`pgrep -P ${s.pid}`.nothrow().text()).split('\n').filter(Boolean).map(Number)
    expect(kids.length).toBe(1)
    s.proc.kill('SIGKILL')
    for (let i = 0; i < 50 && alive(kids[0]!); i++) await sleep(100)
    expect(alive(kids[0]!)).toBe(false)
  })
})
void tmp
