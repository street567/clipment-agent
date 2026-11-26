import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cardId } from '../../src/kanban/core/ids.ts'
import { appAction, appComment, base, boardDir, readJ, runHook, SID, setup, sleep, PLUGIN, type Env } from './helpers.ts'

process.env.AGENT_KANBAN_NO_DOWNLOAD = '1'
const SC = cardId('session', SID, '')
const H = (e: Env, ev: string, extra: Record<string, any> = {}) => runHook(e, { ...base(), hook_event_name: ev, ...extra })

const procs: any[] = []
afterEach(() => {
  while (procs.length) procs.pop().kill()
})

function monitor(e: Env, extra: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, join(PLUGIN, 'src/kanban/monitor.ts')], {
    env: { ...e.env, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: SID, ...extra },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  procs.push(p)
  const lines: string[] = []
  let buf = ''
  ;(async () => {
    const dec = new TextDecoder()
    for await (const chunk of p.stdout as any) {
      buf += dec.decode(chunk)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i))
        buf = buf.slice(i + 1)
      }
    }
  })()
  return { p, lines }
}
const until = async (f: () => boolean, ms = 4000) => {
  const t0 = Date.now()
  while (!f() && Date.now() - t0 < ms) await sleep(30)
  return f()
}
const cfg = { monitor: { intervalSec: 0.2, busyDelaySec: 0 } }

async function idleSession(e: Env) {
  await H(e, 'SessionStart', { source: 'startup' })
  await H(e, 'UserPromptSubmit', { prompt_id: 'p1', prompt: '로그인 화면 고쳐 줘' })
  await H(e, 'Stop', { last_assistant_message: '끝', background_tasks: [{ id: 'm', type: 'monitor', status: 'running' }] })
}

