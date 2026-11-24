import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cmpVersion, selectTarget } from '../src/relay/lib.ts'
import { RpcSession, alive, logLines, mkBundled, mkFake, pidsFromLog, sandbox, setVersion, sleep, tmp, type Sandbox } from './relay-helpers.ts'

const open: RpcSession[] = []
async function start(sb: Sandbox, bundledVersion = '0.4.0', fake: Record<string, unknown> = {}) {
  const b = join(sb.base, 'bundled')
  mkBundled(b, bundledVersion, fake)
  const s = new RpcSession(join(b, 'src/mcp.ts'), sb.env)
  open.push(s)
  return s
}
afterEach(async () => { for (const s of open.splice(0)) { await s.close(); if (!s.exited) s.proc.kill('SIGKILL') } })
const badList = (sb: Sandbox) => { try { return JSON.parse(readFileSync(join(sb.home, 'bad-versions.json'), 'utf8')) } catch { return {} } }

describe('selectTarget (대상 선택)', () => {
  test('버전 비교', () => {
    expect(cmpVersion('0.4.1', '0.4.0')).toBe(1)
    expect(cmpVersion('0.10.0', '0.9.9')).toBe(1)
    expect(cmpVersion('1.0.0', '1.0.0')).toBe(0)
    expect(cmpVersion('0.4.0-rc1', '0.4.0')).toBeNull()
  })
  test('autoUpdate 꺼짐/없음/이름·major·버전·나쁜 목록/server.ts 없음 → 번들, 조건 맞으면 관리형', () => {
    const base = tmp(), b = join(base, 'b'), m = join(base, 'm')
    mkFake(b, '0.4.0'); mkFake(m, '0.4.1')
    expect(selectTarget(b, { autoUpdate: false, managed: m }).source).toBe('bundled')
    expect(selectTarget(b, { autoUpdate: true, managed: m })).toEqual({ dir: m, version: '0.4.1', source: 'managed' })
    expect(selectTarget(b, { autoUpdate: true, managed: join(base, 'none') }).source).toBe('bundled')
    mkFake(m, '0.4.0'); expect(selectTarget(b, { autoUpdate: true, managed: m }).source).toBe('managed') // 같은 버전은 허용(>=)
    mkFake(m, '0.3.9'); expect(selectTarget(b, { autoUpdate: true, managed: m }).source).toBe('bundled')
    mkFake(m, '1.0.0'); expect(selectTarget(b, { autoUpdate: true, managed: m }).source).toBe('bundled') // major 다름
    mkFake(m, '0.5.0', {}, 'other-pkg'); expect(selectTarget(b, { autoUpdate: true, managed: m }).source).toBe('bundled')
    mkFake(m, '0.5.0'); expect(selectTarget(b, { autoUpdate: true, managed: m, bad: v => v === '0.5.0' }).source).toBe('bundled')
  })
})