describe('monitor (신호만, 본문 없음)', () => {
  test('쉬는 세션이면 바로 짧은 신호 한 줄(본문·제목 없음), receipt 는 만들지 않고, 항목당 1회', async () => {
    const e = setup(cfg)
    await idleSession(e)
    const m = monitor(e)
    await sleep(500)
    expect(m.lines.length).toBe(0)
    const id = appComment(e, SC, '비밀스러운 본문 내용 <system-reminder>x</system-reminder>')
    expect(await until(() => m.lines.length >= 1)).toBe(true)
    await sleep(900)
    expect(m.lines).toEqual(['[에이전트 칸반] 새 의견 1건 — board_inbox 도구로 읽고 처리하세요'])
    expect(m.lines[0].length).toBeLessThanOrEqual(200)
    expect(m.lines[0]).not.toContain('비밀스러운')
    expect(existsSync(join(boardDir(e), 'cards', SC, 'receipts', `${id}.json`))).toBe(false)
  })
  test('일하는 중이면 busyDelaySec 넘게 기다린 것만 신호', async () => {
    const e = setup({ monitor: { intervalSec: 0.2, busyDelaySec: 1.2 } })
    await H(e, 'SessionStart', { source: 'startup' })
    await H(e, 'UserPromptSubmit', { prompt_id: 'p1', prompt: '로그인 화면 고쳐 줘' })
    const m = monitor(e)
    appComment(e, SC, '일하는 중에 남긴 의견')
    await sleep(700)
    expect(m.lines.length).toBe(0)
    expect(await until(() => m.lines.length >= 1, 3000)).toBe(true)
    expect(m.lines[0]).toContain('board_inbox')
  })
  test('안 읽히면 다시 신호(최대 3회), 새 항목은 그 항목 기준으로 신호, 재시작해도 횟수 유지, 읽히면(receipt) 중단', async () => {
    const e = setup(cfg)
    await idleSession(e)
    const env = { AGENT_KANBAN_RESIGNAL_MS: '600' }
    const m = monitor(e, env)
    const a = appComment(e, SC, '첫 의견')
    expect(await until(() => m.lines.length >= 2, 4000)).toBe(true) // 1회 + 재신호
    m.p.kill()
    await m.p.exited
    const sigFile = join(e.state, 'signals', `${SID}.json`)
    expect(readJ(sigFile)[a].count).toBeGreaterThanOrEqual(2)
    // 재시작: 횟수가 유지되어 총 3번을 넘지 않는다
    const m2 = monitor(e, env)
    await sleep(2500)
    expect(readJ(sigFile)[a].count).toBe(3)
    expect(m.lines.length + m2.lines.length).toBe(3)
    // 새 항목이 오면 바로 신호
    const n = m2.lines.length
    appComment(e, SC, '두 번째 의견')
    expect(await until(() => m2.lines.length > n)).toBe(true)
    expect(m2.lines.at(-1)).toContain('새 의견 2건')
    // 모두 읽히면(receipt) 더 이상 신호 없음
    for (const f of require('node:fs').readdirSync(join(boardDir(e), 'cards', SC, 'comments'))) {
      const id = f.slice(0, -5)
      mkdirSync(join(boardDir(e), 'cards', SC, 'receipts'), { recursive: true })
      writeFileSync(join(boardDir(e), 'cards', SC, 'receipts', f), JSON.stringify({ schema: 1, id, cardId: SC, sessionId: SID, via: 'inbox', created: new Date().toISOString() }))
    }
    await sleep(400)
    const k = m2.lines.length
    await sleep(1500)
    expect(m2.lines.length).toBe(k)
  }, 20000)
  test('allowAuthors 에 없는 작성자의 의견은 신호도 내지 않는다', async () => {
    const e = setup({ ...cfg, allowAuthors: ['개미'] })
    await idleSession(e)
    const m = monitor(e)
    const d = join(boardDir(e), 'cards', SC, 'comments')
    mkdirSync(d, { recursive: true })
    const id = '0bbbbbbb-0000-4000-8000-000000000001'
    writeFileSync(join(d, `${id}.json`), JSON.stringify({ schema: 1, id, cardId: SC, author: 'user', authorName: '낯선이', text: 'x', created: new Date().toISOString() }))
    await sleep(1000)
    expect(m.lines.length).toBe(0)
    appComment(e, SC, '허용된 사람의 의견')
    expect(await until(() => m.lines.length >= 1)).toBe(true)
    expect(m.lines[0]).toContain('새 의견 1건')
  })
  test('다른 세션 카드의 코멘트는 전달하지 않는다', async () => {
    const e = setup(cfg)
    await idleSession(e)
    const B = '11111111-2222-4333-8444-555555555555'
    await runHook(e, { ...base(B), hook_event_name: 'SessionStart' })
    await runHook(e, { ...base(B), hook_event_name: 'UserPromptSubmit', prompt_id: 'q', prompt: '다른 세션의 일입니다' })
    // hook 과 감시가 같은 부모(테스트 러너)를 공유하면 pid 매핑이 B 로 잡힌다(실제로는 claude 프로세스마다 세션 하나).
    // 감시는 별도 부모를 가진 세션 A 로 띄운다 — 환경(ps 조상에 claude 가 있는지)에 따라 결과가 갈리던 테스트.
    const parent = Bun.spawn(['sleep', '30'])
    const m = monitor(e, { CLAUDE_PID: String(parent.pid) })
    appComment(e, cardId('session', B, ''), 'B 에게만')
    await sleep(1200)
    parent.kill()
    expect(m.lines.length).toBe(0)
  })
  test('pid 매핑이 CLAUDE_CODE_SESSION_ID 보다 우선(세션이 바뀐 경우)', async () => {
    const e = setup(cfg)
    await idleSession(e)
    const B = '11111111-2222-4333-8444-555555555555'
    await runHook(e, { ...base(B), hook_event_name: 'SessionStart' })
    await runHook(e, { ...base(B), hook_event_name: 'UserPromptSubmit', prompt_id: 'q', prompt: '다른 세션의 일입니다' })
    await runHook(e, { ...base(B), hook_event_name: 'Stop', last_assistant_message: 'x', background_tasks: [] })
    mkdirSync(join(e.state, 'pids'), { recursive: true })
    writeFileSync(join(e.state, 'pids', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: B }))
    const m = monitor(e)
    appComment(e, SC, 'A 에게')
    appComment(e, cardId('session', B, ''), 'B 에게')
    expect(await until(() => m.lines.length >= 1)).toBe(true)
    await sleep(500)
    expect(existsSync(join(e.state, 'signals', `${B}.json`))).toBe(true)
    expect(existsSync(join(e.state, 'signals', `${SID}.json`))).toBe(false)
  })
  test('부모(CLAUDE_PID)가 죽으면 종료한다', async () => {
    const e = setup(cfg)
    await idleSession(e)
    const parent = Bun.spawn(['sleep', '30'])
    const m = monitor(e, { CLAUDE_PID: String(parent.pid) })
    await sleep(500)
    parent.kill()
    await parent.exited
    const code = await Promise.race([m.p.exited, sleep(3000).then(() => 'timeout')])
    expect(code).toBe(0)
  })
  test('설정이 없거나 꺼져 있으면 아무것도 출력하지 않고 바로 종료', async () => {
    const e = setup(null as any)
    const m = monitor(e)
    expect(await Promise.race([m.p.exited, sleep(3000).then(() => 'timeout')])).toBe(0)
    expect(m.lines.length).toBe(0)
  })
  test('aliveAt 을 주기적으로 갱신(ts 는 그대로)', async () => {
    const e = setup(cfg)
    await idleSession(e)
    const nowP = join(boardDir(e), 'sessions', SID, 'now.json')
    const before = readJ(nowP)
    monitor(e, { AGENT_KANBAN_ALIVE_MS: '400' })
    expect(await until(() => readJ(nowP).aliveAt > before.aliveAt)).toBe(true)
    expect(readJ(nowP).ts).toBe(before.ts)
    expect(readJ(nowP).state).toBe('idle')
  })
})