describe('릴레이 (실제 stdio 프로세스)', () => {
  test('패스스루: initialize/tools/call, 자식에는 세션 환경변수', async () => {
    const sb = sandbox(false)
    const s = await start(sb)
    const init = await s.init()
    expect(init.result.serverInfo.version).toBe('0.4.0')
    expect(await s.tools()).toEqual(['echo', 'tool_v0.4.0'])
    expect(await s.call('echo')).toContain('v0.4.0')
    expect(logLines(sb)[0]).toContain(`session=${s.pid}/0.4.0`)
  })

  test('autoUpdate 꺼짐 = 관리형이 더 새로워도 번들만 쓰고 스왑 안 함', async () => {
    const sb = sandbox(false)
    mkFake(sb.managed, '0.4.5')
    const s = await start(sb)
    await s.init()
    await sleep(700)
    expect(await s.call('echo')).toContain('v0.4.0')
    expect(s.count('notifications/tools/list_changed')).toBe(0)
    expect(pidsFromLog(sb).map(p => p.version)).toEqual(['0.4.0'])
  })

  test('autoUpdate 켜짐 + 관리형이 더 새로우면 처음부터 관리형', async () => {
    const sb = sandbox(true)
    mkFake(sb.managed, '0.4.2')
    const s = await start(sb)
    expect((await s.init()).result.serverInfo.version).toBe('0.4.2')
  })

  test('세션 도중 스왑: 새 도구가 tools/list 에 보이고 list_changed 가 가며 옛 자식은 SIGUSR2 로 내려감', async () => {
    const sb = sandbox(true)
    const s = await start(sb)
    await s.init()
    expect(await s.tools()).toContain('tool_v0.4.0')
    mkFake(sb.managed, '0.4.1')
    await s.until(() => s.count('notifications/tools/list_changed') === 1, 8000, 'list_changed')
    const tools = await s.tools()
    expect(tools).toContain('tool_v0.4.1')
    expect(tools).not.toContain('tool_v0.4.0')
    expect(await s.call('tool_v0.4.1')).toContain('v0.4.1')
    const log = logLines(sb)
    expect(log).toContain('sigusr2 v0.4.0')
    // 새 자식은 initialize 후 initialized 를 받았고, 그 전에 옛 자식이 내려갔다
    const iSig = log.indexOf('sigusr2 v0.4.0'), iInit = log.indexOf('msg v0.4.1 notifications/initialized')
    expect(iSig).toBeGreaterThan(-1); expect(iInit).toBeGreaterThan(iSig)
    // 새 자식 환경: 세션 pid/시작 버전 유지
    expect(log.find(l => l.startsWith('start v0.4.1'))).toContain(`session=${s.pid}/0.4.0`)
    expect(s.msgs.filter(m => m.id === '__clipment_relay_init__')).toEqual([]) // 사설 initialize 응답은 삼킴
  })

  test('긴 호출이 도는 동안에도 다른 호출은 막히지 않고, 다 끝난 뒤 스왑된다', async () => {
    const sb = sandbox(true)
    const s = await start(sb)
    await s.init()
    const slow = s.call('echo', { sleepMs: 2500 }, 10000)
    await sleep(100)
    mkFake(sb.managed, '0.4.1')
    await sleep(600) // 릴레이가 새 버전을 알아챔
    const t0 = Date.now()
    expect(await s.call('echo')).toContain('v0.4.0')
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(await slow).toContain('v0.4.0')
    await s.until(() => s.count('notifications/tools/list_changed') === 1, 8000, 'list_changed')
    expect(await s.call('echo')).toContain('v0.4.1')
  })
  test('진행 중 호출은 옛 자식에서 끝나고, 그 뒤에 스왑된다', async () => {
    const sb = sandbox(true)
    const s = await start(sb)
    await s.init()
    const slow = s.call('echo', { sleepMs: 1500 }, 10000)
    await sleep(100)
    mkFake(sb.managed, '0.4.1')
    expect(await slow).toContain('v0.4.0')
    await s.until(() => s.count('notifications/tools/list_changed') === 1, 8000, 'list_changed')
    expect(await s.call('echo')).toContain('v0.4.1')
  })

  test('스왑 중 보낸 요청은 버퍼링돼 새 자식이 답하고, ping 은 즉시 답한다', async () => {
    const sb = sandbox(true)
    const s = await start(sb)
    await s.init()
    mkFake(sb.managed, '0.4.1', { initDelayMs: 1200 })
    await s.until(() => logLines(sb).some(l => l.startsWith('start v0.4.1')), 5000, '새 자식 시작')
    const t0 = Date.now()
    const ping = await s.request('ping', undefined, 800) // 핸드셰이크 중이어도 릴레이가 직접 답한다
    expect(Date.now() - t0).toBeLessThan(800)
    expect(ping.result).toEqual({})
    const answer = await s.call('echo', {}, 8000) // 스왑이 끝난 뒤 새 자식이 답
    expect(answer).toContain('v0.4.1')
  })

  test('새 버전이 실패(initialize 오류)하면 기존 유지 + 나쁜 버전 기록, 타임아웃도 마찬가지', async () => {
    const sb = sandbox(true)
    const s = await start(sb)
    await s.init()
    mkFake(sb.managed, '0.4.1', { failInit: true })
    await s.until(() => badList(sb)['0.4.1'], 6000, '나쁜 버전 기록')
    expect(await s.call('echo')).toContain('v0.4.0')
    expect(s.count('notifications/tools/list_changed')).toBe(0)
    expect(s.stderr).toContain('새 버전 v0.4.1 시작 실패')
    // 타임아웃
    mkFake(sb.managed, '0.4.2', { hangInit: true })
    await s.until(() => badList(sb)['0.4.2'], 8000, '타임아웃 나쁜 버전')
    expect(await s.call('echo')).toContain('v0.4.0')
    // 나쁜 목록은 영속 → 새 세션도 그 버전은 안 고른다
    mkFake(sb.managed, '0.4.1')
    const s2 = await start(sandboxSame(sb))
    expect((await s2.init()).result.serverInfo.version).toBe('0.4.0')
  }, 30000)

  test('protocolVersion 이 다르면 거부', async () => {
    const sb = sandbox(true)
    const s = await start(sb)
    await s.init()
    mkFake(sb.managed, '0.4.1', { protocolVersion: '1999-01-01' })
    await s.until(() => badList(sb)['0.4.1'], 6000, '나쁜 버전')
    expect(await s.call('echo')).toContain('v0.4.0')
  })

  test('자식이 죽으면 진행 중 요청에 오류를 돌려주고 재시작, 세션은 계속', async () => {
    const sb = sandbox(false)
    const s = await start(sb)
    await s.init()
    const r = await s.request('tools/call', { name: 'crash', arguments: {} })
    expect(r.error.message).toContain('예기치 않게 종료')
    expect(await s.call('echo', {}, 8000)).toContain('v0.4.0') // 재시작 뒤 버퍼된 요청 처리
    expect(pidsFromLog(sb).length).toBe(2)
    await s.until(() => s.count('notifications/tools/list_changed') >= 1, 3000, 'list_changed')
  })

  test('관리형 버전이 반복해서 죽으면 나쁜 버전으로 기록하고 번들로 복귀', async () => {
    const sb = sandbox(true)
    mkFake(sb.managed, '0.4.1', { dieAfterInitMs: 100 })
    const s = await start(sb)
    await s.init()
    await s.until(() => badList(sb)['0.4.1'], 10000, '나쁜 버전 기록')
    await s.until(() => pidsFromLog(sb).some(p => p.version === '0.4.0'), 10000, '번들 복귀')
    expect(await s.call('echo', {}, 8000)).toContain('v0.4.0')
  }, 30000)

  test('stdin 이 닫히면 자식을 내리고 종료 (고아 없음)', async () => {
    const sb = sandbox(false)
    const s = await start(sb)
    await s.init()
    const child = pidsFromLog(sb)[0]!.pid
    expect(alive(child)).toBe(true)
    s.proc.stdin!.end()
    await s.until(() => s.exited, 6000, '릴레이 종료')
    await sleep(200)
    expect(alive(child)).toBe(false)
  })

  test('릴레이가 SIGKILL 로 죽어도 자식은 stdin EOF 로 스스로 종료', async () => {
    const sb = sandbox(false)
    const s = await start(sb)
    await s.init()
    const child = pidsFromLog(sb)[0]!.pid
    s.proc.kill('SIGKILL')
    for (let i = 0; i < 40 && alive(child); i++) await sleep(100)
    expect(alive(child)).toBe(false)
  })

  test('SIGTERM → 자식 종료 + 하트비트/상태 파일 정리', async () => {
    const sb = sandbox(false)
    const s = await start(sb)
    await s.init()
    const child = pidsFromLog(sb)[0]!.pid
    s.proc.kill('SIGTERM')
    await s.until(() => s.exited, 6000, '종료')
    await sleep(200)
    expect(alive(child)).toBe(false)
    expect(existsSync(join(sb.home, 'relay', `${s.pid}.json`))).toBe(false)
  })
})

/** 같은 홈/설정을 쓰는 새 샌드박스(번들 폴더만 새로) */
function sandboxSame(sb: Sandbox): Sandbox {
  const base = tmp()
  return { ...sb, base }
}
